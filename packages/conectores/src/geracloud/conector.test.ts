import { describe, it, expect } from 'vitest'
import { conformidade } from '../conformidade.js'
import { ConectorGeraCloud } from './conector.js'

/**
 * O GeraCloud passa pela mesma suíte que qualquer outro adaptador.
 *
 * ⚠️ O `fetch` é dublado com a forma REAL confirmada pela sonda contra
 * `apresentacao.geracloud.com.br` (`geracloud-explorar`): as listagens são
 * ARRAY CRU (não o envelope `content`/`last` do Spring), a venda usa `valor`,
 * `clientePDV`, `dataVenda` em `DD/MM/YYYY`, `status` e `isRascunho`. Dublar com
 * o formato que eu tinha presumido fazia o teste passar enquanto a carga real
 * gravava lixo.
 */
const respostas: Record<string, unknown> = {
  // Array cru, não { content: [...] }.
  '/clientespdv': [
    {
      id: 4471, nome: 'SATURNO E ALVES', sobrenome: 'LTDA',
      cnpj: '60.631.000/0014-30', telefone: '(81) 99861-7049',
      email: 'apvcprmd@gmail.com', usernameCadastro: 'kahgreys', status: 0,
    },
  ],
  '/estoques': [
    {
      id: 900, quantidade: 3,
      codigoBarra: {
        id: 22625, valor: '7891234567890',
        produto: { referencia: '22625', descricao: 'CONJUNTO LAILA', status: 0 },
        cor: { descricao: 'VERDE' },
        tamanho: { descricao: 'G' },
        subTamanho: { descricao: '42' },
      },
    },
  ],
  '/estoques/tela-venda': {
    content: [{ idCodigoBarra: 22625, codigoBarra: { id: 22625 }, quantidadeDecimal: 3, valorVenda: 146.0 }],
  },
  '/vendas': [
    {
      id: 302, valor: 189.9, status: 'FINALIZADA', usernameVendedor: 'EDUARDA',
      clientePDV: { id: 39, nome: 'Amanda' }, dataVenda: '03/08/2021 09:11:33.788328',
      isRascunho: false,
    },
  ],
}

function dublarCom(mapa: Record<string, unknown>): typeof fetch {
  return (async (url) => {
    const caminho = new URL(String(url)).pathname.replace(/^.*\/api/, '')
    const corpo = mapa[caminho] ?? []
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const criar = (mapa: Record<string, unknown> = respostas) =>
  new ConectorGeraCloud({ baseUrl: 'https://erp.exemplo/api', token: 'dublê', buscar: dublarCom(mapa) })

conformidade(() => criar())

describe('GeraCloud — parsing contra a forma REAL (sonda)', () => {
  it('⚠️ listagem é array cru — o parser não pode esperar {content}', async () => {
    const p = await criar().listarClientes()
    // Com o parser antigo (dados.content), isto viria vazio e a carga
    // importaria zero cliente sem erro nenhum.
    expect(p.itens).toHaveLength(1)
    expect(p.itens[0]!.idExterno).toBe('4471')
  })

  it('cliente: nome+sobrenome, documento e telefone normalizados', async () => {
    const [c] = (await criar().listarClientes()).itens
    expect(c!.nome).toBe('SATURNO E ALVES LTDA')
    expect(c!.documento).toBe('60631000001430')
    expect(c!.telefones).toEqual(['81998617049'])
    // ⚠️ Cliente não carrega vendedor — a carteira vem da venda.
    expect(c!.vendedorExterno).toBeUndefined()
  })

  it('SKU é o codigoBarra, com cor/tamanho/subTamanho abertos', async () => {
    const [s] = (await criar().listarSkus()).itens
    expect(s!.idExterno).toBe('22625')
    expect(s!.referencia).toBe('22625')
    expect(s!.atributos).toEqual({ cor: 'VERDE', tamanho: 'G', subTamanho: '42' })
    expect(s!.codigoBarras).toBe('7891234567890')
  })

  describe('vendas — onde meus chutes estavam errados', () => {
    it('⚠️ valor (não valorTotal), clientePDV (não cliente), data DD/MM/YYYY', async () => {
      const [v] = (await criar().listarVendas(new Date('2020-01-01'))).itens
      // valorTotal não existe → o parser antigo importaria 0.
      expect(v!.valorCentavos).toBe(18990)
      // cliente não existe → o parser antigo deixaria "sem contato".
      expect(v!.clienteExterno).toBe('39')
      // "03/08/2021" é 3 de AGOSTO — new Date() interpretaria como 8 de março.
      expect(v!.ocorridaEm.getFullYear()).toBe(2021)
      expect(v!.ocorridaEm.getMonth()).toBe(7) // agosto (0-based)
      expect(v!.ocorridaEm.getDate()).toBe(3)
      expect(v!.canceladaEm).toBeUndefined()
    })

    it('⚠️ status CANCELADA → entra com canceladaEm (para conciliar, fora do RFV)', async () => {
      const [v] = (await criar({
        '/vendas': [{ id: 500, valor: 10, status: 'CANCELADA', clientePDV: { id: 39 }, dataVenda: '03/08/2021 09:11:33.0', isRascunho: false }],
      }).listarVendas(new Date('2020-01-01'))).itens
      expect(v!.canceladaEm).toBeInstanceOf(Date)
    })

    it('⚠️ isRascunho → NÃO vira venda (rascunho não é faturamento)', async () => {
      const p = await criar({
        '/vendas': [
          { id: 1, valor: 50, status: 'FINALIZADA', clientePDV: { id: 39 }, dataVenda: '01/02/2024 10:00:00.0', isRascunho: true },
          { id: 2, valor: 70, status: 'FINALIZADA', clientePDV: { id: 40 }, dataVenda: '01/02/2024 11:00:00.0', isRascunho: false },
        ],
      }).listarVendas(new Date('2020-01-01'))
      expect(p.itens.map((v) => v.idExterno)).toEqual(['2'])
    })

    it('data inválida vira Invalid Date — a ingestão rejeita, não inventa', async () => {
      const [v] = (await criar({
        '/vendas': [{ id: 9, valor: 10, status: 'FINALIZADA', clientePDV: { id: 1 }, dataVenda: 'sem data', isRascunho: false }],
      }).listarVendas(new Date('2020-01-01'))).itens
      expect(Number.isNaN(v!.ocorridaEm.getTime())).toBe(true)
    })
  })

  it('⚠️ página cheia (>= 200) devolve cursor; parcial encerra', async () => {
    const cheia = Array.from({ length: 200 }, (_, i) => ({ id: i, nome: `C${i}`, status: 0 }))
    const p = await criar({ '/clientespdv': cheia }).listarClientes()
    // Sem cursor numa página cheia, uma base grande seria truncada em silêncio.
    // ⚠️ Cursor é OFFSET em linhas (inicio/limite), não número de página.
    expect(p.cursor).toBe('200')

    const parcial = await criar({ '/clientespdv': cheia.slice(0, 5) }).listarClientes()
    expect(parcial.cursor).toBeUndefined()
  })

  it('⚠️ usa inicio/limite e dataInicial em DD/MM/YYYY — não page/size/ISO', async () => {
    // Confirmado ao vivo: page/size e ISO são ignorados pelo ERP. Se alguém
    // reintroduzir, a carga volta a trazer 5 vendas achando que trouxe tudo.
    let urlVendas = ''
    const espiao: typeof fetch = (async (url: string | URL | Request) => {
      urlVendas = String(url)
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const c = new ConectorGeraCloud({ baseUrl: 'https://erp.exemplo/api', token: 't', buscar: espiao })

    await c.listarVendas(new Date(Date.UTC(2026, 0, 1)))
    expect(urlVendas).toContain('inicio=0')
    expect(urlVendas).toContain('limite=200')
    expect(urlVendas).toContain('dataInicial=01/01/2026')
    expect(urlVendas).not.toContain('page=')
    expect(urlVendas).not.toContain('2026-01-01') // ISO seria ignorado pelo ERP
  })
})
