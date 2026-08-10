import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'

/**
 * Mapa de Clientes — distribuição geográfica pelo ENDEREÇO DECLARADO (sem
 * geocoding). ⚠️ Honesto por desenho: não é um mapa com pino; é a base agrupada
 * por UF e cidade, mais um balde "sem endereço" — que a tela nomeia, em vez de
 * fingir cobertura. Quando houver geocoding, isto vira a camada de dados do mapa.
 *
 * Usa o endereço PRINCIPAL de cada contato (ou o de menor seq), um por contato.
 */
export async function rotasMapa(app: FastifyInstance): Promise<void> {
  app.get('/v1/mapa', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      // Um endereço por contato: o principal; senão o de menor seq.
      const base = tx`
        SELECT c.id AS contato_id,
               (SELECT e.uf FROM contato_endereco e
                 WHERE e.tenant_id = c.tenant_id AND e.contato_id = c.id
                 ORDER BY e.principal DESC, e.seq ASC LIMIT 1) AS uf,
               (SELECT e.cidade FROM contato_endereco e
                 WHERE e.tenant_id = c.tenant_id AND e.contato_id = c.id
                 ORDER BY e.principal DESC, e.seq ASC LIMIT 1) AS cidade
          FROM contato c
         WHERE c.tenant_id = tenant_atual() AND c.ativo`

      const [tot] = await tx<{ total: number; sem: number }[]>`
        WITH b AS (${base})
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE uf IS NULL AND cidade IS NULL)::int AS sem
          FROM b`

      const porEstado = await tx<{ uf: string; contatos: number }[]>`
        WITH b AS (${base})
        SELECT uf, count(*)::int AS contatos FROM b WHERE uf IS NOT NULL
         GROUP BY uf ORDER BY count(*) DESC, uf ASC LIMIT 30`

      const porCidade = await tx<{ cidade: string; uf: string | null; contatos: number }[]>`
        WITH b AS (${base})
        SELECT cidade, max(uf) AS uf, count(*)::int AS contatos FROM b WHERE cidade IS NOT NULL
         GROUP BY cidade ORDER BY count(*) DESC, cidade ASC LIMIT 15`

      return { tot, porEstado, porCidade }
    })

    return reply.send({
      total: dados.tot?.total ?? 0,
      semEndereco: dados.tot?.sem ?? 0,
      porEstado: dados.porEstado.map((e) => ({ uf: e.uf, contatos: e.contatos })),
      porCidade: dados.porCidade.map((c) => ({ cidade: c.cidade, uf: c.uf, contatos: c.contatos })),
    })
  })
}
