// Monitor de saúde do GeraCRM — uma execução = uma rodada de checagens, e sai.
// Pensado para um cron service do Railway a cada 5 min (`*/5 * * * *`). JavaScript ESM puro,
// Node 22, sem dependência. Veja README.md.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DIAS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 }
const CICLO_MIN = 5

/** "seg-sex 08-18" | "seg-sab 08:30-17:30" → { dias:Set<number>, ini:min, fim:min }. */
export function lerHorario(texto = 'seg-sex 08-18') {
  const m = /^\s*([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?\s*$/i.exec(texto)
  if (!m) throw new Error(`HORARIO_COMERCIAL inválido: "${texto}" (use ex.: "seg-sex 08-18")`)
  const a = DIAS[m[1].toLowerCase()]
  const b = DIAS[(m[2] ?? m[1]).toLowerCase()]
  if (a === undefined || b === undefined) throw new Error(`HORARIO_COMERCIAL com dia inválido: "${texto}"`)
  const dias = new Set()
  for (let d = a; ; d = (d + 1) % 7) { dias.add(d); if (d === b) break }
  const ini = Number(m[3]) * 60 + Number(m[4] ?? 0)
  const fim = Number(m[5]) * 60 + Number(m[6] ?? 0)
  if (fim <= ini) throw new Error(`HORARIO_COMERCIAL: fim deve ser depois do início: "${texto}"`)
  return { dias, ini, fim }
}

/** Dia da semana (0=dom) e minuto do dia no fuso `tz`. */
export function relogioLocal(data, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(data).map((x) => [x.type, x.value]))
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday]
  return { dia, minuto: Number(p.hour) * 60 + Number(p.minute) }
}

/** FNV-1a 32 bits: só espalha motivos pelas fatias de tempo; não é segurança. */
export function hash(texto) {
  let h = 0x811c9dc5
  for (const c of texto) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}

function configuracao(env) {
  const num = (v, pad) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : pad)
  return {
    apiUrl: (env.API_URL ?? '').replace(/\/+$/, ''),
    consoleUrl: (env.CONSOLE_URL ?? '').replace(/\/+$/, ''),
    slack: env.SLACK_WEBHOOK_URL || '',
    discord: env.DISCORD_WEBHOOK_URL || '',
    heartbeat: env.HEARTBEAT_URL || '',
    webhookParadoMin: num(env.WEBHOOK_PARADO_MIN, 30),
    repetirMin: num(env.REPETIR_MIN, 60),
    horario: lerHorario(env.HORARIO_COMERCIAL || undefined),
    tz: env.TZ || 'America/Fortaleza',
    estadoArquivo: env.ESTADO_ARQUIVO || '',
    timeoutMs: num(env.TIMEOUT_SEG, 10) * 1000,
    ambiente: env.AMBIENTE || env.RAILWAY_ENVIRONMENT_NAME || 'producao',
  }
}

async function buscar(fetchFn, url, timeoutMs) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
  return { status: r.status, texto: await r.text() }
}

/** Coleta os problemas do ciclo: [{ chave, texto }]. Falha de um passo não impede os outros. */
export async function checar(cfg, fetchFn, agora) {
  const problemas = []
  if (cfg.apiUrl) {
    const url = `${cfg.apiUrl}/saude/detalhada`
    let corpo = null
    try {
      const r = await buscar(fetchFn, url, cfg.timeoutMs)
      try { corpo = JSON.parse(r.texto) } catch { /* corpo não-JSON */ }
      if (!corpo || typeof corpo.status !== 'string') {
        problemas.push({ chave: 'api_resposta_invalida', texto: `API respondeu HTTP ${r.status} sem um corpo de saúde válido (${url})` })
        corpo = null
      }
    } catch {
      problemas.push({ chave: 'api_fora', texto: `API sem resposta em ${url} (rede, timeout ou fora do ar)` })
    }
    if (corpo) {
      const motivos = Array.isArray(corpo.motivos) ? corpo.motivos.map(String) : []
      if (corpo.status === 'erro') {
        problemas.push({ chave: 'api_erro', texto: `API em ERRO (processo encerrando): ${motivos.join(', ') || 'sem motivo'} (${url})` })
      } else if (corpo.status !== 'ok') {
        for (const m of motivos.length ? motivos : ['sem_motivo']) {
          problemas.push({ chave: `saude:${m}`, texto: `API degradada: ${m} — ver runbook do agente (${url})` })
        }
      }
      const p = webhookParado(cfg, corpo.componentes?.entrada, agora)
      if (p) problemas.push(p)
    }
  }
  if (cfg.consoleUrl) {
    try {
      const r = await buscar(fetchFn, `${cfg.consoleUrl}/`, cfg.timeoutMs)
      if (r.status !== 200) problemas.push({ chave: 'console_fora', texto: `Console respondeu HTTP ${r.status} em ${cfg.consoleUrl}/ (esperado 200)` })
    } catch {
      problemas.push({ chave: 'console_fora', texto: `Console sem resposta em ${cfg.consoleUrl}/ (rede, timeout ou fora do ar)` })
    }
  }
  return problemas
}

/**
 * Webhook parado: nenhuma mensagem de entrada há mais de WEBHOOK_PARADO_MIN minutos DENTRO do
 * horário comercial. O silêncio só conta a partir da abertura do expediente (segunda 08:10 com a
 * última mensagem de sexta não é webhook parado). Sem leitura (`lido:false`) não alerta.
 */
export function webhookParado(cfg, entrada, agora) {
  if (!entrada || entrada.lido !== true) return null
  const { dia, minuto } = relogioLocal(agora, cfg.tz)
  const { dias, ini, fim } = cfg.horario
  if (!dias.has(dia) || minuto < ini || minuto >= fim) return null
  const desdeAbertura = minuto - ini
  const ultima = entrada.ultimaMensagemEntradaEm ? Date.parse(entrada.ultimaMensagemEntradaEm) : NaN
  const desdeUltima = Number.isFinite(ultima) ? (agora.getTime() - ultima) / 60_000 : Infinity
  const silencio = Math.min(desdeUltima, desdeAbertura)
  if (silencio <= cfg.webhookParadoMin) return null
  const quanto = Number.isFinite(desdeUltima) ? `há ${Math.floor(desdeUltima)} min` : 'nas últimas 48 h'
  return {
    chave: 'webhook_parado',
    texto: `Webhook parado: nenhuma mensagem de entrada ${quanto}, em horário comercial (limite ${cfg.webhookParadoMin} min). Confira a Meta/PlugZapi — runbook §11`,
  }
}

/** Estado persistido (arquivo opcional): { [chave]: epochMsDoUltimoAviso }. */
export function estadoEmArquivo(caminho) {
  return {
    async ler() {
      try { return JSON.parse(await readFile(caminho, 'utf8')) } catch { return {} }
    },
    async gravar(e) { await writeFile(caminho, JSON.stringify(e)) },
  }
}

/**
 * Decide o que avisar. COM estado: problema novo avisa na hora; o mesmo problema repete a cada
 * REPETIR_MIN; o que sumiu vira "voltou ao normal". SEM estado (cron sem volume): a chave é
 * espalhada pelas fatias de REPETIR_MIN por hash — cada motivo avisa no máximo uma vez por janela,
 * mas o primeiro aviso pode atrasar até REPETIR_MIN e NÃO há recuperação (não há memória do que
 * estava errado).
 */
export function decidir(problemas, estadoAnterior, agora, cfg) {
  const t = agora.getTime()
  const repetirMs = cfg.repetirMin * 60_000
  const avisar = []
  if (estadoAnterior) {
    const novoEstado = {}
    for (const p of problemas) {
      const ultimo = estadoAnterior[p.chave]
      if (ultimo === undefined || t - ultimo >= repetirMs) { avisar.push(p); novoEstado[p.chave] = t } else novoEstado[p.chave] = ultimo
    }
    const recuperados = Object.keys(estadoAnterior).filter((k) => !problemas.some((p) => p.chave === k))
    return { avisar, recuperados, novoEstado }
  }
  const fatias = Math.max(1, Math.round(cfg.repetirMin / CICLO_MIN))
  const tick = Math.floor(t / (CICLO_MIN * 60_000))
  for (const p of problemas) if (tick % fatias === hash(p.chave) % fatias) avisar.push(p)
  return { avisar, recuperados: [], novoEstado: null }
}

async function enviar(fetchFn, cfg, linhas) {
  const texto = linhas.join('\n')
  const alvos = []
  if (cfg.slack) alvos.push([cfg.slack, { text: texto }])
  if (cfg.discord) alvos.push([cfg.discord, { content: texto.slice(0, 1900) }])
  let falhou = false
  for (const [url, corpo] of alvos) {
    try {
      const r = await fetchFn(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) falhou = true
    } catch { falhou = true } // a URL do webhook é segredo: nunca entra no log
  }
  return { entregue: alvos.length === 0 || !falhou, destinos: alvos.length }
}

/** Uma rodada. `deps`: fetch, agora, estado ({ler,gravar}), log. Devolve o resumo; lança em erro do script. */
export async function executar(env, deps = {}) {
  const cfg = configuracao(env)
  const fetchFn = deps.fetch ?? fetch
  const agora = (deps.agora ?? (() => new Date()))()
  const log = deps.log ?? ((m) => console.log(`${agora.toISOString()} monitor: ${m}`))
  const estado = deps.estado ?? (cfg.estadoArquivo ? estadoEmArquivo(cfg.estadoArquivo) : null)
  if (!cfg.apiUrl && !cfg.consoleUrl) throw new Error('defina API_URL e/ou CONSOLE_URL')

  const problemas = await checar(cfg, fetchFn, agora)
  const anterior = estado ? await estado.ler() : null
  const { avisar, recuperados, novoEstado } = decidir(problemas, anterior, agora, cfg)
  log(`${problemas.length} problema(s) [${problemas.map((p) => p.chave).join(', ')}]; avisar=${avisar.length} recuperados=${recuperados.length}`)

  const linhas = []
  if (avisar.length) {
    linhas.push(`:rotating_light: GeraCRM (${cfg.ambiente}) — ${avisar.length} problema(s):`)
    for (const p of avisar) linhas.push(`• ${p.texto}`)
  }
  if (recuperados.length) linhas.push(`:white_check_mark: GeraCRM (${cfg.ambiente}) voltou ao normal: ${recuperados.join(', ')}`)
  let entrega = { entregue: true, destinos: 0 }
  if (linhas.length) {
    entrega = await enviar(fetchFn, cfg, linhas)
    if (entrega.destinos === 0) log(`sem SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL: alerta só no log\n${linhas.join('\n')}`)
  }
  // Só memoriza o que foi de fato entregue: aviso que falhou tenta de novo na próxima rodada.
  if (estado && novoEstado && entrega.entregue) await estado.gravar(novoEstado)
  if (!entrega.entregue) throw new Error('não consegui entregar o alerta no Slack/Discord')

  if (cfg.heartbeat) {
    try { await fetchFn(cfg.heartbeat, { signal: AbortSignal.timeout(10_000) }) } catch { log('heartbeat falhou') }
  }
  return { problemas, avisados: avisar.map((p) => p.chave), recuperados }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executar(process.env).catch((e) => { console.error(`monitor: erro do script: ${e.message}`); process.exit(1) })
}
