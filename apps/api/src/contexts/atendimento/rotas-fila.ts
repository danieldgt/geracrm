import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { atendePapel, papeisDoUsuario } from '../plataforma/papel.js'
import { operadorAusente, RECUSA_OPERADOR_AUSENTE } from './presenca-operador.js'
import { garantirEtapasAtendimento } from './rotas-atendimento-kanban.js'
import { fragmentoForaDaSimulacao, fragmentoNaFila, respostaHumanaDoAtendimento } from './sla-handoff.js'

/**
 * Fila e assunção (EP-06).
 *
 * ⚠️ "Assumir atendimento" é vencedor ATÔMICO por índice único (INV-51:
 * `atendimento_aberto_unico`), NUNCA `SELECT` antes de `INSERT`. Em 50 assunções
 * concorrentes da mesma conversa, exatamente 1 vence; as outras recebem erro
 * tipificado — e a tela já atualizou pelo tempo real.
 */

/**
 * Garante o `usuario` do chamador (por cognito_sub) e devolve o id.
 *
 * ⚠️ O conflito é resolvido por `(tenant_id, cognito_sub)`, não por `cognito_sub`
 * sozinho: a MESMA pessoa pode ser usuária de dois clientes nossos — consultor,
 * contador, e o staff que entra no cliente pelo PLT-05. Com o único global, a
 * segunda empresa caía no UPDATE de uma linha de OUTRO tenant, o RLS FORCE
 * recusava, o `RETURNING` voltava vazio e a rota estourava em 500. Vale para os
 * ~25 pontos que chamam esta função — praticamente toda escrita do produto.
 * A chave composta nasce na migration 0081; o único global sai na 0082.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function garantirUsuarioId(tx: Sql, req: FastifyRequest): Promise<string> {
  // Dev (header x-tenant-id, sem Cognito): sub sintético por tenant, para duas
  // empresas locais não disputarem a mesma linha. ⚠️ A regra do `sub` é UMA só
  // (`subDoUsuario`) — presença, ausência e autoria têm de casar a mesma linha.
  const sub = subDoUsuario(req)
  const email = req.usuarioEmail ?? 'dogfooding@geracrm.local'
  const nome = (email.split('@')[0] ?? 'Atendente') || 'Atendente'
  const [u] = await tx<{ id: string }[]>`
    INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
    VALUES (tenant_atual(), ${randomUUID()}, ${sub}, ${nome}, ${email})
    ON CONFLICT (tenant_id, cognito_sub) DO UPDATE SET email = EXCLUDED.email
    RETURNING id`
  return u!.id
}

async function emitirEvento(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'atendimento.mudou', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}

export async function rotasFila(app: FastifyInstance): Promise<void> {
  /** Busca de conversa por PROTOCOLO (E5-08). O número é a identidade. */
  app.get<{ Querystring: { p?: string } }>(
    '/v1/conversas/por-protocolo',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const p = Number(req.query.p)
      if (!Number.isSafeInteger(p) || p <= 0) return reply.code(422).send({ erro: 'protocolo.invalido' })
      const [row] = await req.comTenant((tx) => tx<{ conversa_id: string }[]>`
        SELECT conversa_id FROM atendimento
         WHERE tenant_id = tenant_atual() AND protocolo = ${p}
         ORDER BY criado_em DESC LIMIT 1`)
      if (!row) return reply.code(404).send({ erro: 'protocolo.nao_encontrado' })
      return reply.send({ conversaId: row.conversa_id })
    },
  )

  /** Contadores das abas (E6-02): fila (não assumidas) e meus (em atendimento). */
  app.get('/v1/fila/contadores', { preHandler: exigirTenant }, async (req, reply) => {
    const sub = subDoUsuario(req) // a MESMA regra do assumir (dev: "dev-<tenant>")
    const r = await req.comTenant(async (tx) => {
      const [fila] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conversa cv
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada AND ${fragmentoNaFila(tx)}`
      const [meus] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM atendimento a
         JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
         JOIN conversa cv ON cv.tenant_id = a.tenant_id AND cv.id = a.conversa_id
         WHERE a.tenant_id = tenant_atual() AND a.estado <> 'encerrado' AND u.cognito_sub = ${sub}
           AND ${fragmentoForaDaSimulacao(tx)}`
      return { fila: fila?.n ?? 0, meus: meus?.n ?? 0 }
    })
    return reply.send(r)
  })

  /**
   * Assumir a conversa. `etapaId` (opcional) diz em QUAL etapa do painel o atendimento
   * nasce — é o que o kanban manda quando o gestor solta o card numa coluna; sem ela,
   * nasce na 1ª etapa de atendimento. ⚠️ Só etapa ATIVA do tipo 'atendimento': encerrar
   * é mover DEPOIS de assumir (`/atendimento-kanban/:id/mover`), nunca nascer encerrado —
   * um atendimento encerrado não tira a conversa da fila, e o card apareceria nas duas.
   */
  app.post<{ Params: { id: string }; Body: { etapaId?: string } | null }>(
    '/v1/conversas/:id/assumir',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      const etapaPedida = req.body?.etapaId
      const ETAPA_INVALIDA = { erro: 'etapa.invalida', mensagem: 'Solte o card numa etapa de atendimento ativa.' }
      if (etapaPedida !== undefined && !UUID.test(etapaPedida)) return reply.code(422).send(ETAPA_INVALIDA)
      const r = await req.comTenant(async (tx) => {
        const [conv] = await tx<{ canal_id: string }[]>`
          SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!conv) return { tipo: 'nao_encontrada' as const }

        // ⚠️ AUSENTE NÃO ASSUME, e aqui o motivo é mais grave que a simetria com
        //    o envio: assumir CALA o agente naquela conversa por uma hora
        //    (`atendente_presente` no portão). Quem está ausente assumindo um
        //    card desligaria o robô sem colocar ninguém no lugar — o cliente
        //    escreve e não recebe nada de ninguém. É a mesma família da assunção
        //    esquecida que silenciou a resposta de ausência em 26/08.
        if (await operadorAusente(tx, req)) return { tipo: 'operador_ausente' as const }

        const usuarioId = await garantirUsuarioId(tx, req)
        await garantirEtapasAtendimento(tx)
        const [etapa] = etapaPedida
          ? await tx<{ id: string }[]>`
              SELECT id FROM atendimento_etapa
               WHERE tenant_id = tenant_atual() AND id = ${etapaPedida} AND ativo AND tipo = 'atendimento'`
          : await tx<{ id: string }[]>`
              SELECT id FROM atendimento_etapa
               WHERE tenant_id = tenant_atual() AND ativo AND tipo = 'atendimento' ORDER BY ordem LIMIT 1`
        if (etapaPedida && !etapa) return { tipo: 'etapa_invalida' as const }
        const atId = randomUUID()

        // ⚠️ Vencedor atômico: o índice parcial único recusa um 2º aberto.
        const [criado] = await tx<{ protocolo: string; etapa_id: string | null }[]>`
          INSERT INTO atendimento
            (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em, etapa_id, entrou_etapa_em)
          VALUES (tenant_atual(), ${atId}, ${conversaId}, ${conv.canal_id},
                  proximo_numero(tenant_atual(), 'protocolo'), ${usuarioId}, 'em_atendimento', now(),
                  ${etapa?.id ?? null}, now())
          ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado'
          DO NOTHING
          RETURNING protocolo, etapa_id`

        if (criado) {
          if (criado.etapa_id) {
            await tx`INSERT INTO atendimento_etapa_historico (tenant_id, id, atendimento_id, etapa_id, entrou_em, ator_id)
                     VALUES (tenant_atual(), ${randomUUID()}, ${atId}, ${criado.etapa_id}, now(), ${usuarioId})`
          }
          await emitirEvento(tx, conversaId)
          await auditar(tx, {
            atorId: usuarioId, acao: 'atendimento.assumido', entidade: 'conversa',
            entidadeId: conversaId, dados: { protocolo: Number(criado.protocolo) },
          })
          return { tipo: 'assumido' as const, protocolo: Number(criado.protocolo), meu: true, atendimentoId: atId }
        }

        // Já havia um atendimento aberto — quem tem?
        const [aberto] = await tx<{
          id: string; atendente_id: string | null; nome: string | null; protocolo: string; estado: string
          responsavel_id: string | null; responsavel_nome: string | null; responsavel_disponivel: boolean | null
          reatribuicao_liberada_em: Date | null; reatribuicao_vence_em: Date | null; respondido_em: Date | null
        }[]>`
          SELECT a.id, a.atendente_id, u.nome, a.protocolo, a.estado, a.responsavel_id, r.nome AS responsavel_nome,
                 (r.ativo AND NOT r.ausente) AS responsavel_disponivel, a.reatribuicao_liberada_em, a.reatribuicao_vence_em,
                 ${respostaHumanaDoAtendimento(tx)} AS respondido_em
            FROM atendimento a
            LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
            LEFT JOIN usuario r ON r.tenant_id = a.tenant_id AND r.id = a.responsavel_id
           WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado <> 'encerrado'`

        // ── SLA do handoff (P18) ────────────────────────────────────────────
        // ⚠️ O handoff ROTEADO fica reservado ao responsável até o 2º limiar
        //    (`reatribuicao_liberada_em`); gestão (admin/gestor/supervisor) assume
        //    sempre. Depois do limiar, qualquer um assume — inclusive de quem
        //    assumiu e não respondeu (a REATRIBUIÇÃO). O vencedor continua
        //    atômico: o UPDATE só pega a linha no estado lido.
        if (aberto && aberto.atendente_id !== usuarioId) {
          const liberada = aberto.reatribuicao_liberada_em !== null
          const livre = aberto.atendente_id === null && aberto.estado === 'na_fila'
          const reatribuivel = aberto.atendente_id !== null && liberada && aberto.respondido_em === null
          if (livre || reatribuivel) {
            const gestao = atendePapel(
              await papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff }), ['gestor', 'supervisor'])
            // ⚠️ A reserva só vale com o responsável ATIVO e DISPONÍVEL agora: quem
            //    se marcou ausente (ou foi desativado) depois do roteamento não pode
            //    prender o cliente até o 2º limiar.
            if (livre && aberto.responsavel_id && aberto.responsavel_id !== usuarioId && !liberada && !gestao
              && aberto.responsavel_disponivel === true) {
              return {
                tipo: 'reservado' as const, para: aberto.responsavel_nome,
                ate: aberto.reatribuicao_vence_em ? aberto.reatribuicao_vence_em.toISOString() : null,
              }
            }
            const [tomado] = await tx<{ protocolo: string }[]>`
              UPDATE atendimento
                 SET atendente_id = ${usuarioId}, estado = 'em_atendimento', assumido_em = now(), versao = versao + 1,
                     -- Reatribuição MANTÉM a etapa (e o aging) do card; só a fila ganha etapa.
                     etapa_id = ${livre ? tx`coalesce(${etapa?.id ?? null}::uuid, etapa_id)` : tx`etapa_id`},
                     entrou_etapa_em = ${livre ? tx`now()` : tx`entrou_etapa_em`}
               WHERE tenant_id = tenant_atual() AND id = ${aberto.id} AND estado <> 'encerrado'
                 AND atendente_id IS NOT DISTINCT FROM ${aberto.atendente_id}::uuid
              RETURNING protocolo`
            if (tomado) {
              if (livre && etapa?.id) {
                await tx`UPDATE atendimento_etapa_historico SET saiu_em = now()
                          WHERE tenant_id = tenant_atual() AND atendimento_id = ${aberto.id} AND saiu_em IS NULL`
                await tx`INSERT INTO atendimento_etapa_historico (tenant_id, id, atendimento_id, etapa_id, entrou_em, ator_id)
                         VALUES (tenant_atual(), ${randomUUID()}, ${aberto.id}, ${etapa.id}, now(), ${usuarioId})`
              }
              await emitirEvento(tx, conversaId)
              await auditar(tx, {
                atorId: usuarioId, acao: livre ? 'atendimento.assumido' : 'atendimento.reatribuido', entidade: 'conversa',
                entidadeId: conversaId,
                dados: { protocolo: Number(tomado.protocolo), origem: 'handoff', ...(livre ? {} : { de: aberto.atendente_id }) },
              })
              return { tipo: 'assumido' as const, protocolo: Number(tomado.protocolo), meu: true, atendimentoId: aberto.id }
            }
            // Perdeu a corrida: devolve QUEM ganhou, lido agora — não o estado da 1ª leitura.
            const [agora] = await tx<{ atendente_id: string | null; nome: string | null; protocolo: string }[]>`
              SELECT a.atendente_id, u.nome, a.protocolo FROM atendimento a
                LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
               WHERE a.tenant_id = tenant_atual() AND a.id = ${aberto.id}`
            return {
              tipo: 'ja_aberto' as const, meu: agora?.atendente_id === usuarioId,
              por: agora?.nome ?? null, protocolo: Number(agora?.protocolo ?? aberto.protocolo),
            }
          }
        }
        return {
          tipo: 'ja_aberto' as const,
          meu: aberto?.atendente_id === usuarioId,
          por: aberto?.nome ?? null,
          protocolo: Number(aberto?.protocolo ?? 0),
        }
      })

      if (r.tipo === 'nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      if (r.tipo === 'operador_ausente') return reply.code(409).send(RECUSA_OPERADOR_AUSENTE)
      if (r.tipo === 'etapa_invalida') return reply.code(422).send(ETAPA_INVALIDA)
      if (r.tipo === 'reservado') {
        return reply.code(409).send({
          erro: 'atendimento.reservado', para: r.para, ate: r.ate,
          mensagem: `Este cliente foi direcionado a ${r.para ?? 'outra pessoa'}. Se ninguém responder no prazo, a fila é liberada para todos.`,
        })
      }
      if (r.tipo === 'assumido') return reply.code(201).send({ ok: true, protocolo: r.protocolo, meu: true, atendimentoId: r.atendimentoId })
      // Já aberto: se é meu, 200 ok; se é de outro, 409 tipificado.
      if (r.meu) return reply.code(200).send({ ok: true, protocolo: r.protocolo, meu: true })
      return reply.code(409).send({ erro: 'atendimento.ja_assumido', mensagem: `Em atendimento por ${r.por ?? 'outro atendente'}.`, por: r.por })
    },
  )
}
