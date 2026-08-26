import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../../plugins/tenant.js'
import { faltaParaLlm } from './fabrica.js'

/**
 * A superfície do AGENTE SDR: ligar/desligar, escrever as políticas, e ver o que
 * o robô falou com os clientes.
 *
 * ⚠️ O painel de auditoria não é enfeite — é o invariante 6 do escopo. Sem ele,
 * "o que o robô disse para o meu cliente?" só teria resposta no log do
 * fornecedor de IA, que ninguém do time do cliente vai abrir.
 */

const PAGINA = 20

export async function rotasAgente(app: FastifyInstance): Promise<void> {
  /** Configuração do agente naquele número. */
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const [cfg] = await req.comTenant((tx) => tx<{
        ativo: boolean; politicas: string | null; max_turnos: number
      }[]>`
        SELECT ativo, politicas, max_turnos FROM agente_config
         WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`)

      return reply.send({
        ativo: cfg?.ativo ?? false,
        politicas: cfg?.politicas ?? '',
        maxTurnos: cfg?.max_turnos ?? 6,
        // ⚠️ A tela precisa dizer o NOME da variável que falta, não "IA
        //    indisponível": erro genérico manda abrir chamado, nome manda
        //    resolver.
        faltaConfigurar: faltaParaLlm(),
      })
    },
  )

  app.put<{ Params: { id: string }; Body: { ativo?: boolean; politicas?: string; maxTurnos?: number } }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const politicas = req.body?.politicas?.trim() ?? ''
      const ativo = req.body?.ativo === true
      const maxTurnos = Number(req.body?.maxTurnos ?? 6)

      if (!Number.isInteger(maxTurnos) || maxTurnos < 1 || maxTurnos > 20) {
        return reply.code(422).send({ erro: 'agente.turnos_invalidos', mensagem: 'Entre 1 e 20 idas e vindas.' })
      }
      // ⚠️ Falha de negócio é retorno TIPIFICADO com ação corretiva, não erro de
      //    banco vazando para a tela. O CHECK do 0071 é a rede de segurança;
      //    esta é a mensagem que a pessoa lê.
      if (ativo && !politicas) {
        return reply.code(422).send({
          erro: 'agente.sem_politicas',
          mensagem: 'Escreva as políticas da loja antes de ligar o agente — sem elas ele responde "não sei" a tudo.',
        })
      }
      if (ativo && faltaParaLlm().length > 0) {
        return reply.code(422).send({
          erro: 'agente.sem_chave',
          mensagem: `Falta configurar ${faltaParaLlm().join(', ')} no servidor.`,
        })
      }

      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`
          SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        await tx`
          INSERT INTO agente_config (tenant_id, canal_id, ativo, politicas, max_turnos, atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${ativo}, ${politicas || null}, ${maxTurnos}, now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            ativo = EXCLUDED.ativo, politicas = EXCLUDED.politicas,
            max_turnos = EXCLUDED.max_turnos, atualizado_em = now()`
        return canal
      })
      if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /**
   * O que o agente conduziu — a entrega ao humano.
   *
   * ⚠️ Paginado por CURSOR, como toda lista do produto: `top-N` cru e OFFSET
   * profundo já derrubaram um Postgres desta casa em horário comercial.
   */
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/agente/sessoes', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }

      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; contato: string | null
        estado: string; turnos: number; motivo_saida: string | null
        iniciada_em: Date; encerrada_em: Date | null
        extraido: Record<string, unknown>; descartados: unknown[]
        tokens_entrada: number; tokens_saida: number
      }[]>`
        SELECT s.id, s.conversa_id, ct.nome AS contato, s.estado, s.turnos, s.motivo_saida,
               s.iniciada_em, s.encerrada_em, s.extraido, s.descartados,
               s.tokens_entrada, s.tokens_saida
          FROM agente_sessao s
          JOIN conversa cv ON cv.tenant_id = s.tenant_id AND cv.id = s.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE s.tenant_id = tenant_atual()
           AND ${curEm === null ? tx`true` : tx`(s.iniciada_em, s.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY s.iniciada_em DESC, s.id DESC LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, conversaId: l.conversa_id, contato: l.contato,
          estado: l.estado, turnos: l.turnos, motivoSaida: l.motivo_saida,
          iniciadaEm: l.iniciada_em, encerradaEm: l.encerrada_em,
          extraido: l.extraido, descartados: l.descartados,
          // ⚠️ O custo aparece por sessão, na tela de quem paga a conta.
          tokens: l.tokens_entrada + l.tokens_saida,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.iniciada_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )
}
