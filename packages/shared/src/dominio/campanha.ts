/**
 * CAMPANHAS V2 (F1) — vocabulário e regras PURAS que a API e o console usam iguais.
 * TypeScript puro: nada de framework, nada de IO. Dinheiro em centavos inteiros.
 */

// ── Estados ──────────────────────────────────────────────────────────────────

/**
 * Estados da campanha. `disparando` é do modelo LEGADO (segmento + texto livre) e
 * continua valendo para as campanhas antigas; a v2 usa `agendada`/`enviando`.
 */
export const ESTADOS_CAMPANHA = [
  'rascunho', 'agendada', 'enviando', 'disparando', 'pausada', 'concluida', 'cancelada',
] as const
export type EstadoCampanha = (typeof ESTADOS_CAMPANHA)[number]

export function ehEstadoCampanha(v: unknown): v is EstadoCampanha {
  return typeof v === 'string' && (ESTADOS_CAMPANHA as readonly string[]).includes(v)
}

export const ROTULO_ESTADO_CAMPANHA: Readonly<Record<EstadoCampanha, string>> = {
  rascunho: 'Rascunho', agendada: 'Agendada', enviando: 'Enviando', disparando: 'Disparando',
  pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Cancelada',
}

/** Estado de cada destinatário. A ordem do funil é a da lista até `respondeu`. */
export const ESTADOS_DESTINATARIO = [
  'pendente', 'enviando', 'enviada', 'entregue', 'lida', 'respondeu', 'falhou', 'excluida', 'optout',
] as const
export type EstadoDestinatario = (typeof ESTADOS_DESTINATARIO)[number]

export function ehEstadoDestinatario(v: unknown): v is EstadoDestinatario {
  return typeof v === 'string' && (ESTADOS_DESTINATARIO as readonly string[]).includes(v)
}

export const ROTULO_ESTADO_DESTINATARIO: Readonly<Record<EstadoDestinatario, string>> = {
  pendente: 'Na fila', enviando: 'Enviando', enviada: 'Enviada', entregue: 'Entregue', lida: 'Lida',
  respondeu: 'Respondeu', falhou: 'Falhou', excluida: 'Excluída', optout: 'Pediu para sair',
}

// ── Exclusões automáticas do público ─────────────────────────────────────────

/**
 * Motivos de exclusão, NA ORDEM em que são avaliados (o primeiro que casa vence).
 * `foraDoEscopo` vem primeiro: quem não enxerga o contato não precisa saber por que
 * ele ficaria de fora. `telefoneDuplicado`: dois contatos com a mesma chave de
 * telefone (com e sem o nono dígito) — só o primeiro recebe.
 */
export const MOTIVOS_EXCLUSAO = [
  'foraDoEscopo', 'optout', 'anonimizado', 'semTelefone',
  'conversaRecente', 'campanhaRecente', 'compraRecente', 'telefoneDuplicado',
] as const
export type MotivoExclusao = (typeof MOTIVOS_EXCLUSAO)[number]

export const ROTULO_MOTIVO_EXCLUSAO: Readonly<Record<MotivoExclusao, string>> = {
  foraDoEscopo: 'Fora do seu escopo',
  optout: 'Pediu para não receber',
  anonimizado: 'Contato inativo ou anonimizado',
  semTelefone: 'Sem telefone válido',
  conversaRecente: 'Conversou recentemente',
  campanhaRecente: 'Recebeu campanha recentemente',
  compraRecente: 'Comprou recentemente',
  telefoneDuplicado: 'Telefone repetido em outro contato',
}

/** Janelas padrão das exclusões configuráveis (dias). 0 desliga a exclusão. */
export const EXCLUSOES_PADRAO = {
  conversaRecenteDias: 7,
  campanhaRecenteDias: 30,
  compraRecenteDias: 7,
} as const

export const LIMITES_EXCLUSOES = {
  conversaRecenteDias: 90,
  campanhaRecenteDias: 180,
  compraRecenteDias: 365,
} as const

// ── Público ──────────────────────────────────────────────────────────────────

/**
 * O público da campanha. **AND entre tipos, OR dentro do tipo**: `{etiquetas: [A, B],
 * origens: [X]}` = (tem A OU tem B) E veio de X. Tipo ausente ou vazio não restringe;
 * público sem nenhum filtro = a base inteira (menos as exclusões).
 */
export interface PublicoCampanha {
  readonly segmentos?: readonly string[]
  readonly listas?: readonly string[]
  readonly etapas?: readonly string[]
  readonly origens?: readonly string[]
  readonly etiquetas?: readonly string[]
  readonly qualificacao?: readonly string[]
  /** Sem conversa nem toque há pelo menos N dias. */
  readonly semInteracaoDias?: number
  /** 'AAAA-MM-DD', dia do tenant. */
  readonly criadoDe?: string
  readonly criadoAte?: string
  readonly exclusoes?: {
    readonly conversaRecenteDias?: number
    readonly campanhaRecenteDias?: number
    readonly compraRecenteDias?: number
  }
}

// ── Envio ────────────────────────────────────────────────────────────────────

export const LOTE_DIARIO_PADRAO = 500
export const LOTE_DIARIO_MAXIMO = 10000
/** Envio de teste: no máximo 5 números, fora do lote. */
export const MAX_TELEFONES_TESTE = 5
/** Resposta do cliente até 7 dias depois do envio conta para a campanha. */
export const JANELA_RESPOSTA_DIAS = 7

/**
 * Janela de envio quando nem a campanha nem o número declaram horário: 8h às 20h de
 * segunda a sábado, no fuso do tenant. ⚠️ O expediente vazio vale "aberto 24h" para o
 * ATENDIMENTO (quem escreve às 3h recebe resposta); para disparo de marketing, 3h da
 * manhã é denúncia garantida — então a campanha tem o seu recuo.
 */
export const JANELA_CAMPANHA_PADRAO: Readonly<Record<string, { de: string; ate: string } | null>> = {
  seg: { de: '08:00', ate: '20:00' }, ter: { de: '08:00', ate: '20:00' }, qua: { de: '08:00', ate: '20:00' },
  qui: { de: '08:00', ate: '20:00' }, sex: { de: '08:00', ate: '20:00' }, sab: { de: '08:00', ate: '20:00' }, dom: null,
}

/** Dias para enviar a todos os elegíveis no ritmo do lote diário. */
export function duracaoDias(elegiveis: number, loteDiario: number): number {
  if (elegiveis <= 0) return 0
  return Math.ceil(elegiveis / Math.max(1, Math.floor(loteDiario)))
}

/** Custo estimado: mensagens × preço por mensagem (centavos inteiros). */
export function custoCampanhaCentavos(mensagens: number, centavosPorMensagem: number): number {
  return Math.max(0, mensagens) * Math.max(0, centavosPorMensagem)
}

/** Custo por venda, ou null sem venda (nunca divide por zero, nunca devolve fração). */
export function custoPorVenda(custoCentavos: number, vendas: number): number | null {
  return vendas > 0 ? Math.round(custoCentavos / vendas) : null
}

// ── Pausa automática ─────────────────────────────────────────────────────────

/** Opt-out acima de 2% dos ENVIADOS pausa — com pelo menos 50 envios. */
export const PAUSA_OPTOUT_PCT = 2
/** Falha acima de 10% dos PROCESSADOS (enviados + falhas) pausa — com pelo menos 50. */
export const PAUSA_FALHA_PCT = 10
export const PAUSA_AMOSTRA_MINIMA = 50

export type MotivoPausa = 'manual' | 'optout_alto' | 'falhas_altas' | 'qualidade_numero' | 'template_indisponivel'

export const ROTULO_MOTIVO_PAUSA: Readonly<Record<MotivoPausa, string>> = {
  manual: 'Pausada por uma pessoa',
  optout_alto: 'Pausa automática: muitos pedidos para sair (acima de 2% dos enviados)',
  falhas_altas: 'Pausa automática: muitas falhas de envio (acima de 10%)',
  qualidade_numero: 'Pausa automática: a Meta baixou a qualidade do número',
  template_indisponivel: 'Pausa automática: o template deixou de estar aprovado na Meta',
}

export interface ContagemPausa {
  /** Envios que saíram (com ou sem entrega). */
  readonly enviados: number
  readonly optouts: number
  /** Enviados + falhas de envio (o que já foi tentado). */
  readonly processados: number
  readonly falhas: number
}

/**
 * Motivo da pausa automática pelas taxas, ou null. Comparação em inteiros
 * (parte × 100 > pct × total), sem ponto flutuante. Falha vem primeiro: número
 * com problema de envio tem de parar antes de se medir opt-out.
 */
export function motivoPausaAutomatica(c: ContagemPausa): 'optout_alto' | 'falhas_altas' | null {
  if (c.processados >= PAUSA_AMOSTRA_MINIMA && c.falhas * 100 > PAUSA_FALHA_PCT * c.processados) return 'falhas_altas'
  if (c.enviados >= PAUSA_AMOSTRA_MINIMA && c.optouts * 100 > PAUSA_OPTOUT_PCT * c.enviados) return 'optout_alto'
  return null
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────

export type AcaoCampanha = 'editar' | 'excluir' | 'iniciar' | 'pausar' | 'retomar' | 'cancelar' | 'testar'

/** O que cada estado permite. A API decide com isto; a tela mostra os botões com isto. */
export function acaoPermitida(estado: EstadoCampanha, acao: AcaoCampanha): boolean {
  switch (acao) {
    case 'editar': case 'excluir': case 'iniciar': return estado === 'rascunho'
    case 'pausar': return estado === 'agendada' || estado === 'enviando'
    case 'retomar': return estado === 'pausada'
    case 'cancelar': return estado === 'rascunho' || estado === 'agendada' || estado === 'enviando' || estado === 'pausada'
    case 'testar': return estado !== 'cancelada' && estado !== 'concluida' && estado !== 'disparando'
  }
}

/** A confirmação digitada para iniciar: igual ao nome, ignorando espaços nas pontas. */
export function confirmacaoDoNomeConfere(nome: string, digitado: unknown): boolean {
  return typeof digitado === 'string' && digitado.trim().length > 0 && digitado.trim() === nome.trim()
}
