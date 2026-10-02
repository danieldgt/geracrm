import { describe, it, expect } from 'vitest'
import {
  corpoParaEdicao, formDeProduto, formDeSku, produtoVazio, rotuloSku, skuEstaVazio, skuVazio,
  validarProduto, validarSku, type ProdutoForm, type SkuForm,
} from './catalogo-produtos.regras.js'

const sku = (p: Partial<SkuForm> = {}): SkuForm => ({ ...skuVazio(), ...p })
const produto = (p: Partial<ProdutoForm> = {}): ProdutoForm => ({ ...produtoVazio(), skus: [], ...p })

describe('validarSku — o que a tela digita vira skuEntrada', () => {
  it('monta atributos, preços em centavos e saldo', () => {
    const v = validarSku(sku({
      atributos: [{ chave: 'cor', valor: ' VERDE ' }, { chave: 'tamanho', valor: 'G' }],
      codigoBarras: '789', precoVarejo: '12,50', precoAtacado: '9,90', controlaEstoque: true, saldo: '15',
    }))
    expect(v).toEqual({ ok: true, corpo: {
      atributos: { cor: 'VERDE', tamanho: 'G' }, codigoBarras: '789',
      precos: { varejo: 1250, atacado: 990 }, saldo: 15,
    } })
  })

  it('"não controla estoque" manda saldo null; atributo sugerido sem valor não entra', () => {
    const v = validarSku(sku({ precoAtacado: '100' }))
    expect(v).toEqual({ ok: true, corpo: { atributos: {}, precos: { atacado: 10000 }, saldo: null } })
  })

  it('preço inválido é erro nomeado no campo, com prefixo', () => {
    const v = validarSku(sku({ precoVarejo: 'abc' }), 'skus.2.')
    expect(v).toEqual({ ok: false, erros: { 'skus.2.precoVarejo': 'Preço inválido. Use o formato 12,50.' } })
  })

  it('controla estoque sem saldo é erro; saldo negativo também', () => {
    expect(validarSku(sku({ controlaEstoque: true, saldo: '' })).ok).toBe(false)
    expect(validarSku(sku({ controlaEstoque: true, saldo: '-1' })).ok).toBe(false)
    expect(validarSku(sku({ controlaEstoque: true, saldo: '0' }))).toMatchObject({ ok: true, corpo: { saldo: 0 } })
  })

  it('valor sem nome de atributo é erro', () => {
    const v = validarSku(sku({ atributos: [{ chave: '', valor: 'X' }] }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.erros['atributos']).toMatch(/nome/)
  })
})

describe('validarProduto — criação', () => {
  it('exige referência e descrição', () => {
    const v = validarProduto(produto())
    expect(v).toEqual({ ok: false, erros: {
      referencia: 'Informe a referência (o código do produto).', descricao: 'Informe a descrição.',
    } })
  })

  it('monta o corpo com imagens por linha e SKUs válidos; SKU totalmente vazio é ignorado', () => {
    const v = validarProduto(produto({
      referencia: ' REF-1 ', descricao: 'Camisa', descricaoLonga: 'Algodão', categoria: 'Camisas',
      imagens: 'https://a/1.jpg\n\n https://a/2.jpg ',
      skus: [sku(), sku({ atributos: [{ chave: 'cor', valor: 'AZUL' }], precoAtacado: '50' })],
    }))
    expect(v).toEqual({ ok: true, corpo: {
      referencia: 'REF-1', descricao: 'Camisa', descricaoLonga: 'Algodão', categoria: 'Camisas',
      imagens: ['https://a/1.jpg', 'https://a/2.jpg'],
      skus: [{ atributos: { cor: 'AZUL' }, precos: { atacado: 5000 }, saldo: null }],
    } })
  })

  it('imagem que não é URL é erro no campo imagens', () => {
    const v = validarProduto(produto({ referencia: 'R', descricao: 'D', imagens: 'foto.jpg' }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(Object.keys(v.erros)).toEqual(['imagens'])
  })

  it('erro de SKU vem com o índice no nome do campo', () => {
    const v = validarProduto(produto({ referencia: 'R', descricao: 'D', skus: [sku(), sku({ precoVarejo: 'x' })] }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(Object.keys(v.erros)).toEqual(['skus.1.precoVarejo'])
  })

  it('sem SKU válido o corpo não leva a chave skus', () => {
    const v = validarProduto(produto({ referencia: 'R', descricao: 'D', skus: [sku()] }))
    expect(v.ok && 'skus' in v.corpo).toBe(false)
  })
})

describe('corpoParaEdicao — produto do ERP só muda o que o ERP não tem', () => {
  const f = produto({ referencia: 'NOVA', descricao: 'Nova', descricaoLonga: 'L', categoria: 'C', imagens: '' })
  it('⚠️ origem erp: corpo sem referência/descrição, senão a API responde 409', () => {
    expect(corpoParaEdicao(f, 'erp')).toEqual({ ok: true, corpo: { descricaoLonga: 'L', categoria: 'C', imagens: [] } })
  })
  it('origem manual: tudo vai, e referência continua obrigatória', () => {
    expect(corpoParaEdicao(f, 'manual')).toEqual({ ok: true, corpo: {
      referencia: 'NOVA', descricao: 'Nova', descricaoLonga: 'L', categoria: 'C', imagens: [],
    } })
    expect(corpoParaEdicao({ ...f, referencia: '' }, 'manual').ok).toBe(false)
  })
})

describe('preencher o form a partir da API', () => {
  it('formDeProduto junta imagens por linha e troca null por vazio', () => {
    expect(formDeProduto({ referencia: 'R', descricao: 'D', descricaoLonga: null, categoria: null, imagens: ['u1', 'u2'] }))
      .toEqual({ referencia: 'R', descricao: 'D', descricaoLonga: '', categoria: '', imagens: 'u1\nu2', skus: [] })
  })
  it('formDeSku traz os dois preços em R$ e garante cor/tamanho como linhas', () => {
    const f = formDeSku({ id: 's1', atributos: { ciclo: 'mensal' }, codigoBarras: null, saldo: null }, { varejo: 1250, atacado: null })
    expect(f.atributos).toEqual([{ chave: 'ciclo', valor: 'mensal' }, { chave: 'cor', valor: '' }, { chave: 'tamanho', valor: '' }])
    expect(f.precoVarejo).toBe('12,50'); expect(f.precoAtacado).toBe('')
    expect(f.controlaEstoque).toBe(false)
    expect(formDeSku({ id: 's', atributos: {}, saldo: 3 }, { varejo: null, atacado: null })).toMatchObject({ controlaEstoque: true, saldo: '3' })
  })
})

describe('utilitários', () => {
  it('skuEstaVazio ignora atributos sugeridos sem valor', () => {
    expect(skuEstaVazio(skuVazio())).toBe(true)
    expect(skuEstaVazio(sku({ precoAtacado: '1' }))).toBe(false)
  })
  it('rotuloSku ordena cor, tamanho e depois o resto nomeado', () => {
    expect(rotuloSku({ tamanho: 'G', cor: 'AZUL', ciclo: 'mensal' })).toBe('AZUL · G · ciclo: mensal')
    expect(rotuloSku({})).toBe('único')
  })
})
