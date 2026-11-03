import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { atendePapel, exigirPapel, papeisDoUsuario } from '../plataforma/papel.js'
import { mascararTexto } from './agente/pipeline/tipos.js'
import { modoEfetivoDoCanal } from './agente/pipeline/modo-efetivo.js'
import { patchEstado } from './agente/estado-agente.js'
import { destinatariosDaFilaDoNumero, notificarPessoasDaConversa } from './notificacao.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { alvosDoHandoff, armarSlaDoHandoff } from './sla-handoff.js'

/**
 * DEVOLVER AO AGENTE e REATRIBUIR (paridade G1).
 *
 * ⚠️ "Devolver" não é mexer em flag: é o oposto do handoff. Quem decide para onde
 * a conversa vai é o MODO EFETIVO do número (ADR-028) — devolver a quem não vai
 * responder deixaria o cliente sem ninguém:
 *
 *   autônomo            → atendimento encerrado, conversa conduzida pelo agente;
 *   assistido / sombra / desligado
 *                       → o agente NÃO fala sozinho: o atendimento volta para a FILA
 *                         (sem atendente, SLA rearmado) e quem atende é avisado.
 *
 * O motivo fica em `agente_sessao.estado_agente.devolucao` (sessão ativa, criada
 * aqui se não houver): é de onde o turno seguinte o lê sem mexer no pipeline.
 * ⚠️ O evento de outbox NÃO carrega motivo nem texto — só ids e versão (ADR-007).
 */

export const MOTIVOS_DEVOLUCAO = ['resolvido_pelo_humano', 'cliente_quer_continuar_com_agente', 'fora_do_horario', 'outro'] as const
export type MotivoDevolucao = (typeof MOTIVOS_DEVOLUCAO)[number]

const ROTULO_MOTIVO: Record<MotivoDevolucao, string> = {
  resolvido_pelo_humano: 'assunto resolvido pela equipe',
  cliente_quer_continuar_com_agente: 'o cliente quer continuar com o agente',
  fora_do_horario: 'fora do horário de atendimento',
  outro: 'outro motivo',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXTO = 300
export const MARCA_DEVOLUCAO = 'devolvido_ao_agente'

async function emitir(tx: Sql, conversaId: string, tipos: readonly string[]): Promise<number> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  const versao = Number(conv?.versao ?? 0)
  for (const tipo of tipos) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), ${tipo}, 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao })}::text::jsonb)`
  }
  return versao
}

async function mensagemDeSistema(
  tx: Sql,
  p: { conversaId: string; atendimentoId: string; texto: string; automatica: string; atorId: string; agora: Date },
): Promise<void> {
  await tx`
    INSERT INTO mensagem (tenant_id, id, conversa_id, atendimento_id, direcao, tipo, conteudo, criado_em)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.conversaId}, ${p.atendimentoId}, 'saliente', 'sistema',
            ${JSON.stringify({ texto: p.texto, automatica: p.automatica, atorId: p.atorId })}::text::jsonb, ${p.agora})`
}

/** Deixa o motivo no estado da sessão ATIVA do agente (cria uma, sem turnos, se não houver). */
async function deixarRecadoParaOAgente(tx: Sql, p: {
  conversaId: string; canalId: string; modo: string; agora: Date; motivo: MotivoDevolucao; observacao: string | null
}): Promise<void> {
  const [ativa] = await tx<{ id: string }[]>`
    SELECT id FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND estado = 'ativa'`
  let sessaoId = ativa?.id
  if (!sessaoId) {
    sessaoId = randomUUID()
    await tx`
      INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo)
      VALUES (tenant_atual(), ${sessaoId}, ${p.conversaId}, ${p.canalId}, ${p.agora}, 'devolvido_pela_equipe', ${p.modo})`
  }
  await patchEstado(tx, sessaoId, {
    devolucao: { motivo: p.motivo, ...(p.observacao ? { observacao: p.observacao } : {}), em: p.agora.toISOString() },
  })
}

export async function rotasDevolucao(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { motivo?: unknown; observacao?: unknown } | null }>(
    '/v1/conversas/:id/devolver-agente',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      if (!UUID.test(conversaId)) return reply.code(400).send({ erro: 'conversa.id_invalido', mensagem: 'Id inválido.' })
      const motivo = req.body?.motivo
      if (typeof motivo !== 'string' || !(MOTIVOS_DEVOLUCAO as readonly string[]).includes(motivo)) {
        return reply.code(422).send({ erro: 'devolucao.motivo_invalido', mensagem: 'Escolha o motivo da devolução.', validos: MOTIVOS_DEVOLUCAO })
      }
      const obsBruta = req.body?.observacao
      if (obsBruta !== undefined && obsBruta !== null && (typeof obsBruta !== 'string' || obsBruta.length > MAX_TEXTO)) {
        return reply.code(422).send({ erro: 'devolucao.observacao_invalida', mensagem: `A observação aceita até ${MAX_TEXTO} caracteres.` })
      }
      const observacao = typeof obsBruta === 'string' && obsBruta.trim() ? mascararTexto(obsBruta.trim()) : null
      const motivoOk = motivo as MotivoDevolucao

      const r = await req.comTenant(async (tx) => {
        const agora = new Date()
        const [conv] = await tx<{ canal_id: string; contato_id: string; conduzida_por: string }[]>`
          SELECT canal_id, contato_id, conduzida_por FROM conversa
           WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' as const }

        const [aberto] = await tx<{ id: string; atendente_id: string | null; estado: string; devolvido: boolean }[]>`
          SELECT a.id, a.atendente_id, a.estado,
                 EXISTS (SELECT 1 FROM mensagem m
                          WHERE m.tenant_id = a.tenant_id AND m.atendimento_id = a.id
                            AND m.conteudo->>'automatica' = ${MARCA_DEVOLUCAO}) AS devolvido
            FROM atendimento a
           WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado <> 'encerrado'`

        // Idempotência: devolver de novo o que já foi devolvido não quebra nem repete efeito.
        if (!aberto && conv.conduzida_por === 'ia') return { tipo: 'ja_devolvida' as const, destino: 'agente' as const }
        if (aberto?.devolvido && aberto.atendente_id === null) return { tipo: 'ja_devolvida' as const, destino: 'fila' as const }
        if (!aberto || aberto.atendente_id === null) return { tipo: 'sem_humano' as const }

        const usuarioId = await garantirUsuarioId(tx, req)
        const gestao = atendePapel(
          await papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff }), ['gestor', 'supervisor'])
        if (aberto.atendente_id !== usuarioId && !gestao) return { tipo: 'sem_permissao' as const }

        const efetivo = await modoEfetivoDoCanal(tx, { canalId: conv.canal_id, contatoId: conv.contato_id, agora })
        const agenteFala = efetivo.modo === 'autonomo'
        const rotulo = ROTULO_MOTIVO[motivoOk]

        if (agenteFala) {
          await tx`UPDATE atendimento_etapa_historico SET saiu_em = now()
                    WHERE tenant_id = tenant_atual() AND atendimento_id = ${aberto.id} AND saiu_em IS NULL`
          await tx`
            UPDATE atendimento SET estado = 'encerrado', encerrado_em = coalesce(encerrado_em, ${agora}), versao = versao + 1
             WHERE tenant_id = tenant_atual() AND id = ${aberto.id}`
          await tx`UPDATE conversa SET conduzida_por = 'ia' WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
          await deixarRecadoParaOAgente(tx, { conversaId, canalId: conv.canal_id, modo: efetivo.modo, agora, motivo: motivoOk, observacao })
        } else {
          // Volta para a fila como um handoff novo: sem atendente, SLA do zero, roteado de novo.
          await tx`
            UPDATE atendimento
               SET atendente_id = NULL, estado = 'na_fila', assumido_em = NULL, versao = versao + 1,
                   sla_inicio_em = NULL, sla_vence_em = NULL, reatribuicao_vence_em = NULL, aviso_espera_previsto_em = NULL,
                   sla_estourado_em = NULL, reatribuicao_liberada_em = NULL, aviso_espera_em = NULL,
                   aviso_espera_resultado = NULL, sla_respondido_em = NULL, responsavel_id = NULL, responsavel_origem = NULL
             WHERE tenant_id = tenant_atual() AND id = ${aberto.id}`
          await armarSlaDoHandoff(tx, { atendimentoId: aberto.id, conversaId, canalId: conv.canal_id, agora })
          const alvos = (await alvosDoHandoff(tx, conversaId)) ?? await destinatariosDaFilaDoNumero(tx, conv.canal_id)
          await notificarPessoasDaConversa(
            tx, alvos.filter((u) => u !== usuarioId), 'fila.nova', 'devolvida à fila (o agente não está atendendo neste número)', conversaId)
        }

        const detalhe = observacao ? `\nObservação: ${observacao}` : ''
        await mensagemDeSistema(tx, {
          conversaId, atendimentoId: aberto.id, automatica: MARCA_DEVOLUCAO, atorId: usuarioId, agora,
          texto: agenteFala
            ? `Conversa devolvida ao agente: ${rotulo}.${detalhe}`
            : `Conversa devolvida à fila (agente em modo ${efetivo.modo}): ${rotulo}.${detalhe}`,
        })
        await emitir(tx, conversaId, ['atendimento.mudou', 'conversa.devolvida'])
        await auditar(tx, {
          atorId: usuarioId, acao: 'conversa.devolvida_ao_agente', entidade: 'conversa', entidadeId: conversaId,
          dados: { motivo: motivoOk, ...(observacao ? { observacao } : {}), destino: agenteFala ? 'agente' : 'fila', modoEfetivo: efetivo.modo },
        })
        return { tipo: 'devolvida' as const, destino: agenteFala ? ('agente' as const) : ('fila' as const), modo: efetivo.modo }
      })

      if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      if (r.tipo === 'sem_humano') {
        return reply.code(409).send({ erro: 'conversa.sem_atendimento_humano', mensagem: 'Esta conversa não está com um atendente — não há o que devolver.' })
      }
      if (r.tipo === 'sem_permissao') {
        return reply.code(403).send({
          erro: 'atendimento.nao_e_seu',
          mensagem: 'Só quem conduz este atendimento, ou a gestão, pode devolvê-lo ao agente.',
        })
      }
      if (r.tipo === 'ja_devolvida') return reply.code(200).send({ ok: true, jaDevolvida: true, destino: r.destino })
      return reply.code(200).send({
        ok: true, jaDevolvida: false, destino: r.destino, modoEfetivo: r.modo,
        ...(r.destino === 'fila' ? { aviso: 'O agente não responde sozinho neste número agora: a conversa voltou para a fila.' } : {}),
      })
    },
  )

  app.post<{ Params: { id: string }; Body: { usuarioId?: unknown; motivo?: unknown } | null }>(
    '/v1/conversas/:id/reatribuir',
    { preHandler: [exigirTenant, exigirPapel('gestor', 'supervisor')] },
    async (req, reply) => {
      const conversaId = req.params.id
      if (!UUID.test(conversaId)) return reply.code(400).send({ erro: 'conversa.id_invalido', mensagem: 'Id inválido.' })
      const destinoId = req.body?.usuarioId
      if (typeof destinoId !== 'string' || !UUID.test(destinoId)) {
        return reply.code(422).send({ erro: 'reatribuicao.usuario_invalido', mensagem: 'Escolha para quem reatribuir.' })
      }
      const motivoBruto = req.body?.motivo
      const motivo = typeof motivoBruto === 'string' ? motivoBruto.trim() : ''
      if (!motivo || motivo.length > MAX_TEXTO) {
        return reply.code(422).send({ erro: 'reatribuicao.motivo_invalido', mensagem: `Diga o motivo (até ${MAX_TEXTO} caracteres).` })
      }

      const r = await req.comTenant(async (tx) => {
        const [destino] = await tx<{ id: string; nome: string; ativo: boolean; ausente: boolean }[]>`
          SELECT id, nome, ativo, ausente FROM usuario WHERE tenant_id = tenant_atual() AND id = ${destinoId}`
        if (!destino) return { tipo: 'usuario_nao_encontrado' as const }
        if (!destino.ativo) return { tipo: 'usuario_inativo' as const }

        const [conv] = await tx<{ id: string }[]>`SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' as const }
        const [aberto] = await tx<{ id: string; atendente_id: string | null }[]>`
          SELECT id, atendente_id FROM atendimento
           WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado <> 'encerrado'`
        if (!aberto) return { tipo: 'sem_atendimento' as const }
        if (aberto.atendente_id === destino.id) return { tipo: 'ja_era' as const }

        const atorId = await garantirUsuarioId(tx, req)
        // Mesmo UPDATE condicional do assumir: só pega a linha no estado lido.
        const [tomado] = await tx<{ id: string }[]>`
          UPDATE atendimento
             SET atendente_id = ${destino.id}, estado = 'em_atendimento', assumido_em = now(), versao = versao + 1
           WHERE tenant_id = tenant_atual() AND id = ${aberto.id} AND estado <> 'encerrado'
             AND atendente_id IS NOT DISTINCT FROM ${aberto.atendente_id}::uuid
          RETURNING id`
        if (!tomado) return { tipo: 'conflito' as const }
        await mensagemDeSistema(tx, {
          conversaId, atendimentoId: aberto.id, automatica: 'reatribuido', atorId, agora: new Date(),
          texto: `Conversa reatribuída para ${destino.nome}. Motivo: ${mascararTexto(motivo)}`,
        })
        if (destino.id !== atorId) {
          await notificarPessoasDaConversa(tx, [destino.id], 'atendimento.reatribuido', 'foi reatribuída para você', conversaId)
        }
        await emitir(tx, conversaId, ['atendimento.mudou', 'conversa.reatribuida'])
        await auditar(tx, {
          atorId, acao: 'atendimento.reatribuido', entidade: 'conversa', entidadeId: conversaId,
          dados: { de: aberto.atendente_id, para: destino.id, motivo: mascararTexto(motivo), origem: 'gestao' },
        })
        return { tipo: 'ok' as const, nome: destino.nome, ausente: destino.ausente }
      })

      if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      if (r.tipo === 'usuario_nao_encontrado') return reply.code(404).send({ erro: 'usuario.nao_encontrado' })
      if (r.tipo === 'usuario_inativo') return reply.code(422).send({ erro: 'usuario.inativo', mensagem: 'Esse usuário está inativo.' })
      if (r.tipo === 'sem_atendimento') {
        return reply.code(409).send({ erro: 'conversa.sem_atendimento', mensagem: 'Não há atendimento aberto para reatribuir — assuma a conversa primeiro.' })
      }
      if (r.tipo === 'conflito') return reply.code(409).send({ erro: 'atendimento.conflito', mensagem: 'Alguém mexeu antes — recarregue.' })
      if (r.tipo === 'ja_era') return reply.code(200).send({ ok: true, jaEra: true })
      return reply.code(200).send({ ok: true, jaEra: false, para: r.nome, destinoAusente: r.ausente })
    },
  )
}
