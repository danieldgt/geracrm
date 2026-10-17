import { z } from 'zod'

/**
 * AGENTE VENDEDOR — contratos compartilhados (ADR-023).
 *
 * O console configura, a API executa, o app de campo vai mostrar. Tudo que os
 * três precisam concordar mora aqui; o resto (prompt, ferramentas, laço) é da API.
 */

export const MODOS_AGENTE = ['desligado', 'sombra', 'assistido', 'autonomo'] as const
export type ModoAgente = (typeof MODOS_AGENTE)[number]

export const ROTULO_MODO: Readonly<Record<ModoAgente, string>> = {
  desligado: 'Desligado',
  sombra: 'Sombra — decide e registra, não envia',
  assistido: 'Assistido — sugere, o vendedor aprova',
  autonomo: 'Autônomo — responde sozinho',
}

/**
 * Em que modo UM TURNO roda: o modo do número, ou uma das execuções sem efeito
 * no cliente — `simulacao` (playground) e `copiloto` (o vendedor humano pede
 * uma sugestão sob demanda; só leitura). Os dois últimos nunca enviam.
 */
export type ModoDoTurno = ModoAgente | 'simulacao' | 'copiloto'

export const OBJETIVOS_AGENTE = ['vender', 'qualificar'] as const
export type ObjetivoAgente = (typeof OBJETIVOS_AGENTE)[number]

export const TONS = ['informal', 'neutro', 'formal'] as const
export type Tom = (typeof TONS)[number]

/** Persona: o que muda de loja para loja sem mudar o prompt. */
export const persona = z.object({
  nome: z.string().trim().min(1).max(40).default('Assistente'),
  /** Nome da loja como o cliente a conhece. */
  loja: z.string().trim().max(80).default(''),
  tom: z.enum(TONS).default('neutro'),
  usaEmojis: z.boolean().default(false),
  idioma: z.literal('pt-BR').default('pt-BR'),
  /** Primeira frase quando o agente abre a conversa (opcional). */
  saudacao: z.string().trim().max(300).default(''),
  /** Como se apresenta: a Meta exige identificar atendimento automatizado. */
  identificaComoRobo: z.boolean().default(true),
})
export type Persona = z.input<typeof persona>
export type PersonaResolvida = z.output<typeof persona>
export const PERSONA_PADRAO: PersonaResolvida = persona.parse({})

/** Slots de qualificação (SPIN/BANT como campos, não como script). */
export const SLOTS_QUALIFICACAO = ['tipoCompra', 'cidade', 'volume', 'prazo', 'orcamento', 'necessidade', 'cnpj'] as const
export type SlotQualificacao = (typeof SLOTS_QUALIFICACAO)[number]

export const FASES_VENDA = ['descoberta', 'recomendacao', 'proposta', 'fechamento', 'handoff', 'encerrada'] as const
export type FaseDaVenda = (typeof FASES_VENDA)[number]

/**
 * Motivos que o MODELO pode escolher (enum da saída estruturada e da ferramenta
 * `transferir`). ⚠️ Mudar esta lista muda o JSON Schema enviado ao fornecedor —
 * é mudança de comportamento do agente (changelog + evals).
 */
export const MOTIVOS_HANDOFF_DO_MODELO = [
  'pedido_de_humano', 'reclamacao', 'desconto_fora_da_politica', 'incerteza',
  'sentimento_negativo', 'fora_do_escopo', 'acima_da_alcada', 'modelo_indisponivel',
  'limite_de_turnos', 'qualificado', 'limite_de_custo', 'ferramenta_indisponivel',
] as const

/**
 * Motivos que só o PIPELINE decide, em código, antes ou depois do modelo
 * (gatilhos de entrada, teto por conversa, regras de qualidade, playbook).
 * Ficam fora do enum do modelo de propósito: o modelo não "decide" opt-out.
 */
export const MOTIVOS_HANDOFF_DO_PIPELINE = [
  'qualidade_violacao_critica', 'limite_de_custo_conversa', 'opt_out',
  'audio_sem_transcricao', 'pergunta_robo', 'gatilho_playbook',
] as const

export const MOTIVOS_HANDOFF = [...MOTIVOS_HANDOFF_DO_MODELO, ...MOTIVOS_HANDOFF_DO_PIPELINE] as const
export type MotivoHandoff = (typeof MOTIVOS_HANDOFF)[number]

export const ROTULO_HANDOFF: Readonly<Record<MotivoHandoff, string>> = {
  pedido_de_humano: 'o cliente pediu uma pessoa',
  reclamacao: 'reclamação ou problema com pedido',
  desconto_fora_da_politica: 'pediu desconto fora da política',
  incerteza: 'o agente não tinha como responder',
  sentimento_negativo: 'cliente irritado',
  fora_do_escopo: 'assunto fora do escopo da loja',
  acima_da_alcada: 'pedido acima da alçada do agente',
  modelo_indisponivel: 'IA indisponível',
  limite_de_turnos: 'teto de idas e vindas',
  qualificado: 'lead qualificado — pronto para o vendedor',
  limite_de_custo: 'limite de custo do dia',
  ferramenta_indisponivel: 'ferramenta necessária não disponível',
  qualidade_violacao_critica: 'resposta barrada por violação crítica de qualidade',
  limite_de_custo_conversa: 'limite de custo desta conversa',
  opt_out: 'o cliente pediu para não receber mais mensagens',
  audio_sem_transcricao: 'áudio que não deu para transcrever',
  pergunta_robo: 'o cliente insistiu em saber se fala com um robô',
  gatilho_playbook: 'gatilho de transferência do playbook',
}

/**
 * A RESPOSTA do modelo num turno — o que o laço exige como saída estruturada.
 * ⚠️ 1 a 3 mensagens curtas: cada bolha custa dinheiro na Meta desde out/2026.
 */
const slotsDaResposta = z.object(
  Object.fromEntries(SLOTS_QUALIFICACAO.map((k) => [k, z.string().trim().max(120).optional()])) as {
    [K in SlotQualificacao]: z.ZodOptional<z.ZodString>
  },
)

export const respostaDoAgente = z.object({
  mensagens: z.array(z.string().trim().min(1).max(1200)).min(1).max(3),
  /** 0..1 — abaixo do limiar do canal vira handoff por incerteza. */
  confianca: z.number().min(0).max(1),
  fase: z.enum(FASES_VENDA).optional(),
  handoff: z.object({ motivo: z.enum(MOTIVOS_HANDOFF_DO_MODELO), resumo: z.string().trim().max(600) }).optional(),
  /**
   * Slots que o cliente DISSE neste turno. Ainda passam por validação.
   * ⚠️ Objeto plano com cada slot opcional — nunca `z.record`/`z.partialRecord`:
   * o record com enum de chaves é exaustivo no Zod 4 (`{}` reprova) e os dois
   * viram `propertyNames` no JSON Schema, que fornecedores gratuitos (Nvidia via
   * OpenRouter) recusam com "Grammar error". Chave desconhecida é descartada.
   */
  slots: slotsDaResposta.optional(),
})
export type RespostaDoAgente = z.infer<typeof respostaDoAgente>

// ─────────────────────────────────────────────────────────────────────────────
// MARCAS DE GUARDRAIL (pipeline do agente, ADR-029)
// ─────────────────────────────────────────────────────────────────────────────

export const GRAVIDADES_GUARDRAIL = ['CRITICA', 'ALTA', 'MEDIA', 'INFO'] as const
export type GravidadeGuardrail = (typeof GRAVIDADES_GUARDRAIL)[number]

export const ACOES_GUARDRAIL = ['removido', 'reescrito', 'anexado', 'substituido', 'bloqueado', 'handoff', 'registrado'] as const
export type AcaoGuardrail = (typeof ACOES_GUARDRAIL)[number]

/** Tamanho máximo do trecho citado numa marca (sempre mascarado antes). */
export const MAX_TRECHO_GUARDRAIL = 160

/**
 * O que uma etapa do pipeline fez com a resposta de um turno. Grava em
 * `agente_decisao.guardrails`; a tela de decisões e a de qualidade leem daqui.
 * `trecho` nunca carrega PII crua (≤160, mascarado por quem cria a marca).
 */
export interface MarcaGuardrail {
  readonly etapa: string
  readonly codigo: string
  readonly gravidade: GravidadeGuardrail
  readonly acao: AcaoGuardrail
  readonly trecho?: string | undefined
}

export const marcaGuardrail = z.object({
  etapa: z.string().min(1).max(60),
  codigo: z.string().min(1).max(80),
  gravidade: z.enum(GRAVIDADES_GUARDRAIL),
  acao: z.enum(ACOES_GUARDRAIL),
  trecho: z.string().max(MAX_TRECHO_GUARDRAIL).optional(),
})

/**
 * GUARDRAIL NUMÉRICO: todo valor monetário citado na resposta precisa ter vindo
 * de uma ferramenta neste turno. Regra pura, testável sem modelo.
 *
 * Retorna os números que NÃO foram encontrados nos permitidos (vazio = ok).
 * Compara em centavos; "R$ 12,90", "12,90 reais", "R$12.90" e "1.299,00" contam.
 */
export function verificarNumerosNaResposta(texto: string, permitidosCentavos: ReadonlySet<number>): number[] {
  const achados = new Set<number>()
  const numero = String.raw`(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`
  const padroes = [
    // "R$ 49,90" · "49,90 reais"
    new RegExp(String.raw`(?:R\$\s?)${numero}|${numero}\s?(?:reais|real)\b`, 'gi'),
    // "custa 1299" · "fica 39,90" · "sai por 120" · "preço 89" · "a partir de 59"
    new RegExp(String.raw`\b(?:custa|custam|fica|ficam|sai por|saem por|sai a|preço|preco|valor|a partir de|por apenas)\s*(?:de\s*)?(?:R\$\s?)?${numero}`, 'gi'),
    // "39,90 cada" · "1299 a unidade" · "59 por peça"
    new RegExp(String.raw`${numero}\s?(?:cada|a unidade|por unidade|a peça|por peça|o par|por mês|/mês|mensais)\b`, 'gi'),
    // decimal com vírgula e dois dígitos é dinheiro em pt-BR ("39,90"), mesmo sem R$
    /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/g,
  ]
  for (const re of padroes) {
    for (const m of texto.matchAll(re)) {
      const bruto = (m[1] ?? m[2] ?? '').trim()
      if (!bruto) continue
      const cents = paraCentavos(bruto)
      if (cents !== null && cents > 0 && !permitidosCentavos.has(cents)) achados.add(cents)
    }
  }
  return [...achados]
}

function paraCentavos(bruto: string): number | null {
  let s = bruto
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else if (/\.\d{1,2}$/.test(s) && !/\.\d{3}$/.test(s)) s = s.replace(/,/g, '')
  else s = s.replace(/[.,]/g, '')
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Divide um texto longo em bolhas de até `max` caracteres, por parágrafo/frase. */
export function fatiarMensagem(texto: string, max = 1000): string[] {
  const limpo = texto.trim()
  if (limpo.length <= max) return limpo ? [limpo] : []
  const partes: string[] = []
  let atual = ''
  for (const bloco of limpo.split(/\n{2,}|(?<=[.!?])\s+/)) {
    if (!bloco) continue
    if ((atual + '\n' + bloco).trim().length > max && atual) {
      partes.push(atual.trim()); atual = bloco
    } else atual = atual ? `${atual}\n${bloco}` : bloco
  }
  if (atual.trim()) partes.push(atual.trim())
  return partes.flatMap((p) => (p.length <= max ? [p] : p.match(new RegExp(`.{1,${max}}`, 'gs')) ?? [p]))
}
