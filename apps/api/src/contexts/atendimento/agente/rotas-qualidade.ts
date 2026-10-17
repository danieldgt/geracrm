import type { FastifyInstance } from 'fastify'

/**
 * QUALIDADE EM PRODUÇÃO — STUB da raia P12 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P12 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET /v1/agente/qualidade (cursor), /resumo, /amostra-semanal.csv (mascarado), POST /avaliar.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasQualidade(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P12
}
