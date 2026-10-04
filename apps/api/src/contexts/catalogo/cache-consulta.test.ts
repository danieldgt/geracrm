import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { sql, encerrarBanco } from '../../db/index.js'
import { embutirConsulta, TIMEOUT_CONSULTA_MS } from './busca.js'
import { cacheEmMemoria, cacheNoPostgres, chaveDeConsulta, normalizarConsulta, podarCache } from './cache-consulta.js'
import { ErroEmbedding, type PortaEmbedding } from './porta-embedding.js'

/**
 * O cache do vetor da pergunta: normalização, LRU em memória, tabela global
 * (0095) e o caminho quente `embutirConsulta` — acerto não vai ao fornecedor,
 * falha do fornecedor degrada para lexical sem erro, tempo limite curto.
 */
const PREFIXO = 'teste-cache-consulta'

function portaContadora(opcoes: { falhar?: ErroEmbedding; demoraMs?: number } = {}): PortaEmbedding & { chamadas: number } {
  const p = {
    nome: `${PREFIXO}:v1`, capacidades: { buscaSemantica: true }, dimensoes: 4, chamadas: 0,
    async embutir(textos: readonly string[], _tipo: unknown, o?: { timeoutMs?: number | undefined }) {
      p.chamadas += 1
      if (opcoes.falhar) throw opcoes.falhar
      if (opcoes.demoraMs && o?.timeoutMs !== undefined && opcoes.demoraMs > o.timeoutMs) {
        throw new ErroEmbedding('tempo_esgotado', 'lento')
      }
      return textos.map((t) => [t.length, 0.5, 0.25, 1])
    },
  }
  return p as unknown as PortaEmbedding & { chamadas: number }
}

beforeAll(async () => { await sql`DELETE FROM embedding_consulta_cache WHERE modelo LIKE ${PREFIXO + '%'}` })
afterAll(async () => {
  await sql`DELETE FROM embedding_consulta_cache WHERE modelo LIKE ${PREFIXO + '%'}`
  await encerrarBanco()
})

describe('normalização e chave', () => {
  it('maiúsculas, espaços e pontuação final não mudam a chave; acento e palavra mudam', () => {
    expect(normalizarConsulta('  Qual o  PRAZO de entrega?? ')).toBe('qual o prazo de entrega')
    expect(chaveDeConsulta('m', 'Qual o prazo?')).toBe(chaveDeConsulta('m', 'qual o prazo'))
    expect(chaveDeConsulta('m', 'prazo')).not.toBe(chaveDeConsulta('m', 'praso'))
    expect(chaveDeConsulta('m1', 'prazo')).not.toBe(chaveDeConsulta('m2', 'prazo'))
    expect(chaveDeConsulta('m', 'x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('cache em memória (LRU)', () => {
  it('guarda até o teto e descarta o menos usado', async () => {
    const c = cacheEmMemoria(2)
    await c.gravar('a', 'm', [1]); await c.gravar('b', 'm', [2])
    expect(await c.ler('a')).toEqual([1])          // 'a' vira o mais recente
    await c.gravar('c', 'm', [3])                  // estoura: sai 'b'
    expect(await c.ler('b')).toBeNull()
    expect(await c.ler('a')).toEqual([1])
    expect(await c.ler('c')).toEqual([3])
    expect(c.tamanho()).toBe(2)
  })
})

describe('cache no Postgres (tabela global 0095)', () => {
  it('grava, lê de outro processo (memória vazia), conta acertos e renova usado_em', async () => {
    const chave = chaveDeConsulta(`${PREFIXO}:v1`, 'tem frete grátis?')
    const escritor = cacheNoPostgres(sql)
    await escritor.gravar(chave, `${PREFIXO}:v1`, [0.1, 0.2, 0.3])
    const leitor = cacheNoPostgres(sql)  // memória própria, vazia → vai ao banco
    expect(await leitor.ler(chave)).toEqual([0.1, 0.2, 0.3])
    expect(await leitor.ler(chave)).toEqual([0.1, 0.2, 0.3])  // agora da memória
    const [l] = await sql<{ acertos: number; dimensoes: number }[]>`SELECT acertos, dimensoes FROM embedding_consulta_cache WHERE chave = ${chave}`
    expect(l).toMatchObject({ acertos: 1, dimensoes: 3 })
    expect(await leitor.ler(chaveDeConsulta(`${PREFIXO}:v1`, 'nunca perguntado'))).toBeNull()
  })

  it('podarCache remove por idade e por teto, e devolve quantas saíram', async () => {
    const velha = chaveDeConsulta(`${PREFIXO}:velha`, 'antiga')
    await cacheNoPostgres(sql).gravar(velha, `${PREFIXO}:velha`, [1, 2])
    await sql`UPDATE embedding_consulta_cache SET usado_em = now() - interval '200 days' WHERE chave = ${velha}`
    const n = await podarCache(sql, { dias: 90 })
    expect(n).toBeGreaterThanOrEqual(1)
    expect(await sql`SELECT 1 FROM embedding_consulta_cache WHERE chave = ${velha}`).toHaveLength(0)
  })
})

describe('embutirConsulta com cache e tempo limite', () => {
  it('primeira vez vai ao fornecedor e grava; a segunda (mesma pergunta, outra grafia) vem do cache', async () => {
    const porta = portaContadora()
    const cache = cacheEmMemoria()
    const a = await embutirConsulta(porta, 'Qual o prazo?', { cache })
    const b = await embutirConsulta(porta, 'qual o prazo', { cache })
    expect(a).toMatchObject({ origem: 'fornecedor', modelo: `${PREFIXO}:v1` })
    expect(b).toMatchObject({ origem: 'cache' })
    expect(a.vetor).toEqual(b.vetor)
    expect(porta.chamadas).toBe(1)
  })

  it('fornecedor fora → {vetor:null, motivo} e nada é gravado; lento além do limite → tempo_esgotado', async () => {
    const cache = cacheEmMemoria()
    const fora = await embutirConsulta(portaContadora({ falhar: new ErroEmbedding('indisponivel', 'x') }), 'oi', { cache })
    expect(fora).toEqual({ vetor: null, motivo: 'indisponivel' })
    expect(cache.tamanho()).toBe(0)
    const lenta = portaContadora({ demoraMs: TIMEOUT_CONSULTA_MS + 1 })
    expect(await embutirConsulta(lenta, 'oi', { cache })).toEqual({ vetor: null, motivo: 'tempo_esgotado' })
    // O worker (lote) pode pedir mais tempo:
    expect((await embutirConsulta(lenta, 'oi', { cache, timeoutMs: TIMEOUT_CONSULTA_MS + 10 })).vetor).not.toBeNull()
  })

  it('sem cache funciona como antes; capacidade desligada nem tenta', async () => {
    const porta = portaContadora()
    expect((await embutirConsulta(porta, 'x')).vetor).not.toBeNull()
    expect(porta.chamadas).toBe(1)
    const desligada = { ...portaContadora(), capacidades: { buscaSemantica: false } } as PortaEmbedding
    expect(await embutirConsulta(desligada, 'x', { cache: cacheEmMemoria() })).toEqual({ vetor: null, motivo: 'capacidade_desligada' })
  })
})
