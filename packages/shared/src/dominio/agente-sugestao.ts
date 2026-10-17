import { z } from 'zod'
import { jaccard, tokensPergunta, normalizarPergunta } from './agente-perguntas.js'
import { GRAVIDADES_GUARDRAIL, type GravidadeGuardrail, type MarcaGuardrail, type ModoAgente } from './agente-vendedor.js'

/**
 * SUGESTÃO DO ASSISTIDO, COPILOTO E MÉTRICA DE EDIÇÃO (raia P13, docs/plano-port-playbook-am.md;
 * ADR-028 "assistido sugere", ADR-031 "0 CRÍTICA também nas sugestões").
 *
 * Porte do copiloto da AM (playbook §6.1, §6.2, §6.4) para o GeraCRM:
 *   - a sugestão é uma `agente_decisao` (modo `assistido`, gerada pelo turno; ou `copiloto`, pedida
 *     pelo vendedor) — o texto é o que SAIRIA, já depois de todo o pipeline (filtro, números, pergunta);
 *   - as MARCAS de guardrail da decisão viram os avisos por gravidade: `CRITICA` = "não envie assim";
 *   - o vendedor envia (igual ou editada) ou descarta; o banco guarda o desfecho e a similaridade
 *     entre o sugerido e o enviado (0103). A métrica vem do banco, nunca de contador em memória.
 *
 * ⚠️ TypeScript puro: consumido pela API, pelo console e pelo app.
 */

// ── estados ─────────────────────────────────────────────────────────────────

/**
 * O que o vendedor fez com a sugestão (coluna `agente_decisao.sugestao_estado`). `superada` = ele
 * respondeu a conversa sem usá-la (outro texto, ou uma sugestão mais nova) — conta como não usada.
 */
export const DESFECHOS_SUGESTAO = ['enviada', 'editada', 'descartada', 'superada'] as const
export type DesfechoSugestao = (typeof DESFECHOS_SUGESTAO)[number]

/** Estado visto pela tela: NULL na coluna = ainda pendente. */
export type EstadoSugestao = 'pendente' | DesfechoSugestao

/** De onde veio a sugestão: o turno em modo assistido, ou o botão "Sugerir resposta" (copiloto). */
export const ORIGENS_SUGESTAO = ['assistido', 'copiloto'] as const
export type OrigemSugestao = (typeof ORIGENS_SUGESTAO)[number]

export function estadoDaSugestao(coluna: string | null | undefined): EstadoSugestao {
  return (DESFECHOS_SUGESTAO as readonly string[]).includes(coluna ?? '') ? (coluna as DesfechoSugestao) : 'pendente'
}

/** Prazo do copiloto sob demanda (playbook §6.1): passou disso, 502 `copiloto.indisponivel`. */
export const PRAZO_COPILOTO_MS = 20_000

/**
 * Sombra × humano (ADR-031, critério de fase — PROPOSTA): um turno de sombra "acerta" quando a
 * similaridade entre o que o robô diria e o que o humano mandou é ≥ 0,6.
 */
export const LIMIAR_SIMILARIDADE_SOMBRA = 0.6

// ── similaridade ────────────────────────────────────────────────────────────

/**
 * Forma de comparar para "foi editada?": NFC, espaços colapsados, sem bordas. Caixa, acento e
 * pontuação CONTAM — trocar "Ok." por "ok" é editar.
 */
export function textoComparavel(t: string): string {
  return t.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** O vendedor mexeu no texto sugerido? (só espaços não contam). */
export function foiEditada(sugerido: string, enviado: string): boolean {
  return textoComparavel(sugerido) !== textoComparavel(enviado)
}

/**
 * SIMILARIDADE ENTRE DOIS TEXTOS — a métrica da P13, pura e documentada.
 *
 * Jaccard dos conjuntos de PALAVRAS SIGNIFICATIVAS (mesmos tokens da trava de pergunta repetida,
 * `tokensPergunta`): minúsculas, sem acento, sem pontuação, sem stopwords, palavras com 3+ letras e
 * TODOS os números. Resultado em [0, 1], arredondado a 3 casas:
 *   - 1   = mesmas palavras (ordem e repetição não importam);
 *   - 0   = nenhuma palavra em comum;
 *   - textos sem palavra significativa (ex.: "ok", "👍"): 1 se iguais depois de normalizados, senão 0.
 *
 * Por que Jaccard de tokens e não distância de edição: o uso principal é sombra × humano, dois
 * textos escritos de forma independente — a mesma ideia em outra ordem precisa contar como
 * parecida. Para "enviada × editada" a decisão é `foiEditada` (comparação exata); a similaridade
 * mede o TAMANHO da edição. É a mesma métrica que a AM usa (`perguntas.ts similaridade`).
 */
export function similaridadeTextos(a: string, b: string): number {
  const ta = tokensPergunta(a)
  const tb = tokensPergunta(b)
  if (ta.size === 0 || tb.size === 0) {
    return ta.size === 0 && tb.size === 0 && normalizarPergunta(a) === normalizarPergunta(b) ? 1 : 0
  }
  return Math.round(jaccard(ta, tb) * 1000) / 1000
}

// ── avisos (marcas de guardrail → o que o vendedor lê) ─────────────────────

export interface AvisoSugestao {
  readonly codigo: string
  readonly gravidade: Exclude<GravidadeGuardrail, 'INFO'>
  /** Frase para o vendedor: o que aconteceu e o que conferir. */
  readonly texto: string
}

const ROTULOS: Readonly<Record<string, string>> = {
  valor_sem_fonte: 'O texto citava um valor que não veio do catálogo; o valor foi tirado. Confira o preço antes de responder.',
  numero_sem_fonte: 'Um número (percentual, quantidade ou prazo) não tinha fonte e foi barrado. Confira antes de prometer.',
  opt_out_confirmar: 'O cliente pediu para não receber mensagens. Confirme e bloqueie em Opt-out / Bloqueios — nada foi bloqueado ainda.',
  possivel_opt_out: 'Pode ser um pedido para não receber mensagens. Leia com atenção antes de responder.',
  garantia_sem_fonte: 'Uma promessa de garantia (prazo, estoque ou preço) foi tirada do texto.',
  garantia_de: 'Uma promessa de garantia foi tirada do texto.',
  garantido: 'Uma promessa de "garantido" foi tirada do texto.',
  entrega_sem_falta: 'Uma promessa de entrega "sem falta" foi tirada do texto.',
  estoque_infinito: 'Uma promessa de estoque ilimitado foi tirada do texto.',
  escassez_sem_fonte: 'Uma afirmação de escassez sem fonte ("últimas unidades") foi tirada do texto.',
  baixa_preco: 'Uma promessa de baixar o preço foi tirada do texto.',
  oferece_desconto: 'Uma oferta de desconto foi tirada do texto — desconto é decisão sua, dentro da alçada.',
  melhor_preco_do_mercado: '"Melhor preço do mercado" foi tirado do texto.',
  ninguem_mais_barato: '"Ninguém mais barato" foi tirado do texto.',
  preco_congelado: 'Uma promessa de preço congelado foi tirada do texto.',
  urgencia_falsa: 'Uma urgência falsa foi tirada do texto.',
  nega_ser_ia: 'Uma frase negando ser assistente virtual foi tirada.',
  finge_ser_humano: 'Uma frase fingindo ser pessoa foi tirada.',
  pede_consentimento: 'Um pedido de consentimento desnecessário foi tirado.',
  hesitacao_em_afirmacao: 'Uma afirmação hesitante ("acho que…") foi tirada.',
  promessa_prazo_handoff: 'Uma promessa de prazo de retorno foi tirada.',
  numero_no_handoff: 'Um número no aviso de transferência foi tirado.',
  pergunta_repetida: 'Uma pergunta que já tinha sido feita foi trocada.',
  max_caracteres: 'O texto foi encurtado ao limite do número.',
  max_perguntas: 'Perguntas acima do limite foram tiradas.',
  qualidade_violacao_critica: 'A regra de qualidade marcou uma violação crítica neste texto.',
  nao_envie: 'A regra de qualidade barrou este texto: não envie assim. Copie e reescreva antes de enviar.',
}

const ORDEM: Readonly<Record<GravidadeGuardrail, number>> = { CRITICA: 0, ALTA: 1, MEDIA: 2, INFO: 3 }

/**
 * Avisos da sugestão, do mais grave para o menos, um por código. `INFO` é auditoria, não aviso —
 * fica fora (a tela de decisões mostra tudo).
 */
export function avisosDaSugestao(marcas: readonly MarcaGuardrail[]): AvisoSugestao[] {
  const porCodigo = new Map<string, AvisoSugestao>()
  for (const m of marcas) {
    if (m.gravidade === 'INFO' || !GRAVIDADES_GUARDRAIL.includes(m.gravidade)) continue
    const atual = porCodigo.get(m.codigo)
    if (atual && ORDEM[atual.gravidade] <= ORDEM[m.gravidade]) continue
    porCodigo.set(m.codigo, {
      codigo: m.codigo, gravidade: m.gravidade,
      texto: ROTULOS[m.codigo] ?? `O texto foi ${m.acao} por uma proteção (${m.codigo.replace(/_/g, ' ')}). Confira antes de enviar.`,
    })
  }
  return [...porCodigo.values()].sort((a, b) => ORDEM[a.gravidade] - ORDEM[b.gravidade])
}

/** ADR-031 §3: qualquer marca CRÍTICA = "não envie assim". */
export function naoEnvieAssim(marcas: readonly MarcaGuardrail[]): boolean {
  return marcas.some((m) => m.gravidade === 'CRITICA')
}

/** A marca que a P12 (regras de qualidade) grava quando a sugestão não pode sair como está. */
export const ETAPA_QUALIDADE = 'regras-qualidade'
export const CODIGO_NAO_ENVIE = 'nao_envie'

/**
 * BLOQUEADA PELA QUALIDADE (P12, ADR-031 §3): a decisão tem a marca `regras-qualidade/nao_envie`.
 * Diferente de `naoEnvieAssim` (qualquer CRÍTICA, só avisa): aqui o texto INALTERADO não pode sair —
 * o botão "Usar" fica desabilitado e a API recusa o envio idêntico (422 `sugestao.bloqueada`).
 * Editar libera: a responsabilidade passa a ser de quem reescreveu.
 */
export function bloqueadaPelaQualidade(marcas: readonly MarcaGuardrail[]): boolean {
  return marcas.some((m) => m.etapa === ETAPA_QUALIDADE && m.codigo === CODIGO_NAO_ENVIE)
}

/** O motivo do bloqueio, para o selo: o trecho da marca (já mascarado por quem a criou), se houver. */
export function motivoDoBloqueio(marcas: readonly MarcaGuardrail[]): string | null {
  const m = marcas.find((x) => x.etapa === ETAPA_QUALIDADE && x.codigo === CODIGO_NAO_ENVIE)
  if (!m) return null
  return m.trecho?.trim() || 'Violação crítica de qualidade neste texto.'
}

/** O cliente pediu opt-out e o vendedor precisa confirmar (P4, assistido). */
export function pedeConfirmarOptOut(marcas: readonly MarcaGuardrail[]): boolean {
  return marcas.some((m) => m.codigo === 'opt_out_confirmar')
}

// ── contrato HTTP ───────────────────────────────────────────────────────────

/** A sugestão vigente de uma conversa (GET /v1/conversas/:id/sugestao). */
export interface SugestaoVigente {
  readonly decisaoId: string
  readonly origem: OrigemSugestao
  /** O texto para o campo de envio (mensagens do turno juntas por linha em branco). */
  readonly texto: string
  readonly criadaEm: string
  readonly avisos: readonly AvisoSugestao[]
  readonly naoEnvie: boolean
  /** P12 `nao_envie`: o texto inalterado não pode ser enviado ("Usar" desabilitado; API 422). */
  readonly bloqueada: boolean
  /** Motivo do bloqueio para o selo "Não envie assim" (null quando não bloqueada). */
  readonly motivoBloqueio: string | null
  readonly optOutAConfirmar: boolean
  /** O turno também pediria transferência ao humano (motivo e resumo). */
  readonly handoff: { readonly motivo: string; readonly resumo: string } | null
}

export interface RespostaSugestao {
  readonly sugestao: SugestaoVigente | null
  /** Modo do agente no número desta conversa (selo); null = agente não configurado. */
  readonly modoAgente: ModoAgente | null
  /** "Sugerir resposta" pode ser pedido agora? */
  readonly copilotoDisponivel: boolean
  /** Por que não: 'agente.desligado' | 'agente.sem_configuracao'. */
  readonly motivoIndisponivel: string | null
}

/** Junta as mensagens de um turno no texto único que o vendedor revisa. */
export function textoDaSugestao(mensagens: readonly string[]): string {
  return mensagens.map((m) => m.trim()).filter(Boolean).join('\n\n')
}

/** Corpo opcional de POST /v1/agente/sugestoes/:decisaoId/descartar. */
export const descartarSugestaoEntrada = z.object({ motivo: z.string().trim().max(200).optional() }).strict()

// ── métricas (fonte para a P19) ─────────────────────────────────────────────

/** Contagens cruas que a API lê do banco (GET /v1/agente/sugestoes/metricas). */
export interface ContagensSugestao {
  readonly geradas: number
  readonly enviadas: number
  readonly editadas: number
  readonly descartadas: number
  /** O vendedor respondeu sem usar a sugestão. */
  readonly superadas: number
  readonly pendentes: number
  /** Sugestões com ao menos uma marca CRÍTICA. */
  readonly criticas: number
  /** Média da similaridade sugerido × enviado nas editadas (null sem editadas). */
  readonly similaridadeMediaEditadas: number | null
}

export interface ContagensSombra {
  /** Turnos de sombra comparados com a mensagem humana seguinte. */
  readonly comparados: number
  readonly similaridadeMedia: number | null
  /** Quantos com similaridade ≥ LIMIAR_SIMILARIDADE_SOMBRA. */
  readonly acimaDoLimiar: number
}

export interface TaxasSugestao {
  /** (enviadas + editadas) ÷ geradas — "o vendedor usa?" (AM: ≥ 40%). */
  readonly taxaUso: number | null
  /** enviadas ÷ (enviadas + editadas) — "usa sem mexer?" (AM: ≥ 70% com ≥ 50 enviadas). */
  readonly taxaSemEdicao: number | null
  readonly taxaDescarte: number | null
}

const razao = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null)

export function taxasDaSugestao(c: ContagensSugestao): TaxasSugestao {
  const usadas = c.enviadas + c.editadas
  return {
    taxaUso: razao(usadas, c.geradas),
    taxaSemEdicao: razao(c.enviadas, usadas),
    taxaDescarte: razao(c.descartadas, c.geradas),
  }
}

export interface MetricasSugestoes {
  readonly dias: number
  readonly canalId: string | null
  readonly assistido: ContagensSugestao & TaxasSugestao
  readonly copiloto: ContagensSugestao & TaxasSugestao
  readonly sombra: ContagensSombra & { readonly taxaAcimaDoLimiar: number | null; readonly limiar: number }
}

export function taxaSombra(c: ContagensSombra): number | null {
  return razao(c.acimaDoLimiar, c.comparados)
}
