import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import postgres from 'postgres'
import { aplicarMigrations } from '../src/db/migrations.js'
import {
  BANCO_E2E, META_APP_SECRET, META_VERIFY_TOKEN, PORTA_API, PORTA_ERP, PORTA_META,
  RAIZ_API, RAIZ_REPO, URL_API, URL_ERP, URL_META,
} from './ambiente.js'
import { subirErpFalso, subirMetaFalsa } from './fakes.js'

/**
 * Sobe o ambiente do teste ponta a ponta e o derruba no fim:
 *   1. banco `geracrm_e2e` NOVO (derruba o anterior), migrado, com o papel de app
 *      sem BYPASSRLS (infra/dev/setup-dev.sql) e a semente de demonstração;
 *   2. Meta e GeraCloud/Keycloak FALSOS (HTTP local, gravam o que recebem);
 *   3. a API de verdade — `tsx src/server.ts`, com os workers ligados — num
 *      ambiente ISOLADO (nada do .env do desenvolvedor vaza para dentro).
 */
let api: ChildProcess | undefined
let log: WriteStream | undefined
let arquivoLog = ''
const servidores: Server[] = []

/** Admin URL do ambiente (CI) ou do .env da raiz (local); só a conexão-base importa. */
function urlAdminBase(): URL {
  let bruto = process.env.DATABASE_ADMIN_URL
  if (!bruto) {
    try { process.loadEnvFile(resolve(RAIZ_REPO, '.env')) } catch { /* sem .env */ }
    bruto = process.env.DATABASE_ADMIN_URL
  }
  if (!bruto) throw new Error('DATABASE_ADMIN_URL não definida (nem no ambiente, nem no .env da raiz)')
  return new URL(bruto)
}

function urlDoBanco(base: URL, banco: string, usuario?: { nome: string; senha: string }): string {
  const u = new URL(base.toString())
  u.pathname = `/${banco}`
  if (usuario) { u.username = usuario.nome; u.password = usuario.senha }
  return u.toString()
}

async function prepararBanco(base: URL): Promise<void> {
  const manutencao = postgres(base.toString(), { max: 1, onnotice: () => {} })
  try {
    await manutencao.unsafe(`DROP DATABASE IF EXISTS ${BANCO_E2E} WITH (FORCE)`)
    await manutencao.unsafe(`CREATE DATABASE ${BANCO_E2E}`)
  } finally {
    await manutencao.end()
  }
  const dono = postgres(urlDoBanco(base, BANCO_E2E), { max: 1, onnotice: () => {} })
  try {
    await aplicarMigrations(dono, resolve(RAIZ_REPO, 'infra/migrations'), () => {})
    await dono.file(resolve(RAIZ_REPO, 'infra/dev/setup-dev.sql'))
  } finally {
    await dono.end()
  }
}

function esperar(ms: number): Promise<void> { return new Promise((ok) => setTimeout(ok, ms)) }

function rodar(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, falha) => {
    const p = spawn(cmd, args, { cwd: RAIZ_API, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let saida = ''
    p.stdout.on('data', (c) => { saida += String(c) })
    p.stderr.on('data', (c) => { saida += String(c) })
    p.on('exit', (code) => (code === 0 ? ok() : falha(new Error(`${args.join(' ')} saiu com ${code}\n${saida}`))))
  })
}

export async function setup(): Promise<void> {
  const base = urlAdminBase()
  await prepararBanco(base)

  // Ambiente ISOLADO do processo da API: só o que o teste define.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    PORT: String(PORTA_API),
    DATABASE_ADMIN_URL: urlDoBanco(base, BANCO_E2E),
    DATABASE_URL: urlDoBanco(base, BANCO_E2E, { nome: 'geracrm_api', senha: 'geracrm_dev' }),
    CREDENCIAL_CHAVE: 'chave-e2e-descartavel-com-mais-de-32-caracteres',
    CRYPTO_KEY: 'chave-e2e-descartavel',
    DEV_TENANT_HEADER: 'on',
    DEV_STAFF: 'on',
    IA_PROVEDOR: 'simulado',
    META_APP_SECRET,
    META_VERIFY_TOKEN,
    META_GRAPH_BASE_URL: URL_META,
    GERACLOUD_TOKEN_URL: `${URL_ERP}/token`,
    LOG_LEVEL: 'info',
  }
  // O processo do teste (worker do vitest) herda isto: confere/semeia como dono, no banco e2e.
  process.env.E2E_DATABASE_ADMIN_URL = env.DATABASE_ADMIN_URL
  const tsx = resolve(RAIZ_API, 'node_modules/.bin/tsx')

  await rodar(tsx, ['src/db/seed-demo.ts'], { ...env, SEED_DEMO: 'on' })

  servidores.push(await subirMetaFalsa(PORTA_META), await subirErpFalso(PORTA_ERP))

  arquivoLog = process.env.E2E_LOG ?? resolve(RAIZ_API, 'e2e/api.e2e.log')
  log = createWriteStream(arquivoLog)
  api = spawn(tsx, ['src/server.ts'], { cwd: RAIZ_API, env, stdio: ['ignore', 'pipe', 'pipe'] })
  api.stdout?.pipe(log)
  api.stderr?.pipe(log)
  let saiu: number | null = null
  api.on('exit', (code) => { saiu = code ?? -1 })

  const limite = Date.now() + 90_000
  for (;;) {
    if (saiu !== null) throw new Error(`a API saiu (${saiu}) ao subir. Log:\n${ultimasLinhas()}`)
    try {
      const r = await fetch(`${URL_API}/saude`)
      if (r.ok) break
    } catch { /* ainda subindo */ }
    if (Date.now() > limite) throw new Error(`a API não respondeu em 90 s. Log:\n${ultimasLinhas()}`)
    await esperar(300)
  }
  console.log(`e2e: API no ar em ${URL_API} (log: ${arquivoLog})`)
}

function ultimasLinhas(n = 60): string {
  try { return readFileSync(arquivoLog, 'utf8').split('\n').slice(-n).join('\n') } catch { return '(sem log)' }
}

export async function teardown(): Promise<void> {
  if (api && api.exitCode === null) {
    api.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((ok) => api!.once('exit', () => ok())),
      esperar(10_000).then(() => { api?.kill('SIGKILL') }),
    ])
  }
  log?.end()
  await Promise.all(servidores.map((s) => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()) })))
  if (process.env.E2E_MANTER === '1') {
    console.log(`e2e: banco ${BANCO_E2E} mantido (E2E_MANTER=1); log da API em ${arquivoLog}`)
    return
  }
  const manutencao = postgres(urlAdminBase().toString(), { max: 1, onnotice: () => {} })
  try { await manutencao.unsafe(`DROP DATABASE IF EXISTS ${BANCO_E2E} WITH (FORCE)`) } finally { await manutencao.end() }
}
