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
