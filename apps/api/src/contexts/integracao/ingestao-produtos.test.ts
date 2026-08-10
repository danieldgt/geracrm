import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp, SkuCanonico } from '@geracrm/conectores'
import { ingerirProdutos } from './ingestao-produtos.js'

// ⚠️ UUIDs exclusivos deste arquivo — Vitest roda arquivos em paralelo.
const T = 'c0a7a1a0-0000-4000-8000-000000000001'
const PV = 'c0a7a1a0-1111-4000-8000-000000000001'
const CONEXAO = 'c0a7a1a0-2222-4000-8000-000000000001'
const PLANO = 'c0a7a1a0-3333-4000-8000-000000000001'
const MODELO = 'c0a7a1a0-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const conectorFalso = (paginas: SkuCanonico[][]): ConectorErp => ({
  nome: 'falso',
  capacidades: {
    ingestaoClientes: false, ingestaoProdutos: true, ingestaoPedidos: false,
    cargaHistorica: true, saldoSincrono: false, tabelaPrecoSincrona: false,
    creditoCliente: false, escritaPedido: false, webhookDeVenda: false, fidelidade: false,
  },
  async listarClientes() { return { itens: [] } },
  async listarSkus(cursor?: string) {
    const i = cursor ? Number(cursor) : 0
    return {
      itens: paginas[i] ?? [],
      cursor: i + 1 < paginas.length ? String(i + 1) : undefined,
    }
  },
  async listarVendas() { return { itens: [] } },
})

const sku = (p: Partial<SkuCanonico> & { idExterno: string }): SkuCanonico => ({
  referencia: 'LAILA', descricao: 'CONJUNTO LAILA',
  atributos: { cor: 'VERDE', tamanho: 'G' }, ativo: true, ...p,
})

const ingerir = (paginas: SkuCanonico[][], opcoes = {}) =>
  dono.begin((tx) => ingerirProdutos(tx as never, T, CONEXAO, conectorFalso(paginas), opcoes))

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-produtos', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-produtos', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Catálogo', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, fonte_de_venda)
             VALUES (${T}, ${CONEXAO}, 'falso', 'ERP', true) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM sku_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM sku WHERE tenant_id = ${T}`
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM sku_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM sku WHERE tenant_id = ${T}`
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
  await dono`DELETE FROM conexao_erp WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('Ingestão de catálogo', () => {
  it('⚠️ dados vários SKUs da mesma referência, então cria UM produto com N SKUs', async () => {
    const r = await ingerir([[
      sku({ idExterno: 'S-1', atributos: { cor: 'VERDE', tamanho: 'P' } }),
      sku({ idExterno: 'S-2', atributos: { cor: 'VERDE', tamanho: 'G' } }),
      sku({ idExterno: 'S-3', atributos: { cor: 'AZUL', tamanho: 'G' } }),
    ]])

    // Produto é o modelo; SKU é a combinação. Tratar produto como unidade
    // vendável erraria saldo, preço e grade ao mesmo tempo.
    expect(r).toMatchObject({ produtosCriados: 1, skusCriados: 3 })
    const [p] = await dono`SELECT count(*)::int AS n FROM produto WHERE tenant_id = ${T}`
    expect(p!.n).toBe(1)
  })

  it('⚠️ dada a mesma carga duas vezes, então não duplica o catálogo', async () => {
    const carga = [[sku({ idExterno: 'S-1' }), sku({ idExterno: 'S-2' })]]
    await ingerir(carga)
    const r2 = await ingerir(carga)

    // Sem o índice único de 0013b isto criaria um segundo "CONJUNTO LAILA",
    // os SKUs se dividiriam e o histórico do produto mostraria metade.
    expect(r2).toMatchObject({ produtosCriados: 0, skusCriados: 0, skusAtualizados: 2 })
    const [p] = await dono`SELECT count(*)::int AS n FROM produto WHERE tenant_id = ${T}`
    const [s] = await dono`SELECT count(*)::int AS n FROM sku WHERE tenant_id = ${T}`
    expect([p!.n, s!.n]).toEqual([1, 2])
  })

  it('dada descrição alterada no ERP, então a tela passa a mostrar o nome de hoje', async () => {
    await ingerir([[sku({ idExterno: 'S-1' })]])
    await ingerir([[sku({ idExterno: 'S-1', descricao: 'CONJUNTO LAILA VERAO' })]])

    const [p] = await dono<{ descricao: string }[]>`SELECT descricao FROM produto WHERE tenant_id = ${T}`
    expect(p!.descricao).toBe('CONJUNTO LAILA VERAO')
  })

  it('dado atributo com sub-tamanho, então guarda os três sem coluna fixa', async () => {
    // ADR-004: o ERP de referência tem cor, tamanho E sub-tamanho.
    await ingerir([[sku({ idExterno: 'S-1', atributos: { cor: 'VERDE', tamanho: 'G', subTamanho: '42' } })]])

    const [s] = await dono<{ tipo: string; atributos: Record<string, string> }[]>`
      SELECT jsonb_typeof(atributos) AS tipo, atributos FROM sku WHERE tenant_id = ${T}`
    // ⚠️ 'object', não 'string': `${JSON.stringify(x)}::jsonb` grava a string
    // JSON inteira como escalar. O INSERT passa, a coluna parece preenchida, e
    // aí `atributos->>'tamanho'` devolve NULL para sempre — o filtro "tamanho G"
    // volta vazio e o índice GIN não casa com nada, sem erro nenhum.
    expect(s!.tipo).toBe('object')
    expect(s!.atributos).toEqual({ cor: 'VERDE', tamanho: 'G', subTamanho: '42' })
  })

  it('dado SKU sem referência, então rejeita com motivo em vez de criar produto órfão', async () => {
    const r = await ingerir([[sku({ idExterno: 'S-1', referencia: '  ' })]])
    expect(r.rejeitados).toBe(1)
    expect(r.rejeicoes[0]!.motivo).toContain('referência')
  })

  it('dado desativarAusentes após varredura completa, então desativa o que sumiu', async () => {
    await ingerir([[sku({ idExterno: 'S-1' }), sku({ idExterno: 'S-2' })]])
    const r = await ingerir([[sku({ idExterno: 'S-1' })]], { desativarAusentes: true })

    expect(r.skusDesativados).toBe(1)
    // ⚠️ Desativa, nunca apaga: o SKU descontinuado ainda aparece em vendas
    // antigas, e removê-lo apagaria histórico que existe de verdade.
    const [s] = await dono`SELECT count(*)::int AS n FROM sku WHERE tenant_id = ${T}`
    expect(s!.n).toBe(2)
  })

  it('⚠️ dada varredura interrompida, então NÃO desativa nada', async () => {
    await ingerir([[sku({ idExterno: 'S-1' }), sku({ idExterno: 'S-2' })]])

    // Duas páginas, mas para na primeira: simula falha de rede no meio.
    const r = await ingerir(
      [[sku({ idExterno: 'S-1' })], [sku({ idExterno: 'S-2' })]],
      { maxPaginas: 1, desativarAusentes: true },
    )

    // Desativar aqui transformaria uma falha de rede em "o catálogo inteiro
    // foi descontinuado" — e o vendedor abriria a tela sem produto nenhum.
    expect(r.skusDesativados).toBe(0)
    const [s] = await dono`SELECT count(*)::int AS n FROM sku WHERE tenant_id = ${T} AND ativo`
    expect(s!.n).toBe(2)
  })

  it('dado catálogo paginado, então percorre todas as páginas', async () => {
    const r = await ingerir([
      [sku({ idExterno: 'S-1' })],
      [sku({ idExterno: 'S-2', referencia: 'BRUNA', descricao: 'VESTIDO BRUNA' })],
      [sku({ idExterno: 'S-3' })],
    ])
    expect(r).toMatchObject({ lidos: 3, produtosCriados: 2, skusCriados: 3 })
  })
})
