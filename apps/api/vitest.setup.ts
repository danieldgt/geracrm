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
