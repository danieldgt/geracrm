import type { OrigemCatalogo, ProdutoEntrada, SkuEntrada } from '@geracrm/shared'
import { centavosParaReais, reaisParaCentavos } from '../../compartilhado/ui/dinheiro.js'

/**
 * Regras PURAS do cadastro manual de catálogo (ADR-025): o que a tela digita →
 * o corpo que a API aceita, com erro por campo. Sem Angular, sem HTTP — testado
 * em catalogo-produtos.regras.spec.ts.
 *
 * ⚠️ Produto do ERP só aceita o que o ERP não tem (descrição longa, imagens,
 * categoria). A tela desabilita o resto; aqui a regra garante que o corpo do
 * PATCH não carrega campo vetado, senão a API responde 409 `catalogo.origem_erp`.
 */

export interface AtributoForm { readonly chave: string; readonly valor: string }

export interface SkuForm {
  /** Id do SKU no servidor; vazio = ainda não existe. */
  readonly id: string
  readonly atributos: readonly AtributoForm[]
  readonly codigoBarras: string
  /** Em R$ como digitado ("12,50"). */
  readonly precoVarejo: string
  readonly precoAtacado: string
  /** false = vende sob demanda (saldo null). */
  readonly controlaEstoque: boolean
  readonly saldo: string
}

export interface ProdutoForm {
  readonly referencia: string
  readonly descricao: string
  readonly descricaoLonga: string
  readonly categoria: string
  /** Uma URL por linha. */
  readonly imagens: string
  readonly skus: readonly SkuForm[]
}

export type Erros = Record<string, string>

export type Validacao<T> =
  | { readonly ok: true; readonly corpo: T }
  | { readonly ok: false; readonly erros: Erros }

/** Campos que o CRM pode mudar num produto que veio do ERP. */
export const CAMPOS_EDITAVEIS_ERP: readonly (keyof ProdutoEntrada)[] = ['descricaoLonga', 'imagens', 'categoria']

export const ATRIBUTOS_SUGERIDOS = ['cor', 'tamanho'] as const

export function skuVazio(): SkuForm {
  return {
    id: '', atributos: ATRIBUTOS_SUGERIDOS.map((chave) => ({ chave, valor: '' })),
    codigoBarras: '', precoVarejo: '', precoAtacado: '', controlaEstoque: false, saldo: '',
  }
}

export function produtoVazio(): ProdutoForm {
  return { referencia: '', descricao: '', descricaoLonga: '', categoria: '', imagens: '', skus: [skuVazio()] }
}

/** Preenche o form a partir do que a API devolveu (edição). */
export function formDeProduto(p: {
  referencia: string; descricao: string; descricaoLonga: string | null; categoria: string | null
  imagens?: readonly string[]; imagem?: string | null
}): ProdutoForm {
  const imagens = p.imagens ?? (p.imagem ? [p.imagem] : [])
  return {
    referencia: p.referencia, descricao: p.descricao, descricaoLonga: p.descricaoLonga ?? '',
    categoria: p.categoria ?? '', imagens: imagens.join('\n'), skus: [],
  }
}

/** Form de um SKU a partir do que a API devolveu, com os dois preços já lidos. */
export function formDeSku(s: {
  id: string; atributos: Record<string, string>; codigoBarras?: string | null; saldo: number | null
}, precos: { varejo: number | null; atacado: number | null }): SkuForm {
  const atributos = Object.entries(s.atributos).map(([chave, valor]) => ({ chave, valor }))
  for (const sug of ATRIBUTOS_SUGERIDOS) if (!atributos.some((a) => a.chave === sug)) atributos.push({ chave: sug, valor: '' })
  return {
    id: s.id, atributos, codigoBarras: s.codigoBarras ?? '',
    precoVarejo: centavosParaReais(precos.varejo), precoAtacado: centavosParaReais(precos.atacado),
    controlaEstoque: s.saldo !== null, saldo: s.saldo === null ? '' : String(s.saldo),
  }
}

const linhasDeImagens = (texto: string): string[] =>
  texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

function ehUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

/** Valida um SKU; `prefixo` nomeia o erro na tela ("skus.0."). */
export function validarSku(s: SkuForm, prefixo = ''): Validacao<SkuEntrada> {
  const erros: Erros = {}
  const atributos: Record<string, string> = {}
  for (const a of s.atributos) {
    const chave = a.chave.trim(), valor = a.valor.trim()
    if (!chave && !valor) continue
    if (!chave) { erros[`${prefixo}atributos`] = 'Dê um nome ao atributo (ex.: cor).'; continue }
    if (!valor) continue // atributo sugerido sem valor: não entra
    if (chave.length > 40 || valor.length > 80) { erros[`${prefixo}atributos`] = 'Atributo longo demais (nome até 40, valor até 80).'; continue }
    atributos[chave] = valor
  }
  const precos: { varejo?: number; atacado?: number } = {}
  for (const perfil of ['varejo', 'atacado'] as const) {
    const texto = perfil === 'varejo' ? s.precoVarejo : s.precoAtacado
    if (!texto.trim()) continue
    const c = reaisParaCentavos(texto)
    if (c === null) erros[`${prefixo}preco${perfil === 'varejo' ? 'Varejo' : 'Atacado'}`] = 'Preço inválido. Use o formato 12,50.'
    else precos[perfil] = c
  }
  let saldo: number | null = null
  if (s.controlaEstoque) {
    const n = Number(s.saldo.trim().replace(',', '.'))
    if (s.saldo.trim() === '' || !Number.isFinite(n) || n < 0) erros[`${prefixo}saldo`] = 'Informe o saldo (0 ou mais) ou desmarque o controle de estoque.'
    else saldo = n
  }
  const codigoBarras = s.codigoBarras.trim()
  if (codigoBarras.length > 40) erros[`${prefixo}codigoBarras`] = 'Código de barras até 40 caracteres.'

  if (Object.keys(erros).length) return { ok: false, erros }
  return {
    ok: true,
    corpo: {
      atributos,
      ...(codigoBarras ? { codigoBarras } : {}),
      precos,
      saldo,
    },
  }
}

/**
 * Valida o produto inteiro (criação). SKUs vazios por completo são ignorados;
 * um produto pode nascer sem SKU e ganhar variações depois.
 */
export function validarProduto(f: ProdutoForm): Validacao<ProdutoEntrada & { skus?: SkuEntrada[] }> {
  const erros: Erros = {}
  const referencia = f.referencia.trim(), descricao = f.descricao.trim()
  if (!referencia) erros['referencia'] = 'Informe a referência (o código do produto).'
  else if (referencia.length > 60) erros['referencia'] = 'Referência até 60 caracteres.'
  if (!descricao) erros['descricao'] = 'Informe a descrição.'
  else if (descricao.length > 160) erros['descricao'] = 'Descrição até 160 caracteres.'
  const extras = validarCamposLivres(f, erros)

  const skus: SkuEntrada[] = []
  f.skus.forEach((s, i) => {
    if (skuEstaVazio(s)) return
    const v = validarSku(s, `skus.${i}.`)
    if (v.ok) skus.push(v.corpo)
    else Object.assign(erros, v.erros)
  })

  if (Object.keys(erros).length) return { ok: false, erros }
  return { ok: true, corpo: { referencia, descricao, ...extras, ...(skus.length ? { skus } : {}) } }
}

/**
 * Corpo do PATCH. Produto do ERP: só os campos que o CRM pode mudar — mandar
 * referência/descrição iguais ainda seria recusado pela API (409).
 */
export function corpoParaEdicao(f: ProdutoForm, origem: OrigemCatalogo): Validacao<Partial<ProdutoEntrada>> {
  const erros: Erros = {}
  const extras = validarCamposLivres(f, erros)
  if (origem === 'manual') {
    const referencia = f.referencia.trim(), descricao = f.descricao.trim()
    if (!referencia) erros['referencia'] = 'Informe a referência (o código do produto).'
    if (!descricao) erros['descricao'] = 'Informe a descrição.'
    if (Object.keys(erros).length) return { ok: false, erros }
    return { ok: true, corpo: { referencia, descricao, ...extras } }
  }
  if (Object.keys(erros).length) return { ok: false, erros }
  return { ok: true, corpo: extras }
}

function validarCamposLivres(f: ProdutoForm, erros: Erros): Pick<ProdutoEntrada, 'descricaoLonga' | 'categoria' | 'imagens'> {
  const descricaoLonga = f.descricaoLonga.trim()
  const categoria = f.categoria.trim()
  const imagens = linhasDeImagens(f.imagens)
  if (descricaoLonga.length > 4000) erros['descricaoLonga'] = 'Descrição longa até 4000 caracteres.'
  if (categoria.length > 80) erros['categoria'] = 'Categoria até 80 caracteres.'
  if (imagens.length > 10) erros['imagens'] = 'No máximo 10 imagens.'
  else if (imagens.some((u) => !ehUrl(u) || u.length > 500)) erros['imagens'] = 'Cada linha precisa ser uma URL http(s) válida.'
  // ⚠️ Campo vazio vai como '' para LIMPAR no PATCH; a API aceita string vazia
  //    com `trim()` (max apenas). Imagens vazias viram lista vazia.
  return { descricaoLonga, categoria, imagens }
}

export function skuEstaVazio(s: SkuForm): boolean {
  return s.atributos.every((a) => !a.valor.trim()) && !s.codigoBarras.trim()
    && !s.precoVarejo.trim() && !s.precoAtacado.trim() && !(s.controlaEstoque && s.saldo.trim())
}

/** Rótulo curto de um SKU para a lista ("VERDE · G"). */
export function rotuloSku(atributos: Record<string, string>): string {
  const ordem = ['cor', 'tamanho']
  const partes: string[] = []
  for (const k of ordem) if (atributos[k]) partes.push(atributos[k]!)
  for (const [k, v] of Object.entries(atributos)) if (!ordem.includes(k) && v) partes.push(`${k}: ${v}`)
  return partes.join(' · ') || 'único'
}
