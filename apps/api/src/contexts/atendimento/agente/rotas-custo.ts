import type { FastifyInstance } from 'fastify'

/**
 * CUSTO E TETOS DO AGENTE — STUB da raia P6 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P6 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET/PUT /v1/agente/orcamento (mensal do tenant, alertas 80/100%); GET/PUT /v1/canais/:id/agente/custo (teto por sessão).
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasCusto(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P6
}
