import { describe, it, expect } from 'vitest'
import { executar, decidir, hash, lerHorario, relogioLocal } from './monitor.mjs'

// America/Fortaleza = UTC-3 (sem horário de verão). Terça 2026-11-03 10:00 local = 13:00Z.
const TERCA_10H = new Date('2026-11-03T13:00:00Z')
const TERCA_22H = new Date('2026-11-04T01:00:00Z')
const SABADO_10H = new Date('2026-11-07T13:00:00Z')
const SEGUNDA_0810 = new Date('2026-11-02T11:10:00Z')
const minAtras = (d, m) => new Date(d.getTime() - m * 60_000).toISOString()

const ENV = {
  API_URL: 'https://api.exemplo.test', CONSOLE_URL: 'https://console.exemplo.test',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.test/segredo', TZ: 'America/Fortaleza',
}

const saude = (status, motivos, ultima) => ({
  status, motivos,
  componentes: { entrada: { estado: 'ok', motivos: [], lido: ultima !== undefined, ultimaMensagemEntradaEm: ultima ?? null } },
})

/** fetch falso: roteia por URL e registra as chamadas. */
function mundo({ api = saude('ok', [], null), consoleCod = 200, apiCai = false } = {}) {
  const chamadas = []
  const m = {
    chamadas, api, consoleCod, apiCai,
    posts: () => chamadas.filter((c) => c.metodo === 'POST').map((c) => ({ url: c.url, corpo: JSON.parse(c.body) })),
    fetch: async (url, init = {}) => {
      chamadas.push({ url, metodo: init.method ?? 'GET', body: init.body })
      if (url.startsWith('https://api.exemplo.test')) {
        if (m.apiCai) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify(m.api), { status: m.api.status === 'erro' ? 503 : 200 })
      }
      if (url.startsWith('https://console.exemplo.test')) return new Response('<html>', { status: m.consoleCod })
      return new Response('ok', { status: 200 }) // slack, discord, heartbeat
    },
  }
  return m
}
const estadoMemoria = (inicial = {}) => {
  const e = { dados: inicial, ler: async () => ({ ...e.dados }), gravar: async (x) => { e.dados = x } }
  return e
}
const rodar = (m, agora, extra = {}, estado = estadoMemoria()) =>
  executar({ ...ENV, ...extra }, { fetch: m.fetch, agora: () => agora, estado, log: () => {} })

describe('monitor — checagens', () => {
  it('tudo ok: sem alerta e sem POST', async () => {
    const m = mundo({ api: saude('ok', [], minAtras(TERCA_10H, 2)) })
    const r = await rodar(m, TERCA_10H)
    expect(r.problemas).toEqual([])
    expect(m.posts()).toEqual([])
  })

  it('degradado: alerta no Slack com o motivo e o link', async () => {
    const m = mundo({ api: saude('degradado', ['fila_agente_atrasada'], minAtras(TERCA_10H, 2)) })
    await rodar(m, TERCA_10H)
    const [p] = m.posts()
    expect(p.url).toBe(ENV.SLACK_WEBHOOK_URL)
    expect(p.corpo.text).toContain('fila_agente_atrasada')
    expect(p.corpo.text).toContain('https://api.exemplo.test/saude/detalhada')
  })

  it('erro, API fora e console fora geram problemas distintos', async () => {
    const a = await rodar(mundo({ api: saude('erro', ['encerrando']) }), TERCA_10H)
    expect(a.avisados).toContain('api_erro')
    const b = await rodar(mundo({ apiCai: true, consoleCod: 502 }), TERCA_10H)
    expect(b.avisados.sort()).toEqual(['api_fora', 'console_fora'])
  })

  it('manda também para o Discord (campo content) quando configurado', async () => {
    const m = mundo({ apiCai: true })
    await rodar(m, TERCA_10H, { DISCORD_WEBHOOK_URL: 'https://discord.test/hook' })
    const alvo = m.posts().find((p) => p.url === 'https://discord.test/hook')
    expect(alvo.corpo.content).toContain('API sem resposta')
  })

  it('sem webhook configurado: não envia e não falha', async () => {
    const m = mundo({ apiCai: true })
    await expect(rodar(m, TERCA_10H, { SLACK_WEBHOOK_URL: '' })).resolves.toBeDefined()
    expect(m.posts()).toEqual([])
  })

  it('falha ao entregar o alerta é erro do script (e não memoriza o aviso)', async () => {
    const m = mundo({ apiCai: true })
    const f = m.fetch
    m.fetch = async (u, i) => (i?.method === 'POST' ? new Response('x', { status: 500 }) : f(u, i))
    const estado = estadoMemoria()
    await expect(rodar(m, TERCA_10H, {}, estado)).rejects.toThrow(/entregar/)
    expect(estado.dados).toEqual({})
  })

  it('sem API_URL e CONSOLE_URL é erro do script', async () => {
    await expect(executar({}, { fetch: mundo().fetch, estado: estadoMemoria() })).rejects.toThrow(/API_URL/)
  })
})

describe('monitor — webhook parado (só em horário comercial)', () => {
  it('em horário comercial, sem entrada há 45 min: alerta', async () => {
    const m = mundo({ api: saude('ok', [], minAtras(TERCA_10H, 45)) })
    const r = await rodar(m, TERCA_10H)
    expect(r.avisados).toEqual(['webhook_parado'])
    expect(m.posts()[0].corpo.text).toContain('há 45 min')
  })

  it('em horário comercial, entrada há 10 min: não alerta', async () => {
    const r = await rodar(mundo({ api: saude('ok', [], minAtras(TERCA_10H, 10)) }), TERCA_10H)
    expect(r.problemas).toEqual([])
  })

  it('o limite é configurável (WEBHOOK_PARADO_MIN)', async () => {
    const m = mundo({ api: saude('ok', [], minAtras(TERCA_10H, 10)) })
    expect((await rodar(m, TERCA_10H, { WEBHOOK_PARADO_MIN: '5' })).avisados).toEqual(['webhook_parado'])
  })

  it('fora do horário (noite e fim de semana): não alerta mesmo sem mensagem há horas', async () => {
    const velha = minAtras(TERCA_10H, 600)
    for (const quando of [TERCA_22H, SABADO_10H]) {
      const r = await rodar(mundo({ api: saude('ok', [], velha) }), quando)
      expect(r.problemas).toEqual([])
    }
  })

  it('só conta o silêncio desde a abertura: segunda 08:10 com a última mensagem de sexta não alerta', async () => {
    const r = await rodar(mundo({ api: saude('ok', [], '2026-10-30T20:00:00Z') }), SEGUNDA_0810)
    expect(r.problemas).toEqual([])
  })

  it('sem mensagem na janela de 48 h (null) em horário comercial: alerta', async () => {
    const m = mundo({ api: { ...saude('ok', [], null), componentes: { entrada: { lido: true, ultimaMensagemEntradaEm: null } } } })
    expect((await rodar(m, TERCA_10H)).avisados).toEqual(['webhook_parado'])
  })

  it('leitura indisponível (lido:false): não acusa webhook parado', async () => {
    const r = await rodar(mundo({ api: saude('ok', [], undefined) }), TERCA_10H)
    expect(r.problemas).toEqual([])
  })

  it('HORARIO_COMERCIAL é lido e o relógio local respeita o fuso', () => {
    const h = lerHorario('seg-sab 08:30-17:30')
    expect([...h.dias]).toEqual([1, 2, 3, 4, 5, 6])
    expect([h.ini, h.fim]).toEqual([510, 1050])
    expect(relogioLocal(TERCA_10H, 'America/Fortaleza')).toEqual({ dia: 2, minuto: 600 })
    expect(() => lerHorario('qualquer coisa')).toThrow(/inválido/)
  })
})

describe('monitor — recuperação e dedupe', () => {
  it('problema novo avisa; repetido dentro de REPETIR_MIN não avisa; some e avisa "voltou ao normal"', async () => {
    const estado = estadoMemoria()
    const ruim = mundo({ api: saude('degradado', ['banco_lento'], minAtras(TERCA_10H, 1)) })
    await rodar(ruim, TERCA_10H, {}, estado)
    expect(ruim.posts()).toHaveLength(1)

    const depois = new Date(TERCA_10H.getTime() + 5 * 60_000)
    const ruim2 = mundo({ api: saude('degradado', ['banco_lento'], minAtras(depois, 1)) })
    await rodar(ruim2, depois, {}, estado)
    expect(ruim2.posts()).toHaveLength(0)

    const bom = mundo({ api: saude('ok', [], minAtras(depois, 1)) })
    const quando = new Date(depois.getTime() + 5 * 60_000)
    const r = await rodar(bom, quando, {}, estado)
    expect(r.recuperados).toEqual(['saude:banco_lento'])
    expect(bom.posts()[0].corpo.text).toContain('voltou ao normal')

    const bom2 = mundo({ api: saude('ok', [], minAtras(quando, 1)) })
    await rodar(bom2, new Date(quando.getTime() + 300_000), {}, estado)
    expect(bom2.posts()).toHaveLength(0)
  })

  it('o mesmo motivo repete depois de REPETIR_MIN; motivo novo avisa na hora', async () => {
    const estado = estadoMemoria()
    const mk = (agora, motivos) => mundo({ api: saude('degradado', motivos, minAtras(agora, 1)) })
    await rodar(mk(TERCA_10H, ['banco_lento']), TERCA_10H, {}, estado)
    const t30 = new Date(TERCA_10H.getTime() + 30 * 60_000)
    const novo = mk(t30, ['banco_lento', 'llm_reserva_ativo'])
    await rodar(novo, t30, {}, estado)
    expect(novo.posts()[0].corpo.text).toContain('llm_reserva_ativo')
    expect(novo.posts()[0].corpo.text).not.toContain('banco_lento —')
    const t61 = new Date(TERCA_10H.getTime() + 61 * 60_000)
    const rep = mk(t61, ['banco_lento'])
    await rodar(rep, t61, {}, estado)
    expect(rep.posts()[0].corpo.text).toContain('banco_lento')
  })

  it('sem estado (cron sem volume): cada motivo avisa no máximo 1 vez por janela de REPETIR_MIN, e nunca há recuperação', () => {
    const cfg = { repetirMin: 60 }
    const p = [{ chave: 'saude:banco_lento', texto: 'x' }]
    const avisos = []
    for (let i = 0; i < 12; i++) {
      const agora = new Date(Date.UTC(2026, 10, 3, 13, i * 5))
      avisos.push(decidir(p, null, agora, cfg).avisar.length)
    }
    expect(avisos.reduce((a, b) => a + b, 0)).toBe(1)
    expect(decidir([], null, TERCA_10H, cfg).recuperados).toEqual([])
    // a fatia depende do hash do motivo: motivos diferentes não são obrigados a coincidir
    expect(hash('a')).not.toBe(hash('b'))
  })
})

describe('monitor — heartbeat', () => {
  it('chama HEARTBEAT_URL a cada execução bem-sucedida', async () => {
    const m = mundo()
    await rodar(m, TERCA_10H, { HEARTBEAT_URL: 'https://hc.test/uuid' })
    expect(m.chamadas.some((c) => c.url === 'https://hc.test/uuid')).toBe(true)
  })

  it('não chama o heartbeat quando o script falha', async () => {
    const m = mundo({ apiCai: true })
    const f = m.fetch
    m.fetch = async (u, i) => (i?.method === 'POST' ? new Response('x', { status: 500 }) : f(u, i))
    await rodar(m, TERCA_10H, { HEARTBEAT_URL: 'https://hc.test/uuid' }).catch(() => {})
    expect(m.chamadas.some((c) => c.url === 'https://hc.test/uuid')).toBe(false)
  })
})
