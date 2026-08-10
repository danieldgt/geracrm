import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

/**
 * Retenção — o funil de recompra (ciclo de vida). Distribui a base em
 * Ativo/Inativo/Perdido/Sem compra, com a fronteira POR DIAS configurável.
 *
 * ⚠️ Classifica a partir das colunas denormalizadas e VIVAS de `contato`
 * (qtd_vendas, ultima_venda_em, total_vendas_centavos), atualizadas a cada
 * venda — não da MV de métricas, cujo `dias_sem_comprar` congela no refresh.
 *
 * ⚠️ Este é o ciclo de vida ABSOLUTO (dias sem comprar), decisão do dono do
 * negócio — distinto do RFV, que compara com a média do próprio cliente. Os dois
 * coexistem (funil-de-vendas): aqui o operador escolhe a fronteira.
 */
const DEFAULT_ATIVO = 30
const DEFAULT_INATIVO = 90

const ESTADOS = ['ativo', 'inativo', 'perdido', 'sem_compra'] as const

export async function rotasRetencao(app: FastifyInstance): Promise<void> {
  app.get('/v1/retencao', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      const [cfg] = await tx<{ dias_ativo: number; dias_inativo: number }[]>`
        SELECT dias_ativo, dias_inativo FROM retencao_config WHERE tenant_id = tenant_atual()`
      const diasAtivo = cfg?.dias_ativo ?? DEFAULT_ATIVO
      const diasInativo = cfg?.dias_inativo ?? DEFAULT_INATIVO

      const linhas = await tx<{ estado: string; contatos: number; receita: string }[]>`
        SELECT estado, count(*)::int AS contatos, sum(total)::text AS receita FROM (
          SELECT
            CASE
              WHEN c.qtd_vendas = 0 OR c.ultima_venda_em IS NULL THEN 'sem_compra'
              WHEN (now()::date - c.ultima_venda_em::date) <= ${diasAtivo}   THEN 'ativo'
              WHEN (now()::date - c.ultima_venda_em::date) <= ${diasInativo} THEN 'inativo'
              ELSE 'perdido'
            END AS estado,
            c.total_vendas_centavos AS total
          FROM contato c
          WHERE c.tenant_id = tenant_atual()
        ) t GROUP BY estado`

      return { diasAtivo, diasInativo, linhas }
    })

    const porEstado = new Map(dados.linhas.map((l) => [l.estado, l]))
    const buckets = ESTADOS.map((estado) => {
      const l = porEstado.get(estado)
      return { estado, contatos: l ? l.contatos : 0, receitaCentavos: l ? Number(l.receita) : 0 }
    })
    const totalContatos = buckets.reduce((s, b) => s + b.contatos, 0)
    return reply.send({
      config: { diasAtivo: dados.diasAtivo, diasInativo: dados.diasInativo },
      buckets,
      totalContatos,
    })
  })

  // Ajustar a fronteira do ciclo de vida (decisão do dono do negócio).
  app.put<{ Body: { diasAtivo?: number; diasInativo?: number } }>(
    '/v1/retencao/config', { preHandler: exigirTenant },
    async (req, reply) => {
      const diasAtivo = req.body?.diasAtivo
      const diasInativo = req.body?.diasInativo
      if (!Number.isInteger(diasAtivo) || !Number.isInteger(diasInativo) || diasAtivo! <= 0 || diasInativo! <= diasAtivo!) {
        return reply.code(422).send({
          erro: 'retencao.faixas_invalidas',
          mensagem: 'Informe dias (inteiros) com Ativo > 0 e Inativo maior que Ativo.',
        })
      }
      await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        await tx`
          INSERT INTO retencao_config (tenant_id, dias_ativo, dias_inativo, atualizado_por)
          VALUES (tenant_atual(), ${diasAtivo!}, ${diasInativo!}, ${eu})
          ON CONFLICT (tenant_id)
          DO UPDATE SET dias_ativo = EXCLUDED.dias_ativo, dias_inativo = EXCLUDED.dias_inativo,
                        atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`
      })
      return reply.send({ ok: true, config: { diasAtivo, diasInativo } })
    },
  )
}
