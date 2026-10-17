import type { FastifyInstance } from 'fastify'

/**
 * COMPLIANCE DO AGENTE (frases proibidas e gatilhos de handoff do canal) — STUB da raia P2 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P2 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET/PUT /v1/canais/:id/agente/compliance — admin grava (`exigirPapel('admin')`, plataforma/papel.ts), com auditoria; extras só ACRESCENTAM à base.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasCompliance(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P2
}
