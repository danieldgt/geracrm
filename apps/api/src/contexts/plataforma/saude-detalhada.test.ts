import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { SaudeDetalhada } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { encerrarBanco, sql } from '../../db/index.js'
import { rotasSaudeDetalhada } from './rotas-saude-detalhada.js'
import { lerFilasComo, memorizar, comTeto, type DepsSaude, type LeituraFilas } from './saude-detalhada.js'
import { batimento, idadeDoBatimentoSeg } from './batimento.js'

/**
 * SAÚDE DETALHADA (P8): a rota HTTP com dependências falsas (estados e códigos),
 * a leitura das filas contra o Postgres real com DOIS tenants, e a resposta
 * pública sem id, sem segredo e sem dado pessoal.
 */
const A = 'c8a50000-0000-4000-8000-000000000001'
const B = 'c8a50000-0000-4000-8000-000000000002'
const PV_A = 'c8a50000-1111-4000-8000-000000000001'
const PV_B = 'c8a50000-1111-4000-8000-000000000002'
const PLANO = 'c8a50000-3333-4000-8000-000000000001'
const MODELO = 'c8a50000-4444-4000-8000-000000000001'
const canal = (t: string) => t.replace('-0000-4000', '-5555-4000')
const contato = (t: string) => t.replace('-0000-4000', '-6666-4000')
const conversa = (t: string) => t.replace('-0000-4000', '-7777-4000')
const CONTATO_NOME = 'Fulano Saude Sigiloso'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const FUTURO = new Date(Date.now() + 10 * 365 * 86_400_000)
const LEITURA_EM = new Date(FUTURO.getTime() + 86_400_000)
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const FILAS_EM_DIA: LeituraFilas = {
  agente: { vencidas: 0, maisAntigaHaSeg: null, travadas: 0 },
  retornos: { vencidos: 0, maisAntigoHaSeg: null },
  transcricao: { pendentes: 0, maisAntigaHaSeg: null },
  embeddings: { pendentes: 0 },
}
const FALSO: Partial<DepsSaude> = {
  encerrando: () => false,
  uptimeSeg: () => 3_600,
  pingBanco: async () => 4,
  lerFilas: async () => FILAS_EM_DIA,
  idadeBatimento: () => 1,
  estadoDoLlm: () => ({ situacao: 'principal', reservaAteEm: null, falhasSeguidas: 0, modelosBloqueados: [] }),
  configuracao: { workers: true, transcricao: true, embeddingModelo: 'bge-m3' },
}

async function montar(deps: Partial<DepsSaude>): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(rotasSaudeDetalhada, deps)
  await app.ready()
  return app
}
async function pedir(deps: Partial<DepsSaude>) {
  const app = await montar(deps)
  try {
    const r = await app.inject({ method: 'GET', url: '/saude/detalhada' })
    return { code: r.statusCode, corpo: r.json() as SaudeDetalhada, texto: r.body, cache: r.headers['cache-control'] }
  } finally { await app.close() }
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-saude-detalhada', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-saude-detalhada', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'Saude', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal(t)}, 'whatsapp_nao_oficial', 'Saude', 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato(t)}, ${CONTATO_NOME}, true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conversa(t)}, ${canal(t)}, ${contato(t)}, 1) ON CONFLICT DO NOTHING`
    // Uma tarefa e um retorno em CADA tenant, para daqui a 10 anos. ⚠️ Nunca no
    // passado: os testes de worker de outros arquivos varrem TODOS os tenants e
    // pegariam a tarefa. A leitura abaixo usa um `agora` 10 anos + 1 dia à frente.
    await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${t}`
    await dono`INSERT INTO agente_tarefa (tenant_id, id, conversa_id, canal_id, estado, executar_em)
               VALUES (${t}, gen_random_uuid(), ${conversa(t)}, ${canal(t)}, 'pendente', ${FUTURO})`
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${t}`
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, tentativa, texto, estado, executar_em)
               VALUES (${t}, gen_random_uuid(), ${conversa(t)}, ${canal(t)}, 'proposta_sem_resposta', 1, 'oi', 'pendente', ${FUTURO})`
  }
})
afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${t}`
    await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('GET /saude/detalhada — estados e código HTTP', () => {
  it('dado tudo em dia, então 200 com status ok, sem cache e os oito componentes', async () => {
    const r = await pedir(FALSO)
    expect(r.code).toBe(200)
    expect(r.cache).toBe('no-store')
    expect(r.corpo.status).toBe('ok')
    expect(r.corpo.motivos).toEqual([])
    expect(Object.keys(r.corpo.componentes)).toEqual(
      ['processo', 'banco', 'workerAgente', 'filaAgente', 'llm', 'transcricao', 'embeddings', 'retornos'])
    // O monitor externo procura exatamente esta palavra-chave.
    expect(r.texto).toContain('"status":"ok"')
  })

  it('dado banco fora, então DEGRADADO com 200 (nunca 503) e o monitor por palavra-chave alerta', async () => {
    const r = await pedir({ ...FALSO, pingBanco: () => Promise.reject(new Error('ECONNREFUSED senha=xyz')),
      lerFilas: () => Promise.reject(new Error('ECONNREFUSED')) })
    expect(r.code).toBe(200)
    expect(r.corpo.status).toBe('degradado')
    expect(r.corpo.motivos).toEqual(['banco_indisponivel', 'filas_sem_leitura'])
    expect(r.texto).not.toContain('"status":"ok"')
    // O erro do driver não vaza para a resposta pública.
    expect(r.texto).not.toContain('ECONNREFUSED')
    expect(r.texto).not.toContain('xyz')
  })

  it('dado banco pendurado, então a rota responde mesmo assim (teto da medição) e acusa o banco', async () => {
    const r = await pedir({ ...FALSO, pingBanco: () => new Promise(() => {}) })
    expect(r.code).toBe(200)
    expect(r.corpo.motivos).toContain('banco_indisponivel')
  }, 10_000)

  it('dado worker do agente parado e LLM na reserva, então 200 degradado com os dois motivos', async () => {
    const agora = new Date('2026-10-17T12:00:00Z')
    const r = await pedir({
      ...FALSO,
      agora: () => agora,
      idadeBatimento: (nome) => (nome === 'workerAgente' ? 600 : 1),
      estadoDoLlm: () => ({
        situacao: 'reserva', reservaAteEm: new Date(agora.getTime() + 900_000), falhasSeguidas: 2,
        modelosBloqueados: [{ modelo: 'modelo-secreto-x', ateEm: new Date(agora.getTime() + 60_000) }],
      }),
    })
    expect(r.code).toBe(200)
    expect(r.corpo.motivos).toEqual(['worker_agente_parado', 'llm_reserva_ativo', 'modelo_bloqueado'])
    expect(r.corpo.componentes.llm).toMatchObject({ reservaRestanteSeg: 900, modelosBloqueados: 1 })
    // Nome de modelo não sai na rota pública — só a contagem.
    expect(r.texto).not.toContain('modelo-secreto-x')
  })

  it('dado processo encerrando, então 503 com status erro — o ÚNICO caminho para 503', async () => {
    const r = await pedir({ ...FALSO, encerrando: () => true })
    expect(r.code).toBe(503)
    expect(r.corpo.status).toBe('erro')
    expect(r.corpo.motivos).toEqual(['encerrando'])
  })

  it('dado app.close() (o que o SIGTERM chama) com a medição em voo, então ela sai como encerrando/503', async () => {
    const { encerrando: _semFlagInjetada, ...semEncerrando } = FALSO
    let liberar: (f: LeituraFilas) => void = () => {}
    const app = await montar({ ...semEncerrando, lerFilas: () => new Promise((ok) => { liberar = ok }) })
    const emVoo = app.inject({ method: 'GET', url: '/saude/detalhada' })
    await new Promise((ok) => setTimeout(ok, 20))
    // ⚠️ Fastify recusa requisição NOVA depois de close() (503 próprio); o que o
    //    plugin garante é que a medição em voo não responda "ok" de um processo saindo.
    await app.close()
    liberar(FILAS_EM_DIA)
    const r = await emVoo
    expect(r.statusCode).toBe(503)
    expect((r.json() as SaudeDetalhada).status).toBe('erro')
  })
})

describe('Leitura das filas — conexão de serviço, todos os tenants, só agregados', () => {
  it('dado tarefas e retornos vencidos em DOIS tenants, então soma os dois e mede a idade', async () => {
    const f = await lerFilasComo(dono as never, { workers: true, transcricao: true, embeddingModelo: 'modelo-saude-teste' }, () => LEITURA_EM)()
    // ≥: outros arquivos de teste correm em paralelo no mesmo banco.
    expect(f.agente.vencidas).toBeGreaterThanOrEqual(2)
    expect(f.agente.maisAntigaHaSeg).toBeGreaterThanOrEqual(86_400 - 5)
    expect(f.retornos.vencidos).toBeGreaterThanOrEqual(2)
    expect(f.retornos.maisAntigoHaSeg).toBeGreaterThanOrEqual(86_400 - 5)
    expect(f.transcricao).not.toBeNull()
    expect(f.embeddings).not.toBeNull()
  })

  it('dado capacidades desligadas, então não consulta transcrição nem embeddings', async () => {
    const f = await lerFilasComo(dono as never, { workers: true, transcricao: false, embeddingModelo: null }, () => new Date())()
    expect(f.transcricao).toBeNull()
    expect(f.embeddings).toBeNull()
  })

  it('dado o pool da API (geracrm_api, sem tenant), então o RLS devolve zero — por isso a saúde usa a conexão de serviço', async () => {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_tarefa`
    expect(r!.n).toBe(0)
  })
})

describe('Resposta pública — sem id, sem segredo, sem dado pessoal', () => {
  it('dado o app de verdade, então /saude/detalhada responde e não carrega UUID, nome de cliente nem credencial', async () => {
    const app = await criarApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/saude/detalhada' })
      expect(r.statusCode).toBe(200)
      const corpo = r.json() as SaudeDetalhada
      expect(['ok', 'degradado']).toContain(corpo.status)
      expect(corpo.componentes.filaAgente.vencidas).toBeGreaterThanOrEqual(0)
      expect(r.body).not.toMatch(UUID)
      expect(r.body).not.toContain(CONTATO_NOME)
      for (const v of [process.env.DATABASE_URL, process.env.DATABASE_ADMIN_URL, process.env.GROQ_API_KEY,
        process.env.ANTHROPIC_API_KEY, process.env.OPENROUTER_API_KEY]) {
        if (v) expect(r.body).not.toContain(v)
      }
      const senha = new URL(process.env.DATABASE_ADMIN_URL!).password
      if (senha) expect(r.body).not.toContain(senha)
      // Só números, booleanos, null e códigos curtos — nenhum texto livre.
      const textos: string[] = []
      JSON.stringify(corpo, (_k, v: unknown) => { if (typeof v === 'string') textos.push(v); return v })
      for (const t of textos) expect(t).toMatch(/^[a-z_]+$/)
    } finally { await app.close() }
  })

  it('dado o app de verdade, então /saude e /pronto seguem como eram (healthcheck do Railway inalterado)', async () => {
    const app = await criarApp()
    try {
      const saude = await app.inject({ method: 'GET', url: '/saude' })
      expect(saude.statusCode).toBe(200)
      expect(Object.keys(saude.json())).toEqual(['ok', 'versao'])
      const pronto = await app.inject({ method: 'GET', url: '/pronto' })
      expect(pronto.statusCode).toBe(200)
      expect(pronto.json()).toEqual({ ok: true, banco: 'ok' })
    } finally { await app.close() }
  })
})

describe('Peças da medição', () => {
  it('memorizar: chamadas dentro do TTL dividem a mesma promessa; depois do TTL mede de novo', async () => {
    let t = 0, n = 0
    const f = memorizar(async () => ++n, 10_000, () => t)
    expect(await Promise.all([f(), f(), f()])).toEqual([1, 1, 1])
    t = 10_001
    expect(await f()).toBe(2)
  })

  it('comTeto: promessa pendurada rejeita no teto', async () => {
    await expect(comTeto(new Promise(() => {}), 10)).rejects.toThrow('saude_teto')
    await expect(comTeto(Promise.resolve(7), 10)).resolves.toBe(7)
  })

  it('batimento: idade em segundos inteiros, null antes da primeira passada', () => {
    const fonte = new Map([['retornos', new Date('2026-10-17T12:00:00Z')]] as const)
    expect(idadeDoBatimentoSeg('retornos', new Date('2026-10-17T12:01:30.900Z'), fonte)).toBe(90)
    expect(idadeDoBatimentoSeg('sla', new Date(), fonte)).toBeNull()
    batimento('posIngestao', new Date('2026-10-17T12:00:00Z'))
    expect(idadeDoBatimentoSeg('posIngestao', new Date('2026-10-17T12:00:05Z'))).toBe(5)
  })
})
