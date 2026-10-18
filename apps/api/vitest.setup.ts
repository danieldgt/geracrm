import { fileURLToPath } from 'node:url'

/**
 * ⚠️ Carrega o .env da raiz do monorepo antes de qualquer teste.
 *
 * Sem isto, `vitest run` conecta com o usuário do sistema em vez do papel do
 * banco, e o erro é "password authentication failed for user <seu login>" —
 * que não se parece em nada com "faltou variável de ambiente" e faz perder
 * tempo procurando problema de permissão no Postgres.
 */
const env = fileURLToPath(new URL('../../.env', import.meta.url))

try {
  process.loadEnvFile(env)
} catch {
  // Em CI as variáveis vêm do ambiente; ausência do arquivo não é erro.
}

// ⚠️ Os testes de rota mandam `x-tenant-id`; isso só vale com o bypass de
//    desenvolvimento ligado. Localmente vem do .env; no CI não há .env e sem
//    isto todo POST/GET autenticado responde 401 — que não parece "faltou
//    variável". Nunca em produção: o plugin ignora o header fora de dev/test.
process.env.DEV_TENANT_HEADER ??= 'on'
// ⚠️ O modelo SIMULADO nos testes: ligar o agente exige um provedor de IA
//    configurado, e nenhum teste pode chamar fornecedor de verdade (skill
//    geracrm-ia). Quem precisar do Claude/OpenRouter falso ajusta no próprio arquivo.
process.env.IA_PROVEDOR ??= 'simulado'

// ⚠️ P0e — DESVIO DE RELÓGIO de propósito, para provar que a suíte não depende de o relógio do
//    processo bater com o do Postgres nem da hora do dia. O Docker no macOS deixa o relógio do
//    contêiner MINUTOS atrás do host depois de uma suspensão (medido: 15 min) — foi a causa das
//    falhas em grupo da P0e. `GERACRM_TESTE_DESVIO_RELOGIO_MIN=-30` faz o processo viver 30 min
//    ATRÁS do banco; `=600`, 10 h à frente. Só o `Date` global muda (`new Date()` e `Date.now()`);
//    timers seguem reais. Sem a variável, nada é tocado.
const desvioMin = Number(process.env.GERACRM_TESTE_DESVIO_RELOGIO_MIN ?? 0)
if (Number.isFinite(desvioMin) && desvioMin !== 0) {
  const Real = Date
  const desvioMs = desvioMin * 60_000
  class DateDesviado extends Real {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(Real.now() + desvioMs)
      else super(...(a as [number]))
    }
    static override now(): number { return Real.now() + desvioMs }
  }
  globalThis.Date = DateDesviado as DateConstructor
}
