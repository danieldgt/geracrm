import type { FastifyInstance } from 'fastify'

/**
 * PAINEL E CRITÉRIO DE FASE (go-live) — STUB da raia P19 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P19 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET /v1/agente/go-live?canalId → {fase, dias, criterios[{id, alvo, valor, ok}], podeAvancar}.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasGoLive(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P19
}
