import { fileURLToPath } from 'node:url'

/**
 * Constantes do ambiente e2e. ⚠️ Banco, portas e segredos são TODOS locais e
 * descartáveis — nenhum segredo real, nenhuma rede externa.
 */
export const RAIZ_API = fileURLToPath(new URL('..', import.meta.url))
export const RAIZ_REPO = fileURLToPath(new URL('../../..', import.meta.url))

export const BANCO_E2E = process.env.E2E_BANCO ?? 'geracrm_e2e'
const BASE = Number(process.env.E2E_PORTA_BASE ?? 39100)
export const PORTA_API = BASE
export const PORTA_META = BASE + 1
export const PORTA_ERP = BASE + 2

export const URL_API = `http://127.0.0.1:${PORTA_API}`
export const URL_META = `http://127.0.0.1:${PORTA_META}`
export const URL_ERP = `http://127.0.0.1:${PORTA_ERP}`

export const META_APP_SECRET = 'app-secret-e2e-descartavel'
export const META_VERIFY_TOKEN = 'verify-e2e'

/** O tenant da semente de demonstração (`src/db/seed-demo.ts`). */
export const TENANT = '7d3e0000-0000-4000-8000-000000000001'
