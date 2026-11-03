import {
  MAX_CAMPOS_FORMULARIO, camposControlados, camposVisiveis, moverCampo, temOpcoes, validarEstruturaCampos, validarRespostas,
  type CampoFormulario, type TipoCampo, type TipoFormulario,
} from '@geracrm/shared'

/**
 * Regras PURAS do builder e da renderização dos formulários públicos (F3). A API é a regra
 * (`@geracrm/shared` é a mesma que ela usa); aqui só se prepara a tela: paleta, edição da lista de
 * campos, condicionais e os textos do "Incorporar". Testável sem DOM.
 */

export { camposVisiveis, camposControlados, temOpcoes, validarEstruturaCampos, MAX_CAMPOS_FORMULARIO }
export type { CampoFormulario, TipoCampo, TipoFormulario }

export const ROTULO_TIPO_CAMPO: Record<TipoCampo, string> = {
  texto: 'Texto curto', texto_longo: 'Texto longo', numero: 'Número', moeda: 'Valor em R$', data: 'Data',
  telefone: 'Telefone', email: 'E-mail', cpf: 'CPF', cnpj: 'CNPJ', selecao: 'Lista de opções',
  selecao_condicional: 'Lista condicional', escolha_unica: 'Escolha única', multipla: 'Múltipla escolha', anexo: 'Anexo',
}

export const PALETA_CAMPOS: readonly TipoCampo[] = [
  'texto', 'texto_longo', 'telefone', 'email', 'cpf', 'cnpj', 'numero', 'moeda', 'data',
  'selecao', 'selecao_condicional', 'escolha_unica', 'multipla', 'anexo',
]

export const ROTULO_TIPO_FORM: Record<TipoFormulario, string> = {
  cadastro: 'Cadastro', qualificacao: 'Qualificação', documentacao: 'Documentação', pos_venda: 'Pós-venda', outro: 'Outro',
}
export const TIPOS_FORM: readonly TipoFormulario[] = ['cadastro', 'qualificacao', 'documentacao', 'pos_venda', 'outro']

/** Cores do formulário: nomes de token (a tela nunca guarda hex). */
export const CORES_FORM: readonly { valor: string; rotulo: string }[] = [
  { valor: 'acao', rotulo: 'Laranja (padrão)' }, { valor: 'sucesso', rotulo: 'Verde' }, { valor: 'atencao', rotulo: 'Amarelo' },
  { valor: 'erro', rotulo: 'Vermelho' }, { valor: 'ia', rotulo: 'Roxo' }, { valor: 'neutro', rotulo: 'Cinza' },
]
/**
 * Nome do token → fundo e texto do botão do formulário público. Cor desconhecida cai na de ação.
 * Texto escuro só onde o fundo é claro o bastante (ação, atenção, sucesso).
 */
export function estiloDoBotao(cor: string): { fundo: string; texto: string } {
  const c = CORES_FORM.some((x) => x.valor === cor) ? cor : 'acao'
  const fundo = c === 'neutro' ? 'var(--texto-suave)' : `var(--${c})`
  const claro = c === 'acao' || c === 'atencao' || c === 'sucesso'
  return { fundo, texto: claro ? 'var(--acao-texto)' : 'var(--superficie-elevada)' }
}

export function novoId(): string {
  return crypto.randomUUID()
}

export function novoCampo(tipo: TipoCampo, id: string = novoId()): CampoFormulario {
  return {
    id, tipo, rotulo: ROTULO_TIPO_CAMPO[tipo], placeholder: null, obrigatorio: tipo === 'telefone',
    opcoes: temOpcoes(tipo) ? ['Opção 1', 'Opção 2'] : [], condicoes: {}, referencia: false,
  }
}

/** Acrescenta ao fim. No limite devolve a lista como está. */
export function adicionarCampo(lista: readonly CampoFormulario[], campo: CampoFormulario): CampoFormulario[] {
  return lista.length >= MAX_CAMPOS_FORMULARIO ? [...lista] : [...lista, campo]
}

/** Remove o campo e limpa qualquer condição que o apontava (senão a API recusaria "campo que não existe"). */
export function removerCampo(lista: readonly CampoFormulario[], id: string): CampoFormulario[] {
  return lista.filter((c) => c.id !== id).map((c) => c.tipo === 'selecao_condicional'
    ? { ...c, condicoes: Object.fromEntries(Object.entries(c.condicoes).map(([o, ids]) => [o, ids.filter((x) => x !== id)])) }
    : c)
}

export function moverPorId(lista: readonly CampoFormulario[], id: string, delta: -1 | 1): CampoFormulario[] {
  const i = lista.findIndex((c) => c.id === id)
  return i < 0 ? [...lista] : moverCampo(lista, i, i + delta)
}

/** Troca um campo. Mudar o tipo recompõe as opções/condições que deixam de fazer sentido. */
export function atualizarCampo(
  lista: readonly CampoFormulario[], id: string, mudanca: Partial<CampoFormulario>,
): CampoFormulario[] {
  return lista.map((c) => {
    if (c.id !== id) return c
    const novo = { ...c, ...mudanca }
    if (!temOpcoes(novo.tipo)) { novo.opcoes = []; novo.condicoes = {} }
    else if (novo.opcoes.length === 0) novo.opcoes = ['Opção 1']
    if (novo.tipo !== 'selecao_condicional') novo.condicoes = {}
    else novo.condicoes = Object.fromEntries(Object.entries(novo.condicoes).filter(([o]) => novo.opcoes.includes(o)))
    if (novo.tipo !== 'texto') novo.referencia = false
    return novo
  })
}

/** A referência é única: marcar uma desmarca a anterior; marcar de novo a desmarca. */
export function alternarReferencia(lista: readonly CampoFormulario[], id: string): CampoFormulario[] {
  const atual = lista.find((c) => c.id === id)
  if (!atual || atual.tipo !== 'texto') return [...lista]
  return lista.map((c) => ({ ...c, referencia: c.id === id ? !c.referencia : false }))
}

/** Opções digitadas uma por linha → lista limpa, sem vazias nem repetidas. */
export function opcoesDeTexto(texto: string): string[] {
  const vistas = new Set<string>()
  const r: string[] = []
  for (const l of texto.split('\n')) {
    const o = l.trim().slice(0, 100)
    if (o && !vistas.has(o.toLowerCase())) { vistas.add(o.toLowerCase()); r.push(o) }
  }
  return r.slice(0, 100)
}

/** Liga/desliga o campo `alvo` para a `opcao` da condicional. */
export function alternarCondicao(campo: CampoFormulario, opcao: string, alvo: string): Record<string, string[]> {
  const atual = campo.condicoes[opcao] ?? []
  const novo = atual.includes(alvo) ? atual.filter((x) => x !== alvo) : [...atual, alvo]
  return { ...campo.condicoes, [opcao]: novo }
}

/** Campos que podem ser ligados por esta condicional: todos os outros, exceto o telefone de identificação. */
export function alvosPossiveis(lista: readonly CampoFormulario[], controlador: CampoFormulario): CampoFormulario[] {
  const tel = lista.find((c) => c.tipo === 'telefone')
  return lista.filter((c) => c.id !== controlador.id && c.id !== tel?.id)
}

/** Erros da API/validação (`campos.<i>`) → por id de campo, para pintar no card certo. */
export function errosPorIdDeCampo(erros: Record<string, string>, lista: readonly CampoFormulario[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (const [k, msg] of Object.entries(erros)) {
    const m = /^campos\.(\d+)$/.exec(k)
    const c = m ? lista[Number(m[1])] : undefined
    if (c) r[c.id] = msg
  }
  return r
}

export function linkPublico(origem: string, chave: string): string {
  return `${origem.replace(/\/$/, '')}/f/${chave}`
}
export function linkIncorporado(origem: string, chave: string): string {
  return `${linkPublico(origem, chave)}?embed=1`
}
export function snippetIframe(url: string, titulo: string): string {
  const t = titulo.replace(/"/g, '&quot;')
  return `<iframe src="${url}" title="${t}" width="100%" height="720" style="border:0;max-width:640px" loading="lazy"></iframe>`
}

export interface FormularioDefinicao {
  titulo: string; descricao: string | null; cor: string; textoBotao: string
  campos: CampoFormulario[]; textoConsentimento: string; armadilha: string
  /** Devolvido no envio: a API confere que a pessoa aceitou ESTE texto (409 `formulario.texto_mudou` se mudou). */
  textoConsentimentoHash: string
}

/** Formato da chave pública (o mesmo que a API e o nginx aceitam). Fora dele, nem chama a API. */
export const CHAVE_PUBLICA_VALIDA = /^[a-z0-9]{16,40}$/

export type EnvioPronto =
  | { ok: true; respostas: Record<string, unknown>; anexos: Map<string, File> }
  | { ok: false; erros: Record<string, string> }

/**
 * Prepara o envio: só os campos VISÍVEIS (a condicional esconde, a API também descartaria), dinheiro em
 * centavos inteiros, e a mesma validação da API para antecipar o erro — a API continua sendo a regra.
 */
/** Os mesmos tetos da API (10 MB por arquivo, 20 MB no envio): aqui é conveniência, lá é a regra. */
export const MAX_BYTES_ANEXO = 10 * 1024 * 1024
export const MAX_BYTES_ENVIO = 20 * 1024 * 1024

export function prepararEnvio(
  campos: readonly CampoFormulario[], valores: Record<string, unknown>, arquivos: ReadonlyMap<string, File>,
  consentimento: boolean, reaisParaCentavos: (t: string) => number | null,
): EnvioPronto {
  const visiveis = camposVisiveis(campos, valores)
  const respostas: Record<string, unknown> = {}
  const anexos = new Map<string, File>()
  for (const c of visiveis) {
    if (c.tipo === 'anexo') { const a = arquivos.get(c.id); if (a) anexos.set(c.id, a); continue }
    const v = valores[c.id]
    if (v === undefined) continue
    respostas[c.id] = c.tipo === 'moeda' && typeof v === 'string' ? (v.trim() ? reaisParaCentavos(v) : '') : v
  }
  const r = validarRespostas(campos, respostas, new Set(anexos.keys()))
  const erros: Record<string, string> = r.ok ? {} : { ...r.campos }
  let total = 0
  for (const [campoId, a] of anexos) {
    total += a.size
    if (a.size > MAX_BYTES_ANEXO) erros[campoId] = 'O arquivo passa de 10 MB.'
  }
  if (total > MAX_BYTES_ENVIO) {
    const ultimo = [...anexos.keys()].pop()
    if (ultimo && !erros[ultimo]) erros[ultimo] = 'Os arquivos passam de 20 MB no total.'
  }
  if (!consentimento) erros['consentimento'] = 'É preciso aceitar o aviso de privacidade para enviar.'
  return Object.keys(erros).length > 0 ? { ok: false, erros } : { ok: true, respostas, anexos }
}

/** Resposta gravada → texto da célula da tabela de respostas (dinheiro em reais, lista com " | ", anexo pelo nome). */
export function textoDaResposta(campo: CampoFormulario, valor: unknown): string {
  if (valor === undefined || valor === null) return ''
  if (campo.tipo === 'multipla' && Array.isArray(valor)) return valor.join(' | ')
  if (campo.tipo === 'moeda' && typeof valor === 'number') return (valor / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  if (campo.tipo === 'anexo' && typeof valor === 'object') return String((valor as { nome?: unknown }).nome ?? '')
  if (campo.tipo === 'data' && typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor.split('-').reverse().join('/')
  return String(valor)
}

/** Colunas de campo que cabem na tela; o resto fica para o CSV (que leva todas). */
export const MAX_COLUNAS_RESPOSTA = 5
export const camposDaTabela = (campos: readonly CampoFormulario[]): CampoFormulario[] =>
  campos.filter((c) => c.tipo !== 'anexo').slice(0, MAX_COLUNAS_RESPOSTA)
