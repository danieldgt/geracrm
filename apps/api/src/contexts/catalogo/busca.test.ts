import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { buscarCatalogo, detalharProduto, embutirConsulta, precoEEstoque } from './busca.js'
import { criarProdutoManual } from './escrita-manual.js'
import { indexarProduto, reindexarTenant, temColunaEmbedding } from './indexador.js'
import { EmbeddingIndisponivel } from './porta-embedding.js'

/**
 * Busca híbrida do catálogo (ADR-026), contra o Postgres real e SOB O PAPEL DA
 * APLICAÇÃO (`comTenantServico` usa DATABASE_URL): o que passa aqui passa pela
 * RLS. Dado preparado pelo mesmo código da rota — `criarProdutoManual` —, para
 * que o teste prove o caminho que o produto usa, não um atalho de INSERT.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo (Vitest roda em paralelo).
 */
const T = 'ca7a1091-0000-4000-8000-000000000001'
const PV = 'ca7a1091-1111-4000-8000-000000000001'
const PLANO = 'ca7a1091-3333-4000-8000-000000000001'
const MODELO = 'ca7a1091-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const ids: Record<string, { produto: string; skus: string[] }> = {}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-catalogo-busca', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-catalogo-busca', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Busca', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`

  await comTenantServico(T, async (tx) => {
    const criar = async (chave: string, entrada: Parameters<typeof criarProdutoManual>[1]) => {
      const r = await criarProdutoManual(tx, entrada)
      if (!r.ok) throw new Error(`fixture ${chave}: ${r.falha.erro}`)
      ids[chave] = { produto: r.valor.id, skus: r.valor.skus }
      await indexarProduto(tx, r.valor.id)
    }
    await criar('camiseta', {
      referencia: 'BUSCA-CAM', descricao: 'Camiseta básica algodão', categoria: 'Camisetas',
      descricaoLonga: 'Malha penteada, gola careca.',
      skus: [
        { atributos: { cor: 'VERDE', tamanho: 'G' }, precos: { varejo: 4990, atacado: 2990 }, saldo: 12 },
        { atributos: { cor: 'VERDE', tamanho: 'M' }, precos: { varejo: 4990 }, saldo: null },
        { atributos: { cor: 'PRETO', tamanho: 'G' }, precos: { varejo: 4990, atacado: 2990 }, saldo: 0 },
      ],
    })
    await criar('calca', {
      referencia: 'BUSCA-CALCA', descricao: 'Calça jeans skinny', categoria: 'Calças',
      skus: [{ atributos: { cor: 'AZUL', tamanho: '40' }, precos: { varejo: 15990, atacado: 9990 }, saldo: 5 }],
    })
    await criar('vestido', {
      referencia: 'BUSCA-VEST', descricao: 'Vestido midi floral verde', categoria: 'Vestidos',
      skus: [{ atributos: { cor: 'VERDE', tamanho: 'M' }, precos: { varejo: 13990, atacado: 8990 }, saldo: 3 }],
    })
    await criar('plano', {
      referencia: 'BUSCA-PLANO', descricao: 'GeraCRM Pro', categoria: 'Plano SaaS',
      descricaoLonga: 'Agente vendedor com IA e campanhas com ROI.',
      skus: [{ atributos: { ciclo: 'mensal' }, precos: { varejo: 59900, atacado: 59900 }, saldo: null }],
    })
  })
})

afterAll(async () => {
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
  await dono`DELETE FROM tabela_preco WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco()
  await dono.end()
})

const buscar = (consulta: string, extra: Partial<Parameters<typeof buscarCatalogo>[1]> = {}) =>
  comTenantServico(T, (tx) => buscarCatalogo(tx, { consulta, perfil: 'varejo', ...extra }))

describe('Busca híbrida — lexical (FTS pt_sem_acento)', () => {
  it('dado "camiseta verde G", então acha a camiseta em primeiro, pela perna lexical', async () => {
    const r = await buscar('camiseta verde G')
    expect(r.itens[0]?.referencia).toBe('BUSCA-CAM')
    expect(r.itens[0]?.fontes).toContain('lexical')
    expect(r.itens[0]?.score).toBeGreaterThan(0)
    expect(r.fontes).toContain('lexical')
  })

  it('dado acento diferente ("calca jeans"), então acha "Calça jeans"', async () => {
    const r = await buscar('calca jeans')
    expect(r.itens.map((i) => i.referencia)).toContain('BUSCA-CALCA')
  })

  it('dado texto que só está na descrição longa ("campanhas ROI"), então acha o plano', async () => {
    const r = await buscar('campanhas ROI')
    expect(r.itens[0]?.referencia).toBe('BUSCA-PLANO')
  })

  it('dado consulta vazia, então nada — e nenhuma perna roda', async () => {
    expect(await buscar('   ')).toEqual({ itens: [], fontes: [] })
  })
})

describe('Busca híbrida — trgm (erro de digitação)', () => {
  it('dado "camisetta", então o trgm ainda acha a camiseta', async () => {
    const r = await buscar('camisetta')
    const cam = r.itens.find((i) => i.referencia === 'BUSCA-CAM')
    expect(cam).toBeDefined()
    expect(cam!.fontes).toContain('trgm')
  })

  it('dado dois acertos de pernas diferentes, então o RRF soma e quem está nas duas sobe', async () => {
    // "camiseta" exato: lexical E trgm acham a camiseta; só o trgm pode achar
    // mais alguém por semelhança. A camiseta precisa ficar em primeiro.
    const r = await buscar('camiseta')
    expect(r.itens[0]?.referencia).toBe('BUSCA-CAM')
    expect(r.itens[0]?.fontes).toEqual(expect.arrayContaining(['lexical', 'trgm']))
  })
})

describe('Busca híbrida — filtros no banco', () => {
  it('dado filtro de categoria, então "verde" só devolve vestidos', async () => {
    const r = await buscar('verde', { filtros: { categoria: 'Vestidos' } })
    expect(r.itens.map((i) => i.referencia)).toEqual(['BUSCA-VEST'])
  })

  it('dado filtro de atributos {tamanho: G}, então o vestido (só M) sai', async () => {
    const r = await buscar('verde', { filtros: { atributos: { tamanho: 'G' } } })
    expect(r.itens.map((i) => i.referencia)).toEqual(['BUSCA-CAM'])
  })

  it('dado limite, então respeita (e nunca passa de 50)', async () => {
    const r = await buscar('verde', { limite: 1 })
    expect(r.itens).toHaveLength(1)
  })
})

describe('Preço por perfil e situação nomeada', () => {
  it('dado perfil varejo e atacado, então o mesmo SKU cota preços diferentes (regra de preco-de-venda.ts)', async () => {
    const varejo = await comTenantServico(T, (tx) => detalharProduto(tx, ids.camiseta!.produto, 'varejo'))
    const atacado = await comTenantServico(T, (tx) => detalharProduto(tx, ids.camiseta!.produto, 'atacado'))
    const skuG = (p: typeof varejo) => p!.skus.find((s) => s.atributos.cor === 'VERDE' && s.atributos.tamanho === 'G')!
    expect(skuG(varejo).precoCentavos).toBe(4990)
    expect(skuG(atacado).precoCentavos).toBe(2990)
    expect(skuG(varejo).saldo).toBe(12)
    expect(skuG(varejo).saldoEm).not.toBeNull()
    expect(varejo!.origem).toBe('manual')
    expect(varejo!.imagem).toBeNull()
  })

  it('dado SKU sem preço no perfil, então precoCentavos null — nunca número inventado', async () => {
    const atacado = await comTenantServico(T, (tx) => detalharProduto(tx, ids.camiseta!.produto, 'atacado'))
    const skuM = atacado!.skus.find((s) => s.atributos.tamanho === 'M')!
    expect(skuM.precoCentavos).toBeNull()
    expect(skuM.saldo).toBeNull() // não controla estoque
  })

  it('⚠️ precoEEstoque: cotado, sem_preco e sku_desconhecido — uma entrada por id pedido', async () => {
    const [cotado, semPreco, zerado] = ids.camiseta!.skus
    const fantasma = randomUUID()
    const r = await comTenantServico(T, (tx) => precoEEstoque(tx, [cotado!, semPreco!, zerado!, fantasma], 'atacado'))
    expect(r.get(cotado!)).toEqual({ situacao: 'cotado', centavos: 2990, saldo: 12, saldoEm: expect.any(String) })
    expect(r.get(semPreco!)).toEqual({ situacao: 'sem_preco', saldo: null, saldoEm: null })
    expect(r.get(zerado!)).toEqual({ situacao: 'cotado', centavos: 2990, saldo: 0, saldoEm: expect.any(String) })
    expect(r.get(fantasma)).toEqual({ situacao: 'sku_desconhecido', saldo: null, saldoEm: null })
  })

  it('dado produto de outro tenant, então detalharProduto devolve null (RLS)', async () => {
    const outro = await comTenantServico('ca7a1091-0000-4000-8000-00000000ffff', (tx) => detalharProduto(tx, ids.camiseta!.produto, 'varejo'))
    expect(outro).toBeNull()
  })
})

describe('Semântica como capacidade opcional (ADR-026)', () => {
  it('dado provedor indisponível, então embutirConsulta degrada com motivo em vez de estourar', async () => {
    expect(await embutirConsulta(EmbeddingIndisponivel, 'camiseta')).toEqual({ vetor: null, motivo: 'capacidade_desligada' })
  })

  it('dado vetor de consulta, então a perna semântica só roda se a coluna existir — sem erro em nenhum caso', async () => {
    const vetor = Array.from({ length: 1024 }, () => 0.01)
    const temColuna = await comTenantServico(T, (tx) => temColunaEmbedding(tx))
    const r = await buscar('camiseta', { vetorConsulta: vetor })
    expect(r.itens[0]?.referencia).toBe('BUSCA-CAM')
    if (temColuna) expect(r.fontes).toContain('semantica')
    else expect(r.fontes).not.toContain('semantica')
  })
})

describe('Indexador', () => {
  it('dado texto inalterado, quando reindexar o tenant, então nada é regravado (hash)', async () => {
    const r = await comTenantServico(T, (tx) => reindexarTenant(tx, { lote: 2 }))
    expect(r).toEqual({ indexados: 0, inalterados: 4, ausentes: 0 })
  })

  it('dado produto inexistente, então nao_encontrado', async () => {
    expect(await comTenantServico(T, (tx) => indexarProduto(tx, randomUUID()))).toBe('nao_encontrado')
  })

  it('⚠️ o índice nunca carrega preço nem saldo', async () => {
    const [linha] = await dono<{ texto: string }[]>`SELECT texto FROM produto_indice WHERE tenant_id = ${T} AND produto_id = ${ids.camiseta!.produto}`
    expect(linha!.texto).not.toMatch(/4990|2990|\b12\b/)
    expect(linha!.texto).toContain('VERDE')
  })
})
