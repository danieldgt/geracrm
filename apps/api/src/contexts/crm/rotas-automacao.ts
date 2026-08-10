import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { executarAutomacoesDoTenant } from './automacao-motor.js'

const GATILHOS = new Set(['rfv_segmento', 'dias_sem_comprar', 'lead_frio', 'nps_detrator'])
const ACOES = new Set(['criar_tarefa', 'aplicar_sequencia', 'adicionar_lista'])

/**
 * Automações (CRUD + "rodar agora"). Motor = varredura agendada, ações internas
 * (ver automacao-motor.ts e docs/automacoes.md). O CRUD roda sob RLS; o "rodar
 * agora" chama o motor em modo dono, isolado pelo tid explícito do token.
 */
export async function rotasAutomacao(app: FastifyInstance): Promise<void> {
  app.get('/v1/automacoes', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      id: string; nome: string; ativa: boolean; gatilho: string; gatilho_param: Record<string, unknown>
      acao: string; acao_param: Record<string, unknown>; ultima_execucao_em: Date | null; execucoes: number
    }[]>`
      SELECT a.id, a.nome, a.ativa, a.gatilho, a.gatilho_param, a.acao, a.acao_param, a.ultima_execucao_em,
             (SELECT count(*)::int FROM automacao_execucao e WHERE e.tenant_id = a.tenant_id AND e.automacao_id = a.id) AS execucoes
        FROM automacao a WHERE a.tenant_id = tenant_atual()
       ORDER BY a.ativa DESC, a.nome ASC LIMIT 200`)
    return reply.send({
      itens: linhas.map((l) => ({
        id: l.id, nome: l.nome, ativa: l.ativa, gatilho: l.gatilho, gatilhoParam: l.gatilho_param,
        acao: l.acao, acaoParam: l.acao_param, ultimaExecucaoEm: l.ultima_execucao_em, execucoes: l.execucoes,
      })),
    })
  })

  app.post<{ Body: { nome?: string; gatilho?: string; gatilhoParam?: object; acao?: string; acaoParam?: object } }>(
    '/v1/automacoes', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const nome = b.nome?.trim()
      if (!nome) return reply.code(422).send({ erro: 'automacao.nome_obrigatorio', mensagem: 'Dê um nome à automação.' })
      if (!GATILHOS.has(b.gatilho ?? '')) return reply.code(422).send({ erro: 'automacao.gatilho_invalido' })
      if (!ACOES.has(b.acao ?? '')) return reply.code(422).send({ erro: 'automacao.acao_invalida' })
      const id = randomUUID()
      try {
        await req.comTenant(async (tx) => {
          // Ação referencia sequência/lista? Confere existência para não nascer regra pendurada.
          if (b.acao === 'aplicar_sequencia') {
            const sid = (b.acaoParam as { sequenciaId?: string })?.sequenciaId
            const [ok] = await tx`SELECT 1 FROM sequencia WHERE tenant_id = tenant_atual() AND id = ${sid ?? null}`
            if (!ok) throw new ErroRef('sequencia')
          }
          if (b.acao === 'adicionar_lista') {
            const lid = (b.acaoParam as { listaId?: string })?.listaId
            const [ok] = await tx`SELECT 1 FROM lista WHERE tenant_id = tenant_atual() AND id = ${lid ?? null}`
            if (!ok) throw new ErroRef('lista')
          }
          const eu = await garantirUsuarioId(tx, req)
          await tx`INSERT INTO automacao (tenant_id, id, nome, gatilho, gatilho_param, acao, acao_param, criado_por)
                   VALUES (tenant_atual(), ${id}, ${nome}, ${b.gatilho!}, ${JSON.stringify(b.gatilhoParam ?? {})}::text::jsonb,
                           ${b.acao!}, ${JSON.stringify(b.acaoParam ?? {})}::text::jsonb, ${eu})`
        })
        return reply.code(201).send({ id })
      } catch (e) {
        if (e instanceof ErroRef) return reply.code(422).send({ erro: `automacao.${e.tipo}_invalida`, mensagem: `A ${e.tipo} escolhida não existe.` })
        throw e
      }
    },
  )

  app.patch<{ Params: { id: string }; Body: { ativa?: boolean; nome?: string } }>(
    '/v1/automacoes/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        UPDATE automacao SET
           ativa = COALESCE(${req.body?.ativa ?? null}, ativa),
           nome  = COALESCE(${req.body?.nome?.trim() ?? null}, nome)
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'automacao.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/automacoes/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        DELETE FROM automacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'automacao.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  // Rodar agora (não espera o ciclo). Motor em modo dono, isolado pelo tid do token.
  app.post('/v1/automacoes/executar', { preHandler: exigirTenant }, async (req, reply) => {
    const acoes = await executarAutomacoesDoTenant(req.tenantId!, new Date())
    return reply.send({ ok: true, acoesExecutadas: acoes })
  })
}

class ErroRef extends Error {
  constructor(readonly tipo: 'sequencia' | 'lista') { super(tipo) }
}
