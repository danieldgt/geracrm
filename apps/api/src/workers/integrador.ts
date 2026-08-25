import { createServer } from 'node:http'
import { rodarScript } from './rodar-script.js'

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
 *
 * ⚠️ **E ele responde `/saude`**, apesar de não ser um servidor. O `railway.json`
 * da raiz é COMPARTILHADO pelos três serviços e declara `healthcheckPath`; um
 * worker que não responde reprova no healthcheck e o deploy FALHA — foi
 * exatamente o que aconteceu na primeira subida depois que o healthcheck entrou.
 *
 * A alternativa seria uma exceção por serviço no painel. Responder liveness é
 * melhor: além de destravar o deploy, dá ao worker o mesmo auto-restart que a API
 * tem — worker pendurado é indistinguível de worker ocioso, e ninguém percebe.
 */
const INTERVALO_HORAS = Number(process.env.INTERVALO_HORAS ?? 6) || 6
const INTERVALO_MS = INTERVALO_HORAS * 3_600_000
const DIR = '/app/apps/api'

// Ordem importa: preços dependem dos produtos que a carga trouxe.
const SCRIPTS = [
  'dist/contexts/integracao/geracloud-carregar.js',
  'dist/contexts/integracao/geracloud-precos.js',
]

/**
 * ⚠️ A saída do script sai AO VIVO (ver `rodar-script.ts`). A carga histórica
 * leva horas: com o log preso até o fim, "rodando" e "travado" ficam com a mesma
 * cara — e é justamente durante a carga longa que alguém precisa saber em qual
 * etapa ela está.
 */
async function rodar(rel: string): Promise<void> {
  const inicio = Date.now()
  console.log(`[integrador] iniciando ${rel}`)
  const r = await rodarScript('node', [rel], { cwd: DIR, env: process.env })
  const minutos = ((Date.now() - inicio) / 60000).toFixed(1)
  if (r.ok) {
    console.log(`[integrador] concluído ${rel} em ${minutos} min`)
  } else {
    console.error(
      `[integrador] ✗ FALHOU ${rel} depois de ${minutos} min `
      + `(código ${r.codigo ?? '—'}${r.sinal ? `, sinal ${r.sinal}` : ''})`)
  }
}

async function ciclo(): Promise<void> {
  const inicio = new Date().toISOString()
  console.log(`[integrador] === ciclo ${inicio} (a cada ${INTERVALO_HORAS}h) ===`)
  for (const s of SCRIPTS) await rodar(s)
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

/**
 * Liveness. ⚠️ Não toca no banco nem espera o ciclo: a pergunta é "este processo
 * ainda responde?". Amarrar a saúde ao ciclo faria o healthcheck reprovar
 * durante uma carga longa — e o Railway reiniciaria o worker no meio do trabalho.
 */
const porta = Number(process.env.PORT ?? 8080)
createServer((req, res) => {
  if (req.url === '/saude') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, papel: 'integrador', ciclo: rodando ? 'rodando' : 'ocioso' }))
    return
  }
  res.writeHead(404).end()
}).listen(porta, () => console.log(`[integrador] liveness em :${porta}/saude`))

// Um ciclo agora e, depois, no intervalo. O setInterval mantém o processo vivo.
await cicloGuardado()
setInterval(() => void cicloGuardado(), INTERVALO_MS)
console.log(`[integrador] agendado: próximo ciclo em ${INTERVALO_HORAS}h`)
