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

export const configAtivas = z.object({
  limiteDia: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_DIA),
  limiteSemana: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_SEMANA),
  /** Id do template usado no OFICIAL fora da janela de 24h. `null` = nenhum. */
  templateRetorno: z.string().uuid().nullable(),
}).refine((c) => c.limiteSemana >= c.limiteDia, {
  message: 'O limite da semana não pode ser menor que o do dia.', path: ['limiteSemana'],
})
export type ConfigAtivas = z.infer<typeof configAtivas>

export const ATIVAS_PADRAO: ConfigAtivas = {
  limiteDia: LIMITE_ATIVAS_DIA_PADRAO,
  limiteSemana: LIMITE_ATIVAS_SEMANA_PADRAO,
  templateRetorno: null,
}

/** Corpo do PUT: a config das ativas + os feriados do número. */
export const corpoAtivas = z.object({
  limiteDia: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_DIA),
  limiteSemana: z.number().int().min(1).max(LIMITE_ATIVAS_MAX_SEMANA),
  templateRetorno: z.string().uuid().nullable(),
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
  return { limiteDia, limiteSemana, templateRetorno }
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
}

/** O que a tela de ativas lê (GET /v1/canais/:id/agente/ativas). */
export interface EstadoAtivas {
  readonly config: ConfigAtivas
  readonly padroes: ConfigAtivas
  readonly feriados: readonly string[]
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

/** Primeiro nome para o {{1}} — nunca vazio (a Meta recusa parâmetro vazio). */
export function primeiroNome(nome: string | null | undefined): string {
  const p = (nome ?? '').trim().split(/\s+/)[0] ?? ''
  // Nome que é telefone (lead sem perfil) não serve de saudação.
  if (!p || /^\+?\d[\d\s-]*$/.test(p)) return 'cliente'
  return p.slice(0, 40)
}
