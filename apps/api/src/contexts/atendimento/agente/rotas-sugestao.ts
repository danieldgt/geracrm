import type { FastifyInstance } from 'fastify'

/**
 * SUGESTÃO DO ASSISTIDO E COPILOTO — STUB da raia P13 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P13 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET /v1/conversas/:id/sugestao; POST /v1/conversas/:id/sugestao/gerar (copiloto: `conduzirTurnoVendedor(..., { copiloto: true })`, 20 s, 502 copiloto.indisponivel); POST /v1/agente/sugestoes/:decisaoId/descartar; GET /v1/agente/sugestoes/metricas.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasSugestao(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P13
}
