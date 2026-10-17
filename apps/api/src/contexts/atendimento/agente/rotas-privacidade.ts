import type { FastifyInstance } from 'fastify'

/**
 * PRIVACIDADE (aviso exibido e texto padrão do tenant) — STUB da raia P4 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P4 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET/PUT /v1/privacidade (admin); GET /v1/contatos/:id/avisos-privacidade (paginado por cursor).
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasPrivacidade(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P4
}
