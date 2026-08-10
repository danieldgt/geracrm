import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // Carrega o .env da raiz antes dos testes — ver o porquê em vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
})
