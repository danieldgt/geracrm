import { describe, it, expect } from 'vitest'
import { PlataformaGoogleAds } from './google-ads.js'

/** Adaptador Google Ads — fetch mockado, o Google NUNCA é chamado. */
function fakeFetch(
  respostas: { status: number; corpo: unknown }[],
  capturar?: (url: string, init: RequestInit) => void,
): typeof fetch {
  let i = 0
  return (async (url: string, init: RequestInit) => {
    capturar?.(url, init)
    const r = respostas[Math.min(i++, respostas.length - 1)]!
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.corpo } as Response
  }) as unknown as typeof fetch
}

const cred = { developerToken: 'dev-secreto', loginCustomerId: '123-276-0756', accessToken: 'tok-oauth' }
const criar = (respostas: { status: number; corpo: unknown }[], cap?: Parameters<typeof fakeFetch>[1]) =>
  new PlataformaGoogleAds(cred, { buscar: fakeFetch(respostas, cap), versao: 'v25' })

describe('Montagem da chamada', () => {
  it('usa a URL versionada e os três cabeçalhos obrigatórios', async () => {
    let cap: { url: string; init: RequestInit } | null = null
    const g = criar([{ status: 200, corpo: { results: [] } }], (url, init) => { cap = { url, init } })
    await g.lerMetricas('987-654-3210', { de: '2026-08-01', ate: '2026-08-10' })

    expect(cap!.url).toBe('https://googleads.googleapis.com/v25/customers/9876543210/googleAds:search')
    const h = cap!.init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer tok-oauth')
    expect(h['developer-token']).toBe('dev-secreto')
    // ⚠️ Sem login-customer-id o Google recusa conta de cliente vinculada.
    expect(h['login-customer-id']).toBe('1232760756')
  })

  // ⚠️ Versão fixa no código seria apagão com data marcada: o Google lança
  //    mensalmente e na desativação TODAS as requisições falham.
  it('a versão é configurável', async () => {
    let cap: { url: string } | null = null
    const g = new PlataformaGoogleAds(cred, {
      buscar: fakeFetch([{ status: 200, corpo: { results: [] } }], (url) => { cap = { url } }),
      versao: 'v26',
    })
    await g.lerEstrutura('111')
    expect(cap!.url).toContain('/v26/')
  })

  // ⚠️ Sem segments.date o Google agrega o período numa linha só — e a tabela é
  //    por dia. O total viraria um carimbo num dia qualquer.
  it('a consulta de métricas pede o grão diário', async () => {
    let cap: { init: RequestInit } | null = null
    const g = criar([{ status: 200, corpo: { results: [] } }], (_u, init) => { cap = { init } })
    await g.lerMetricas('111', { de: '2026-08-01', ate: '2026-08-10' })
    const corpo = JSON.parse(cap!.init.body as string)
    expect(corpo.query).toContain('segments.date')
    expect(corpo.query).toContain("BETWEEN '2026-08-01' AND '2026-08-10'")
  })
})

describe('Leitura de métricas', () => {
  it('converte micros para centavos e int64-string para número', async () => {
    const g = criar([{
      status: 200,
      corpo: {
        results: [{
          adGroupAd: { ad: { id: '555' } },
          segments: { date: '2026-08-03' },
          metrics: { impressions: '1200', clicks: '48', costMicros: '12345678', conversions: 2.4 },
        }],
      },
    }])
    const r = await g.lerMetricas('111', { de: '2026-08-01', ate: '2026-08-10' })
    expect(r.ok).toBe(true)
    expect(r.ok && r.dados[0]).toEqual({
      anuncioExternoId: '555',
      dia: '2026-08-03',
      impressoes: 1200,
      cliques: 48,
      custoCentavos: 1235,          // 12.345.678 micros = 1234,5678 → ARREDONDA
      conversoesPlataforma: 2,      // 2,4 conversões fracionadas → inteiro
    })
  })

  /**
   * ⚠️ O erro silencioso desta API: ignorar `nextPageToken` devolve 200 OK com
   * metade dos dados, e o custo aparece MENOR — ninguém desconfia porque melhora.
   */
  it('segue a paginação até o fim', async () => {
    const pagina = (id: string, token?: string) => ({
      status: 200,
      corpo: {
        results: [{
          adGroupAd: { ad: { id } }, segments: { date: '2026-08-03' },
          metrics: { impressions: '10', clicks: '1', costMicros: '1000000' },
        }],
        ...(token ? { nextPageToken: token } : {}),
      },
    })
    const g = criar([pagina('1', 'p2'), pagina('2', 'p3'), pagina('3')])
    const r = await g.lerMetricas('111', { de: '2026-08-01', ate: '2026-08-10' })
    expect(r.ok && r.dados).toHaveLength(3)
    expect(r.ok && r.dados.map((d) => d.anuncioExternoId)).toEqual(['1', '2', '3'])
  })

  it('descarta linha sem id de anúncio ou sem data', async () => {
    const g = criar([{
      status: 200,
      corpo: { results: [{ metrics: { clicks: '5' } }, { adGroupAd: { ad: { id: '9' } } }] },
    }])
    const r = await g.lerMetricas('111', { de: '2026-08-01', ate: '2026-08-10' })
    expect(r.ok && r.dados).toHaveLength(0)
  })
})

describe('Leitura de estrutura', () => {
  it('monta a hierarquia e traduz os estados', async () => {
    const g = criar([
      { status: 200, corpo: { results: [{ campaign: { id: '10', name: 'Verão', status: 'ENABLED' } }] } },
      { status: 200, corpo: { results: [{ adGroup: { id: '20', name: 'G1', status: 'PAUSED', campaign: 'customers/1/campaigns/10' } }] } },
      { status: 200, corpo: { results: [{ adGroupAd: { ad: { id: '30' }, status: 'REMOVED', adGroup: 'customers/1/adGroups/20' } }] } },
    ])
    const r = await g.lerEstrutura('111')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dados.campanhas[0]).toEqual({ idExterno: '10', nome: 'Verão', estado: 'ativa', paiExternoId: null })
    expect(r.dados.conjuntos[0]).toMatchObject({ idExterno: '20', estado: 'pausada', paiExternoId: '10' })
    // ⚠️ Removido NÃO é filtrado: ele tem custo histórico, e escondê-lo faria o
    //    total do período não fechar.
    expect(r.dados.anuncios[0]).toMatchObject({ idExterno: '30', estado: 'removida', paiExternoId: '20' })
  })

  it('anúncio sem nome cai no id em vez de vir vazio', async () => {
    const g = criar([
      { status: 200, corpo: { results: [] } },
      { status: 200, corpo: { results: [] } },
      { status: 200, corpo: { results: [{ adGroupAd: { ad: { id: '77' }, status: 'ENABLED' } }] } },
    ])
    const r = await g.lerEstrutura('111')
    expect(r.ok && r.dados.anuncios[0]!.nome).toBe('Anúncio 77')
  })
})

describe('Tradução de erro — a classificação que protege receita', () => {
  const erro = async (status: number, corpo: unknown) => {
    const r = await criar([{ status, corpo }]).lerEstrutura('111')
    return r.ok ? null : r.motivo
  }

  it('401 é credencial', async () => {
    expect(await erro(401, { error: { status: 'UNAUTHENTICATED' } })).toBe('credencial_invalida')
  })

  // ⚠️ O despachante NÃO consome tentativa em limite_de_taxa. Classificar errado
  //    mandaria conversões válidas para o dead-letter.
  it('429 e RESOURCE_EXHAUSTED são limite de taxa', async () => {
    expect(await erro(429, {})).toBe('limite_de_taxa')
    expect(await erro(400, { error: { status: 'RESOURCE_EXHAUSTED' } })).toBe('limite_de_taxa')
  })

  // 403 é ambíguo no Google: pode ser cota OU permissão.
  it('403 sem menção a cota é falta de permissão', async () => {
    expect(await erro(403, { error: { message: 'user does not have access' } })).toBe('sem_permissao')
  })

  it('403 mencionando cota é limite de taxa', async () => {
    expect(await erro(403, { error: { message: 'QUOTA exceeded' } })).toBe('limite_de_taxa')
  })

  it('conta suspensa é conta_indisponivel — problema do cliente, não nosso', async () => {
    expect(await erro(400, { error: { message: 'CUSTOMER_NOT_ENABLED' } })).toBe('conta_indisponivel')
  })

  it('5xx é indisponivel — a ação é esperar', async () => {
    expect(await erro(503, {})).toBe('indisponivel')
  })

  it('o que não reconhecemos vira resposta_inesperada, não silêncio', async () => {
    expect(await erro(418, { algo: 'novo' })).toBe('resposta_inesperada')
  })
})

describe('Capacidades honestas', () => {
  it('declara só o que faz de verdade', () => {
    const g = criar([{ status: 200, corpo: { results: [] } }])
    expect(g.capacidades).toMatchObject({
      leituraEstrutura: true,
      leituraMetrica: true,
      // ⚠️ Ainda não implementados — declarar true faria o produto FALHAR em vez
      //    de degradar, e o despachante tentaria contra o vazio.
      publicoPersonalizado: false,
      conversaoOffline: false,
      cliqueParaConversa: false,   // CTWA é Meta
      escritaEstado: false,
      escritaOrcamento: false,
    })
  })

  it('e enviarConversao é coerente com a capacidade desligada', async () => {
    const g = criar([{ status: 200, corpo: {} }])
    const r = await g.enviarConversao('111', {
      eventId: 'e1', tipoEvento: 'compra', valorCentavos: 5000,
      clickId: 'gclid', ocorridaEm: new Date('2026-08-20T00:00:00Z'),
    })
    expect(r).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
  })
})
