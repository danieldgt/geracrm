import type { FastifyInstance } from 'fastify'

/**
 * SAÚDE DETALHADA EM TRÊS ESTADOS — STUB da raia P8 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P8 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: GET /saude/detalhada — PÚBLICO e sem dado de tenant → {status, motivos[], componentes{...}}; 503 só encerrando, degradado (200) para dependências. Lê `batimentos()` (plataforma/batimento.ts) e `estadoDoLlm()` (agente/llm-estado.ts). O /saude e o /pronto do app.ts ficam como estão (healthcheck do Railway).
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasSaudeDetalhada(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P8
}
