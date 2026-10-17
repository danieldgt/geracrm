import type { FastifyInstance } from 'fastify'

/**
 * SLA DO HANDOFF (fatia de INB-22) — STUB da raia P18 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P18 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: configuração `atendimento_sla_config` e leitura do cronômetro da fila.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasSla(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P18
}
