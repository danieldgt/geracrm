import type { FastifyInstance } from 'fastify'

/**
 * MENSAGENS ATIVAS DO AGENTE (limites, suspensão por qualidade do número, template fora de 24h) — STUB da raia P11 (docs/plano-port-playbook-am.md).
 *
 * Já registrado em `app.ts` pela raia P0: a raia P11 declara as rotas AQUI,
 * sem tocar no `app.ts`.
 *
 * Contrato: configuração de `agente_config.ativas` ({limiteDia, limiteSemana, templateRetorno}) e leitura da suspensão do canal.
 *
 * ⚠️ Enquanto stub: não registra rota nenhuma.
 */
export async function rotasAtivas(_app: FastifyInstance): Promise<void> {
  // stub — preenchido pela raia P11
}
