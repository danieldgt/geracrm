import { z } from 'zod'
import { SLOTS_QUALIFICACAO, TONS, verificarNumerosNaResposta, type PersonaResolvida, type SlotQualificacao } from './agente-vendedor.js'
import {
  LIMITES_COMPLIANCE, PROMESSA_PRAZO_RE, ajustarMensagemHandoff, chaveLiteral, filtrarSaida, semDuplicatas, type ComplianceExtra,
} from './agente-filtro.js'
import { textoAvisoPrivacidade } from './agente-gatilhos.js'
import { PERGUNTA_DO_SLOT } from './agente-perguntas.js'

/**
 * PLAYBOOK COMERCIAL VERSIONADO (raia P17; ADR-029, ADR-033).
 *
 * "Como vender" por tenant ou por número — estilo, persona, roteiro de
 * qualificação, mensagens prontas, compliance EXTRA e ações habilitáveis —
 * editado na tela num RASCUNHO, testado no sandbox (modo seco), PUBLICADO com
 * observação e guardado como versão IMUTÁVEL. Restaurar = publicar uma cópia de
 * versão antiga como versão nova.
 *
 * ⚠️ A REGRA DE FRONTEIRA (ADR-029 §5): o playbook só ACRESCENTA restrição.
 *    Não existe campo para desligar guardrail — os schemas são `.strict()`, então
 *    um corpo com `identificaComoRobo: false`, `atendimento_transferir: false`
 *    ou `removerFrasesBase` é recusado (422), não ignorado. O que protege
 *    (filtro base, número só com fonte, opt-out, transferir, identificação como
 *    assistente, aviso de privacidade) fica no código.
 *
 * ⚠️ Fato (preço, prazo, condição) NÃO mora aqui — mora no conhecimento, onde é
 *    fonte citável. Por isso as mensagens prontas não aceitam valor em reais,
 *    percentual nem número de negócio: antes do modelo não há ferramenta no
 *    turno, então qualquer número seria "sem fonte".
 *
 * TypeScript puro: consumido pela API (pipeline, rotas), pelo console e pelo app.
 */

// ── limites ────────────────────────────────────────────────────────────────

export const LIMITES_PLAYBOOK = {
  maxCaracteresMin: 120,
  maxCaracteresMax: 1000,
  maxPerguntasMin: 1,
  maxPerguntasMax: 3,
  orientacoes: 1500,
  pergunta: 200,
  mensagem: 600,
  observacaoMin: 10,
  observacaoMax: 500,
  resumoMudancas: 20,
} as const

/** Os únicos placeholders aceitos nas mensagens prontas. */
export const PLACEHOLDERS_PLAYBOOK = ['{nome}', '{assistente}', '{empresa}'] as const

// ── seções ─────────────────────────────────────────────────────────────────

export const TRATAMENTOS = ['voce', 'senhor_senhora'] as const
export type Tratamento = (typeof TRATAMENTOS)[number]

export const estiloPlaybook = z.object({
  tratamento: z.enum(TRATAMENTOS),
  /** Máximo de caracteres POR MENSAGEM (bolha) — aplicado no FILTRO DE SAÍDA. null = sem limite extra. */
  maxCaracteres: z.number().int().min(LIMITES_PLAYBOOK.maxCaracteresMin).max(LIMITES_PLAYBOOK.maxCaracteresMax).nullable(),
  /** Máximo de perguntas por mensagem — aplicado no FILTRO DE SAÍDA. null = sem limite extra. */
  maxPerguntas: z.number().int().min(LIMITES_PLAYBOOK.maxPerguntasMin).max(LIMITES_PLAYBOOK.maxPerguntasMax).nullable(),
  /** Conduta em texto livre (como abordar, ritmo, objeções). Vai para a instrução do turno. */
  orientacoes: z.string().trim().max(LIMITES_PLAYBOOK.orientacoes),
}).strict()
export type EstiloPlaybook = z.output<typeof estiloPlaybook>

/**
 * Identidade da assistente — o MESMO formato de `agente_config.persona`, sem
 * `identificaComoRobo` (identificar-se é regra, não opção) e sem `idioma`.
 * Publicar espelha a persona em `agente_config.persona` dos números alcançados.
 */
export const personaPlaybook = z.object({
  nome: z.string().trim().min(1).max(40),
  loja: z.string().trim().max(80),
  tom: z.enum(TONS),
  usaEmojis: z.boolean(),
  saudacao: z.string().trim().max(300),
}).strict()
export type PersonaPlaybook = z.output<typeof personaPlaybook>

export const itemQualificacao = z.object({
  slot: z.enum(SLOTS_QUALIFICACAO),
  /** Como perguntar (orientação ao modelo). */
  pergunta: z.string().trim().min(5).max(LIMITES_PLAYBOOK.pergunta),
  obrigatorio: z.boolean(),
  ativo: z.boolean(),
}).strict()
export type ItemQualificacao = z.output<typeof itemQualificacao>

const mensagemPronta = z.string().trim().min(3).max(LIMITES_PLAYBOOK.mensagem).nullable()

export const MENSAGENS_PLAYBOOK = ['abertura', 'handoff', 'foraDoHorario', 'avisoEspera', 'despedida'] as const
export type ChaveMensagemPlaybook = (typeof MENSAGENS_PLAYBOOK)[number]

/** Mensagens prontas. null = o texto padrão do código. */
export const mensagensPlaybook = z.object({
  /** Saudação da 1ª resposta. O sistema SEMPRE garante a identificação como assistente e o aviso de privacidade. */
  abertura: mensagemPronta,
  /** Aviso ao cliente quando um gatilho transfere para uma pessoa (no expediente). */
  handoff: mensagemPronta,
  /** Aviso de transferência fora do expediente. */
  foraDoHorario: mensagemPronta,
  /** Mensagem única de espera quando a fila demora (SLA, P18). */
  avisoEspera: mensagemPronta,
  /** Referência para o modelo ao encerrar a conversa. */
  despedida: mensagemPronta,
}).strict()
export type MensagensPlaybook = z.output<typeof mensagensPlaybook>

const itemCompliancePlaybook = z.string().trim()
  .min(LIMITES_COMPLIANCE.minCaracteres, `Use ao menos ${LIMITES_COMPLIANCE.minCaracteres} caracteres.`)
  .max(LIMITES_COMPLIANCE.maxCaracteres, `Use no máximo ${LIMITES_COMPLIANCE.maxCaracteres} caracteres.`)
const listaCompliancePlaybook = z.array(itemCompliancePlaybook).max(LIMITES_COMPLIANCE.maxItens, `No máximo ${LIMITES_COMPLIANCE.maxItens} itens.`)

/** Compliance EXTRA — o mesmo contrato da P2 (`ComplianceExtra`): só acrescenta à base do código. */
export const compliancePlaybook = z.object({
  frasesProibidas: listaCompliancePlaybook,
  gatilhosHandoff: listaCompliancePlaybook,
}).strict()

/**
 * AÇÕES HABILITÁVEIS — ferramentas que o negócio pode tirar do menu do modelo.
 * ⚠️ `atendimento_transferir`, `cliente_perfil` e os gatilhos de segurança
 *    (opt-out, pedido de humano, "é robô?") NÃO aparecem aqui: ficam sempre
 *    ligados. `.strict()` recusa qualquer chave fora desta lista.
 */
export const ACOES_PLAYBOOK = ['catalogo', 'pedido', 'proposta', 'memoria', 'conhecimento'] as const
export type AcaoPlaybook = (typeof ACOES_PLAYBOOK)[number]
export const acoesPlaybook = z.object({
  catalogo: z.boolean(), pedido: z.boolean(), proposta: z.boolean(), memoria: z.boolean(), conhecimento: z.boolean(),
}).strict()
export type AcoesPlaybook = z.output<typeof acoesPlaybook>
export const ACOES_TODAS_LIGADAS: AcoesPlaybook = { catalogo: true, pedido: true, proposta: true, memoria: true, conhecimento: true }

export const ROTULO_ACAO: Readonly<Record<AcaoPlaybook, { rotulo: string; descricao: string; ferramentas: readonly string[] }>> = {
  catalogo: { rotulo: 'Consultar catálogo', descricao: 'Buscar produtos, ver variações, preço e estoque.', ferramentas: ['catalogo_buscar', 'catalogo_detalhar', 'catalogo_preco_estoque'] },
  pedido: { rotulo: 'Montar pedido', descricao: 'Ver e alterar o rascunho do pedido na conversa.', ferramentas: ['pedido_ver', 'pedido_itens'] },
  proposta: { rotulo: 'Enviar proposta', descricao: 'Mandar o resumo do pedido e pedir a confirmação do cliente (a efetivação nunca é do modelo).', ferramentas: ['pedido_propor'] },
  memoria: { rotulo: 'Anotar memória do cliente', descricao: 'Guardar preferências e objeções para as próximas conversas (nunca dado pessoal).', ferramentas: ['memoria_anotar'] },
  conhecimento: { rotulo: 'Consultar a base de conhecimento', descricao: 'Buscar políticas, prazos e condições nos documentos da loja.', ferramentas: ['conhecimento_buscar'] },
}

/** O que fica SEMPRE ligado e não aparece como opção — mostrado na tela, somente leitura. */
export const SEMPRE_LIGADAS_PLAYBOOK: ReadonlyArray<{ readonly id: string; readonly rotulo: string }> = [
  { id: 'atendimento_transferir', rotulo: 'Transferir para uma pessoa' },
  { id: 'cliente_perfil', rotulo: 'Ler o perfil do cliente' },
  { id: 'opt_out', rotulo: 'Respeitar "pare de mandar mensagem" (opt-out)' },
  { id: 'pedido_humano', rotulo: 'Chamar uma pessoa quando o cliente pede' },
  { id: 'identificacao', rotulo: 'Identificar-se como assistente virtual e mostrar o aviso de privacidade' },
  { id: 'filtro_base', rotulo: 'Filtro de frases proibidas da base (promessa de entrega, preço, desconto…)' },
  { id: 'numeros', rotulo: 'Preço, prazo, % e quantidade só com fonte no turno' },
  { id: 'pedido_efetivar', rotulo: 'Efetivar pedido nunca é do modelo (alçada)' },
]

export const conteudoPlaybook = z.object({
  estilo: estiloPlaybook,
  persona: personaPlaybook,
  qualificacao: z.array(itemQualificacao).max(SLOTS_QUALIFICACAO.length),
  mensagens: mensagensPlaybook,
  compliance: compliancePlaybook,
  acoes: acoesPlaybook,
}).strict()
export type ConteudoPlaybook = z.output<typeof conteudoPlaybook>

export const SECOES_PLAYBOOK = ['estilo', 'persona', 'qualificacao', 'mensagens', 'compliance', 'acoes'] as const
export type SecaoPlaybook = (typeof SECOES_PLAYBOOK)[number]
export const ROTULO_SECAO_PLAYBOOK: Readonly<Record<SecaoPlaybook, string>> = {
  estilo: 'Tom e estilo', persona: 'Persona', qualificacao: 'Roteiro de qualificação',
  mensagens: 'Mensagens prontas', compliance: 'Compliance extra', acoes: 'Ações permitidas',
}

export const ROTULO_MENSAGEM: Readonly<Record<ChaveMensagemPlaybook, string>> = {
  abertura: 'Abertura (1ª resposta)', handoff: 'Ao transferir para uma pessoa', foraDoHorario: 'Ao transferir fora do horário',
  avisoEspera: 'Aviso de espera na fila', despedida: 'Despedida',
}

// ── ciclo de vida ──────────────────────────────────────────────────────────

export const ESTADOS_PLAYBOOK = ['rascunho', 'publicada', 'arquivada'] as const
export type EstadoPlaybook = (typeof ESTADOS_PLAYBOOK)[number]
export const ORIGENS_PLAYBOOK = ['importada', 'manual', 'documento', 'restaurada'] as const
export type OrigemPlaybook = (typeof ORIGENS_PLAYBOOK)[number]
/** `numero` = playbook só daquele número; `tenant` = padrão da conta para os números sem playbook próprio. */
export const ESCOPOS_PLAYBOOK = ['numero', 'tenant'] as const
export type EscopoPlaybook = (typeof ESCOPOS_PLAYBOOK)[number]

/** Uma versão como a API devolve. `numero` é null no rascunho (ganha número ao publicar). */
export interface VersaoPlaybook {
  readonly id: string
  readonly canalId: string | null
  readonly numero: number | null
  readonly estado: EstadoPlaybook
  readonly origem: OrigemPlaybook
  readonly baseadaEm: string | null
  readonly observacao: string | null
  readonly resumoMudancas: readonly string[]
  readonly documentoNome: string | null
  readonly criadoEm: string
  readonly criadoPor: string | null
  /** Última gravação do conteúdo (rascunho). Publicar exige o valor que a tela viu. */
  readonly atualizadoEm: string
  readonly publicadaEm: string | null
  readonly publicadaPor: string | null
  readonly conteudo: ConteudoPlaybook
}

/** O que `agente_config.playbook` guarda: o espelho da versão publicada que vale para o número. */
export interface PlaybookVigente {
  readonly versaoId: string
  readonly numero: number
  readonly escopo: EscopoPlaybook
  readonly publicadaEm: string
  readonly conteudo: ConteudoPlaybook
}

export const corpoPublicarPlaybook = z.object({
  canalId: z.string().uuid().nullable().optional(),
  observacao: z.string().trim()
    .min(LIMITES_PLAYBOOK.observacaoMin, `Escreva ao menos ${LIMITES_PLAYBOOK.observacaoMin} caracteres explicando o que mudou.`)
    .max(LIMITES_PLAYBOOK.observacaoMax),
  /**
   * `atualizadoEm` do rascunho que a pessoa REVISOU no diff. Se alguém gravou
   * depois, publicar recusa (409) — nunca se publica o que ninguém viu.
   */
  rascunhoAtualizadoEm: z.string().datetime({ offset: true }),
}).strict()

// ── padrão e importação ────────────────────────────────────────────────────

export const MENSAGENS_PADRAO: MensagensPlaybook = { abertura: null, handoff: null, foraDoHorario: null, avisoEspera: null, despedida: null }

/** O playbook "como o produto já se comporta": nada muda ao importar. */
export function playbookPadrao(): ConteudoPlaybook {
  return {
    estilo: { tratamento: 'voce', maxCaracteres: null, maxPerguntas: null, orientacoes: '' },
    persona: { nome: 'Assistente', loja: '', tom: 'neutro', usaEmojis: false, saudacao: '' },
    qualificacao: [],
    mensagens: { ...MENSAGENS_PADRAO },
    compliance: { frasesProibidas: [], gatilhosHandoff: [] },
    acoes: { ...ACOES_TODAS_LIGADAS },
  }
}

/**
 * A v1 a partir do que está em `agente_config` hoje (persona, slots, compliance
 * extra). Leitura TOLERANTE: campo inválido vale o padrão. O resultado é
 * equivalente ao comportamento atual — importar não muda a próxima mensagem.
 */
export function playbookDaConfig(cfg: { persona?: unknown; qualificacao?: unknown; compliance?: unknown }): ConteudoPlaybook {
  const base = playbookPadrao()
  const p = (cfg.persona && typeof cfg.persona === 'object' ? cfg.persona : {}) as Record<string, unknown>
  const persona = personaPlaybook.safeParse({
    nome: typeof p['nome'] === 'string' && p['nome'].trim() ? p['nome'] : base.persona.nome,
    loja: typeof p['loja'] === 'string' ? p['loja'] : '',
    tom: (TONS as readonly unknown[]).includes(p['tom']) ? p['tom'] : base.persona.tom,
    usaEmojis: p['usaEmojis'] === true,
    saudacao: typeof p['saudacao'] === 'string' ? p['saudacao'].slice(0, 300) : '',
  })
  const slots = Array.isArray(cfg.qualificacao)
    ? [...new Set(cfg.qualificacao.filter((s): s is SlotQualificacao => (SLOTS_QUALIFICACAO as readonly unknown[]).includes(s)))]
    : []
  const c = (cfg.compliance && typeof cfg.compliance === 'object' ? cfg.compliance : {}) as Record<string, unknown>
  const lista = (x: unknown): string[] => semDuplicatas((Array.isArray(x) ? x : []).flatMap((i) => {
    const r = itemCompliancePlaybook.safeParse(i)
    return r.success ? [r.data] : []
  })).slice(0, LIMITES_COMPLIANCE.maxItens)
  return {
    ...base,
    persona: persona.success ? persona.data : base.persona,
    qualificacao: slots.map((slot) => ({ slot, pergunta: PERGUNTA_DO_SLOT[slot], obrigatorio: false, ativo: true })),
    compliance: { frasesProibidas: lista(c['frasesProibidas']), gatilhosHandoff: lista(c['gatilhosHandoff']) },
  }
}

// ── validação ──────────────────────────────────────────────────────────────

export interface ErroCampoPlaybook { readonly campo: string; readonly mensagem: string }
export type ResultadoValidacaoPlaybook =
  | { readonly ok: true; readonly conteudo: ConteudoPlaybook }
  | { readonly ok: false; readonly erros: readonly ErroCampoPlaybook[] }

const PLACEHOLDER_RE = /\{[^{}\s]{1,30}\}/g
const PERCENTUAL_RE = /\d+(?:[.,]\d+)?\s*%/

// ── texto do negócio: o que NUNCA passa (revisão P17) ──────────────────────

/** Homóglifos comuns (cirílico/grego/latinos estendidos e leet) → ASCII. */
const HOMOGLIFOS: Readonly<Record<string, string>> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'α': 'a', 'ο': 'o', 'ι': 'i', 'ρ': 'p', 'ν': 'v', 'τ': 't',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's',
}

/**
 * Normalização para a checagem de identidade: NFKD sem acento, minúsculas,
 * homóglifos para ASCII e pontuação ENTRE letras removida ("A.I." → "ai",
 * "r-o-b-ô" → "robo", "I'm" → "im"). O resto da pontuação vira espaço.
 */
export function normalizarIdentidade(texto: string): string {
  const base = texto.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const ascii = [...base].map((c) => HOMOGLIFOS[c] ?? c).join('')
  return ascii
    .replace(/(?<=[a-z])[.\-_'’*·•]+(?=[a-z])/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NAO = String.raw`(?:nao|nada de|sem|nenhum|nenhuma|jamais|nunca|not|never)`
const MAQ = String.raw`(?:ia|ai|robo\w*|robot\w*|bot\w*|chat ?bot\w*|maquina\w*|inteligencia artificial|artificial intelligence|automac\w*|atendimento automatico|(?:assistente|atendente) virtual|virtual assistant)`
/** Sem "ai": em português é "aí" ("tudo bem aí? não…"). */
const MAQ2 = String.raw`(?:ia|robo\w*|robot\w*|bot\w*|chat ?bot\w*|maquina\w*|inteligencia artificial|automac\w*)`
const PERTO = String.raw`(?:\s+\w+){0,4}\s+`
/**
 * Negar ser IA, se passar por gente ou mandar esconder isso — no texto que o
 * NEGÓCIO escreve (mensagens prontas, saudação, orientações, nome da persona).
 * Mais largo que a base do filtro de saída de propósito. É a CAMADA EXTRA: a
 * identificação como assistente virtual é sempre anexada pelo código.
 * Roda sobre `normalizarIdentidade`.
 */
const NEGA_IA_RES: readonly RegExp[] = [
  // "não tem IA", "nada de robô", "sem robô e sem IA", "não sou um bot", "not a bot"
  new RegExp(String.raw`\b${NAO}\s+(?:(?:tem|ha|e|somos|sou|usamos|existe|am|is|are)\s+)?(?:um\s+|uma\s+|de\s+|a\s+|an\s+|nenhum\s+|nenhuma\s+)?${MAQ}\b`),
  // "IA? Aqui não.", "robô aqui jamais"
  new RegExp(String.raw`\b${MAQ2}(?:\s+aqui)?\s+(?:nao|nunca|jamais)\b`),
  // "que nada" perto de robô/IA
  new RegExp(String.raw`\bque nada${PERTO}${MAQ2}\b|\b${MAQ2}${PERTO}que nada\b|\b${MAQ2} que nada\b`),
  // gente de verdade
  /\batendimento (?:\w+ )?human[oa]\b|\bpessoas? (?:real|reais|de verdade|de carne)\b|\bde carne e osso\b|\bgente de verdade\b|\bso gente\b|\bhuman[oa]s? (?:de verdade|mesmo)\b|\bequipe humana\b|\bem pessoa\b|\bsou de verdade\b/,
  /\b(?:sou|somos) (?:um |uma )?(?:human[oa]s?|pessoas?|gente|atendente humano)\b/,
  // inglês
  /\breal (?:person|people|human)\b|\bhumans? here\b|\bi ?a?m (?:a )?human\b|\bnot (?:a |an )?(?:bot|robot|ai|machine)\b/,
  // mandar mentir, esconder ou revogar
  /\b(?:diga|fale|responda|afirme|finja|diz|dizer|fingir|say|tell)\s+(?:que\s+|that\s+)?(?:e|ser|somos|sou|voce e|you are|youre|we are|i am)\s+(?:um\s+|uma\s+|a\s+)?(?:human[oa]?|pessoa|person|gente|atendente|vendedor[a]?|funcionari[oa])\b/,
  /\b(?:fing\w*|finj\w*|pretend\w*|desconvers\w*|como se fosse)\b/,
  new RegExp(String.raw`\b(?:nao revel\w*|nao conte|escond\w*|ocult\w*|disfarc\w*)${PERTO.replace('{0,4}', '{0,5}')}(?:${MAQ}|que e|que somos|humano)\b|\b(?:nao revel\w*|escond\w*|ocult\w*) (?:${MAQ})\b`),
  /\bignor\w* (?:as |todas as |all |the |previous |anteriores )*(?:regras|instruc\w*|orientac\w*|rules|instructions)\b|\bdesconsider\w* (?:as )?(?:regras|instruc\w*)\b/,
]

/** O texto nega ser IA, se passa por humano, manda esconder isso ou tenta revogar as regras? */
export function negaSerIa(texto: string): boolean {
  const t = normalizarIdentidade(texto)
  return NEGA_IA_RES.some((r) => r.test(t))
}

const NUMERO_EXTENSO = String.raw`(?:um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzent[oa]s|trezent[oa]s|quinhent[oa]s|mil|meia\s+d[uú]zia|d[uú]zia)`
/** Número por extenso com unidade de negócio ("dez por cento", "dois dias úteis", "cinco peças"). */
const NUMERO_EXTENSO_RE = new RegExp(String.raw`(?:^|[^\p{L}])${NUMERO_EXTENSO}(?:\s+e\s+${NUMERO_EXTENSO})*\s+(?:por\s+cento|reais|real|centavos|dias?|horas?|semanas?|meses|m[eê]s|unidades?|pe[cç]as?|caixas?|pares|fardos?|pacotes?|kg|quilos?|metros?)(?![\p{L}])`, 'iu')

/** Verbo de entrega/envio/chegada/saída/expedição (texto normalizado sem acento). */
const VERBO_ENTREGA_RE = /(?:^|[^\p{L}])(?:entreg\p{L}*|envi\p{L}*|mand\p{L}*|cheg\p{L}*|sai|saem|sair|saiu|sairá|saira|despach\p{L}*|exped\p{L}*|lev\p{L}*|post\p{L}*|recebe\p{L}*)(?![\p{L}])/iu
/** Vocabulário de tempo: dia, dia da semana, "mesma semana", "dia seguinte", prazo. */
const TEMPO_RE = /(?:^|[^\p{L}])(?:amanh[aã]|hoje|ontem|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|mesma\s+semana|dia\s+seguinte|semana\s+que\s+vem|pr[oó]xim[oa]\s+(?:semana|m[eê]s|dia)|prazo|dias?\s+[uú]teis|imediat\p{L}*)(?![\p{L}])/iu

/** Mensagem pronta: placeholders fixos, sem valor/percentual/número/desconto/prazo, sem frase proibida, sem negar ser IA. */
export function errosDaMensagemPronta(texto: string, chave: ChaveMensagemPlaybook | 'pergunta' | 'saudacao'): string | null {
  const desconhecidos = (texto.match(PLACEHOLDER_RE) ?? []).filter((p) => !(PLACEHOLDERS_PLAYBOOK as readonly string[]).includes(p))
  if (desconhecidos.length) return `Marcador desconhecido: ${desconhecidos[0]}. Use só ${PLACEHOLDERS_PLAYBOOK.join(', ')}.`
  const exemplo = renderizarMensagem(texto, { nome: 'Ana', assistente: 'Assistente', empresa: 'Loja' })
  if (negaSerIa(exemplo)) {
    return 'O texto não pode negar que é uma assistente virtual (IA) nem se apresentar como atendimento humano — a identificação é regra, não opção.'
  }
  // Regra definitiva (revisão P17): NENHUM dígito no texto do negócio — nome,
  // assistente e empresa entram pelos marcadores. "Leve 3 pague 2", "10 porcento".
  const semMarcadores = texto.replace(PLACEHOLDER_RE, ' ')
  if (/\d/.test(semMarcadores) || verificarNumerosNaResposta(exemplo, new Set()).length > 0 || /\bR\$/i.test(exemplo) || PERCENTUAL_RE.test(exemplo)
    || /por\s*cento/i.test(exemplo) || NUMERO_EXTENSO_RE.test(exemplo)) {
    return 'Mensagem pronta não pode citar valor, percentual nem número (nem por extenso) — o que é fato vai para a base de conhecimento.'
  }
  if (/(?:^|[^\p{L}])descontos?(?![\p{L}])/iu.test(exemplo)) {
    return 'Mensagem pronta não fala de desconto — desconto é decisão da alçada, nunca texto fixo.'
  }
  if (PROMESSA_PRAZO_RE.test(exemplo) || (VERBO_ENTREGA_RE.test(exemplo) && TEMPO_RE.test(exemplo))) {
    return 'Mensagem pronta não promete prazo de entrega nem de retorno.'
  }
  const f = filtrarSaida(exemplo)
  const proibida = f.ocorrencias.find((o) => o.gravidade === 'CRITICA' || o.acao === 'removido')
  if (proibida) return `Contém uma frase que o filtro de segurança bloqueia (${proibida.id}). Reescreva sem prometer, garantir ou oferecer desconto.`
  if (chave === 'handoff' || chave === 'foraDoHorario' || chave === 'avisoEspera') {
    const a = ajustarMensagemHandoff(exemplo, { semNumeros: true, anexarRetomada: false })
    if (a.ocorrencias.length > 0) return 'Aviso de transferência ou espera não pode prometer prazo nem citar número.'
  }
  return null
}

/** Orientações de conduta: sem valor, sem frase da base, sem negar IA e sem tentar revogar as regras. */
export function errosDasOrientacoes(texto: string): string | null {
  if (!texto.trim()) return null
  if (negaSerIa(texto)) {
    return 'A orientação não pode mandar negar que é IA, se passar por pessoa nem ignorar as regras — esses guardrails não se desligam pela tela.'
  }
  if (/\bR\$/i.test(texto) || verificarNumerosNaResposta(texto, new Set()).length > 0) {
    return 'Orientação de conduta não cita valor em reais — preço vem do catálogo e condição vem da base de conhecimento.'
  }
  const f = filtrarSaida(texto)
  const proibida = f.ocorrencias.find((o) => o.gravidade === 'CRITICA')
  if (proibida) return `A orientação contém algo que o filtro de segurança bloqueia (${proibida.id}). Reescreva sem prometer, garantir ou oferecer desconto.`
  return null
}

/** Validação completa: schema + regras que o schema não expressa. Erros com campo no formato `qualificacao[2].pergunta`. */
export function validarPlaybook(bruto: unknown): ResultadoValidacaoPlaybook {
  const p = conteudoPlaybook.safeParse(bruto)
  if (!p.success) {
    return {
      ok: false,
      erros: p.error.issues.slice(0, 20).map((i) => ({
        campo: i.path.map((x, n) => (typeof x === 'number' ? `[${x}]` : `${n ? '.' : ''}${String(x)}`)).join('') || 'conteudo',
        mensagem: i.code === 'unrecognized_keys'
          ? `Campo não permitido: ${(i as { keys?: string[] }).keys?.join(', ') ?? ''}. O playbook só acrescenta restrições — guardrails não se desligam pela tela.`
          : i.message,
      })),
    }
  }
  const c = p.data
  const erros: ErroCampoPlaybook[] = []
  const vistos = new Set<string>()
  c.qualificacao.forEach((q, i) => {
    if (vistos.has(q.slot)) erros.push({ campo: `qualificacao[${i}].slot`, mensagem: 'Cada informação aparece uma vez no roteiro.' })
    vistos.add(q.slot)
    const e = errosDaMensagemPronta(q.pergunta, 'pergunta')
    if (e) erros.push({ campo: `qualificacao[${i}].pergunta`, mensagem: e })
  })
  for (const k of MENSAGENS_PLAYBOOK) {
    const t = c.mensagens[k]
    if (!t) continue
    const e = errosDaMensagemPronta(t, k)
    if (e) erros.push({ campo: `mensagens.${k}`, mensagem: e })
  }
  if (negaSerIa(c.persona.nome) || negaSerIa(c.persona.loja)) {
    erros.push({ campo: negaSerIa(c.persona.nome) ? 'persona.nome' : 'persona.loja', mensagem: 'O nome não pode negar que é uma assistente virtual (IA) nem se apresentar como pessoa.' })
  }
  if (c.persona.saudacao) {
    const e = errosDaMensagemPronta(c.persona.saudacao, 'saudacao')
    if (e) erros.push({ campo: 'persona.saudacao', mensagem: e })
  }
  const eo = errosDasOrientacoes(c.estilo.orientacoes)
  if (eo) erros.push({ campo: 'estilo.orientacoes', mensagem: eo })
  if (c.acoes.proposta && !c.acoes.pedido) {
    erros.push({ campo: 'acoes.proposta', mensagem: 'Para enviar proposta o agente precisa montar o pedido: ligue também "Montar pedido".' })
  }
  if (erros.length) return { ok: false, erros }
  return {
    ok: true,
    conteudo: {
      ...c,
      compliance: { frasesProibidas: semDuplicatas(c.compliance.frasesProibidas), gatilhosHandoff: semDuplicatas(c.compliance.gatilhosHandoff) },
    },
  }
}

/** Leitura TOLERANTE do espelho em `agente_config.playbook`: inválido = sem playbook (o padrão do código vale). */
export function lerPlaybookVigente(v: unknown): PlaybookVigente | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const c = conteudoPlaybook.safeParse(o['conteudo'])
  if (!c.success || typeof o['versaoId'] !== 'string' || typeof o['numero'] !== 'number') return null
  return {
    versaoId: o['versaoId'], numero: o['numero'], escopo: o['escopo'] === 'tenant' ? 'tenant' : 'numero',
    publicadaEm: typeof o['publicadaEm'] === 'string' ? o['publicadaEm'] : '', conteudo: c.data,
  }
}

// ── uso no turno ───────────────────────────────────────────────────────────

/** Persona do `agente_config` que o playbook publica (identificar-se como assistente é sempre true). */
export function personaDoPlaybook(c: ConteudoPlaybook): PersonaResolvida {
  return { ...c.persona, idioma: 'pt-BR', identificaComoRobo: true }
}

/** Slots ativos, na ordem do roteiro — o que vai para `agente_config.qualificacao`. */
export function slotsDoPlaybook(c: ConteudoPlaybook): SlotQualificacao[] {
  return c.qualificacao.filter((q) => q.ativo).map((q) => q.slot)
}

/** Compliance extra EFETIVO: o do número (P2) ∪ o do playbook. Só acrescenta. */
export function complianceEfetivo(doNumero: ComplianceExtra, doPlaybook: ConteudoPlaybook | null | undefined): ComplianceExtra {
  if (!doPlaybook) return doNumero
  return {
    frasesProibidas: semDuplicatas([...doNumero.frasesProibidas, ...doPlaybook.compliance.frasesProibidas]),
    gatilhosHandoff: semDuplicatas([...doNumero.gatilhosHandoff, ...doPlaybook.compliance.gatilhosHandoff]),
  }
}

/** Limites de estilo para `filtrarSaida` (`limites`). */
export function limitesDoPlaybook(c: ConteudoPlaybook | null | undefined): { maxCaracteres?: number; maxPerguntas?: number } {
  if (!c) return {}
  return {
    ...(c.estilo.maxCaracteres ? { maxCaracteres: c.estilo.maxCaracteres } : {}),
    ...(c.estilo.maxPerguntas ? { maxPerguntas: c.estilo.maxPerguntas } : {}),
  }
}

export interface ValoresPlaceholder {
  /** Primeiro nome do cliente; vazio/ausente remove o marcador com a vírgula antes. */
  readonly nome?: string | null | undefined
  readonly assistente: string
  readonly empresa?: string | null | undefined
}

/** Troca os marcadores. `{nome}` sem nome some junto com ", " antes ("Oi, {nome}!" → "Oi!"). */
export function renderizarMensagem(modelo: string, v: ValoresPlaceholder): string {
  const primeiro = v.nome?.trim().split(/\s+/)[0] ?? ''
  let t = modelo
  t = primeiro ? t.replaceAll('{nome}', primeiro) : t.replace(/,?\s*\{nome\}/g, '')
  t = t.replaceAll('{assistente}', v.assistente.trim() || 'Assistente')
  t = t.replaceAll('{empresa}', v.empresa?.trim() || 'a loja')
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([!?.,])/g, '$1').trim()
}

/**
 * Abertura do playbook: a saudação do negócio + o que o código garante SEMPRE —
 * a frase de identificação como assistente virtual (IA) e o aviso de privacidade
 * (ADR-028/029: não é opção da tela). ⚠️ Não se condiciona a identificação ao
 * texto do negócio ("Aqui não tem IA" também contém "IA"): ela sempre entra.
 * Saudação que nega ser IA nem chega aqui (validação), e se chegar o turno usa
 * a abertura do código.
 */
export function aberturaDoPlaybook(modelo: string, o: {
  clienteNome?: string | null | undefined; assistenteNome: string; loja?: string | undefined
  privacidade?: { textoPadrao?: string | null | undefined; url?: string | null | undefined } | undefined
}): string {
  const saudacao = renderizarMensagem(modelo, { nome: o.clienteNome, assistente: o.assistenteNome, empresa: o.loja })
  const loja = o.loja?.trim() ? `da ${o.loja.trim()}` : 'da loja'
  const identificacao = `Sou ${o.assistenteNome.trim() || 'Assistente'}, assistente virtual ${loja} (uma inteligência artificial).`
  const fim = /[.!?…]$/u.test(saudacao) ? '' : '.'
  return `${saudacao}${fim} ${identificacao} ${textoAvisoPrivacidade(o.privacidade)}`.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Texto de uma mensagem pronta para o turno, se houver e se ainda passar no
 * filtro de hoje (a base pode ter crescido depois da publicação). null = use o
 * texto padrão do código.
 */
export function mensagemProntaSegura(c: ConteudoPlaybook | null | undefined, chave: ChaveMensagemPlaybook, v: ValoresPlaceholder): string | null {
  const modelo = c?.mensagens[chave]
  if (!modelo) return null
  if (errosDaMensagemPronta(modelo, chave)) return null
  return renderizarMensagem(modelo, v)
}

// ── diff por seção ─────────────────────────────────────────────────────────

export interface MudancaPlaybook {
  readonly campo: string
  readonly antes: string | null
  readonly depois: string | null
}
export interface DiffSecaoPlaybook {
  readonly secao: SecaoPlaybook
  readonly rotulo: string
  readonly mudou: boolean
  readonly mudancas: readonly MudancaPlaybook[]
}

const SIM_NAO = (b: boolean) => (b ? 'sim' : 'não')

function camposDaSecao(c: ConteudoPlaybook, s: SecaoPlaybook): Map<string, string> {
  const m = new Map<string, string>()
  switch (s) {
    case 'estilo':
      m.set('Tratamento', c.estilo.tratamento === 'voce' ? 'você' : 'senhor(a)')
      m.set('Máx. caracteres por mensagem', c.estilo.maxCaracteres === null ? 'sem limite' : String(c.estilo.maxCaracteres))
      m.set('Máx. perguntas por mensagem', c.estilo.maxPerguntas === null ? 'sem limite' : String(c.estilo.maxPerguntas))
      m.set('Orientações', c.estilo.orientacoes || '—')
      break
    case 'persona':
      m.set('Nome', c.persona.nome); m.set('Loja', c.persona.loja || '—'); m.set('Tom', c.persona.tom)
      m.set('Emojis', SIM_NAO(c.persona.usaEmojis)); m.set('Saudação', c.persona.saudacao || '—')
      break
    case 'qualificacao':
      c.qualificacao.forEach((q, i) => m.set(`${q.slot}`, `${i + 1}º · ${q.pergunta}${q.obrigatorio ? ' · obrigatório' : ''}${q.ativo ? '' : ' · inativo'}`))
      break
    case 'mensagens':
      for (const k of MENSAGENS_PLAYBOOK) m.set(ROTULO_MENSAGEM[k], c.mensagens[k] ?? '(padrão do sistema)')
      break
    case 'compliance':
      for (const f of c.compliance.frasesProibidas) m.set(`Frase proibida: ${chaveLiteral(f)}`, f)
      for (const g of c.compliance.gatilhosHandoff) m.set(`Gatilho de transferência: ${chaveLiteral(g)}`, g)
      break
    case 'acoes':
      for (const a of ACOES_PLAYBOOK) m.set(ROTULO_ACAO[a].rotulo, c.acoes[a] ? 'ligada' : 'desligada')
      break
  }
  return m
}

/**
 * Diferença entre duas versões, seção por seção (pura). `antes` null = tudo é
 * novo. Campo que só existe de um lado aparece com o outro lado null.
 */
export function diffPorSecao(antes: ConteudoPlaybook | null, depois: ConteudoPlaybook): readonly DiffSecaoPlaybook[] {
  return SECOES_PLAYBOOK.map((secao) => {
    const a = antes ? camposDaSecao(antes, secao) : new Map<string, string>()
    const d = camposDaSecao(depois, secao)
    const mudancas: MudancaPlaybook[] = []
    for (const [campo, v] of d) if (a.get(campo) !== v) mudancas.push({ campo, antes: a.get(campo) ?? null, depois: v })
    for (const [campo, v] of a) if (!d.has(campo)) mudancas.push({ campo, antes: v, depois: null })
    // Ordem do roteiro também é conteúdo.
    if (secao === 'qualificacao' && antes && mudancas.length === 0
      && antes.qualificacao.map((q) => q.slot).join() !== depois.qualificacao.map((q) => q.slot).join()) {
      mudancas.push({ campo: 'Ordem', antes: antes.qualificacao.map((q) => q.slot).join(' → '), depois: depois.qualificacao.map((q) => q.slot).join(' → ') })
    }
    return { secao, rotulo: ROTULO_SECAO_PLAYBOOK[secao], mudou: mudancas.length > 0, mudancas }
  })
}

// ── sandbox ────────────────────────────────────────────────────────────────

export const PLAYBOOK_SIMULACAO = ['rascunho', 'publicada'] as const
export type PlaybookSimulacao = (typeof PLAYBOOK_SIMULACAO)[number]
/** Mensagens do cliente por conversa de simulação; depois disso, reiniciar. */
export const LIMITE_MENSAGENS_SIMULACAO = 20

/** Ferramentas de ESCRITA: no sandbox viram registradores (nada é gravado). */
export const FERRAMENTAS_DE_ESCRITA: readonly string[] = ['pedido_itens', 'pedido_propor', 'memoria_anotar', 'atendimento_transferir']

// ── atualizar a partir de documento ────────────────────────────────────────

/** Seções que um documento pode reescrever. Persona, limites de estilo e AÇÕES nunca. */
export const SECOES_DOCUMENTO = ['orientacoes', 'qualificacao', 'mensagens', 'compliance'] as const
export type SecaoDocumento = (typeof SECOES_DOCUMENTO)[number]
export const LIMITE_TEXTO_DOCUMENTO = 60_000

/** O que o LLM devolve (tudo opcional por seção; null = não mudou). */
export const sugestaoDoDocumento = z.object({
  orientacoes: z.string().nullable(),
  qualificacao: z.array(z.object({
    slot: z.enum(SLOTS_QUALIFICACAO), pergunta: z.string(), obrigatorio: z.boolean(), ativo: z.boolean(),
  })).nullable(),
  mensagens: z.object({
    abertura: z.string().nullable(), handoff: z.string().nullable(), foraDoHorario: z.string().nullable(),
    avisoEspera: z.string().nullable(), despedida: z.string().nullable(),
  }).nullable(),
  frasesProibidasNovas: z.array(z.string()),
  gatilhosHandoffNovos: z.array(z.string()),
  resumoMudancas: z.array(z.string()).min(1),
})
export type SugestaoDoDocumento = z.output<typeof sugestaoDoDocumento>

/**
 * Aplica a sugestão do LLM sobre o conteúdo atual: só as seções do documento.
 * ⚠️ Persona, limites de estilo e AÇÕES vêm SEMPRE do atual; compliance só
 *    GANHA itens (união) — o documento nunca remove frase nem desliga nada.
 */
export function aplicarSugestao(atual: ConteudoPlaybook, s: SugestaoDoDocumento): unknown {
  const mensagens = s.mensagens
    ? Object.fromEntries(MENSAGENS_PLAYBOOK.map((k) => [k, s.mensagens![k]?.trim() ? s.mensagens![k]!.trim() : atual.mensagens[k]]))
    : atual.mensagens
  return {
    estilo: { ...atual.estilo, orientacoes: s.orientacoes?.trim() ? s.orientacoes.trim() : atual.estilo.orientacoes },
    persona: atual.persona,
    qualificacao: s.qualificacao ?? atual.qualificacao,
    mensagens,
    compliance: {
      frasesProibidas: semDuplicatas([...atual.compliance.frasesProibidas, ...s.frasesProibidasNovas.map((x) => x.trim())]),
      gatilhosHandoff: semDuplicatas([...atual.compliance.gatilhosHandoff, ...s.gatilhosHandoffNovos.map((x) => x.trim())]),
    },
    acoes: atual.acoes,
  }
}

