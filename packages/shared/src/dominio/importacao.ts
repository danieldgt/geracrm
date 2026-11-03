/**
 * IMPORTADOR POR PLANILHA (raia H1) — regras puras, sem banco e sem framework: a API valida e executa,
 * o console usa as MESMAS funções para sugerir o de-para, conferir o que falta e comparar a conferência.
 *
 * ⚠️ TypeScript puro (consumido por Angular, Expo e API).
 */

export const TIPOS_IMPORTACAO = ['contatos', 'vendas', 'tarefas'] as const
export type TipoImportacao = (typeof TIPOS_IMPORTACAO)[number]

export const ESTADOS_IMPORTACAO = ['simulada', 'executando', 'concluida', 'falhou', 'cancelada'] as const
export type EstadoImportacao = (typeof ESTADOS_IMPORTACAO)[number]

export const RESULTADOS_ITEM = ['criado', 'atualizado', 'ignorado', 'rejeitado'] as const
export type ResultadoItem = (typeof RESULTADOS_ITEM)[number]

/** Limites do arquivo (a API recusa acima; o console avisa antes de enviar). */
export const IMPORTACAO_MAX_LINHAS = 50_000
export const IMPORTACAO_MAX_BYTES = 20 * 1024 * 1024
/** Lote de gravação do worker: transações curtas. */
export const IMPORTACAO_LOTE = 500

export const ehTipoImportacao = (v: unknown): v is TipoImportacao =>
  typeof v === 'string' && (TIPOS_IMPORTACAO as readonly string[]).includes(v)

export interface CampoImportacao {
  readonly chave: string
  readonly rotulo: string
  readonly obrigatorio: boolean
  /** Nomes de coluna aceitos (já normalizados por `normalizarCabecalho`). */
  readonly apelidos: readonly string[]
  readonly exemplo: string
}

/** Minúsculas, sem acento e sem pontuação: "E-mail do Vendedor" → "e mail do vendedor". */
export function normalizarCabecalho(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

const campo = (chave: string, rotulo: string, obrigatorio: boolean, exemplo: string, apelidos: string[] = []): CampoImportacao =>
  ({ chave, rotulo, obrigatorio, exemplo, apelidos: apelidos.map(normalizarCabecalho) })

/** Cada tipo declara os campos que aceita; a ordem é a do modelo para baixar. */
export const CAMPOS_IMPORTACAO: Readonly<Record<TipoImportacao, readonly CampoImportacao[]>> = {
  contatos: [
    campo('nome', 'Nome', true, 'Maria Souza', ['nome', 'name', 'cliente', 'contato', 'nome completo']),
    campo('telefone', 'Telefone', true, '(81) 99861-7049', ['telefone', 'celular', 'phone', 'fone', 'tel', 'telefone principal', 'whatsapp']),
    campo('whatsapp', 'Tem WhatsApp (sim/não)', false, 'sim', ['tem whatsapp', 'usa whatsapp', 'zap']),
    campo('email', 'E-mail', false, 'maria@exemplo.com', ['email', 'e-mail', 'e mail', 'correio']),
    campo('razao_social', 'Razão social', false, 'Souza Confecções Ltda', ['razao social', 'razao']),
    campo('nome_fantasia', 'Nome fantasia', false, 'Souza Moda', ['nome fantasia', 'fantasia']),
    campo('documento', 'CPF/CNPJ', false, '11.222.333/0001-81', ['documento', 'cpf cnpj', 'cnpj cpf', 'cnpj', 'cpf', 'doc']),
    campo('cep', 'CEP', false, '50000-000', ['cep']),
    campo('logradouro', 'Logradouro', false, 'Rua das Flores', ['logradouro', 'rua', 'endereco']),
    campo('numero', 'Número', false, '120', ['numero', 'num', 'nro']),
    campo('complemento', 'Complemento', false, 'Sala 2', ['complemento']),
    campo('bairro', 'Bairro', false, 'Boa Vista', ['bairro']),
    campo('cidade', 'Cidade', false, 'Recife', ['cidade', 'municipio']),
    campo('uf', 'UF', false, 'PE', ['uf', 'estado']),
    campo('origem', 'Origem', false, 'Instagram', ['origem', 'canal de origem', 'fonte']),
    campo('etiquetas', 'Etiquetas (separadas por |)', false, 'atacado|vip', ['etiquetas', 'etiqueta', 'tags', 'tag']),
    campo('vendedor', 'Vendedor (e-mail)', false, 'vendedor@empresa.com', ['vendedor', 'e-mail do vendedor', 'email do vendedor', 'responsavel', 'carteira']),
    campo('qualificacao', 'Qualificação (novo/qualificado/descartado)', false, 'qualificado', ['qualificacao', 'qualificado', 'status do lead']),
    campo('observacoes', 'Observações', false, 'Prefere contato à tarde', ['observacoes', 'observacao', 'obs', 'anotacoes']),
    campo('criado_em', 'Criado em', false, '15/03/2024', ['criado em', 'data de cadastro', 'data cadastro', 'cadastrado em']),
  ],
  vendas: [
    campo('telefone', 'Telefone do contato', false, '(81) 99861-7049', ['telefone', 'celular', 'fone', 'tel', 'telefone do contato']),
    campo('documento', 'CPF/CNPJ do contato', false, '11.222.333/0001-81', ['documento', 'cnpj', 'cpf', 'cnpj cpf', 'cpf cnpj', 'documento do contato']),
    campo('data', 'Data da venda', true, '20/05/2024', ['data', 'data da venda', 'data venda', 'ocorrida em', 'emissao']),
    campo('valor', 'Valor (R$)', true, '1.234,56', ['valor', 'valor total', 'total', 'valor da venda']),
    campo('referencia', 'Número/referência externa', false, 'NF-1001', ['referencia', 'numero', 'nf', 'pedido', 'numero da venda', 'id externo', 'referencia externa']),
    campo('descricao', 'Descrição', false, 'Pedido de camisetas', ['descricao', 'observacao', 'obs']),
  ],
  tarefas: [
    campo('telefone', 'Telefone do contato', false, '(81) 99861-7049', ['telefone', 'celular', 'fone', 'tel', 'telefone do contato']),
    campo('documento', 'CPF/CNPJ do contato', false, '11.222.333/0001-81', ['documento', 'cnpj', 'cpf', 'cnpj cpf', 'cpf cnpj', 'documento do contato']),
    campo('titulo', 'Título', true, 'Ligar para oferecer a coleção', ['titulo', 'tarefa', 'assunto', 'nome da tarefa']),
    campo('tipo', 'Tipo (ligação, whatsapp, reunião, e-mail, visita, outro)', false, 'ligacao', ['tipo', 'tipo da tarefa']),
    campo('vence_em', 'Vence em', true, '30/11/2026', ['vence em', 'vencimento', 'data', 'prazo', 'data de vencimento']),
    campo('responsavel', 'Responsável (e-mail)', false, 'vendedor@empresa.com', ['responsavel', 'e-mail do responsavel', 'email do responsavel', 'vendedor']),
    campo('descricao', 'Descrição', false, 'Cliente pediu retorno', ['descricao', 'detalhes', 'observacao', 'obs']),
  ],
}

/** Vendas precisam achar o contato: telefone OU documento (um dos dois tem de estar mapeado). */
export const IDENTIFICADORES_DE_CONTATO: Readonly<Partial<Record<TipoImportacao, readonly string[]>>> = {
  vendas: ['telefone', 'documento'],
}

/** De-para: chave do campo → NOME da coluna do arquivo. */
export type DePara = Readonly<Record<string, string>>

/**
 * Sugere o de-para por nome normalizado. Cada coluna do arquivo serve a um campo só; os obrigatórios
 * escolhem primeiro. Campo sem coluna correspondente fica fora do mapa.
 */
export function sugerirDePara(tipo: TipoImportacao, colunas: readonly string[]): DePara {
  const usadas = new Set<string>()
  const resultado: Record<string, string> = {}
  const normalizadas = colunas.map((c) => ({ original: c, norm: normalizarCabecalho(c) }))
  const campos = [...CAMPOS_IMPORTACAO[tipo]].sort((a, b) => Number(b.obrigatorio) - Number(a.obrigatorio))
  for (const c of campos) {
    // Prioridade: a chave, depois os apelidos na ordem declarada, por fim o rótulo.
    const aceitos = [normalizarCabecalho(c.chave), ...c.apelidos, normalizarCabecalho(c.rotulo)]
    let achada: { original: string; norm: string } | undefined
    for (const nome of aceitos) {
      achada = normalizadas.find((n) => !usadas.has(n.original) && n.norm === nome)
      if (achada) break
    }
    if (achada) { resultado[c.chave] = achada.original; usadas.add(achada.original) }
  }
  return resultado
}

/** Só mantém do de-para o que aponta para coluna que existe e campo que o tipo conhece. */
export function limparDePara(tipo: TipoImportacao, dePara: Record<string, unknown>, colunas: readonly string[]): DePara {
  const chaves = new Set(CAMPOS_IMPORTACAO[tipo].map((c) => c.chave))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(dePara)) {
    if (chaves.has(k) && typeof v === 'string' && colunas.includes(v)) out[k] = v
  }
  return out
}

/** Campos obrigatórios sem coluna mapeada (`vendas`: se nenhum identificador de contato, ele entra na lista). */
export function camposObrigatoriosFaltando(tipo: TipoImportacao, dePara: DePara): string[] {
  const faltando = CAMPOS_IMPORTACAO[tipo].filter((c) => c.obrigatorio && !dePara[c.chave]).map((c) => c.chave)
  const ids = IDENTIFICADORES_DE_CONTATO[tipo]
  if (ids && !ids.some((k) => dePara[k])) faltando.push(ids.join('_ou_'))
  return faltando
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export interface CsvLido {
  readonly delimitador: ';' | ',' | '\t'
  readonly colunas: readonly string[]
  /** Linhas de dados (sem o cabeçalho), cada uma com o número da linha no ARQUIVO (cabeçalho = 1). */
  readonly linhas: readonly { readonly numero: number; readonly campos: readonly string[] }[]
}

/** Remove o BOM (U+FEFF) do começo. */
export const semBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)

function detectarDelimitador(texto: string): ';' | ',' | '\t' {
  let emAspas = false
  const n = { ';': 0, ',': 0, '\t': 0 }
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!
    if (ch === '"') emAspas = !emAspas
    else if (!emAspas && (ch === '\n' || ch === '\r')) break
    else if (!emAspas && (ch === ';' || ch === ',' || ch === '\t')) n[ch]++
  }
  if (n[';'] >= n[','] && n[';'] >= n['\t'] && n[';'] > 0) return ';'
  if (n['\t'] > n[','] && n['\t'] > 0) return '\t'
  return ','
}

/**
 * Parser de CSV completo: `;` `,` ou tab (detectado no cabeçalho), BOM, aspas duplas com delimitador e quebra de linha
 * dentro do campo, `""` escapado, CRLF/LF. Linha totalmente vazia é pulada (mas conta no número da linha).
 */
export function parseCsv(entrada: string): CsvLido {
  const texto = semBom(entrada)
  const delimitador = detectarDelimitador(texto)
  const registros: { numero: number; campos: string[] }[] = []
  let campos: string[] = []
  let atual = ''
  let emAspas = false
  let linha = 1
  let inicioRegistro = 1
  const fechaCampo = () => { campos.push(atual.trim()); atual = '' }
  const fechaRegistro = () => {
    fechaCampo()
    if (campos.some((c) => c !== '')) registros.push({ numero: inicioRegistro, campos })
    campos = []
  }
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!
    if (emAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { atual += '"'; i++ } else emAspas = false
      } else { if (ch === '\n') linha++; atual += ch }
    } else if (ch === '"') {
      emAspas = true
    } else if (ch === delimitador) {
      fechaCampo()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++
      fechaRegistro()
      linha++
      inicioRegistro = linha
    } else atual += ch
  }
  if (atual !== '' || campos.length > 0) fechaRegistro()
  const [cab, ...resto] = registros
  return { delimitador, colunas: cab?.campos ?? [], linhas: resto }
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

/**
 * Reais em texto → centavos inteiros. "1.234,56", "R$ 1.234,56", "1234,5", "1234.56", "1.234" (milhar), "10".
 * `null` = não deu para entender. Nunca passa por float de dinheiro: trabalha nos dígitos.
 */
export function reaisParaCentavos(bruto: string): number | null {
  let t = bruto.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '')
  if (t === '') return null
  let negativo = false
  if (t.startsWith('-')) { negativo = true; t = t.slice(1) }
  let inteiro: string
  let fracao = ''
  if (t.includes(',')) {
    const partes = t.split(',')
    if (partes.length !== 2 || !/^\d{1,3}(\.\d{3})*$|^\d+$/.test(partes[0]!) || !/^\d{1,2}$/.test(partes[1]!)) return null
    inteiro = partes[0]!.replace(/\./g, ''); fracao = partes[1]!
  } else if (t.includes('.')) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) inteiro = t.replace(/\./g, '')
    else if (/^\d+\.\d{1,2}$/.test(t)) { const [i, f] = t.split('.'); inteiro = i!; fracao = f! }
    else return null
  } else {
    if (!/^\d+$/.test(t)) return null
    inteiro = t
  }
  const centavos = Number(inteiro) * 100 + Number(fracao.padEnd(2, '0'))
  if (!Number.isSafeInteger(centavos)) return null
  return negativo ? -centavos : centavos
}

/**
 * Data (e hora opcional) → `Date` UTC, interpretando o horário de Brasília (UTC-3). Aceita `dd/mm/aaaa [hh:mm[:ss]]`
 * e `aaaa-mm-dd[ T]hh:mm[:ss]` (com `Z`/offset, respeita o offset). Data inexistente (31/02) → null.
 * Sem hora, usa `horaPadrao` (meio-dia evita virar o dia por fuso).
 */
export function parseDataHora(bruto: string, horaPadrao = 12): Date | null {
  const t = bruto.trim()
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  let a: number, mes: number, d: number, hh: number, mm: number, ss: number
  let offsetMin = 180
  if (m) {
    d = Number(m[1]); mes = Number(m[2]); a = Number(m[3])
    hh = m[4] === undefined ? horaPadrao : Number(m[4]); mm = m[5] === undefined ? 0 : Number(m[5]); ss = m[6] === undefined ? 0 : Number(m[6])
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(t)
    if (!m) return null
    a = Number(m[1]); mes = Number(m[2]); d = Number(m[3])
    hh = m[4] === undefined ? horaPadrao : Number(m[4]); mm = m[5] === undefined ? 0 : Number(m[5]); ss = m[6] === undefined ? 0 : Number(m[6])
    const off = m[7]
    if (off === 'Z') offsetMin = 0
    else if (off) offsetMin = -(off.startsWith('-') ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(-2)))
  }
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null
  const dt = new Date(Date.UTC(a, mes - 1, d, hh, mm, ss))
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) return null
  return new Date(dt.getTime() + offsetMin * 60_000)
}

/** sim/não em planilha brasileira. `null` = não reconhecido. */
export function parseSimNao(bruto: string): boolean | null {
  const t = normalizarCabecalho(bruto)
  if (['sim', 's', 'true', '1', 'yes', 'y', 'verdadeiro'].includes(t)) return true
  if (['nao', 'n', 'false', '0', 'no', 'falso'].includes(t)) return false
  return null
}

/** Qualificação do lead em texto livre. `undefined` = não reconhecido. */
export function parseQualificacao(bruto: string): 'novo' | 'qualificado' | 'descartado' | undefined {
  const t = normalizarCabecalho(bruto)
  if (['novo', 'nao avaliado', 'lead'].includes(t)) return 'novo'
  if (['qualificado', 'qualificada'].includes(t)) return 'qualificado'
  if (['descartado', 'desqualificado', 'perdido', 'descartada'].includes(t)) return 'descartado'
  return undefined
}

/** Etiquetas separadas por `|` (únicas, sem vazias, no máximo 40 caracteres cada). */
export function dividirEtiquetas(bruto: string): string[] {
  const vistas = new Set<string>()
  const out: string[] = []
  for (const p of bruto.split('|')) {
    const nome = p.trim().slice(0, 40)
    const k = nome.toLowerCase()
    if (nome && !vistas.has(k)) { vistas.add(k); out.push(nome) }
  }
  return out
}

// ---------------------------------------------------------------------------
// Progresso e conferência
// ---------------------------------------------------------------------------

export interface ContagensImportacao {
  readonly linhas: number
  readonly criados: number
  readonly atualizados: number
  readonly ignorados: number
  readonly rejeitados: number
}

export const CONTAGENS_ZERADAS: ContagensImportacao = { linhas: 0, criados: 0, atualizados: 0, ignorados: 0, rejeitados: 0 }

export interface ProgressoImportacao {
  readonly processadas: number
  readonly total: number
  /** 0–100, inteiro. */
  readonly percentual: number
  readonly terminou: boolean
}

/** Progresso para a barra: processadas = tudo o que já tem desfecho. */
export function progressoImportacao(c: ContagensImportacao, estado: EstadoImportacao): ProgressoImportacao {
  const processadas = c.criados + c.atualizados + c.ignorados + c.rejeitados
  const total = c.linhas
  const terminou = estado === 'concluida' || estado === 'falhou' || estado === 'cancelada'
  const percentual = estado === 'concluida' ? 100 : total <= 0 ? 0 : Math.min(100, Math.floor((processadas / total) * 100))
  return { processadas, total, percentual, terminou }
}

export interface LinhaConferencia {
  readonly filial: string | null
  readonly qualificacao: 'novo' | 'qualificado' | 'descartado'
  readonly origem: string | null
  readonly total: number
}

/** Chave estável de uma linha da conferência (também usada pela coluna "esperado" editável). */
export const chaveConferencia = (l: Pick<LinhaConferencia, 'filial' | 'qualificacao' | 'origem'>): string =>
  `${l.filial ?? ''}|${l.qualificacao}|${l.origem ?? ''}`

export interface LinhaComparada extends LinhaConferencia {
  readonly chave: string
  readonly esperado: number | null
  /** esperado − real (positivo = faltou no sistema); null sem esperado. */
  readonly diferenca: number | null
  readonly divergente: boolean
}

/**
 * Compara o real (banco) com o "esperado" digitado pelo gestor (sistema antigo). Linha sem esperado não diverge;
 * esperado negativo ou fracionário é ignorado (entrada inválida).
 */
export function compararConferencia(
  linhas: readonly LinhaConferencia[], esperado: Readonly<Record<string, number | null | undefined>>,
): { linhas: LinhaComparada[]; totalReal: number; totalEsperado: number | null; divergentes: number } {
  let totalEsperado: number | null = null
  let divergentes = 0
  const out = linhas.map((l): LinhaComparada => {
    const chave = chaveConferencia(l)
    const e = esperado[chave]
    const valido = typeof e === 'number' && Number.isInteger(e) && e >= 0
    const diferenca = valido ? e - l.total : null
    const divergente = diferenca !== null && diferenca !== 0
    if (valido) totalEsperado = (totalEsperado ?? 0) + e
    if (divergente) divergentes++
    return { ...l, chave, esperado: valido ? e : null, diferenca, divergente }
  })
  return { linhas: out, totalReal: linhas.reduce((s, l) => s + l.total, 0), totalEsperado, divergentes }
}
