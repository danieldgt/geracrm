import type { ItemDefinicao } from '../../compartilhado/ui/index.js'
import { OPCOES_MODALIDADE, OPCOES_PRIORIDADE, OPCOES_TEMPERATURA } from './contato-form.regras.js'

/**
 * Regras PURAS da ficha do contato (A3): o que a tela decide sem tocar em HTTP nem em DOM.
 * Ordem dos selos, ações visíveis, texto do feed, linhas do perfil de compra, arquivo aceito.
 */

// ───────── Contrato com a API (formas que a ficha lê) ─────────

export interface DadosFicha {
  readonly id: string
  readonly nome: string
  readonly razaoSocial: string | null
  readonly nomeFantasia: string | null
  readonly email: string | null
  readonly modalidade: string | null
  readonly prioridade: string | null
  readonly temperatura: string | null
  /** true = qualificado, false = descartado, null = novo (ainda não avaliado). */
  readonly qualificado: boolean | null
  readonly valorEstimadoCentavos: number | null
  readonly observacoes: string | null
  readonly perfilPreco?: string | null
  readonly recebeCampanhas?: boolean
  readonly recebeAutomacoes?: boolean
  readonly origem?: string | null
  readonly criadoEm?: string | null
  readonly vendedor?: { readonly id: string; readonly nome: string } | null
  readonly telefones: readonly { seq: number }[]
  readonly metricas: {
    readonly totalCentavos: number
    readonly ticketMedioCentavos: number | null
    readonly diasSemComprar: number | null
    readonly segmento: { readonly codigo: string; readonly rotulo: string }
  } | null
}

export type TipoFeed =
  | 'comentario' | 'funil' | 'qualificacao' | 'tarefa_criada' | 'tarefa_concluida'
  | 'pedido_criado' | 'pedido_efetivado' | 'handoff' | 'etiquetas' | 'arquivo' | 'formulario' | 'reuniao'

export interface ItemFeed {
  readonly id: string
  readonly tipo: TipoFeed
  readonly em: string
  readonly autor: { readonly id: string; readonly nome: string } | null
  readonly texto: string
  readonly ref?: { readonly tipo: string; readonly id: string }
}

// ───────── Selos do cabeçalho ─────────

export type TomSelo = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'
export type IdSelo = 'segmento' | 'qualificacao' | 'prioridade' | 'temperatura' | 'modalidade'
export interface Selo { readonly id: IdSelo; readonly rotulo: string; readonly tom: TomSelo; readonly codigoRfv?: string }

/** A ordem é FIXA: segmento RFV, qualificação, prioridade, temperatura, modalidade. Vazio não aparece. */
export const ORDEM_SELOS: readonly IdSelo[] = ['segmento', 'qualificacao', 'prioridade', 'temperatura', 'modalidade']

const rotuloDe = (opcoes: readonly { valor: string; rotulo: string }[], v: string): string =>
  opcoes.find((o) => o.valor === v)?.rotulo ?? v

export function rotuloQualificacao(q: boolean | null): string {
  return q === true ? 'Qualificado' : q === false ? 'Descartado' : 'Novo'
}

export function selosDaFicha(f: Pick<DadosFicha, 'metricas' | 'qualificado' | 'prioridade' | 'temperatura' | 'modalidade'>): Selo[] {
  const porId: Record<IdSelo, Selo | null> = {
    segmento: f.metricas ? { id: 'segmento', rotulo: f.metricas.segmento.rotulo, tom: 'neutro', codigoRfv: f.metricas.segmento.codigo } : null,
    qualificacao: { id: 'qualificacao', rotulo: rotuloQualificacao(f.qualificado), tom: f.qualificado === true ? 'sucesso' : f.qualificado === false ? 'erro' : 'info' },
    prioridade: f.prioridade
      ? { id: 'prioridade', rotulo: `Prioridade ${rotuloDe(OPCOES_PRIORIDADE, f.prioridade).toLowerCase()}`,
          tom: f.prioridade === 'urgente' ? 'erro' : f.prioridade === 'alta' ? 'atencao' : 'neutro' }
      : null,
    temperatura: f.temperatura
      ? { id: 'temperatura', rotulo: rotuloDe(OPCOES_TEMPERATURA, f.temperatura),
          tom: f.temperatura === 'quente' ? 'erro' : f.temperatura === 'morno' ? 'atencao' : 'info' }
      : null,
    modalidade: f.modalidade ? { id: 'modalidade', rotulo: rotuloDe(OPCOES_MODALIDADE, f.modalidade), tom: 'neutro' } : null,
  }
  return ORDEM_SELOS.map((id) => porId[id]).filter((s): s is Selo => s !== null)
}

// ───────── Ações do cabeçalho ─────────

export type IdAcao = 'editar' | 'conversar' | 'novo-pedido' | 'nova-tarefa' | 'qualificar' | 'descartar' | 'agendar'
export interface AcaoFicha { readonly id: IdAcao; readonly rotulo: string; readonly desabilitada: boolean; readonly dica: string }

/**
 * Quais ações aparecem e quais estão desabilitadas.
 *  · Qualificar/Descartar são a transição possível: novo → ambos; qualificado → só Descartar;
 *    descartado → só Qualificar (reativa).
 *  · Conversar exige telefone. Agendar fica desabilitado até o módulo Agenda (C2).
 */
export function acoesVisiveis(f: Pick<DadosFicha, 'qualificado' | 'telefones'>, agendaAtiva = false): AcaoFicha[] {
  const semTelefone = f.telefones.length === 0
  const acoes: AcaoFicha[] = [
    { id: 'conversar', rotulo: 'Conversar', desabilitada: semTelefone, dica: semTelefone ? 'Cadastre um telefone para conversar.' : 'Abrir o chat com este contato' },
    { id: 'novo-pedido', rotulo: 'Novo pedido', desabilitada: false, dica: 'Montar um pedido para este contato' },
    { id: 'nova-tarefa', rotulo: 'Nova tarefa', desabilitada: false, dica: 'Criar uma tarefa para este contato' },
    { id: 'agendar', rotulo: 'Agendar', desabilitada: !agendaAtiva, dica: agendaAtiva ? 'Agendar uma reunião' : 'Disponível com o módulo Agenda.' },
  ]
  if (f.qualificado !== true) acoes.push({ id: 'qualificar', rotulo: 'Qualificar', desabilitada: false, dica: 'Marcar como qualificado' })
  if (f.qualificado !== false) acoes.push({ id: 'descartar', rotulo: 'Descartar', desabilitada: false, dica: 'Descartar este contato' })
  acoes.unshift({ id: 'editar', rotulo: 'Editar', desabilitada: false, dica: 'Editar o cadastro completo' })
  return acoes
}

/**
 * A barra de ações da ficha: UMA ação cheia (Conversar) e duas secundárias à vista
 * (Editar, Novo pedido); o resto vai para o menu "⋯" (Nova tarefa, Agendar,
 * Qualificar, Descartar — destrutivo por último). Antes eram 9 botões numa linha,
 * 3 cheios em cores diferentes.
 */
export const ACOES_A_VISTA: readonly IdAcao[] = ['conversar', 'editar', 'novo-pedido']

export function separarAcoesFicha(acoes: readonly AcaoFicha[]): { readonly aVista: AcaoFicha[]; readonly noMenu: AcaoFicha[] } {
  const aVista = ACOES_A_VISTA.map((id) => acoes.find((a) => a.id === id)).filter((a): a is AcaoFicha => !!a)
  const noMenu = acoes.filter((a) => !ACOES_A_VISTA.includes(a.id))
  return { aVista, noMenu }
}

/** Estado enviado ao endpoint de qualificação para cada ação. */
export const estadoDaAcao = (id: 'qualificar' | 'descartar'): 'qualificado' | 'descartado' =>
  id === 'qualificar' ? 'qualificado' : 'descartado'

// ───────── Feed ─────────

export interface ItemFeedVista {
  readonly id: string
  readonly tipo: TipoFeed
  readonly icone: string
  readonly rotuloTipo: string
  readonly tom: TomSelo
  readonly texto: string
  readonly autor: string
  readonly em: string
  /**
   * Resposta de formulário NÃO verificada (telefone já cadastrado, preenchido por anônimo): a ficha mostra o
   * aviso e oferece "Aplicar ao contato" (gestor). É o id da resposta; ausente nos demais itens.
   */
  readonly respostaPendenteId: string | null
}

const ICONE_FEED: Record<TipoFeed, string> = {
  comentario: 'file-text', funil: 'kanban', qualificacao: 'check', tarefa_criada: 'check-square', tarefa_concluida: 'check-square',
  pedido_criado: 'shopping-cart', pedido_efetivado: 'receipt', handoff: 'users', etiquetas: 'tag', arquivo: 'upload',
  formulario: 'file-text', reuniao: 'calendar',
}
const ROTULO_FEED: Record<TipoFeed, string> = {
  comentario: 'Observação', funil: 'Funil', qualificacao: 'Qualificação', tarefa_criada: 'Tarefa', tarefa_concluida: 'Tarefa concluída',
  pedido_criado: 'Pedido', pedido_efetivado: 'Pedido efetivado', handoff: 'Atendimento', etiquetas: 'Etiquetas', arquivo: 'Arquivo',
  formulario: 'Formulário', reuniao: 'Reunião',
}
const TOM_FEED: Record<TipoFeed, TomSelo> = {
  comentario: 'neutro', funil: 'info', qualificacao: 'info', tarefa_criada: 'neutro', tarefa_concluida: 'sucesso',
  pedido_criado: 'neutro', pedido_efetivado: 'sucesso', handoff: 'atencao', etiquetas: 'neutro', arquivo: 'neutro',
  formulario: 'info', reuniao: 'info',
}

/** Item do feed → o que a tela desenha. Autor ausente = Sistema. */
export function itemParaExibicao(i: ItemFeed): ItemFeedVista {
  const pendente = i.tipo === 'formulario' && i.ref?.tipo === 'formulario_resposta_pendente' ? i.ref.id : null
  return {
    id: i.id, tipo: i.tipo, icone: ICONE_FEED[i.tipo] ?? 'file-text', rotuloTipo: ROTULO_FEED[i.tipo] ?? 'Evento',
    tom: pendente ? 'atencao' : TOM_FEED[i.tipo] ?? 'neutro',
    texto: i.texto, autor: i.autor?.nome ?? 'Sistema', em: i.em, respostaPendenteId: pendente,
  }
}

/** Anexa a página nova ao que já está na tela, sem repetir id (um evento novo pode empurrar a borda). */
export function mesclarFeed(atual: readonly ItemFeed[], nova: readonly ItemFeed[]): ItemFeed[] {
  const vistos = new Set(atual.map((i) => i.id))
  return [...atual, ...nova.filter((i) => !vistos.has(i.id))]
}

// ───────── Perfil de compra (memória do agente) ─────────

export interface FatoMemoria { readonly id: string; readonly tipo: string; readonly fato: string }
const ROTULO_MEMORIA: Record<string, string> = { preferencia: 'Preferência', objecao: 'Objeção', contexto: 'Contexto', restricao: 'Restrição' }

/** Memória vigente → linhas rótulo/valor, agrupadas por tipo (preferência, objeção, contexto, restrição). */
export function linhasPerfilDeCompra(fatos: readonly FatoMemoria[]): ItemDefinicao[] {
  const ordem = Object.keys(ROTULO_MEMORIA)
  const posicao = (tipo: string): number => { const i = ordem.indexOf(tipo); return i < 0 ? ordem.length : i }
  return [...fatos]
    .sort((a, b) => posicao(a.tipo) - posicao(b.tipo))
    .map((f) => ({ rotulo: ROTULO_MEMORIA[f.tipo] ?? f.tipo, valor: f.fato }))
}

// ───────── Dados e informações ─────────

const reais = (c: number): string => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataBr = (iso: string | null | undefined): string | null => (iso ? new Date(iso).toLocaleDateString('pt-BR') : null)

export function camposDeCadastro(f: DadosFicha): ItemDefinicao[] {
  const rotulo = (ops: readonly { valor: string; rotulo: string }[], v: string | null) => (v ? rotuloDe(ops, v) : null)
  return [
    { rotulo: 'Nome', valor: f.nome },
    { rotulo: 'Razão social', valor: f.razaoSocial },
    { rotulo: 'Nome fantasia', valor: f.nomeFantasia },
    { rotulo: 'E-mail', valor: f.email },
    { rotulo: 'Modalidade', valor: rotulo(OPCOES_MODALIDADE, f.modalidade) },
    { rotulo: 'Prioridade', valor: rotulo(OPCOES_PRIORIDADE, f.prioridade) },
    { rotulo: 'Temperatura', valor: rotulo(OPCOES_TEMPERATURA, f.temperatura) },
    { rotulo: 'Qualificação', valor: rotuloQualificacao(f.qualificado) },
    { rotulo: 'Valor estimado', valor: f.valorEstimadoCentavos === null ? null : reais(f.valorEstimadoCentavos), mono: true },
    { rotulo: 'Perfil de preço', valor: f.perfilPreco ?? null },
    { rotulo: 'Recebe campanhas', valor: f.recebeCampanhas === undefined ? null : f.recebeCampanhas ? 'Sim' : 'Não' },
    { rotulo: 'Recebe automações', valor: f.recebeAutomacoes === undefined ? null : f.recebeAutomacoes ? 'Sim' : 'Não' },
  ]
}

/** Lateral "Informações": segmento, carteira, origem, criado, total, ticket, dias sem comprar. */
export function camposDeInformacao(f: DadosFicha): ItemDefinicao[] {
  const m = f.metricas
  return [
    { rotulo: 'Segmento', valor: m?.segmento.rotulo ?? null },
    { rotulo: 'Vendedor', valor: f.vendedor?.nome ?? 'Sem carteira' },
    { rotulo: 'Origem', valor: f.origem ?? null },
    { rotulo: 'Criado em', valor: dataBr(f.criadoEm) },
    { rotulo: 'Total em vendas', valor: m ? reais(m.totalCentavos) : null, mono: true },
    { rotulo: 'Ticket médio', valor: m && m.ticketMedioCentavos !== null ? reais(m.ticketMedioCentavos) : null, mono: true },
    { rotulo: 'Dias sem comprar', valor: m?.diasSemComprar ?? null, mono: true },
  ]
}

// ───────── Arquivos ─────────

export const TAMANHO_MAX_ARQUIVO = 15 * 1024 * 1024
const EXTENSOES = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'xls', 'xlsx', 'csv', 'doc', 'docx', 'txt']
export const ACEITA_ARQUIVO = EXTENSOES.map((e) => '.' + e).join(',')

export function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** Conveniência do cliente (a API é a regra): devolve a mensagem de erro ou null. */
export function validarArquivo(a: { name: string; size: number }): string | null {
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : ''
  if (!EXTENSOES.includes(ext)) return 'Tipo não permitido. Aceitos: PDF, imagens, planilhas, Word e texto.'
  if (a.size > TAMANHO_MAX_ARQUIVO) return 'O arquivo passa de 15 MB.'
  if (a.size === 0) return 'O arquivo está vazio.'
  return null
}

// ───────── Abas ─────────

export const ABAS_FICHA = [
  { id: 'feed', rotulo: 'Feed' },
  { id: 'dados', rotulo: 'Dados' },
  { id: 'pedidos', rotulo: 'Pedidos' },
  { id: 'tarefas', rotulo: 'Tarefas' },
  { id: 'agenda', rotulo: 'Agenda' },
] as const
