import { defineConfig } from 'vitest/config'

/**
 * Config do teste ponta a ponta — separada da suíte unitária de propósito: aqui o
 * servidor é um PROCESSO de verdade (e2e/global-setup.ts), não `app.inject`.
 * Sem `setupFiles` do .env (o ambiente do processo é montado à mão, isolado) e
 * sem a guarda de servidor-no-banco da suíte unitária (o banco é `geracrm_e2e`).
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    globalSetup: ['./e2e/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
