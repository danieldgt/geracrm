import { z } from 'zod'

/**
 * MENSAGENS ATIVAS DO AGENTE (raia P11, playbook da AM §2.5 e §5.2).
 *
 * "Ativa" é a mensagem que NÓS iniciamos — hoje, o retorno do agente (proposta
 * sem resposta, carrinho abandonado, combinado). Resposta a quem acabou de
 * escrever NÃO é ativa e não passa por nada daqui.
 *
 * Regras, nesta ordem (a primeira que barrar decide):
 *   1. número com ativas SUSPENSAS (qualidade RED/FLAGGED, conta restrita) → adia;
 *   2. fora do EXPEDIENTE do número, ou feriado → adia para a próxima abertura;
 *   3. acima do LIMITE do dia/semana, contado desde a última mensagem do
 *      cliente → descarta (não acumula para depois);
 *   4. canal OFICIAL fora da janela de 24h → só template APROVADO; sem template
 *      configurado ou não aprovado → recusa com o motivo nomeado. O não-oficial
 *      não tem janela (ADR-021) e envia texto.
 *
 * TypeScript puro: consumido pela API e pelo console.
 */

export const LIMITE_ATIVAS_DIA_PADRAO = 2
export const LIMITE_ATIVAS_SEMANA_PADRAO = 4
export const LIMITE_ATIVAS_MAX_DIA = 10
export const LIMITE_ATIVAS_MAX_SEMANA = 30
export const MAX_FERIADOS = 60

/** "AAAA-MM-DD" vale só naquele dia; "MM-DD" vale todo ano (feriado fixo). */
export const FERIADO = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * ⚠️ O descarte automático é DESLIGADO por padrão (0): é o agente mexendo no CRM
 * sozinho, e só acontece no número em que o dono o ligou explicitamente.
 * `DESCARTE_APOS_HORAS_SUGERIDO` é só a sugestão mostrada na tela.
 */
export const DESCARTE_APOS_HORAS_PADRAO = 0
export const DESCARTE_APOS_HORAS_SUGERIDO = 72
export const DESCARTE_APOS_HORAS_MAX = 720
export const REATIVACAO_DIAS_PADRAO: readonly number[] = [30, 90]
export const REATIVACAO_DIAS_MIN = 7
export const REATIVACAO_DIAS_MAX = 365
export const REATIVACAO_MAX_PASSOS = 3
export const REATIVACAO_TEXTO_MAX = 500
/**
 * Teto de reativações ENVIADAS por número por dia (fuso do tenant). Conservador:
 * a reativação fala com quem não respondeu — no não-oficial é o tipo de envio que
 * mais leva a denúncia e banimento (ADR-021). Soma-se à cota do aquecimento.
 */
export const REATIVACAO_LIMITE_DIA_PADRAO = 30
export const REATIVACAO_LIMITE_DIA_MAX = 200

/**
 * Reativação do contato descartado por `sem_resposta` (raia G5): uma ativa por
 * marco em `dias` (contados do descarte). Desligada por padrão.
 * Oficial: SEMPRE o template aprovado (`templateId`). Não-oficial: o `texto`
 * configurado — sem ele, nada é enviado.
 */
export const reativacaoAtivas = z.object({
  ativa: z.boolean(),
  dias: z.array(z.number().int().min(REATIVACAO_DIAS_MIN, `Use de ${REATIVACAO_DIAS_MIN} a ${REATIVACAO_DIAS_MAX} dias.`)
    .max(REATIVACAO_DIAS_MAX, `Use de ${REATIVACAO_DIAS_MIN} a ${REATIVACAO_DIAS_MAX} dias.`))
    .min(1, 'Informe ao menos um prazo.').max(REATIVACAO_MAX_PASSOS, `No máximo ${REATIVACAO_MAX_PASSOS} prazos.`),
  templateId: z.string().uuid().nullable(),
  texto: z.string().trim().max(REATIVACAO_TEXTO_MAX).nullable().default(null),
  /** Máximo de reativações enviadas por ESTE número por dia; acabou a cota, a próxima espera o dia seguinte. */
  limiteDia: z.number().int().min(1, `Use de 1 a ${REATIVACAO_LIMITE_DIA_MAX} por dia.`)
    .max(REATIVACAO_LIMITE_DIA_MAX, `Use de 1 a ${REATIVACAO_LIMITE_DIA_MAX} por dia.`).default(REATIVACAO_LIMITE_DIA_PADRAO),
}).refine((r) => r.dias.every((d, i) => i === 0 || d > r.dias[i - 1]!), {
  message: 'Os prazos da reativação devem ser crescentes.', path: ['dias'],
})
export type ReativacaoAtivas = z.infer<typeof reativacaoAtivas>

export const REATIVACAO_PADRAO: ReativacaoAtivas = {
  ativa: false, dias: [...REATIVACAO_DIAS_PADRAO], templateId: null, texto: null, limiteDia: REATIVACAO_LIMITE_DIA_PADRAO,
}

export const configAtivas = z.object({
  limiteDia: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_DIA),
  limiteSemana: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_SEMANA),
  /** Id do template usado no OFICIAL fora da janela de 24h. `null` = nenhum. */
  templateRetorno: z.string().uuid().nullable(),
  /** Horas após o ÚLTIMO retorno sem resposta até descartar o contato (`sem_resposta`). 0 = não descarta (padrão). */
  descarteAposHoras: z.number().int().min(0).max(DESCARTE_APOS_HORAS_MAX),
  reativacao: reativacaoAtivas,
}).refine((c) => c.limiteSemana >= c.limiteDia, {
  message: 'O limite da semana não pode ser menor que o do dia.', path: ['limiteSemana'],
})
export type ConfigAtivas = z.infer<typeof configAtivas>

export const ATIVAS_PADRAO: ConfigAtivas = {
  limiteDia: LIMITE_ATIVAS_DIA_PADRAO,
  limiteSemana: LIMITE_ATIVAS_SEMANA_PADRAO,
  templateRetorno: null,
  descarteAposHoras: DESCARTE_APOS_HORAS_PADRAO,
  reativacao: REATIVACAO_PADRAO,
}

/**
 * Corpo do PUT: a config das ativas + os feriados do número. `descarteAposHoras`
 * e `reativacao` são opcionais: ausentes, o servidor mantém o que já está salvo
 * (cliente antigo não zera a política nova).
 */
export const corpoAtivas = z.object({
  limiteDia: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_DIA),
  limiteSemana: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_SEMANA),
  templateRetorno: z.string().uuid().nullable(),
  descarteAposHoras: z.number().int().min(0).max(DESCARTE_APOS_HORAS_MAX).optional(),
  reativacao: reativacaoAtivas.optional(),
  /**
   * Ligar a reativação num número NÃO-OFICIAL exige este `true`: a pessoa leu e
   * confirmou (digitando) o risco de banimento (ADR-021). Sem ele, 422 tipificado.
   */
  confirmaRiscoBanimento: z.boolean().optional(),
  feriados: z.array(z.string().regex(FERIADO)).max(MAX_FERIADOS),
}).refine((c) => c.limiteSemana >= c.limiteDia, {
  message: 'O limite da semana não pode ser menor que o do dia.', path: ['limiteSemana'],
})
export type CorpoAtivas = z.infer<typeof corpoAtivas>

/**
 * Leitura TOLERANTE do jsonb gravado: campo ausente ou inválido cai no padrão,
 * campo a campo. Um valor torto nunca derruba o worker de retorno.
 */
export function lerConfigAtivas(bruto: unknown): ConfigAtivas {
  const o = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>
  const inteiro = (v: unknown, min: number, max: number, padrao: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : padrao
  const limiteDia = inteiro(o['limiteDia'], 1, LIMITE_ATIVAS_MAX_DIA, LIMITE_ATIVAS_DIA_PADRAO)
  const limiteSemana = Math.max(limiteDia, inteiro(o['limiteSemana'], 1, LIMITE_ATIVAS_MAX_SEMANA, LIMITE_ATIVAS_SEMANA_PADRAO))
  const t = o['templateRetorno']
  const templateRetorno = typeof t === 'string' && z.string().uuid().safeParse(t).success ? t : null
  const descarteAposHoras = inteiro(o['descarteAposHoras'], 0, DESCARTE_APOS_HORAS_MAX, DESCARTE_APOS_HORAS_PADRAO)
  return { limiteDia, limiteSemana, templateRetorno, descarteAposHoras, reativacao: lerReativacao(o['reativacao']) }
}

/** Leitura tolerante da reativação: qualquer coisa torta cai no padrão (desligada). */
export function lerReativacao(bruto: unknown): ReativacaoAtivas {
  const r = reativacaoAtivas.safeParse(bruto)
  return r.success ? r.data : { ...REATIVACAO_PADRAO, dias: [...REATIVACAO_DIAS_PADRAO] }
}

/** A reativação só existe nos canais de WhatsApp (oficial e não-oficial); Instagram e TikTok não. */
export function canalAceitaReativacao(tipoCanal: string): boolean {
  return tipoCanal === 'whatsapp_oficial' || tipoCanal === 'whatsapp_nao_oficial'
}

/** Normaliza a lista de feriados: só formatos válidos, sem repetição, ordenada. */
export function normalizarFeriados(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return []
  const validos = bruto.filter((f): f is string => typeof f === 'string' && FERIADO.test(f))
  return [...new Set(validos)].sort().slice(0, MAX_FERIADOS)
}

/** Por que uma ativa NÃO saiu agora. */
export const MOTIVOS_ATIVA_BARRADA = [
  'ativas_suspensas', 'fora_do_expediente', 'feriado', 'limite_dia', 'limite_semana',
  'sem_template', 'template_indisponivel', 'template_incompativel',
] as const
export type MotivoAtivaBarrada = (typeof MOTIVOS_ATIVA_BARRADA)[number]

export const ROTULO_MOTIVO_ATIVA: Readonly<Record<MotivoAtivaBarrada, string>> = {
  ativas_suspensas: 'Ativas suspensas pela qualidade do número — espera liberar',
  fora_do_expediente: 'Fora do expediente — sai na próxima abertura',
  feriado: 'Feriado — sai na próxima abertura',
  limite_dia: 'Limite de mensagens ativas do dia atingido — descartada',
  limite_semana: 'Limite de mensagens ativas da semana atingido — descartada',
  sem_template: 'Oficial fora da janela de 24h e nenhum template de retorno configurado',
  template_indisponivel: 'O template de retorno não está aprovado pela Meta',
  template_incompativel: 'O template de retorno tem variáveis além do nome do cliente',
}

/** Resumo de um template aprovado, para a escolha do template de retorno. */
export interface TemplateAprovadoResumo {
  readonly id: string
  readonly nome: string
  readonly idioma: string
  readonly categoria: string
  readonly corpo: string
  /** Quantas variáveis posicionais o corpo tem. Só 0 ou 1 ({{1}} = primeiro nome) servem ao retorno. */
  readonly variaveis: number
  /** Serve ao retorno? Nenhuma variável, ou só a {{1}} (ver `templateDeRetornoCompativel`). */
  readonly compativel: boolean
}

/** O que a tela de ativas lê (GET /v1/canais/:id/agente/ativas). */
export interface EstadoAtivas {
  readonly config: ConfigAtivas
  readonly padroes: ConfigAtivas
  readonly feriados: readonly string[]
  /** Fuso IANA do tenant — datas da tela (próxima abertura, suspensão) são mostradas nele. */
  readonly fuso: string
  /** `whatsapp_oficial` exige template fora de 24h; os demais não. */
  readonly tipoCanal: string
  readonly exigeTemplateForaDaJanela: boolean
  /** Horário de atendimento declarado no número? Sem ele, as ativas saem a qualquer hora. */
  readonly horarioConfigurado: boolean
  readonly expediente: { readonly aberto: boolean; readonly proximaAbertura: string | null }
  readonly suspensao: { readonly desde: string; readonly motivo: string } | null
  /** O template escolhido, como está AGORA na Meta (pode ter sido pausado). */
  readonly template: (TemplateAprovadoResumo & { readonly status: string }) | null
}

/** Quantas variáveis posicionais ({{1}}, {{2}}…) distintas o texto usa. */
export function contarVariaveis(texto: string): number {
  return new Set([...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size
}

/**
 * O corpo serve de template de RETORNO? Só sem variáveis ou com a ÚNICA
 * variável {{1}} (= primeiro nome). Um {{2}} sozinho, ou {{1}} + {{2}}, exigiria
 * inventar valor — recusado na tela (PUT) e no envio, pela mesma regra.
 */
export function templateDeRetornoCompativel(texto: string): boolean {
  const usadas = new Set([...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))
  return usadas.size === 0 || (usadas.size === 1 && usadas.has(1))
}

/** Primeiro nome para o {{1}} — nunca vazio (a Meta recusa parâmetro vazio). */
export function primeiroNome(nome: string | null | undefined): string {
  const p = (nome ?? '').trim().split(/\s+/)[0] ?? ''
  // Nome que é telefone (lead sem perfil) não serve de saudação.
  if (!p || /^\+?\d[\d\s-]*$/.test(p)) return 'cliente'
  return p.slice(0, 40)
}
