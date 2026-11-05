import { normalizarDocumento, validarCnpj, validarCpf } from './documento.js'
import { normalizarTelefone } from './telefone.js'

/**
 * Regras PURAS dos formulários públicos (F3): estrutura do builder, visibilidade condicional e
 * validação das respostas. Uma só implementação para a API (que decide) e para o console (que só
 * antecipa o erro e esconde o que a condicional esconde) — a API é a regra, a tela é conveniência.
 */

export const TIPOS_CAMPO = [
  'texto', 'texto_longo', 'numero', 'moeda', 'data', 'telefone', 'email', 'cpf', 'cnpj',
  'selecao', 'selecao_condicional', 'escolha_unica', 'multipla', 'anexo',
] as const
export type TipoCampo = (typeof TIPOS_CAMPO)[number]

export const TIPOS_FORMULARIO = ['cadastro', 'qualificacao', 'documentacao', 'pos_venda', 'outro'] as const
export type TipoFormulario = (typeof TIPOS_FORMULARIO)[number]

export const MAX_CAMPOS_FORMULARIO = 60
export const MAX_OPCOES_CAMPO = 100
const TIPOS_COM_OPCOES: readonly TipoCampo[] = ['selecao', 'selecao_condicional', 'escolha_unica', 'multipla']

export const temOpcoes = (t: TipoCampo): boolean => TIPOS_COM_OPCOES.includes(t)

export interface CampoFormulario {
  id: string
  tipo: TipoCampo
  rotulo: string
  placeholder?: string | null
  obrigatorio: boolean
  opcoes: string[]
  /** selecao_condicional: opção → ids dos campos exibidos quando ela está escolhida. */
  condicoes: Record<string, string[]>
  referencia: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export type ErrosCampos = Record<string, string>

/** Ids dos campos que alguma condicional controla (só aparecem quando a opção os liga). */
export function camposControlados(campos: readonly CampoFormulario[]): Set<string> {
  const s = new Set<string>()
  for (const c of campos) {
    if (c.tipo !== 'selecao_condicional') continue
    for (const ids of Object.values(c.condicoes)) for (const id of ids) s.add(id)
  }
  return s
}

const valorTexto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Quais campos o preenchedor VÊ, dado o que já escolheu.
 *
 * Campo controlado só aparece se algum controlador VISÍVEL tem, escolhida, uma opção que o liga.
 * Ciclo (A liga B, B liga A) nunca fica visível — e a validação da estrutura recusa o ciclo.
 */
export function camposVisiveis(
  campos: readonly CampoFormulario[], valores: Record<string, unknown>,
): CampoFormulario[] {
  const controlados = camposControlados(campos)
  const porId = new Map(campos.map((c) => [c.id, c]))
  const memo = new Map<string, boolean>()
  const visitando = new Set<string>()

  const visivel = (id: string): boolean => {
    const c = porId.get(id)
    if (!c) return false
    if (!controlados.has(id)) return true
    const guardado = memo.get(id)
    if (guardado !== undefined) return guardado
    if (visitando.has(id)) return false
    visitando.add(id)
    let r = false
    for (const ctrl of campos) {
      if (ctrl.tipo !== 'selecao_condicional' || ctrl.id === id) continue
      const escolhida = valorTexto(valores[ctrl.id])
      if (escolhida && ctrl.condicoes[escolhida]?.includes(id) && visivel(ctrl.id)) { r = true; break }
    }
    visitando.delete(id)
    memo.set(id, r)
    return r
  }
  return campos.filter((c) => visivel(c.id))
}

/** Valida a lista de campos do builder. Devolve mensagens por posição (`campos.<i>`) ou geral (`campos`). */
export function validarEstruturaCampos(campos: readonly CampoFormulario[]): ErrosCampos {
  const erros: ErrosCampos = {}
  if (campos.length === 0) return { campos: 'Adicione ao menos um campo.' }
  if (campos.length > MAX_CAMPOS_FORMULARIO) return { campos: `No máximo ${MAX_CAMPOS_FORMULARIO} campos.` }

  const ids = new Set<string>()
  campos.forEach((c, i) => {
    const k = `campos.${i}`
    if (!UUID.test(c.id) || ids.has(c.id)) { erros[k] = 'Identificador do campo inválido ou repetido.'; return }
    ids.add(c.id)
    if (!(TIPOS_CAMPO as readonly string[]).includes(c.tipo)) { erros[k] = 'Tipo de campo inválido.'; return }
    if (!c.rotulo.trim() || c.rotulo.trim().length > 160) { erros[k] = 'Informe o rótulo (até 160 caracteres).'; return }
    if (temOpcoes(c.tipo)) {
      const limpas = c.opcoes.map((o) => o.trim())
      if (limpas.length === 0 || limpas.some((o) => !o || o.length > 100)) { erros[k] = 'Informe as opções (até 100 caracteres cada).'; return }
      if (limpas.length > MAX_OPCOES_CAMPO) { erros[k] = `No máximo ${MAX_OPCOES_CAMPO} opções.`; return }
      if (new Set(limpas.map((o) => o.toLowerCase())).size !== limpas.length) { erros[k] = 'Há opções repetidas.'; return }
    } else if (c.opcoes.length > 0) { erros[k] = 'Este tipo de campo não tem opções.'; return }
    if (c.tipo !== 'selecao_condicional' && Object.keys(c.condicoes).length > 0) { erros[k] = 'Só a seleção condicional tem condições.'; return }
  })

  campos.forEach((c, i) => {
    const k = `campos.${i}`
    if (erros[k] || c.tipo !== 'selecao_condicional') return
    for (const [opcao, alvos] of Object.entries(c.condicoes)) {
      if (!c.opcoes.some((o) => o.trim() === opcao)) { erros[k] = `A condição "${opcao}" não é uma opção do campo.`; return }
      if (!Array.isArray(alvos) || alvos.some((a) => typeof a !== 'string' || !ids.has(a))) { erros[k] = 'A condição aponta para campo que não existe neste formulário.'; return }
      if (alvos.includes(c.id)) { erros[k] = 'Um campo não pode depender de si mesmo.'; return }
    }
  })

  // Ciclo entre condicionais: ninguém sairia do estado "escondido".
  if (Object.keys(erros).length === 0) {
    const arestas = new Map<string, string[]>()
    for (const c of campos) {
      if (c.tipo === 'selecao_condicional') arestas.set(c.id, Object.values(c.condicoes).flat())
    }
    const estado = new Map<string, 1 | 2>()
    const temCiclo = (id: string): boolean => {
      if (estado.get(id) === 2) return false
      if (estado.get(id) === 1) return true
      estado.set(id, 1)
      for (const prox of arestas.get(id) ?? []) if (temCiclo(prox)) return true
      estado.set(id, 2)
      return false
    }
    if ([...arestas.keys()].some(temCiclo)) erros['campos'] = 'As condições formam um ciclo.'
  }

  const refs = campos.map((c, i) => [c, i] as const).filter(([c]) => c.referencia)
  if (refs.length > 1) erros[`campos.${refs[1]![1]}`] = 'Só um campo pode ser a referência (nome do contato).'
  for (const [c, i] of refs) {
    if (c.tipo !== 'texto') erros[`campos.${i}`] = 'A referência (nome do contato) tem de ser um campo de texto.'
  }

  const controlados = camposControlados(campos)
  const tel = campos.find((c) => c.tipo === 'telefone')
  if (!tel) erros['campos'] = erros['campos'] ?? 'Inclua um campo de telefone: é por ele que o contato é identificado.'
  else if (controlados.has(tel.id)) {
    erros[`campos.${campos.indexOf(tel)}`] = 'O telefone de identificação não pode depender de uma condição.'
  }
  return erros
}

export interface RespostaValidada {
  /** Só os campos visíveis, já normalizados (E.164 para telefone, dígitos para cpf/cnpj, centavos para moeda). */
  valores: Record<string, string | number | string[]>
}

/**
 * Valida o que foi preenchido contra a definição.
 *
 * ⚠️ Campo escondido pela condicional NÃO é exigido e o valor que vier dele é DESCARTADO —
 * senão um cliente forjado gravaria resposta de campo que a pessoa nunca viu.
 * `anexosEnviados` são os ids de campo `anexo` cujo arquivo veio no envio.
 */
export function validarRespostas(
  campos: readonly CampoFormulario[], brutos: Record<string, unknown>, anexosEnviados: ReadonlySet<string> = new Set(),
): { ok: true; dados: RespostaValidada } | { ok: false; campos: ErrosCampos } {
  const erros: ErrosCampos = {}
  const valores: Record<string, string | number | string[]> = {}
  for (const c of camposVisiveis(campos, brutos)) {
    const bruto = brutos[c.id]
    if (c.tipo === 'anexo') {
      if (c.obrigatorio && !anexosEnviados.has(c.id)) erros[c.id] = 'Anexe o arquivo.'
      continue
    }
    if (c.tipo === 'multipla') {
      const lista = Array.isArray(bruto) ? bruto.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : []
      if (lista.length === 0) { if (c.obrigatorio) erros[c.id] = 'Escolha ao menos uma opção.'; continue }
      if (lista.some((x) => !c.opcoes.includes(x))) { erros[c.id] = 'Opção inválida.'; continue }
      valores[c.id] = [...new Set(lista)]
      continue
    }
    const vazio = bruto === undefined || bruto === null || (typeof bruto === 'string' && bruto.trim() === '')
    if (vazio) { if (c.obrigatorio) erros[c.id] = 'Campo obrigatório.'; continue }

    switch (c.tipo) {
      case 'texto': case 'texto_longo': {
        const t = valorTexto(bruto)
        if (typeof bruto !== 'string') { erros[c.id] = 'Valor inválido.'; break }
        if (t.length > (c.tipo === 'texto' ? 300 : 4000)) { erros[c.id] = 'Texto longo demais.'; break }
        valores[c.id] = t
        break
      }
      case 'numero': {
        const n = typeof bruto === 'number' ? bruto : Number(String(bruto).replace(',', '.'))
        if (!Number.isFinite(n)) erros[c.id] = 'Informe um número.'
        else valores[c.id] = n
        break
      }
      case 'moeda': {
        const n = typeof bruto === 'number' ? bruto : Number(bruto)
        if (!Number.isInteger(n) || n < 0 || n > 1e12) erros[c.id] = 'Informe um valor válido.'
        else valores[c.id] = n // centavos inteiros
        break
      }
      case 'data': {
        const t = valorTexto(bruto)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) erros[c.id] = 'Informe uma data válida.'
        else valores[c.id] = t
        break
      }
      case 'telefone': {
        const tel = normalizarTelefone(String(bruto))
        if (!tel) erros[c.id] = 'Informe um telefone válido, com DDD.'
        else valores[c.id] = tel.e164
        break
      }
      case 'email': {
        const t = valorTexto(bruto)
        if (!EMAIL.test(t) || t.length > 180) erros[c.id] = 'Informe um e-mail válido.'
        else valores[c.id] = t.toLowerCase()
        break
      }
      case 'cpf': {
        if (!validarCpf(String(bruto))) erros[c.id] = 'CPF inválido.'
        else valores[c.id] = normalizarDocumento('cpf', String(bruto)) ?? ''
        break
      }
      case 'cnpj': {
        if (!validarCnpj(String(bruto))) erros[c.id] = 'CNPJ inválido.'
        else valores[c.id] = normalizarDocumento('cnpj', String(bruto)) ?? ''
        break
      }
      case 'selecao': case 'selecao_condicional': case 'escolha_unica': {
        const t = valorTexto(bruto)
        if (!c.opcoes.includes(t)) erros[c.id] = 'Opção inválida.'
        else valores[c.id] = t
        break
      }
    }
  }
  return Object.keys(erros).length > 0 ? { ok: false, campos: erros } : { ok: true, dados: { valores } }
}

/** Troca de posição na lista (builder). Fora dos limites devolve a lista como está. */
export function moverCampo<T>(lista: readonly T[], de: number, para: number): T[] {
  if (de < 0 || de >= lista.length || para < 0 || para >= lista.length || de === para) return [...lista]
  const copia = [...lista]
  const [x] = copia.splice(de, 1)
  copia.splice(para, 0, x as T)
  return copia
}

/** Slug a partir do nome: minúsculo, sem acento, hífen entre palavras, até 80. */
export function slugDeNome(nome: string): string {
  const s = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
  return s || 'formulario'
}
