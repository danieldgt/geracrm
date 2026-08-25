import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Worker do INTEGRADOR GeraCloud.
 *
 * ⚠️ Não reescreve a ingestão: reusa os scripts JÁ PROVADOS (carregar + preços)
 * como subprocessos. Eles autenticam no Keycloak, garantem tenant/conexão e
 * ingerem clientes→produtos→vendas + preços, rodando como DONO do banco com o
 * tenant explícito (ADR-015). Aqui só orquestramos o AGENDAMENTO: um ciclo no
 * boot e a cada `INTERVALO_HORAS`.
 *
 * ⚠️ Um script que falha NÃO derruba o worker nem o próximo ciclo — o erro é
 * logado e a agenda continua. Integração degrada, não quebra.
 */
const exec = promisify(execFile)

const INTERVALO_HORAS = Number(process.env.INTERVALO_HORAS ?? 6) || 6
const INTERVALO_MS = INTERVALO_HORAS * 3_600_000
const DIR = '/app/apps/api'

// Ordem importa: preços dependem dos produtos que a carga trouxe.
const SCRIPTS = [
  'dist/contexts/integracao/geracloud-carregar.js',
  'dist/contexts/integracao/geracloud-precos.js',
]

async function rodarScript(rel: string): Promise<void> {
  console.log(`[integrador] iniciando ${rel}`)
  try {
    const { stdout, stderr } = await exec('node', [rel], {
      cwd: DIR,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    console.log(`[integrador] concluído ${rel}`)
  } catch (erro) {
    // execFile rejeita em exit != 0 — captura stdout/stderr do processo filho.
    const e = erro as { message?: string; stdout?: string; stderr?: string }
    if (e.stdout) process.stdout.write(e.stdout)
    if (e.stderr) process.stderr.write(e.stderr)
    console.error(`[integrador] ✗ FALHOU ${rel}: ${e.message ?? String(erro)}`)
  }
}

async function ciclo(): Promise<void> {
  const inicio = new Date().toISOString()
  console.log(`[integrador] === ciclo ${inicio} (a cada ${INTERVALO_HORAS}h) ===`)
  for (const s of SCRIPTS) await rodarScript(s)
  console.log('[integrador] === ciclo concluído ===')
}

/**
 * ⚠️ GUARDA ANTI-SOBREPOSIÇÃO. A primeira carga é HISTÓRICA (base inteira, sem
 * teto de páginas) e pode passar das 6 horas do intervalo. Sem esta guarda, o
 * `setInterval` dispararia um segundo ciclo por cima do primeiro: dois processos
 * pedindo as mesmas páginas ao ERP e disputando os mesmos upserts.
 *
 * Pular um ciclo é o comportamento certo — o próximo vem em 6h, e a ingestão é
 * idempotente.
 */
let rodando = false
async function cicloGuardado(): Promise<void> {
  if (rodando) {
    console.log('[integrador] ciclo anterior ainda rodando — pulando este')
    return
  }
  rodando = true
  try { await ciclo() } finally { rodando = false }
}

// Um ciclo agora e, depois, no intervalo. O setInterval mantém o processo vivo.
await cicloGuardado()
setInterval(() => void cicloGuardado(), INTERVALO_MS)
console.log(`[integrador] agendado: próximo ciclo em ${INTERVALO_HORAS}h`)
