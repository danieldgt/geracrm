import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { atendePapel, exigirPapel, papeisDoUsuario } from '../plataforma/papel.js'
import { condicaoConversa, escopoDaRequisicao, podeAtenderConversa } from '../plataforma/escopo.js'
import { mascararTexto } from './agente/pipeline/tipos.js'
import { modoEfetivoDoCanal, type ModoEfetivoDoCanal } from './agente/pipeline/modo-efetivo.js'
import {
  CHAVE_DEVOLUCAO, MOTIVOS_DEVOLUCAO, ROTULO_MOTIVO_DEVOLUCAO, type MotivoDevolucao,
} from './agente/pipeline/devolucao-da-equipe.js'
import { patchEstado } from './agente/estado-agente.js'
import { agendarTurno } from './agente/fila.js'
import { destinatariosDaFilaDoNumero, notificarPessoasDaConversa } from './notificacao.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { alvosDoHandoff, armarSlaDoHandoff, fragmentoForaDaSimulacao, respostaHumanaDoAtendimento } from './sla-handoff.js'

/**
 * DEVOLVER AO AGENTE e REATRIBUIR (paridade G1).
 *
 * ⚠️ "Devolver" não é mexer em flag: é o oposto do handoff. Quem decide para onde
 * a conversa vai é o MODO EFETIVO do número (ADR-028) — devolver a quem não vai
 * responder deixaria o cliente sem ninguém:
 *
 *   autônomo            → atendimento encerrado, conversa conduzida pelo agente;
 *                         o recado (motivo + observação mascarada) fica em
 *                         `agente_sessao.estado_agente.devolucao` e é lido pela
 *                         etapa `pipeline/devolucao-da-equipe.ts` no 1º turno; se o
 *                         cliente escreveu e ninguém respondeu, o turno é ENFILEIRADO.
 *   assistido / sombra / desligado / fora do recorte
 *                       → o agente NÃO fala sozinho: o atendimento volta para a FILA
 *                         (sem atendente, SLA rearmado) e quem atende é avisado. O
 *                         porquê (`motivoFila`) vai na resposta e na mensagem de sistema.
 *
 * ⚠️ CONCORRÊNCIA: a primeira escrita é um UPDATE condicional que só pega a linha
 *    no estado lido (`estado <> 'encerrado' AND atendente_id IS NOT DISTINCT FROM
 *    <lido>`), como o assumir. Quem perde relê: se a conversa já foi devolvida,
 *    responde 200 `jaDevolvida`; senão, 409 `atendimento.conflito`. Nenhum efeito
 *    (mensagem, sessão, evento, auditoria) acontece antes de tomar a linha.
 * ⚠️ A devolução NÃO manda nada ao cliente: só mensagem de SISTEMA (interna). Quem
 *    fala com o cliente depois é o turno do agente, pelo pipeline inteiro.
 * ⚠️ O evento de outbox NÃO carrega motivo nem texto — só ids e versão (ADR-007).
 *
 * ACESSO
 *   - Devolver: quem conduz o atendimento, ou a gestão (gestor/supervisor/admin).
 *     Permissão e 404 vêm ANTES do retorno idempotente: `jaDevolvida` só responde
 *     a quem poderia ter devolvido (gestão ou o autor da devolução); os demais
 *     recebem 409 `conversa.sem_atendimento_humano` — nunca um "ok" que não deram.
 *   - Escopo (D3, `contexts/plataforma/escopo.ts`): quem age só alcança a conversa
 *     que VÊ na listagem (`GET /v1/conversas`: não arquivada, fora do playground E
 *     no escopo de quem pede — `condicaoConversa`) — o resto é 404, antes de
 *     permissão e de idempotência. Vale para quem conduz também (conduzir já põe
 *     a conversa no escopo dele).
 *   - Reatribuir: só gestão; o DESTINO precisa poder atender
 *     (`podeAtenderConversa`): o cliente no escopo dele, ou o número que ele atende
 *     (`usuario_canal`, 0011 — número sem ninguém declarado é de todos), ou o número
 *     de uma filial que ele gere.
 */

export { MOTIVOS_DEVOLUCAO }
export type { MotivoDevolucao }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXTO = 300
export const MARCA_DEVOLUCAO = 'devolvido_ao_agente'
/** Até onde olhar mensagens do cliente sem resposta ao devolver (poda partições). */
const JANELA_PENDENTES_MS = 7 * 24 * 60 * 60 * 1000
const TETO_PENDENTES = 20

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

/**
 * Deixa o recado na sessão ATIVA do agente (cria uma, sem turnos, se não houver).
 * ⚠️ `ON CONFLICT DO NOTHING` no índice `agente_sessao_uma_ativa`: um turno do
 *    agente (ou outra devolução) pode abrir a sessão no meio — relê a vencedora.
 */
async function deixarRecadoParaOAgente(tx: Sql, p: {
  conversaId: string; canalId: string; modo: string; agora: Date; motivo: MotivoDevolucao; observacao: string | null
}): Promise<void> {
  const [criada] = await tx<{ id: string }[]>`
    INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.conversaId}, ${p.canalId}, ${p.agora}, 'devolvido_pela_equipe', ${p.modo})
    ON CONFLICT (tenant_id, conversa_id) WHERE estado = 'ativa' DO NOTHING
    RETURNING id`
  const sessaoId = criada?.id ?? (await tx<{ id: string }[]>`
    SELECT id FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND estado = 'ativa'`)[0]?.id
  await patchEstado(tx, sessaoId ?? null, {
    [CHAVE_DEVOLUCAO]: { motivo: p.motivo, ...(p.observacao ? { observacao: p.observacao } : {}), em: p.agora.toISOString() },
  })
}

/**
 * Mensagens do cliente depois da última resposta REAL (sistema não conta), na
 * janela recente — em ordem cronológica. É o que o agente precisa responder.
 */
async function entrantesSemResposta(tx: Sql, conversaId: string, agora: Date): Promise<string[]> {
  const desde = new Date(agora.getTime() - JANELA_PENDENTES_MS)
  const linhas = await tx<{ id: string }[]>`
    SELECT m.id FROM mensagem m
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.direcao = 'entrante'
       AND m.criado_em > ${desde}
       AND NOT EXISTS (SELECT 1 FROM mensagem s
                        WHERE s.tenant_id = m.tenant_id AND s.conversa_id = m.conversa_id
                          AND s.direcao = 'saliente' AND s.tipo <> 'sistema'
                          AND s.criado_em > ${desde} AND s.criado_em >= m.criado_em)
     ORDER BY m.criado_em DESC
     LIMIT ${TETO_PENDENTES}`
  return linhas.map((l) => l.id).reverse()
}

/** Por que o agente não fala sozinho agora — código estável + texto para a tela. */
function motivoDaFila(e: ModoEfetivoDoCanal): { codigo: string; texto: string } {
  const m = e.motivo
  if (m === 'teto_do_tenant') return { codigo: m, texto: `a conta limita o agente ao modo ${e.modo}` }
  if (m === 'recorte_invalido') return { codigo: m, texto: 'o recorte do agente neste número está inválido' }
  if (m === 'modo_efetivo_indisponivel') return { codigo: m, texto: 'não foi possível confirmar o modo do agente' }
  if (m?.startsWith('fora_do_recorte')) {
    const horario = m.includes('horario')
    const segmento = m.includes('segmento')
    const texto = horario && segmento
      ? 'fora do horário e do segmento em que o agente atende sozinho'
      : horario ? 'fora do horário em que o agente atende sozinho' : 'este cliente está fora do segmento do agente'
    return { codigo: m, texto }
  }
  return { codigo: 'modo_do_numero', texto: `o agente deste número está em modo ${e.modoDoNumero}` }
}

// ── situação da conversa (lida antes e RELIDA depois de perder a guarda) ────

interface Situacao {
  readonly conduzidaPor: string
  readonly aberto: { readonly id: string; readonly atendente_id: string | null; readonly devolvido: boolean } | null
  /** Quem fez a devolução mais recente (mensagem de sistema), ou null. */
  readonly devolvidaPor: string | null
}
type Estado = 'humano' | 'ja_agente' | 'ja_fila' | 'sem_humano'

async function lerSituacao(tx: Sql, conversaId: string, agora: Date): Promise<Situacao | null> {
  const [conv] = await tx<{ conduzida_por: string }[]>`
    SELECT conduzida_por FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
  if (!conv) return null
  const [aberto] = await tx<{ id: string; atendente_id: string | null; devolvido: boolean }[]>`
    SELECT a.id, a.atendente_id,
           EXISTS (SELECT 1 FROM mensagem m
                    WHERE m.tenant_id = a.tenant_id AND m.conversa_id = a.conversa_id AND m.atendimento_id = a.id
                      AND m.tipo = 'sistema' AND m.conteudo->>'automatica' = ${MARCA_DEVOLUCAO}) AS devolvido
      FROM atendimento a
     WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado <> 'encerrado'`
  const [ultima] = await tx<{ ator: string | null }[]>`
    SELECT m.conteudo->>'atorId' AS ator FROM mensagem m
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.tipo = 'sistema'
       AND m.conteudo->>'automatica' = ${MARCA_DEVOLUCAO}
       AND m.criado_em > ${new Date(agora.getTime() - JANELA_PENDENTES_MS)}
     ORDER BY m.criado_em DESC LIMIT 1`
  return { conduzidaPor: conv.conduzida_por, aberto: aberto ?? null, devolvidaPor: ultima?.ator ?? null }
}

function classificar(s: Situacao): Estado {
  if (s.aberto?.atendente_id) return 'humano'
  if (s.aberto && s.aberto.devolvido) return 'ja_fila'
  if (!s.aberto && s.conduzidaPor === 'ia' && s.devolvidaPor) return 'ja_agente'
  // ⚠️ `conduzida_por = 'humano'` sem atendimento aberto também cai aqui: ninguém
  //    conduz agora (o atendimento foi encerrado, ou a conversa nasceu de envio
  //    nosso) — não há o que devolver; quem quiser o agente de volta assume antes.
  return 'sem_humano'
}

/**
 * A conversa aparece em `GET /v1/conversas` para QUEM PEDE? (não arquivada, fora do
 * playground e no escopo dele — a mesma régua da listagem, escopo D3).
 */
async function visivelNaListagem(tx: Sql, req: FastifyRequest, conversaId: string): Promise<boolean> {
  const escopo = await escopoDaRequisicao(tx, req)
  const [l] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok FROM conversa cv
     WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId} AND NOT cv.arquivada
       AND ${fragmentoForaDaSimulacao(tx)}
       AND ${condicaoConversa(tx, escopo)}`
  return l?.ok === true
}

type ResultadoDevolucao =
  | { tipo: 'nao_encontrada' } | { tipo: 'sem_humano' } | { tipo: 'sem_permissao' } | { tipo: 'conflito' }
  | { tipo: 'ja_devolvida'; destino: 'agente' | 'fila' }
  | { tipo: 'devolvida'; destino: 'agente' | 'fila'; modo: string; motivoFila: { codigo: string; texto: string } | null; turnoAgendado: boolean }

function jaDevolvida(e: Estado): ResultadoDevolucao | null {
  if (e === 'ja_agente') return { tipo: 'ja_devolvida', destino: 'agente' }
  if (e === 'ja_fila') return { tipo: 'ja_devolvida', destino: 'fila' }
  return null
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

      const r = await req.comTenant(async (tx): Promise<ResultadoDevolucao> => {
        const agora = new Date()
        const [conv] = await tx<{ canal_id: string; contato_id: string }[]>`
          SELECT canal_id, contato_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' }

        const usuarioId = await garantirUsuarioId(tx, req)
        const gestao = atendePapel(
          await papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff }), ['gestor', 'supervisor'])
        const antes = await lerSituacao(tx, conversaId, agora)
        if (!antes) return { tipo: 'nao_encontrada' }
        const conduzo = antes.aberto?.atendente_id === usuarioId

        // ── 404 e permissão ANTES de qualquer retorno idempotente (M1/M2) ──
        // ⚠️ Escopo (D3): fora da listagem de quem pede = 404, para todos (quem conduz
        //    está no escopo por conduzir; a gestão, só no que a sua régua alcança).
        if (!(await visivelNaListagem(tx, req, conversaId))) return { tipo: 'nao_encontrada' }
        const estado = classificar(antes)
        if (estado === 'humano' && !conduzo && !gestao) return { tipo: 'sem_permissao' }
        const ja = jaDevolvida(estado)
        if (ja) return gestao || antes.devolvidaPor === usuarioId ? ja : { tipo: 'sem_humano' }
        if (estado !== 'humano' || !antes.aberto) return { tipo: 'sem_humano' }

        const aberto = antes.aberto
        const efetivo = await modoEfetivoDoCanal(tx, { canalId: conv.canal_id, contatoId: conv.contato_id, agora })
        const agenteFala = efetivo.modo === 'autonomo'
        const rotulo = ROTULO_MOTIVO_DEVOLUCAO[motivoOk]

        // ── TOMA A LINHA: só no estado lido. Nada foi escrito antes daqui. ──
        const [tomado] = agenteFala
          // SLA ao encerrar (M4): os relógios pendentes (reatribuição, aviso de espera)
          // zeram sempre; o prazo do handoff só zera se ainda NÃO estava decidido
          // (sem resposta humana, sem estouro, ainda no prazo) — senão o
          // atendimento encerrado viraria "estourado" na métrica quando o prazo
          // passasse, por uma espera que acabou. Decidido (cumprido ou estourado)
          // fica para a métrica (`sla-metrica.ts`).
          ? await tx<{ id: string }[]>`
              UPDATE atendimento a
                 SET estado = 'encerrado', encerrado_em = coalesce(a.encerrado_em, ${agora}), versao = a.versao + 1,
                     reatribuicao_vence_em = NULL, aviso_espera_previsto_em = NULL, reatribuicao_liberada_em = NULL,
                     sla_inicio_em = CASE WHEN ${slaDecidido(tx, agora)} THEN a.sla_inicio_em END,
                     sla_vence_em  = CASE WHEN ${slaDecidido(tx, agora)} THEN a.sla_vence_em END
               WHERE a.tenant_id = tenant_atual() AND a.id = ${aberto.id} AND a.estado <> 'encerrado'
                 AND a.atendente_id IS NOT DISTINCT FROM ${aberto.atendente_id}::uuid
              RETURNING a.id`
          // Volta para a fila como um handoff novo: sem atendente, SLA do zero, roteado de novo.
          : await tx<{ id: string }[]>`
              UPDATE atendimento
                 SET atendente_id = NULL, estado = 'na_fila', assumido_em = NULL, versao = versao + 1,
                     sla_inicio_em = NULL, sla_vence_em = NULL, reatribuicao_vence_em = NULL, aviso_espera_previsto_em = NULL,
                     sla_estourado_em = NULL, reatribuicao_liberada_em = NULL, aviso_espera_em = NULL,
                     aviso_espera_resultado = NULL, sla_respondido_em = NULL, responsavel_id = NULL, responsavel_origem = NULL
               WHERE tenant_id = tenant_atual() AND id = ${aberto.id} AND estado <> 'encerrado'
                 AND atendente_id IS NOT DISTINCT FROM ${aberto.atendente_id}::uuid
              RETURNING id`
        if (!tomado) {
          // Perdeu para outra escrita concorrente: relê (o commit dela já é visível).
          const depois = await lerSituacao(tx, conversaId, agora)
          return (depois && jaDevolvida(classificar(depois))) ?? { tipo: 'conflito' }
        }

        let motivoFila: { codigo: string; texto: string } | null = null
        let turnoAgendado = false
        if (agenteFala) {
          await tx`UPDATE atendimento_etapa_historico SET saiu_em = now()
                    WHERE tenant_id = tenant_atual() AND atendimento_id = ${aberto.id} AND saiu_em IS NULL`
          await tx`UPDATE conversa SET conduzida_por = 'ia' WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
          await deixarRecadoParaOAgente(tx, { conversaId, canalId: conv.canal_id, modo: efetivo.modo, agora, motivo: motivoOk, observacao })
          // O cliente escreveu e ninguém respondeu? O agente responde agora — pela
          // MESMA fila da ingestão (debounce, um turno por conversa, ADR-024).
          const pendentes = await entrantesSemResposta(tx, conversaId, agora)
          for (const mensagemId of pendentes) {
            await agendarTurno(tx, { conversaId, canalId: conv.canal_id, mensagemId, agora })
          }
          turnoAgendado = pendentes.length > 0
        } else {
          motivoFila = motivoDaFila(efetivo)
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
            : `Conversa devolvida à fila — o agente não responde sozinho agora (${motivoFila!.texto}). Motivo: ${rotulo}.${detalhe}`,
        })
        await emitir(tx, conversaId, ['atendimento.mudou', 'conversa.devolvida'])
        await auditar(tx, {
          atorId: usuarioId, acao: 'conversa.devolvida_ao_agente', entidade: 'conversa', entidadeId: conversaId,
          dados: {
            motivo: motivoOk, ...(observacao ? { observacao } : {}), destino: agenteFala ? 'agente' : 'fila', modoEfetivo: efetivo.modo,
            ...(motivoFila ? { motivoFila: motivoFila.codigo } : {}), ...(turnoAgendado ? { turnoAgendado } : {}),
          },
        })
        return { tipo: 'devolvida', destino: agenteFala ? 'agente' : 'fila', modo: efetivo.modo, motivoFila, turnoAgendado }
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
      if (r.tipo === 'conflito') return reply.code(409).send({ erro: 'atendimento.conflito', mensagem: 'Alguém mexeu nesta conversa antes — recarregue.' })
      if (r.tipo === 'ja_devolvida') return reply.code(200).send({ ok: true, jaDevolvida: true, destino: r.destino })
      return reply.code(200).send({
        ok: true, jaDevolvida: false, destino: r.destino, modoEfetivo: r.modo,
        ...(r.destino === 'agente' ? { turnoAgendado: r.turnoAgendado } : {}),
        ...(r.motivoFila
          ? {
              motivoFila: r.motivoFila.codigo,
              aviso: `O agente não responde sozinho agora (${r.motivoFila.texto}): a conversa voltou para a fila.`,
            }
          : {}),
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
        // Gestão só reatribui o que VÊ (mesma régua da listagem, com o escopo D3 —
        // gestor de filial = a filial) — 404 antes de tudo.
        if (!(await visivelNaListagem(tx, req, conversaId))) return { tipo: 'nao_encontrada' as const }

        const [destino] = await tx<{ id: string; nome: string; ativo: boolean; ausente: boolean }[]>`
          SELECT id, nome, ativo, ausente FROM usuario WHERE tenant_id = tenant_atual() AND id = ${destinoId}`
        if (!destino) return { tipo: 'usuario_nao_encontrado' as const }
        if (!destino.ativo) return { tipo: 'usuario_inativo' as const }
        // ⚠️ Escopo (D3): o DESTINO precisa poder atender — o cliente no escopo dele, o
        //    número que ele atende ou o número de uma filial que ele gere.
        if (!(await podeAtenderConversa(tx, destino.id, conversaId))) return { tipo: 'sem_acesso_ao_numero' as const, nome: destino.nome }

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
      if (r.tipo === 'sem_acesso_ao_numero') {
        return reply.code(422).send({
          erro: 'reatribuicao.sem_acesso_ao_numero',
          mensagem: `${r.nome} não atende este número nem tem este cliente no escopo dele. Dê acesso ao número em Equipe, ou escolha outra pessoa.`,
        })
      }
      if (r.tipo === 'sem_atendimento') {
        return reply.code(409).send({ erro: 'conversa.sem_atendimento', mensagem: 'Não há atendimento aberto para reatribuir — assuma a conversa primeiro.' })
      }
      if (r.tipo === 'conflito') return reply.code(409).send({ erro: 'atendimento.conflito', mensagem: 'Alguém mexeu antes — recarregue.' })
      if (r.tipo === 'ja_era') return reply.code(200).send({ ok: true, jaEra: true })
      return reply.code(200).send({ ok: true, jaEra: false, para: r.nome, destinoAusente: r.ausente })
    },
  )
}

/**
 * Fragmento (alias `a` = atendimento): o SLA do handoff já está DECIDIDO — sem
 * prazo, respondido (carimbo ou resposta humana medida), estourado ou vencido.
 */
function slaDecidido(tx: Sql, agora: Date) {
  return tx`(a.sla_vence_em IS NULL OR a.sla_respondido_em IS NOT NULL OR a.sla_estourado_em IS NOT NULL
             OR a.sla_vence_em <= ${agora} OR ${respostaHumanaDoAtendimento(tx)} IS NOT NULL)`
}
