import { describe, it, expect } from 'vitest'
import {
  criarEmbeddingVoyage, criarEmbeddingCloudflare, embeddingDoAmbiente, faltaParaEmbedding,
  EmbeddingIndisponivel, ErroEmbedding, DIMENSOES_VOYAGE,
} from './porta-embedding.js'

/**
 * Adaptador Voyage testado pelo CONTRATO, com `fetch` injetado — nunca a rede.
 * O que importa: a forma da requisição (é o que o fornecedor cobra) e o mapa de
 * falhas tipificadas (é o que a busca usa para degradar sem adivinhar).
 */

const vetor = (semente: number) => Array.from({ length: DIMENSOES_VOYAGE }, (_, i) => (i + semente) / 1000)

function fetchFalso(resposta: { status?: number; corpo?: unknown; lancar?: Error }) {
  const chamadas: { url: string; init: RequestInit }[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} })
    if (resposta.lancar) throw resposta.lancar
    return new Response(
      resposta.corpo === undefined ? 'nao-json' : JSON.stringify(resposta.corpo),
      { status: resposta.status ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { f, chamadas }
}

describe('Adaptador Voyage — forma da requisição', () => {
  it('dado textos de documento, quando embutir, então manda model, input_type=document e 1024 dims com Bearer', async () => {
    const { f, chamadas } = fetchFalso({ corpo: { data: [{ embedding: vetor(1), index: 0 }, { embedding: vetor(2), index: 1 }] } })
    const porta = criarEmbeddingVoyage({ apiKey: 'chave-teste', fetch: f })

    const r = await porta.embutir(['camiseta verde', 'calça jeans'], 'documento')

    expect(porta.capacidades.buscaSemantica).toBe(true)
    expect(r).toHaveLength(2)
    expect(r[0]).toHaveLength(DIMENSOES_VOYAGE)
    expect(chamadas).toHaveLength(1)
    const { url, init } = chamadas[0]!
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer chave-teste')
    expect(JSON.parse(init.body as string)).toEqual({
      input: ['camiseta verde', 'calça jeans'],
      model: 'voyage-4',
      input_type: 'document',
      output_dimension: 1024,
    })
  })

  it('dado uma consulta, então input_type=query', async () => {
    const { f, chamadas } = fetchFalso({ corpo: { data: [{ embedding: vetor(1), index: 0 }] } })
    await criarEmbeddingVoyage({ apiKey: 'k', fetch: f }).embutir(['vestido'], 'consulta')
    expect(JSON.parse(chamadas[0]!.init.body as string).input_type).toBe('query')
  })

  it('⚠️ dado vetores fora de ordem, então reordena por index — o fornecedor não promete a ordem', async () => {
    const { f } = fetchFalso({ corpo: { data: [{ embedding: vetor(2), index: 1 }, { embedding: vetor(1), index: 0 }] } })
    const r = await criarEmbeddingVoyage({ apiKey: 'k', fetch: f }).embutir(['a', 'b'], 'documento')
    expect(r[0]![0]).toBe(vetor(1)[0])
    expect(r[1]![0]).toBe(vetor(2)[0])
  })

  it('dado lista vazia, então não chama a rede', async () => {
    const { f, chamadas } = fetchFalso({ corpo: { data: [] } })
    expect(await criarEmbeddingVoyage({ apiKey: 'k', fetch: f }).embutir([], 'documento')).toEqual([])
    expect(chamadas).toHaveLength(0)
  })
})

describe('Adaptador Voyage — falhas tipificadas', () => {
  const codigoDe = async (p: Promise<unknown>) => {
    try { await p } catch (e) { return e instanceof ErroEmbedding ? e.codigo : `nao-tipificado:${String(e)}` }
    return 'sem-erro'
  }
  const embutir = (resposta: Parameters<typeof fetchFalso>[0]) =>
    criarEmbeddingVoyage({ apiKey: 'k', fetch: fetchFalso(resposta).f, timeoutMs: 50 }).embutir(['x'], 'consulta')

  it('401 → autenticacao', async () => { expect(await codigoDe(embutir({ status: 401, corpo: {} }))).toBe('autenticacao') })
  it('429 → limite_excedido', async () => { expect(await codigoDe(embutir({ status: 429, corpo: {} }))).toBe('limite_excedido') })
  it('400 → entrada_invalida', async () => { expect(await codigoDe(embutir({ status: 400, corpo: {} }))).toBe('entrada_invalida') })
  it('503 → indisponivel', async () => { expect(await codigoDe(embutir({ status: 503, corpo: {} }))).toBe('indisponivel') })
  it('rede caiu → indisponivel', async () => {
    expect(await codigoDe(embutir({ lancar: new TypeError('fetch failed') }))).toBe('indisponivel')
  })
  it('tempo esgotado → tempo_esgotado', async () => {
    const erro = new Error('timeout'); erro.name = 'TimeoutError'
    expect(await codigoDe(embutir({ lancar: erro }))).toBe('tempo_esgotado')
  })
  it('corpo que não é JSON → resposta_inesperada', async () => {
    expect(await codigoDe(embutir({ status: 200 }))).toBe('resposta_inesperada')
  })
  it('quantidade de vetores diferente da de textos → resposta_inesperada', async () => {
    expect(await codigoDe(embutir({ corpo: { data: [] } }))).toBe('resposta_inesperada')
  })
  it('vetor com dimensão errada → resposta_inesperada', async () => {
    expect(await codigoDe(embutir({ corpo: { data: [{ embedding: [1, 2, 3], index: 0 }] } }))).toBe('resposta_inesperada')
  })
})

describe('Fábrica pelo ambiente', () => {
  it('sem nenhuma chave, então o objeto nulo: capacidade desligada, embutir estoura tipificado e `falta` nomeia as variáveis', async () => {
    const porta = embeddingDoAmbiente({})
    expect(porta).toBe(EmbeddingIndisponivel)
    expect(porta.capacidades.buscaSemantica).toBe(false)
    await expect(porta.embutir(['x'], 'consulta')).rejects.toMatchObject({ codigo: 'nao_configurado' })
    expect(faltaParaEmbedding({})).toBe('CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_AI_TOKEN (ou VOYAGE_API_KEY)')
    expect(faltaParaEmbedding({ CLOUDFLARE_ACCOUNT_ID: 'a' })).toBe('CLOUDFLARE_AI_TOKEN (ou VOYAGE_API_KEY)')
  })

  it('só com VOYAGE_API_KEY, então Voyage; com as duas da Cloudflare, Cloudflare ganha; EMBEDDING_PROVEDOR força', () => {
    expect(embeddingDoAmbiente({ VOYAGE_API_KEY: 'abc' }).nome).toBe('voyage:voyage-4')
    const cf = embeddingDoAmbiente({ VOYAGE_API_KEY: 'abc', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AI_TOKEN: 'tok' })
    expect(cf.nome).toBe('cloudflare:@cf/baai/bge-m3')
    expect(cf.dimensoes).toBe(1024)
    expect(embeddingDoAmbiente({ EMBEDDING_PROVEDOR: 'voyage', VOYAGE_API_KEY: 'abc', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AI_TOKEN: 'tok' }).nome).toBe('voyage:voyage-4')
    // Pedido explícito sem a chave correspondente NÃO cai para o outro: fica desligado e diz o que falta.
    expect(embeddingDoAmbiente({ EMBEDDING_PROVEDOR: 'cloudflare', VOYAGE_API_KEY: 'abc' })).toBe(EmbeddingIndisponivel)
    expect(faltaParaEmbedding({ EMBEDDING_PROVEDOR: 'cloudflare', VOYAGE_API_KEY: 'abc' })).toBe('CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_AI_TOKEN')
    expect(faltaParaEmbedding({ EMBEDDING_PROVEDOR: 'voyage' })).toBe('VOYAGE_API_KEY')
  })
})

describe('Adaptador Cloudflare Workers AI (bge-m3)', () => {
  const vetorCf = (semente: number) => Array.from({ length: 1024 }, (_, i) => (i + semente) / 1000)

  it('manda {text:[...]} com Bearer para a conta certa e devolve result.data na ordem', async () => {
    const { f, chamadas } = fetchFalso({ corpo: { success: true, result: { shape: [2, 1024], data: [vetorCf(1), vetorCf(2)] } } })
    const porta = criarEmbeddingCloudflare({ accountId: 'conta-1', token: 'tok', fetch: f })
    const r = await porta.embutir(['camiseta', 'calça'], 'documento')
    expect(r).toHaveLength(2)
    expect(r[0]![0]).toBeCloseTo(1 / 1000)
    expect(chamadas[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/conta-1/ai/run/@cf/baai/bge-m3')
    const init = chamadas[0]!.init
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ text: ['camiseta', 'calça'] })
  })

  it('aceita também itens {embedding} e recusa vetor de dimensão errada', async () => {
    const ok = criarEmbeddingCloudflare({ accountId: 'a', token: 't', fetch: fetchFalso({ corpo: { success: true, result: { data: [{ embedding: vetorCf(3) }] } } }).f })
    expect((await ok.embutir(['x'], 'consulta'))[0]).toHaveLength(1024)
    const errado = criarEmbeddingCloudflare({ accountId: 'a', token: 't', fetch: fetchFalso({ corpo: { success: true, result: { data: [[0.1, 0.2]] } } }).f })
    await expect(errado.embutir(['x'], 'consulta')).rejects.toMatchObject({ codigo: 'resposta_inesperada' })
  })

  it('mapeia 401/403 → autenticacao, 429 → limite_excedido, 5xx → indisponivel, success:false → tipificado, timeout por chamada → tempo_esgotado', async () => {
    const porta = (resposta: Parameters<typeof fetchFalso>[0]) => criarEmbeddingCloudflare({ accountId: 'a', token: 't', fetch: fetchFalso(resposta).f })
    await expect(porta({ status: 401 }).embutir(['x'], 'consulta')).rejects.toMatchObject({ codigo: 'autenticacao' })
    await expect(porta({ status: 429 }).embutir(['x'], 'consulta')).rejects.toMatchObject({ codigo: 'limite_excedido' })
    await expect(porta({ status: 503 }).embutir(['x'], 'consulta')).rejects.toMatchObject({ codigo: 'indisponivel' })
    await expect(porta({ corpo: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }).embutir(['x'], 'consulta'))
      .rejects.toMatchObject({ codigo: 'autenticacao' })
    const lento: typeof fetch = (_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))
    })
    const p = criarEmbeddingCloudflare({ accountId: 'a', token: 't', fetch: lento, timeoutMs: 10_000 })
    await expect(p.embutir(['x'], 'consulta', { timeoutMs: 20 })).rejects.toMatchObject({ codigo: 'tempo_esgotado' })
  })
})
