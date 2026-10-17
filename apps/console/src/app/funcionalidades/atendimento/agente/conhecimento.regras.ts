/**
 * Regras PURAS da aba Conhecimento — sem DOM, sem Angular, testáveis em node.
 *
 * Tudo que vira texto, tom de badge ou erro de campo mora aqui; o componente
 * só apresenta. Os limites (título, conteúdo, arquivo) espelham os da API em
 * `rotas-conhecimento.ts` / `extrair-texto.ts` — se mudar lá, muda aqui.
 */

export type Tom = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'

export const TIPOS_DOCUMENTO = ['politicas', 'faq', 'frete', 'pagamento', 'troca', 'produto', 'outro'] as const
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number]

export const ROTULO_TIPO: Readonly<Record<TipoDocumento, string>> = {
  politicas: 'Políticas',
  faq: 'Perguntas frequentes',
  frete: 'Frete e entrega',
  pagamento: 'Pagamento',
  troca: 'Troca e devolução',
  produto: 'Produto',
  outro: 'Outro',
}

export const DESCRICAO_TIPO: Readonly<Record<TipoDocumento, string>> = {
  politicas: 'O que a loja garante: prazos, mínimos, condições. As políticas de um número vivem na aba Configuração.',
  faq: 'Perguntas que os clientes fazem e a resposta oficial para cada uma.',
  frete: 'Regiões atendidas, prazos, valores e quem paga o frete.',
  pagamento: 'Formas de pagamento, parcelamento, boleto, prazo e crédito.',
  troca: 'Quando aceita troca ou devolução, prazos e como o cliente pede.',
  produto: 'Detalhes de produto que não cabem no catálogo: uso, composição, cuidados.',
  outro: 'Qualquer outro texto que o agente possa citar.',
}

/** Badge do tipo. Valor desconhecido (API mais nova) sai cru, neutro — nunca quebra a lista. */
export function badgeTipo(t: string): { rotulo: string; tom: Tom } {
  if ((TIPOS_DOCUMENTO as readonly string[]).includes(t)) {
    return { rotulo: ROTULO_TIPO[t as TipoDocumento], tom: t === 'politicas' ? 'info' : 'neutro' }
  }
  return { rotulo: t, tom: 'neutro' }
}

// ─── Alcance: global ou de um número ─────────────────────────────────────────

export type Alcance = 'global' | 'canal'

/**
 * Quais tipos o formulário oferece para um alcance. ⚠️ Políticas POR número
 * não se criam aqui — a API recusa (`conhecimento.politicas_pelo_canal`): elas
 * são o espelho do campo da aba Configuração. Políticas globais, sim.
 */
export function tiposDisponiveis(alcance: Alcance): readonly TipoDocumento[] {
  return alcance === 'canal' ? TIPOS_DOCUMENTO.filter((t) => t !== 'politicas') : TIPOS_DOCUMENTO
}

/** Ao trocar o alcance, um tipo que deixou de valer cai para 'outro' — nunca manda um corpo que a API recusa. */
export function ajustarTipoAoAlcance(tipo: TipoDocumento, alcance: Alcance): TipoDocumento {
  return tiposDisponiveis(alcance).includes(tipo) ? tipo : 'outro'
}

/** O documento 'politicas' de um canal espelha `agente_config.politicas`: não muda de tipo nem de alcance. */
export function ehEspelhoDePoliticas(doc: { readonly tipo: string; readonly canalId: string | null }): boolean {
  return doc.tipo === 'politicas' && doc.canalId !== null
}

export function badgeAlcance(doc: { readonly canalId: string | null }): { rotulo: string; tom: Tom } {
  return doc.canalId === null ? { rotulo: 'global', tom: 'neutro' } : { rotulo: 'este número', tom: 'info' }
}

// ─── Capacidade da busca: lexical ou lexical + semântica ─────────────────────

export interface CapacidadesBusca {
  readonly pgvector: boolean
  readonly embedding: { readonly configurado: boolean; readonly provedor: string | null; readonly falta: string | null }
  /** 'ligada' | 'sem_pgvector' | 'sem_chave' — valor novo da API cai no texto cru. */
  readonly semantica: string
  readonly pendentes: { readonly produtos: number; readonly trechos: number }
  readonly embutidos: { readonly produtos: number; readonly trechos: number }
}

export function semanticaLigada(cap: Pick<CapacidadesBusca, 'semantica'>): boolean {
  return cap.semantica === 'ligada'
}

/** Texto curto para o badge: o que a busca FAZ neste servidor. */
export function rotuloSemantica(cap: Pick<CapacidadesBusca, 'semantica'>): string {
  return semanticaLigada(cap) ? 'Busca lexical + semântica' : 'Busca lexical'
}

/**
 * Por que a semântica está desligada — `null` quando está ligada.
 * ⚠️ Nomeia a variável que falta: genérico manda abrir chamado, nome manda resolver.
 */
export function motivoSemantica(cap: Pick<CapacidadesBusca, 'semantica'> & { readonly embedding?: CapacidadesBusca['embedding'] }): string | null {
  return descreverMotivoSemantica(cap.semantica, cap.embedding?.falta ?? null)
}

/**
 * O mesmo tradutor serve à resposta de `buscar` (`semantica: 'ligada' | motivo`),
 * que pode trazer motivos do adaptador de embedding além dos dois da capacidade.
 */
export function descreverMotivoSemantica(semantica: string, falta: string | null = null): string | null {
  switch (semantica) {
    case 'ligada': return null
    case 'sem_chave': return `Falta ${falta ?? 'VOYAGE_API_KEY'} no servidor`
    case 'sem_pgvector': return 'Postgres sem pgvector'
    case 'capacidade_desligada': return 'Embedding não configurado no servidor'
    default: return semantica
  }
}

export function temPendentes(cap: Pick<CapacidadesBusca, 'pendentes'>): boolean {
  return cap.pendentes.trechos > 0 || cap.pendentes.produtos > 0
}

/** "pendentes: 12 trechos · 340 produtos" */
export function textoPendentes(cap: Pick<CapacidadesBusca, 'pendentes'>): string {
  return `pendentes: ${cap.pendentes.trechos} trechos · ${cap.pendentes.produtos} produtos`
}

/** Uma linha para a aba Configuração: "busca lexical — semântica desligada (falta VOYAGE_API_KEY no servidor)". */
export function fraseCapacidade(cap: Pick<CapacidadesBusca, 'semantica' | 'embedding'>): string {
  const motivo = motivoSemantica(cap)
  if (motivo === null) return 'busca lexical + semântica'
  return `busca lexical — semântica desligada (${minusculaInicial(motivo)})`
}

function minusculaInicial(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

// ─── Fontes e força de um trecho ─────────────────────────────────────────────

export const ROTULO_FONTE: Readonly<Record<string, string>> = {
  lexical: 'lexical',
  trgm: 'trgm',
  semantica: 'semântica',
}

export function rotuloFonte(f: string): string {
  return ROTULO_FONTE[f] ?? f
}

export type Forca = 'forte' | 'medio' | 'fraco'

/**
 * O score é RRF (reciprocal rank fusion) com k = 60: cada perna contribui
 * 1 / (60 + posição). Os valores são PEQUENOS por construção — o primeiro
 * lugar numa perna vale ~0,0164; primeiro em duas, ~0,0328. Por isso não faz
 * sentido mostrar como percentual: a tela traduz em faixas.
 *
 *   ≥ 0,030 → forte  (no topo de duas ou mais pernas)
 *   ≥ 0,016 → médio  (no topo de uma perna, ou bem colocado em duas)
 *   senão   → fraco
 */
export const LIMIAR_FORCA = { forte: 0.03, medio: 0.016 } as const

export function forcaDoScore(score: number): Forca {
  if (!Number.isFinite(score)) return 'fraco'
  if (score >= LIMIAR_FORCA.forte) return 'forte'
  if (score >= LIMIAR_FORCA.medio) return 'medio'
  return 'fraco'
}

export function badgeForca(score: number): { rotulo: string; tom: Tom } {
  switch (forcaDoScore(score)) {
    case 'forte': return { rotulo: 'forte', tom: 'sucesso' }
    case 'medio': return { rotulo: 'médio', tom: 'info' }
    default: return { rotulo: 'fraco', tom: 'neutro' }
  }
}

// ─── Arquivo importado ───────────────────────────────────────────────────────

export const TIPOS_ARQUIVO = ['text/plain', 'text/markdown', 'application/pdf'] as const
export type TipoArquivo = (typeof TIPOS_ARQUIVO)[number]

/** Teto da API (`MAX_BYTES_ARQUIVO`): 6 MB decodificados. Checar antes de ler evita subir 50 MB para ouvir "grande". */
export const ARQUIVO_MAX_BYTES = 6 * 1024 * 1024

const EXTENSAO_PARA_TIPO: Readonly<Record<string, TipoArquivo>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
}

/**
 * Qual dos três tipos aceitos este arquivo é. O MIME do navegador vale quando é
 * um dos três; fora disso (vazio, `text/x-markdown`, `application/octet-stream`)
 * decide a extensão, sem distinguir maiúsculas. `null` = não aceito.
 */
export function tipoArquivoDe(nome: string, mime: string | null | undefined): TipoArquivo | null {
  const m = (mime ?? '').trim().toLowerCase()
  if ((TIPOS_ARQUIVO as readonly string[]).includes(m)) return m as TipoArquivo
  const ponto = nome.lastIndexOf('.')
  if (ponto < 0 || ponto === nome.length - 1) return null
  const ext = nome.slice(ponto + 1).toLowerCase()
  return EXTENSAO_PARA_TIPO[ext] ?? null
}

export function arquivoGrande(bytes: number): boolean {
  return bytes > ARQUIVO_MAX_BYTES
}

/** Milhar com ponto, sem Intl: o resultado não pode variar por ambiente. */
export function formatarInteiro(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** "3.214 caracteres · 4 páginas" (páginas só em PDF). */
export function resumoDaExtracao(r: { readonly caracteres: number; readonly paginas: number | null }): string {
  const base = `${formatarInteiro(r.caracteres)} caracteres`
  if (r.paginas === null) return base
  return `${base} · ${r.paginas} ${r.paginas === 1 ? 'página' : 'páginas'}`
}

// ─── Formulário ──────────────────────────────────────────────────────────────

export const LIMITES_DOCUMENTO = { tituloMax: 200, conteudoMax: 150_000 } as const

export interface FormularioDocumento {
  /** `null` = criando. */
  readonly id: string | null
  readonly titulo: string
  readonly tipo: TipoDocumento
  readonly alcance: Alcance
  readonly conteudo: string
}

/** Erros por campo, com os MESMOS limites da API. Vazio = pode enviar. */
export function validarDocumento(f: Pick<FormularioDocumento, 'titulo' | 'conteudo'>): Readonly<Record<string, string>> {
  const erros: Record<string, string> = {}
  const titulo = f.titulo.trim()
  if (titulo.length === 0) erros['titulo'] = 'Dê um título ao documento.'
  else if (titulo.length > LIMITES_DOCUMENTO.tituloMax) erros['titulo'] = `Título com no máximo ${LIMITES_DOCUMENTO.tituloMax} caracteres.`
  const conteudo = f.conteudo.trim()
  if (conteudo.length === 0) erros['conteudo'] = 'Escreva ou importe o conteúdo.'
  else if (conteudo.length > LIMITES_DOCUMENTO.conteudoMax) {
    erros['conteudo'] = `Conteúdo com no máximo ${formatarInteiro(LIMITES_DOCUMENTO.conteudoMax)} caracteres — divida em dois documentos.`
  }
  return erros
}

/** O corpo do POST/PATCH a partir do formulário. `canalId` só vai quando o alcance é um número. */
export function corpoDoDocumento(f: FormularioDocumento, canalId: string): {
  titulo: string; tipo: TipoDocumento; conteudo: string; canalId: string | null
} {
  return {
    titulo: f.titulo.trim(),
    tipo: f.tipo,
    conteudo: f.conteudo.trim(),
    canalId: f.alcance === 'canal' && canalId ? canalId : null,
  }
}

/** Formulário vazio para criar; quando há um número selecionado, começa valendo só para ele. */
export function formularioNovo(canalId: string): FormularioDocumento {
  return { id: null, titulo: '', tipo: 'faq', alcance: canalId ? 'canal' : 'global', conteudo: '' }
}

export function formularioDe(doc: {
  readonly id: string; readonly titulo: string; readonly tipo: string; readonly canalId: string | null; readonly conteudo: string
}): FormularioDocumento {
  const tipo = (TIPOS_DOCUMENTO as readonly string[]).includes(doc.tipo) ? (doc.tipo as TipoDocumento) : 'outro'
  return { id: doc.id, titulo: doc.titulo, tipo, alcance: doc.canalId === null ? 'global' : 'canal', conteudo: doc.conteudo }
}

// ─── Histórico de versões (raia P9) ──────────────────────────────────────────

/** Teto da nota de uma versão — o mesmo da API (`MAX_OBSERVACAO`). */
export const OBSERVACAO_MAX = 280

export function validarObservacao(texto: string): string | null {
  return texto.trim().length > OBSERVACAO_MAX ? `Nota com no máximo ${OBSERVACAO_MAX} caracteres.` : null
}

export const ROTULO_ORIGEM: Readonly<Record<string, string>> = {
  criacao: 'criada',
  edicao: 'editada',
  restauracao: 'restaurada',
  sincronismo: 'pela Configuração',
  backfill: 'vigente ao ligar o histórico',
  automatica: 'registrada pelo banco',
}

/** Badge da origem da versão. Valor desconhecido sai cru, neutro. */
export function badgeOrigem(origem: string, restauradaDe: number | null = null): { rotulo: string; tom: Tom } {
  if (origem === 'restauracao') return { rotulo: restauradaDe ? `restaurada da v${restauradaDe}` : 'restaurada', tom: 'info' }
  if (origem === 'criacao') return { rotulo: 'criada', tom: 'sucesso' }
  return { rotulo: ROTULO_ORIGEM[origem] ?? origem, tom: 'neutro' }
}

/** Quem fez: nome do usuário, "equipe GeraCRM" (staff) ou "sistema". */
export function rotuloAutor(v: { readonly autor: { readonly nome: string | null } | null; readonly autorStaff: boolean }): string {
  if (v.autorStaff) return 'equipe GeraCRM'
  if (v.autor) return v.autor.nome ?? 'usuário'
  return 'sistema'
}

/**
 * A falha de ler/restaurar uma versão, em texto que diz o que fazer.
 * ⚠️ "Anterior ao histórico" NÃO é erro de sistema: o texto daquela versão foi
 *    sobrescrito antes de o histórico existir. A tela diz isso — nunca mostra
 *    o texto de outra versão no lugar.
 */
export function mensagemFalhaVersao(erro: string | undefined, primeiraRegistrada?: number): string {
  switch (erro) {
    case 'conhecimento.versao_anterior_ao_historico':
      return `Esta versão foi sobrescrita antes de o histórico existir — o texto dela não foi guardado.${
        primeiraRegistrada ? ` O histórico deste documento começa na v${primeiraRegistrada}.` : ''}`
    case 'conhecimento.versao_removida':
      return 'O texto desta versão foi removido do histórico (exclusão a pedido do titular dos dados).'
    case 'conhecimento.versao_nao_encontrada': return 'Este documento não tem essa versão.'
    case 'conhecimento.nao_encontrado': return 'Este documento não existe mais.'
    case 'conhecimento.restaurar_sem_mudanca': return 'Essa versão tem o mesmo título e texto da atual — não há o que restaurar.'
    default: return 'Não foi possível abrir a versão agora. Tente de novo.'
  }
}

// ─── Diff por linha (puro) ───────────────────────────────────────────────────

export type TipoLinhaDiff = 'igual' | 'removida' | 'adicionada'

export interface LinhaDiff {
  readonly tipo: TipoLinhaDiff
  readonly texto: string
  /** Número da linha (1-based) no texto antigo / novo; `null` quando a linha não existe ali. */
  readonly antes: number | null
  readonly depois: number | null
}

export interface ResultadoDiff {
  readonly linhas: readonly LinhaDiff[]
  readonly adicionadas: number
  readonly removidas: number
  /**
   * O miolo diferente era grande demais para o LCS caber no navegador: saiu
   * como "bloco removido + bloco adicionado". Continua CORRETO, só menos fino.
   */
  readonly aproximado: boolean
}

/** Células da tabela do LCS (n × m). 4 M × 4 bytes = 16 MB — o teto sem travar o navegador. */
export const DIFF_MAX_CELULAS = 4_000_000

function linhasDe(texto: string): string[] {
  return texto === '' ? [] : texto.split(/\r?\n/)
}

/**
 * Diferença por linha entre dois textos: prefixo e sufixo iguais são cortados
 * antes (a edição típica mexe num trecho só), e o miolo vai por LCS. Acima de
 * `maxCelulas`, o miolo sai inteiro como removido + adicionado.
 */
export function diffLinhas(antigo: string, novo: string, maxCelulas: number = DIFF_MAX_CELULAS): ResultadoDiff {
  const a = linhasDe(antigo)
  const b = linhasDe(novo)
  let ini = 0
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++
  let fimA = a.length, fimB = b.length
  while (fimA > ini && fimB > ini && a[fimA - 1] === b[fimB - 1]) { fimA--; fimB-- }

  const saida: LinhaDiff[] = []
  for (let k = 0; k < ini; k++) saida.push({ tipo: 'igual', texto: a[k]!, antes: k + 1, depois: k + 1 })

  const ma = a.slice(ini, fimA)
  const mb = b.slice(ini, fimB)
  const n = ma.length, m = mb.length
  let aproximado = false
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= maxCelulas) {
    // lcs[i][j] = tamanho do LCS de ma[i..] e mb[j..]
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
      }
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        saida.push({ tipo: 'igual', texto: ma[i]!, antes: ini + i + 1, depois: ini + j + 1 }); i++; j++
      } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        saida.push({ tipo: 'removida', texto: ma[i]!, antes: ini + i + 1, depois: null }); i++
      } else {
        saida.push({ tipo: 'adicionada', texto: mb[j]!, antes: null, depois: ini + j + 1 }); j++
      }
    }
  } else {
    aproximado = n > 0 && m > 0
    for (let k = 0; k < n; k++) saida.push({ tipo: 'removida', texto: ma[k]!, antes: ini + k + 1, depois: null })
    for (let k = 0; k < m; k++) saida.push({ tipo: 'adicionada', texto: mb[k]!, antes: null, depois: ini + k + 1 })
  }

  for (let k = 0; k < a.length - fimA; k++) {
    saida.push({ tipo: 'igual', texto: a[fimA + k]!, antes: fimA + k + 1, depois: fimB + k + 1 })
  }
  return {
    linhas: saida,
    adicionadas: saida.filter((l) => l.tipo === 'adicionada').length,
    removidas: saida.filter((l) => l.tipo === 'removida').length,
    aproximado,
  }
}

export type BlocoDiff = LinhaDiff | { readonly tipo: 'omitidas'; readonly quantidade: number }

/**
 * Esconde trechos iguais longos, deixando `contexto` linhas em volta de cada
 * mudança — num documento de 300 linhas com 2 mudadas, a tela mostra ~10.
 */
export function compactarDiff(linhas: readonly LinhaDiff[], contexto = 2): BlocoDiff[] {
  const mudou = linhas.map((l) => l.tipo !== 'igual')
  const saida: BlocoDiff[] = []
  let omitidas = 0
  for (let i = 0; i < linhas.length; i++) {
    let perto = false
    for (let k = Math.max(0, i - contexto); k <= Math.min(linhas.length - 1, i + contexto) && !perto; k++) perto = mudou[k]!
    if (perto) {
      if (omitidas > 0) { saida.push({ tipo: 'omitidas', quantidade: omitidas }); omitidas = 0 }
      saida.push(linhas[i]!)
    } else omitidas++
  }
  if (omitidas > 0) saida.push({ tipo: 'omitidas', quantidade: omitidas })
  return saida
}

/**
 * Teto de linhas DESENHADAS de um diff (P9). Acima disso o DOM de milhares de
 * linhas trava a aba; a tela avisa e manda ver o texto. "… N linhas iguais"
 * não conta — é uma linha só.
 */
export const DIFF_MAX_LINHAS_DESENHADAS = 2000

export function diffDesenhavel(blocos: readonly BlocoDiff[], max: number = DIFF_MAX_LINHAS_DESENHADAS): boolean {
  let n = 0
  for (const b of blocos) if (b.tipo !== 'omitidas' && ++n > max) return false
  return true
}

/** "+3 −1 linhas" / "sem diferença no texto". */
export function resumoDiff(d: Pick<ResultadoDiff, 'adicionadas' | 'removidas'>): string {
  if (d.adicionadas === 0 && d.removidas === 0) return 'sem diferença no texto'
  return `+${d.adicionadas} −${d.removidas} ${d.adicionadas + d.removidas === 1 ? 'linha' : 'linhas'}`
}

// ─── Citações de conhecimento numa decisão do agente ─────────────────────────

export interface CitacaoDecisao {
  /** `null` = decisão anterior ao histórico: só título e versão, sem como abrir. */
  readonly documentoId: string | null
  readonly versao: number
  readonly titulo: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CITACAO_NO_TEXTO = /\{"documentoId":"([0-9a-f-]{36})","versao":(\d+),"titulo":("(?:[^"\\]|\\.)*")\}/gi
const FONTE_TITULO_VERSAO = /^(.*) v(\d+)$/

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Quais documentos (e em qual versão) o agente leu neste turno, a partir de
 * `ferramentas[].saida` de `conhecimento_buscar`:
 *   1. `saida.citacoes` (P9) — documento + versão: abre o texto exato;
 *   2. saída cortada em 4.000 caracteres (`{truncado, inicio}`) — as citações
 *      vêm primeiro no objeto e são lidas do texto;
 *   3. decisões antigas, só com `trechos[].fonte = "Título vN"` — citação sem
 *      documento (a tela mostra, mas não tem o que abrir).
 */
export function citacoesDaDecisao(
  ferramentas: readonly { readonly nome: string; readonly saida: unknown; readonly erro?: string | undefined }[],
): CitacaoDecisao[] {
  const saida: CitacaoDecisao[] = []
  const vistas = new Set<string>()
  const somar = (c: CitacaoDecisao): void => {
    const k = `${c.documentoId ?? `t:${c.titulo}`}:${c.versao}`
    if (vistas.has(k)) return
    vistas.add(k)
    saida.push(c)
  }
  for (const f of ferramentas) {
    if (f.nome !== 'conhecimento_buscar' || f.erro || !ehObjeto(f.saida)) continue
    const s = f.saida
    if (Array.isArray(s['citacoes'])) {
      for (const c of s['citacoes'] as unknown[]) {
        if (!ehObjeto(c)) continue
        const id = c['documentoId'], v = c['versao'], t = c['titulo']
        if (typeof id === 'string' && UUID_RE.test(id) && typeof v === 'number' && Number.isInteger(v) && v >= 1) {
          somar({ documentoId: id, versao: v, titulo: typeof t === 'string' ? t : 'Documento' })
        }
      }
      continue
    }
    const inicio = s['inicio']
    if (s['truncado'] === true && typeof inicio === 'string') {
      for (const m of inicio.matchAll(CITACAO_NO_TEXTO)) {
        let titulo = 'Documento'
        try { titulo = JSON.parse(m[3]!) as string } catch { /* título cortado: fica o genérico */ }
        somar({ documentoId: m[1]!, versao: Number(m[2]), titulo })
      }
      continue
    }
    if (Array.isArray(s['trechos'])) {
      for (const t of s['trechos'] as unknown[]) {
        if (!ehObjeto(t) || typeof t['fonte'] !== 'string') continue
        const m = FONTE_TITULO_VERSAO.exec(t['fonte'])
        if (m) somar({ documentoId: null, versao: Number(m[2]), titulo: m[1]! })
      }
    }
  }
  return saida
}
