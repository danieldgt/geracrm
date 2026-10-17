/**
 * FILTRO DE SAÍDA COM NEGAÇÃO (ADR-029, raia P2 de docs/plano-port-playbook-am.md).
 *
 * Roda depois do modelo e antes do envio, em TODO modo (autônomo, assistido,
 * sombra, simulação, copiloto). Três coisas:
 *
 *   1. Frases proibidas (lista base B2B + extras do número) — a FRASE inteira
 *      sai. Negação explícita na mesma oração não é promessa: "não garantimos
 *      entrega amanhã" passa; "garantimos entrega amanhã" sai.
 *   2. Reescritas — hesitações ("talvez", "acho que") são cortadas no lugar.
 *   3. Notas obrigatórias — afirmação que precisa de ressalva na mesma mensagem
 *      ("frete grátis" sem condição) ganha a ressalva anexada.
 *
 * Mecanismo portado da AM (`agent-worker/src/agent/guardrails.ts`, playbook §3.9);
 * a lista é B2B, não as frases de consórcio.
 *
 * ⚠️ A base mora no CÓDIGO e não tem chave de desligar. A configuração do
 *    número (`ComplianceExtra`) só ACRESCENTA (ADR-029 §5).
 * TypeScript puro: consumido pela API e pelo console.
 */
import { z } from 'zod'
import type { GravidadeGuardrail } from './agente-vendedor.js'

// ── tipos ───────────────────────────────────────────────────────────────────

export interface OcorrenciaFiltro {
  readonly id: string
  readonly gravidade: GravidadeGuardrail
  readonly acao: 'removido' | 'reescrito' | 'anexado' | 'registrado'
  /** A frase/trecho afetado (sem máscara — quem grava mascara). */
  readonly trecho?: string | undefined
}

export interface ResultadoFiltroSaida {
  readonly texto: string
  /**
   * O texto mudou. ⚠️ `false` pode vir COM ocorrências: as de ação
   * 'registrado' (ex.: "talvez") só anotam, não mexem no texto.
   */
  readonly alterado: boolean
  readonly ocorrencias: readonly OcorrenciaFiltro[]
  /**
   * Tudo foi removido: `texto` é `TEXTO_SEGURO` (nunca vazio). Quem envia
   * decide se manda o texto seguro ou transfere.
   */
  readonly esvaziado: boolean
}

export interface LimitesMensagem {
  readonly maxCaracteres?: number | undefined
  readonly maxPerguntas?: number | undefined
}

export interface OpcoesFiltroSaida {
  /** Frases proibidas extras (literais, sem acento/caixa) — só acrescentam. */
  readonly extras?: readonly string[] | undefined
  readonly limites?: LimitesMensagem | undefined
  /**
   * Houve saldo/quantidade vinda de fonte (ferramenta) neste turno: escassez
   * ("poucas unidades em estoque") pode ser verdade e deixa de ser vetada.
   * Sem fonte, continua urgência falsa.
   */
  readonly estoqueComFonte?: boolean | undefined
}

// ── configuração do número: só acrescenta ───────────────────────────────────

export const LIMITES_COMPLIANCE = { maxItens: 50, maxCaracteres: 80, minCaracteres: 3 } as const

const itemCompliance = z.string().trim()
  .min(LIMITES_COMPLIANCE.minCaracteres, `Use ao menos ${LIMITES_COMPLIANCE.minCaracteres} caracteres.`)
  .max(LIMITES_COMPLIANCE.maxCaracteres, `Use no máximo ${LIMITES_COMPLIANCE.maxCaracteres} caracteres.`)

const listaCompliance = z.array(itemCompliance)
  .max(LIMITES_COMPLIANCE.maxItens, `No máximo ${LIMITES_COMPLIANCE.maxItens} itens.`)

/**
 * `agente_config.compliance` (0097). Frases proibidas e gatilhos de handoff
 * EXTRAS do número — texto literal, nunca regex. Os gatilhos são consumidos
 * pela etapa de gatilhos de entrada (P4).
 */
export const complianceExtra = z.object({
  frasesProibidas: listaCompliance.default([]),
  gatilhosHandoff: listaCompliance.default([]),
})
export type ComplianceExtra = z.output<typeof complianceExtra>
/**
 * Corpo do PUT: os DOIS campos obrigatórios e nada além deles — um corpo com
 * só um campo não pode apagar o outro por default.
 */
export const complianceExtraCompleto = z.object({
  frasesProibidas: listaCompliance,
  gatilhosHandoff: listaCompliance,
}).strict()
export type ComplianceExtraEntrada = z.input<typeof complianceExtra>
export const COMPLIANCE_VAZIO: ComplianceExtra = { frasesProibidas: [], gatilhosHandoff: [] }

/** Chave de comparação: sem acento, sem caixa, espaços colapsados. */
export function chaveLiteral(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Remove duplicatas (sem acento/caixa), mantendo a primeira grafia. */
export function semDuplicatas(lista: readonly string[]): string[] {
  const vistos = new Set<string>()
  const out: string[] = []
  for (const t of lista) {
    const v = t.replace(/\s+/g, ' ').trim()
    const k = chaveLiteral(v)
    if (!k || vistos.has(k)) continue
    vistos.add(k)
    out.push(v)
  }
  return out
}

/**
 * Leitura TOLERANTE do jsonb gravado: item inválido é descartado, nunca
 * derruba o turno — a base continua valendo de qualquer jeito.
 */
export function lerComplianceExtra(v: unknown): ComplianceExtra {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const lista = (x: unknown): string[] => {
    if (!Array.isArray(x)) return []
    const validos = x.flatMap((i) => {
      const p = itemCompliance.safeParse(i)
      return p.success ? [p.data] : []
    })
    return semDuplicatas(validos).slice(0, LIMITES_COMPLIANCE.maxItens)
  }
  return { frasesProibidas: lista(o['frasesProibidas']), gatilhosHandoff: lista(o['gatilhosHandoff']) }
}

// ── utilitários de regex ────────────────────────────────────────────────────

/** Torna um literal tolerante a acento e caixa (a → [aáàâã] etc.). */
function fuzzy(literal: string): string {
  const map: Record<string, string> = {
    a: '[aáàâã]', e: '[eéê]', i: '[ií]', o: '[oóôõ]', u: '[uúü]', c: '[cç]',
  }
  return literal
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[aeiouc]/g, (ch) => map[ch]!)
    .replace(/\s+/g, '\\s+')
}

const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const re = (src: string): RegExp => new RegExp(src, 'giu')
/** Até N palavras quaisquer (inclui números e %). */
const palavras = (n: number): string => `(?:[\\p{L}\\p{N}%$.,]+\\s+){0,${n}}?`

/** Literal digitado na tela → regex tolerante a acento/caixa, com borda de palavra. */
export function regexLiteral(literal: string): RegExp {
  return re(`${B}${fuzzy(literal.trim())}${E}`)
}

// ── a regra de negação ──────────────────────────────────────────────────────

/*
 * Negação explícita imediatamente antes do termo ("não garantimos entrega
 * amanhã", "o prazo não é garantido", "ninguém consegue garantir estoque",
 * "sem garantia de prazo"). Tudo dentro da MESMA ORAÇÃO (vírgula, ponto e
 * vírgula, dois-pontos, travessão e parênteses separam orações):
 *  - "não/nunca/jamais/nenhum(a)/ninguém" com no máximo 2 palavras entre ela e
 *    o termo, sem conectivo no meio ("não se preocupe que garantimos…" continua
 *    proibido);
 *  - "sem" só vale colado no termo ("sem garantia de prazo");
 *  - número ÍMPAR de negações na oração (dupla negação = afirmação:
 *    "não tem como não ser garantido").
 * Comparação com acento preservado ("é" verbo ≠ "e" conectivo); as negações
 * aceitam a grafia sem acento.
 */
const NEGACOES = new Set(['não', 'nao', 'nunca', 'jamais', 'nenhum', 'nenhuma', 'ninguém', 'ninguem'])
const CONECTIVOS = new Set([
  'que', 'mas', 'porém', 'porem', 'pois', 'porque', 'e', 'ou', 'se', 'só', 'apenas', 'somente',
  'quando', 'então', 'entao', 'também', 'tambem',
])
const MAX_PALAVRAS_ENTRE = 2

export function termoNegado(frase: string, inicioTermo: number): boolean {
  const oracao = frase.slice(0, inicioTermo).split(/[,;:—–()]/).pop() ?? ''
  const ps = oracao.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  let ultima = -1
  for (let i = ps.length - 1; i >= 0; i--) {
    const w = ps[i]!
    if (NEGACOES.has(w) || w === 'sem') { ultima = i; break }
  }
  if (ultima < 0) return false
  const entre = ps.slice(ultima + 1)
  if (ps[ultima] === 'sem') {
    if (entre.length) return false
  } else if (entre.length > MAX_PALAVRAS_ENTRE || entre.some((w) => CONECTIVOS.has(w))) {
    return false
  }
  const negacoes = ps.filter((w) => NEGACOES.has(w) || w === 'sem').length
  return negacoes % 2 === 1
}

// ── lista base B2B ──────────────────────────────────────────────────────────

export interface ProibidaBase {
  readonly id: string
  readonly gravidade: GravidadeGuardrail
  /** Regex da regra — ou `casa`, quando a regra precisa olhar a oração em tokens. */
  readonly re?: RegExp | undefined
  /** Detector programático (já aplica a negação). */
  readonly casa?: ((frase: string) => boolean) | undefined
  /** A negação faz parte da afirmação vetada ("não sou um robô", "nunca falta estoque"). */
  readonly ignoraNegacao?: boolean
  /** Deixa de valer quando o turno trouxe estoque de fonte (`estoqueComFonte`). */
  readonly liberadaComEstoqueDeFonte?: boolean
}

/** Verbos de promessa. ⚠️ "garantia" (substantivo) fica de fora: "garantia de fábrica" é fato do produto. */
const GARANTIR = `(?:garant(?:o|e|em|imos|ir|iremos)|assegur(?:o|a|am|amos|ar|aremos)|promet(?:o|e|em|emos|er|eremos))`
/** O que o agente nunca garante: entrega, prazo, estoque, preço, crédito. */
const OBJETO_GARANTIA = [
  'entrega', 'entregar', 'prazo', 'chegada', 'estoque', 'disponibilidade', 'pre[cç]o', 'valor',
  'cr[eé]dito', 'limite', 'aprova[cç][aã]o', 'aprovad[oa]', 'frete', 'reposi[cç][aã]o',
].join('|')
/** O que vem depois do verbo de promessa: os objetos acima e o que descreve entrega/estoque. */
// ── promessa por verbo (garantir/assegurar/prometer) ─────────────────────────
//
// A regra é em TOKENS da oração depois do verbo, não regex: as exceções
// (encaminhamento, data seguida de quem encaminha, intervalo de horário)
// dependem da ORDEM das palavras.
//
//  1. Depois do verbo aceita-se [\s,:;—–]+ ("Te garanto: chega amanhã").
//  2. Promessa = algum OBJETO nas 5 primeiras palavras da oração seguinte:
//     entrega, prazo, estoque, preço, crédito…, cheg*, entreg*, sai, tem,
//     faltar — ou uma DATA ("eu garanto o seu pedido na sexta").
//     ⚠️ `pedido` não é objeto: "garanto que o pedido foi registrado" é fato.
//  3. Verbo de ENCAMINHAMENTO antes do objeto (verificar, confirmar, consultar,
//     retornar, ver, olhar, registrar, conferir) abona — o compromisso é de
//     checar — SÓ se, depois dele e do que ele checa ("o prazo"), não houver
//     cheg*/entreg*/sai/estoque/data na oração ("garanto que verifico e chega
//     sexta" continua promessa).
//  4. DATA seguida, na mesma oração, de encaminhamento ou de quem encaminha
//     ("prometo que hoje confiro o estoque", "garanto que hoje mesmo o vendedor
//     te chama") não é promessa de entrega — com a mesma ressalva do item 3.
//  5. Intervalo "de segunda a sexta" é horário, não data prometida.
//  6. Negação antes do verbo (regra da AM) abona; "só/apenas" NÃO abona
//     ("a gente só garante entrega amanhã" é promessa).

const VERBO_PROMESSA_RE = new RegExp(`${B}${GARANTIR}${E}`, 'giu')
const DATA_SRC = `hoje|${fuzzy('amanhã')}|segunda|${fuzzy('terça')}|quarta|quinta|sexta|${fuzzy('sábado')}|domingo`
const DATA_TOKEN_RE = new RegExp(`^(?:${DATA_SRC})$`, 'iu')
const ehData = (w: string): boolean => DATA_TOKEN_RE.test(w)
const OBJETO_NOMINAL_RE = new RegExp(`^(?:${OBJETO_GARANTIA})$`, 'iu')
const OBJETO_TOKEN_RE = new RegExp(`^(?:${OBJETO_GARANTIA}|cheg\\p{L}*|entreg\\p{L}*|sai|saem|tem|temos|faltar|falta)$`, 'iu')
const DURO_RE = /^(?:cheg\p{L}*|entreg\p{L}*|sai|saem|estoque)$/iu
const ENCAMINHA_RE = /^(?:(?:verific|confir|consult|retorn|olh|registr|confer|chec)\p{L}*|ver|vejo|vemos)$/iu
const QUEM_ENCAMINHA_RE = /^(?:vendedor|vendedora|equipe|consultor|consultora|atendente|representante)$/iu
const LIGACAO_RE = /^(?:te|lhe|o|a|os|as|seu|sua|seus|suas|um|uma|com|sobre|do|da|dos|das|no|na)$/iu
const INTERVALO_DE_DATAS_RE = new RegExp(`${B}de\\s+(?:${DATA_SRC})\\s+(?:a|${fuzzy('à')}|${fuzzy('até')})\\s+(?:${DATA_SRC})${E}`, 'giu')
const JANELA_OBJETO = 5

const tokensDe = (t: string): string[] => t.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Depois de um encaminhamento em `i`, há promessa dura no resto? (pula o que ele checa: "o prazo"). */
function promessaDepoisDoEncaminhamento(ws: readonly string[], i: number): boolean {
  let j = i + 1
  while (j < ws.length && LIGACAO_RE.test(ws[j]!)) j++
  if (j < ws.length && OBJETO_NOMINAL_RE.test(ws[j]!)) j++
  return ws.slice(j).some((w) => DURO_RE.test(w) || ehData(w))
}

/** Inciso curto sem conteúdo ("com toda a certeza", "pode confiar"): não é o que se promete. */
const MAX_PALAVRAS_INCISO = 4
function ehInciso(ws: readonly string[]): boolean {
  return ws.length <= MAX_PALAVRAS_INCISO && ws[0] !== 'que'
    && !ws.some((w) => OBJETO_TOKEN_RE.test(w) || ehData(w) || ENCAMINHA_RE.test(w) || QUEM_ENCAMINHA_RE.test(w))
}

/**
 * A oração que o verbo promete: a primeira depois dele, pulando até dois
 * incisos ("garantimos, com toda a certeza, a entrega amanhã", "garantimos
 * (pode confiar) a entrega amanhã"). Intervalo de datas vira espaço.
 */
function oracaoDaPromessa(depois: string): string {
  const oracoes = depois.split(/[,;:—–()]/).filter((o) => /[\p{L}\p{N}]/u.test(o))
  let i = 0
  while (i < Math.min(2, oracoes.length - 1) && ehInciso(tokensDe(oracoes[i]!))) i++
  return (oracoes[i] ?? '').replace(INTERVALO_DE_DATAS_RE, ' ')
}

/** Promessa por verbo (garantir/assegurar/prometer) na frase, não negada. */
export function promessaPorVerbo(frase: string): boolean {
  VERBO_PROMESSA_RE.lastIndex = 0
  for (const m of frase.matchAll(VERBO_PROMESSA_RE)) {
    const ini = m.index ?? 0
    if (termoNegado(frase, ini)) continue
    const depois = frase.slice(ini + m[0].length).replace(/^[\s,:;—–]+/u, '')
    const ws = tokensDe(oracaoDaPromessa(depois))
    // Depois de "que" a oração inteira é o conteúdo prometido ("garanto que o
    // seu pedido de 10 caixas chega na sexta"); sem "que", só as primeiras palavras.
    const limite = ws[0] === 'que' ? ws.length : Math.min(ws.length, JANELA_OBJETO)
    let encaminhou = -1
    for (let i = 0; i < limite; i++) {
      const w = ws[i]!
      if (ENCAMINHA_RE.test(w)) { encaminhou = i; break }
      if (ehData(w)) {
        const k = ws.findIndex((x, idx) => idx > i && (ENCAMINHA_RE.test(x) || QUEM_ENCAMINHA_RE.test(x)))
        if (k < 0) return true
        if (promessaDepoisDoEncaminhamento(ws, k)) return true
        encaminhou = -2
        break
      }
      if (OBJETO_TOKEN_RE.test(w)) return true
    }
    if (encaminhou >= 0 && promessaDepoisDoEncaminhamento(ws, encaminhou)) return true
  }
  return false
}

const VERBO_OFERTA = [
  'posso', 'podemos', 'consigo', 'conseguimos', 'vou', 'vamos', 'dou', 'damos', 'fa[cç]o', 'fazemos',
  'libero', 'liberamos', 'ofere[cç]o', 'oferecemos', 'aplico', 'aplicamos', 'deixo', 'deixamos',
].join('|')
/** Palavras que tornam a oferta um ENCAMINHAMENTO ("posso verificar se há desconto"). */
const NAO_OFERTA = '(?!(?:verific|consult|ver|vej|chec|pergunt|ped|confirm|sab|cham|pass|encaminh|fal|solicit|anot|registr|levar)\\p{L}*\\s)'

/**
 * A base que o código garante (ADR-029 §3). Gravidade CRÍTICA, exceto pedido
 * de consentimento (ALTA, à parte). Cada `id` vira o `codigo` da marca.
 */
export const PROIBIDAS_BASE_B2B: readonly ProibidaBase[] = [
  // O agente nunca nega ser IA nem finge ser humano (Meta exige identificar).
  {
    id: 'nega_ser_ia', gravidade: 'CRITICA', ignoraNegacao: true,
    re: re(`${B}${fuzzy('não')}\\s+sou\\s+(?:um\\s+|uma\\s+)?(?:${fuzzy('robô')}|bot|chatbot|${fuzzy('máquina')}|ia|${fuzzy('inteligência artificial')}|assistente\\s+virtual|atendente\\s+virtual)${E}`),
  },
  {
    id: 'finge_ser_humano', gravidade: 'CRITICA',
    re: re(`${B}sou\\s+(?:um\\s+|uma\\s+)?(?:human[oa]|pessoa\\s+(?:real|de\\s+verdade|de\\s+carne))${E}|${B}(?:falando|conversando)\\s+com\\s+(?:um\\s+|uma\\s+)?(?:pessoa\\s+(?:real|de\\s+verdade)|human[oa])${E}`),
  },
  // Garantir entrega, prazo, estoque, preço ou crédito.
  {
    id: 'garantia_sem_fonte', gravidade: 'CRITICA',
    // "garantimos entrega amanhã", "te garanto: chega sexta", "prometemos que não vai faltar estoque".
    casa: promessaPorVerbo,
  },
  {
    // ⚠️ `termo`: a negação conta a partir de "garantido", não do objeto ("o prazo NÃO é garantido").
    id: 'garantido', gravidade: 'CRITICA',
    re: re(`${B}(?:${OBJETO_GARANTIA})\\s+${palavras(2)}(?<termo>garantid[oa]s?|assegurad[oa]s?)${E}`),
  },
  {
    id: 'garantido', gravidade: 'CRITICA',
    re: re(`${B}(?:garantid[oa]s?|assegurad[oa]s?)\\s+${palavras(1)}(?:${OBJETO_GARANTIA})${E}`),
  },
  {
    id: 'garantia_de', gravidade: 'CRITICA',
    re: re(`${B}garantia\\s+de\\s+(?:${OBJETO_GARANTIA})${E}`),
  },
  {
    id: 'entrega_sem_falta', gravidade: 'CRITICA',
    re: re(`${B}(?:chega|chegam|chegar[aá]|entrega|entregamos|entregaremos|sai|despachamos)\\s+${palavras(4)}(?:sem\\s+falta|com\\s+certeza|${fuzzy('com toda certeza')})${E}|${B}(?:sem\\s+falta|com\\s+certeza|${fuzzy('com toda certeza')})\\s+${palavras(2)}(?:chega|chegam|chegar[aá]|entrega|entregamos|entregaremos)${E}`),
  },
  {
    id: 'estoque_infinito', gravidade: 'CRITICA', ignoraNegacao: true,
    re: re(`${B}sempre\\s+(?:temos|tem|${fuzzy('há')})\\s+${palavras(2)}(?:estoque|pronta\\s+entrega)${E}|${B}nunca\\s+(?:falta|faltou|acaba)\\s+${palavras(1)}(?:estoque|produto|mercadoria)${E}`),
  },
  {
    id: 'preco_congelado', gravidade: 'CRITICA',
    re: re(`${B}${fuzzy('preço')}s?\\s+${palavras(2)}${fuzzy('congelado')}s?${E}|${B}(?:mesmo|esse|este)\\s+${fuzzy('preço')}\\s+(?:para|pra)\\s+sempre${E}`),
  },
  // "Melhor preço do mercado" e afins.
  {
    id: 'melhor_preco_do_mercado', gravidade: 'CRITICA',
    re: re(`${B}(?:o\\s+)?(?:melhor|menor)\\s+${fuzzy('preço')}\\s+(?:do|da|de\\s+todo\\s+o|na|no)\\s+(?:mercado|${fuzzy('praça')}|${fuzzy('região')}|cidade|estado|brasil)${E}|${B}mais\\s+barat[oa]s?\\s+(?:do|da|de\\s+todo\\s+o|na)\\s+(?:mercado|${fuzzy('praça')}|${fuzzy('região')}|cidade|brasil)${E}|${B}cobri(?:mos|r)\\s+qualquer\\s+(?:oferta|${fuzzy('preço')}|proposta|${fuzzy('orçamento')})${E}`),
  },
  {
    id: 'ninguem_mais_barato', gravidade: 'CRITICA', ignoraNegacao: true,
    re: re(`${B}${fuzzy('ninguém')}\\s+(?:tem|faz|vende|oferece)\\s+${palavras(1)}(?:mais\\s+barato|${fuzzy('preço')}\\s+melhor|melhor\\s+${fuzzy('preço')})${E}`),
  },
  // Oferecer desconto: desconto é decisão do vendedor (ferramenta/alçada), nunca do modelo.
  {
    id: 'oferece_desconto', gravidade: 'CRITICA',
    re: re(`${B}(?:${VERBO_OFERTA})\\s+${NAO_OFERTA}(?:${NAO_OFERTA}[\\p{L}\\p{N}%$.,]+\\s+){0,3}?(?:um\\s+|uma\\s+)?(?:desconto|descontinho|abatimento|${fuzzy('condição especial')}|${fuzzy('preço especial')})${E}`),
  },
  {
    id: 'baixa_preco', gravidade: 'CRITICA',
    re: re(`${B}(?:consigo|conseguimos|posso|podemos|vou|vamos)\\s+${palavras(2)}(?:baixar|abaixar|reduzir|melhorar|diminuir)\\s+${palavras(2)}(?:${fuzzy('preço')}|valor|${fuzzy('orçamento')})${E}|${B}fa(?:[cç]o|zemos)\\s+(?:por\\s+)?menos${E}`),
  },
  // Urgência falsa.
  {
    id: 'urgencia_falsa', gravidade: 'CRITICA',
    re: re([
      `${B}${fuzzy('só')}\\s+(?:hoje|${fuzzy('até')}\\s+(?:hoje|${fuzzy('amanhã')}))${E}`,
      `${B}(?:${fuzzy('promoção')}|oferta|${fuzzy('preço')}|${fuzzy('condição')})\\s+${palavras(2)}(?:acaba|termina|vence|expira)\\s+(?:hoje|${fuzzy('amanhã')}|em\\s+breve|logo)${E}`,
      `${B}corre\\s+que${E}`,
      `${B}antes\\s+que\\s+(?:acabe|esgote|termine)${E}`,
      `${B}(?:vai|${fuzzy('vão')}|pode)\\s+(?:acabar|esgotar)\\s+(?:logo|${fuzzy('rápido')}|hoje)${E}`,
      `${B}aproveit[ae]\\s+(?:agora|enquanto|${fuzzy('já')})${E}`,
    ].join('|')),
  },
  // Escassez: só é verdade com saldo de ferramenta no turno.
  {
    id: 'escassez_sem_fonte', gravidade: 'CRITICA', liberadaComEstoqueDeFonte: true,
    re: re([
      `${B}(?:${fuzzy('últimas')}|${fuzzy('última')}|poucas)\\s+unidades${E}`,
      `${B}estoque\\s+(?:${fuzzy('está')}\\s+)?(?:acabando|no\\s+fim|${fuzzy('limitadíssimo')})${E}`,
    ].join('|')),
  },
]

/**
 * O que a base garante, em palavras de quem configura (a tela mostra: "isto já
 * vale sempre, não precisa cadastrar"). Uma linha por família de regra.
 */
export const BASE_B2B_DESCRITA: ReadonlyArray<{ readonly id: string; readonly rotulo: string; readonly exemplo: string }> = [
  { id: 'nega_ser_ia', rotulo: 'Negar ser assistente virtual ou fingir ser humano', exemplo: 'não sou um robô' },
  { id: 'garantia_sem_fonte', rotulo: 'Garantir ou prometer entrega, prazo, estoque, preço ou crédito', exemplo: 'te garanto que chega sexta' },
  { id: 'entrega_sem_falta', rotulo: 'Prometer entrega "sem falta" ou "com certeza"', exemplo: 'chega amanhã sem falta' },
  { id: 'estoque_infinito', rotulo: 'Afirmar que nunca falta estoque', exemplo: 'sempre temos estoque' },
  { id: 'preco_congelado', rotulo: 'Prometer preço congelado', exemplo: 'o preço fica congelado' },
  { id: 'melhor_preco_do_mercado', rotulo: '"Melhor preço do mercado" e afins', exemplo: 'cobrimos qualquer oferta' },
  { id: 'oferece_desconto', rotulo: 'Oferecer desconto ou baixar preço por conta própria', exemplo: 'posso te dar um desconto' },
  { id: 'urgencia_falsa', rotulo: 'Urgência falsa e escassez sem saldo do sistema', exemplo: 'só hoje, últimas unidades' },
  { id: 'pede_consentimento', rotulo: 'Pedir consentimento para atender ou guardar dados', exemplo: 'posso guardar seus dados?' },
  { id: 'hesitacao', rotulo: 'Hesitação sobre prazo, estoque ou preço (a frase sai)', exemplo: 'acho que chega amanhã' },
]

/**
 * Pedido de consentimento para atender ou guardar dado: a base legal do
 * atendimento B2B não é consentimento (o aviso de privacidade sai na abertura,
 * P4). Removido junto com a confirmação solta que sobra ("Tudo bem?").
 */
// ⚠️ Coletar CNPJ, e-mail e endereço para faturar é parte da venda B2B
//    ("posso anotar seu CNPJ?", "vou cadastrar seu e-mail") — NÃO é pedido de
//    consentimento. Só pedir permissão para GUARDAR dados genéricos é.
const DADOS_GUARDADOS = String.raw`(?:o\s+|os\s+|a\s+|as\s+)?(?:seu|seus|sua|suas)\s+(?:dados|contato|telefone|informa\p{L}*)`
const VERBO_GUARDAR = String.raw`(?:guard|armazen|salv|mant)\p{L}*`
export const PEDIDO_CONSENTIMENTO_RE = new RegExp(
  [
    String.raw`(?:posso|podemos|tudo\s+bem|autoriza|permite|concorda|consente|me\s+d[aá]\s+permiss)[^.!?\n]{0,60}?${VERBO_GUARDAR}\s+${DADOS_GUARDADOS}`,
    String.raw`${B}(?:seu\s+)?consentimento${E}|${B}voc[eê]\s+consente${E}|autoriza\p{L}*\s+(?:para|pra)\s+(?:usar|tratar|guardar|registrar)`,
    String.raw`${B}(?:voc[eê]\s+)?(?:autoriza|permite|aceita|concorda\s+(?:que|em))\s+(?:que\s+)?(?:eu\s+)?(?:te\s+|lhe\s+|o\s+|a\s+)?(?:atend|continu\p{L}*\s+(?:o\s+|seu\s+)?atendimento)`,
    String.raw`${B}posso\s+(?:te\s+|lhe\s+)?atender\s*\?`,
  ].join('|'),
  'iu',
)
const CONFIRMACAO_SOLTA_RE =
  /^\s*(?:tudo\s+bem|pode\s+ser|ok|combinado|posso|beleza|certo|fechado)\b[^.!?\n]{0,30}\?\s*$/iu

/**
 * Hesitações. ⚠️ Cortar a hesitação de uma afirmação de negócio FABRICA
 * promessa ("Provavelmente chega amanhã" → "Chega amanhã"): nesse caso a FRASE
 * inteira sai (`hesitacao_em_afirmacao`, ALTA). Fora disso, cortamos só as
 * locuções que não deixam a frase quebrada; "talvez" não é cortado (a frase
 * quebraria) — fica registrado.
 */
const HESITACAO_RE = new RegExp(`${B}(?:talvez|provavelmente|quem\\s+sabe|acho\\s+que|acredito\\s+que)${E}`, 'iu')
/** Colocações de PROMESSA (não tokens soltos): chegar/entregar/sair; ter estoque; preço/prazo é/fica/sai. */
const AFIRMACAO_NEGOCIO_RE = new RegExp(
  [
    `${B}(?:cheg\\p{L}*|entreg\\p{L}*|sai|saem)${E}`,
    `${B}(?:tem|temos|${fuzzy('há')})\\s+${palavras(2)}(?:estoque|dispon\\p{L}*|pronta\\s+entrega|unidades|caixas)${E}`,
    `${B}(?:${fuzzy('preço')}|valor|prazo)\\s+(?:${fuzzy('é')}|fica|sai)${E}`,
  ].join('|'),
  'iu',
)
/** Quem encaminha é o sujeito ("o vendedor consegue te ajudar com o prazo"): não é promessa do agente. */
const SUJEITO_ENCAMINHA_RE = new RegExp(
  `${B}(?:vendedor|vendedora|equipe|transportadora|consultor|consultora|atendente|representante)\\s+${palavras(2)}(?:consegue|sabe|pode|vai|confirma|informa|ajuda|explica|passa|diz|te\\s+diz)${E}`,
  'iu',
)
const TALVEZ_RE = new RegExp(`${B}talvez${E}`, 'iu')

export const PROIBIDAS_REESCRITA_B2B: ReadonlyArray<{ readonly id: string; readonly re: RegExp; readonly por: string }> = [
  { id: 'hesitacao_provavelmente', re: re(`${B}provavelmente,?\\s*`), por: '' },
  { id: 'hesitacao_quem_sabe', re: re(`${B}quem\\s+sabe,?\\s*`), por: '' },
  { id: 'hesitacao_acho_que', re: re(`${B}(?:eu\\s+)?acho\\s+que\\s*`), por: '' },
  { id: 'hesitacao_acredito_que', re: re(`${B}acredito\\s+que\\s*`), por: '' },
]

/**
 * Notas obrigatórias (o análogo B2B do "sem juros sem a taxa" da AM): a
 * afirmação só sai acompanhada da ressalva na mesma mensagem. Negada ("não
 * temos frete grátis") não pede nota.
 */
export const NOTAS_OBRIGATORIAS_B2B: ReadonlyArray<{
  readonly id: string; readonly re: RegExp; readonly ressalva: RegExp; readonly nota: string
}> = [
  {
    id: 'frete_gratis_sem_condicao',
    re: re(`${B}frete\\s+(?:${fuzzy('grátis')}|gratuito|free|zero|por\\s+nossa\\s+conta)${E}`),
    ressalva: /pol[ií]tica|acima\s+de|a\s+partir\s+de|para\s+pedidos|conforme|regi[aã]o|condi[cç][õoã]|m[ií]nimo/iu,
    nota: '(conforme a política de frete)',
  },
]

/** Anexa as notas obrigatórias que faltam, frase a frase (ressalva na MESMA frase dispensa). */
function notasObrigatoriasNoTexto(texto: string): { texto: string; ocorrencias: OcorrenciaFiltro[] } {
  const ocorrencias: OcorrenciaFiltro[] = []
  const frases = (texto.match(/(?:[^.!?\n]|(?<=\d)[.,](?=\d))+[.!?…]*[ \t]*|\n/g) ?? []).map((f0) => {
    let f = f0
    for (const n of NOTAS_OBRIGATORIAS_B2B) {
      if (n.ressalva.test(f) || f.includes(n.nota)) continue
      n.re.lastIndex = 0
      for (const m of f.matchAll(n.re)) {
        const ini = m.index ?? 0
        if (termoNegado(f, ini)) continue
        const fimTermo = ini + m[0].length
        ocorrencias.push({ id: n.id, gravidade: 'MEDIA', acao: 'anexado', trecho: m[0] })
        f = `${f.slice(0, fimTermo)} ${n.nota}${f.slice(fimTermo)}`
        break
      }
    }
    return f
  })
  return { texto: ocorrencias.length ? frases.join('') : texto, ocorrencias }
}

// ── extras do número ───────────────────────────────────────────────────────

interface ProibidaExtra { readonly id: string; readonly re: RegExp }

function compilarExtras(lista: readonly string[] | undefined): ProibidaExtra[] {
  if (!lista?.length) return []
  return semDuplicatas(lista)
    .filter((t) => t.length >= LIMITES_COMPLIANCE.minCaracteres)
    // Número (P2) + playbook (P17): até duas listas cheias — nenhuma frase extra é perdida.
    .slice(0, LIMITES_COMPLIANCE.maxItens * 2)
    .map((t) => ({ id: `extra:${chaveLiteral(t).slice(0, 60)}`, re: regexLiteral(t) }))
}

/** Onde a negação é medida: o grupo `termo`, se a regra o tem; senão o início do casamento. */
function inicioDoTermo(m: RegExpMatchArray): number {
  const t = m.groups?.['termo']
  const i = t ? m[0].lastIndexOf(t) : 0
  return (m.index ?? 0) + Math.max(0, i)
}

/** Primeira expressão proibida NÃO negada na frase. */
function proibidaNaFrase(
  frase: string, extras: readonly ProibidaExtra[], estoqueComFonte: boolean,
): { id: string; gravidade: GravidadeGuardrail } | null {
  for (const p of PROIBIDAS_BASE_B2B) {
    if (p.liberadaComEstoqueDeFonte && estoqueComFonte) continue
    if (p.casa) {
      if (p.casa(frase)) return { id: p.id, gravidade: p.gravidade }
      continue
    }
    if (!p.re) continue
    p.re.lastIndex = 0
    for (const m of frase.matchAll(p.re)) {
      if (p.ignoraNegacao || !termoNegado(frase, inicioDoTermo(m))) return { id: p.id, gravidade: p.gravidade }
    }
  }
  // Mesma regra de negação para as extras ("não trabalhamos com consignado" passa).
  for (const p of extras) {
    p.re.lastIndex = 0
    for (const m of frase.matchAll(p.re)) if (!termoNegado(frase, m.index ?? 0)) return { id: p.id, gravidade: 'CRITICA' }
  }
  return null
}

// ── frases e limites ────────────────────────────────────────────────────────

/** Frases de um texto, sem quebrar números decimais/milhar ("1,5", "4.000"). */
function frasesDe(texto: string): string[] {
  return texto.match(/(?:[^.!?\n]|(?<=\d)[.,](?=\d))+[.!?…]*[ \t]*|\n/g) ?? []
}

const temPergunta = (f: string): boolean => /\?/.test(f)

function cortarFrase(f: string, max: number): string {
  if (f.length <= max) return f
  // ⚠️ Nunca separar o termo da sua nota obrigatória ("frete grátis" sem "(conforme a
  //    política de frete)"): se o corte cairia dentro da nota, corta ANTES do termo.
  for (const n of NOTAS_OBRIGATORIAS_B2B) {
    const iNota = f.indexOf(n.nota)
    if (iNota < 0 || iNota + n.nota.length <= max - 1) continue
    n.re.lastIndex = 0
    const m = n.re.exec(f.slice(0, iNota))
    const antes = f.slice(0, m?.index ?? 0).replace(/[\s,;:]+$/u, '')
    // Sem nada antes do termo: a frase fica INTEIRA (estilo cede à nota; nunca o contrário).
    if (!antes) return f
    return antes.length + 1 <= max ? `${antes}…` : cortarFrase(antes, max)
  }
  const corte = f.slice(0, Math.max(1, max - 1))
  const espaco = corte.lastIndexOf(' ')
  return `${(espaco > max * 0.5 ? corte.slice(0, espaco) : corte).replace(/[\s,;:]+$/u, '')}…`
}

/**
 * Estilo (playbook, P17): no máximo `maxPerguntas` perguntas (ficam as
 * últimas) e `maxCaracteres` caracteres (preserva a última pergunta; frase
 * sozinha maior que o limite é cortada).
 */
export function aplicarLimitesMensagem(texto: string, limites: LimitesMensagem = {}): { texto: string; ocorrencias: OcorrenciaFiltro[] } {
  const ocorrencias: OcorrenciaFiltro[] = []
  let frases = frasesDe(texto)
  const maxP = limites.maxPerguntas
  if (maxP && maxP > 0) {
    const idx = frases.map((f, i) => (temPergunta(f) ? i : -1)).filter((i) => i >= 0)
    if (idx.length > maxP) {
      const remover = new Set(idx.slice(0, idx.length - maxP))
      frases = frases.filter((_f, i) => !remover.has(i))
      ocorrencias.push({ id: 'max_perguntas', gravidade: 'MEDIA', acao: 'removido' })
    }
  }
  let out = frases.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const maxC = limites.maxCaracteres
  if (maxC && maxC > 0 && out.length > maxC) {
    ocorrencias.push({ id: 'max_caracteres', gravidade: 'MEDIA', acao: 'reescrito' })
    const lista = frasesDe(out)
    const ultimaPergunta = lista.map(temPergunta).lastIndexOf(true)
    const manter = new Set<number>()
    let total = 0
    const tentar = (i: number): void => {
      const len = lista[i]!.length
      if (total + len <= maxC) { manter.add(i); total += len }
    }
    if (ultimaPergunta >= 0) tentar(ultimaPergunta)
    for (let i = 0; i < lista.length; i++) if (i !== ultimaPergunta) tentar(i)
    out = lista.filter((_f, i) => manter.has(i)).join('').replace(/\n{3,}/g, '\n\n').trim()
    if (!out) out = cortarFrase(lista.find((f) => f.trim())?.trim() ?? '', maxC)
    if (out.length > maxC) out = cortarFrase(out, maxC)
  }
  return { texto: ocorrencias.length ? out : texto, ocorrencias }
}

// ── o filtro ────────────────────────────────────────────────────────────────

/** O que sai quando o filtro removeu tudo. Sem prazo, sem número. */
export const TEXTO_SEGURO = 'Deixa eu confirmar essa informação com a equipe para te responder com segurança.'

/** Remove frases proibidas, trata hesitações, anexa notas obrigatórias e aplica limites. */
export function filtrarSaida(texto: string, opcoes: OpcoesFiltroSaida = {}): ResultadoFiltroSaida {
  const ocorrencias: OcorrenciaFiltro[] = []
  const extras = compilarExtras(opcoes.extras)
  const estoqueComFonte = opcoes.estoqueComFonte === true
  let pediuConsentimento = false
  const mantidas: string[] = []
  for (const original of frasesDe(texto)) {
    let f = original
    if (PEDIDO_CONSENTIMENTO_RE.test(f)) {
      ocorrencias.push({ id: 'pede_consentimento', gravidade: 'ALTA', acao: 'removido', trecho: f.trim() })
      pediuConsentimento = true
      continue
    }
    if (pediuConsentimento && CONFIRMACAO_SOLTA_RE.test(f)) continue
    if (f.trim()) pediuConsentimento = false
    const hit = proibidaNaFrase(f, extras, estoqueComFonte)
    if (hit) { ocorrencias.push({ ...hit, acao: 'removido', trecho: f.trim() }); continue }
    if (HESITACAO_RE.test(f)) {
      // Hesitação + colocação de promessa: a locução NUNCA é cortada (cortar
      // fabricaria a promessa). Pergunta ou sujeito que encaminha → a frase fica
      // INTACTA, com a hesitação, e é registrada; senão a frase inteira sai.
      if (AFIRMACAO_NEGOCIO_RE.test(f)) {
        if (/\?\s*$/.test(f) || SUJEITO_ENCAMINHA_RE.test(f)) {
          ocorrencias.push({ id: 'hesitacao_em_afirmacao', gravidade: 'INFO', acao: 'registrado', trecho: f.trim() })
        } else {
          ocorrencias.push({ id: 'hesitacao_em_afirmacao', gravidade: 'ALTA', acao: 'removido', trecho: f.trim() })
          continue
        }
        mantidas.push(f)
        continue
      }
      // Sem colocação de promessa: corta só a locução ("Quem sabe você tem interesse no modelo novo?").
      for (const p of PROIBIDAS_REESCRITA_B2B) {
        p.re.lastIndex = 0
        const m = p.re.exec(f)
        if (!m) continue
        ocorrencias.push({ id: p.id, gravidade: 'INFO', acao: 'reescrito', trecho: m[0].trim() })
        p.re.lastIndex = 0
        f = f.replace(p.re, p.por)
      }
      const t = TALVEZ_RE.exec(f)
      if (t) ocorrencias.push({ id: 'hesitacao_talvez', gravidade: 'INFO', acao: 'registrado', trecho: t[0] })
    }
    // Nota obrigatória, por frase: a ressalva tem de estar na MESMA frase.
    for (const n of NOTAS_OBRIGATORIAS_B2B) {
      if (n.ressalva.test(f)) continue
      n.re.lastIndex = 0
      for (const m of f.matchAll(n.re)) {
        const ini = m.index ?? 0
        if (termoNegado(f, ini)) continue
        const fimTermo = ini + m[0].length
        ocorrencias.push({ id: n.id, gravidade: 'MEDIA', acao: 'anexado', trecho: m[0] })
        f = `${f.slice(0, fimTermo)} ${n.nota}${f.slice(fimTermo)}`
        break
      }
    }
    mantidas.push(f)
  }
  const mexeu = ocorrencias.some((o) => o.acao !== 'registrado')
  let out = texto
  let esvaziado = false
  if (mexeu) {
    out = mantidas.join('')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.!?])/g, '$1')
      .replace(/(^|[.!?]\s+|\n)([a-zà-ú])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!/[\p{L}\p{N}]/u.test(out)) { out = TEXTO_SEGURO; esvaziado = true }
  }
  if (opcoes.limites && !esvaziado) {
    const l = aplicarLimitesMensagem(out, opcoes.limites)
    if (l.ocorrencias.length) {
      ocorrencias.push(...l.ocorrencias); out = l.texto
      // O corte pode ter levado a RESSALVA ("…cidade e região toda.") e deixado o termo:
      // a nota obrigatória é conferida de novo sobre o texto cortado.
      const n = notasObrigatoriasNoTexto(out)
      if (n.ocorrencias.length) { ocorrencias.push(...n.ocorrencias); out = n.texto }
    }
  }
  return { texto: out, alterado: out !== texto, ocorrencias, esvaziado }
}

// ── mensagem de handoff ─────────────────────────────────────────────────────

/** Promessa de prazo de retorno ("em 5 minutos", "já já", "ainda hoje", "em breve"…). */
export const PROMESSA_PRAZO_RE = new RegExp(
  [
    String.raw`${B}em\s+(?:at[eé]\s+|no\s+m[aá]ximo\s+|uns\s+|cerca\s+de\s+)?\d+\s*(?:min\p{L}*|h|hs|horas?|dias?|segundos?)${E}`,
    String.raw`${B}em\s+(?:poucos\s+|alguns\s+)?(?:instantes|minutinhos?|minutos|segundos|momentos)${E}`,
    String.raw`${B}(?:j[aá]\s+j[aá]|rapidinho|num\s+instante|ainda\s+hoje|hoje\s+mesmo|logo\s+mais|logo\s+logo|em\s+breve|daqui\s+(?:a\s+)?(?:pouco|\d+)|o\s+quanto\s+antes|imediatamente)${E}`,
  ].join('|'),
  'iu',
)

/** Número de negócio que, sem fonte no turno, não acompanha um handoff. */
const NUMERO_DE_NEGOCIO_RE =
  /R\$\s*\d|\d+(?:[.,]\d+)?\s*%|\d+\s*(?:dias?|horas?|unidades|un\b|p[cç]s?\b|pe[cç]as|caixas?|cx\b|fardos?|pacotes?|kg|metros?)/iu

/** Quem retoma: se nenhuma frase diz, anexamos. */
const MENCIONA_HUMANO_RE = /vendedor|consultor|atendente|equipe|especialista|representante|pessoa|colega|humano/iu

export function mencionaQuemRetoma(texto: string): boolean {
  return MENCIONA_HUMANO_RE.test(texto)
}

export const TEXTO_RETOMADA = 'Um vendedor da equipe continua o atendimento com você por aqui, neste mesmo número.'

/**
 * Mensagem do turno em que a conversa vai para um humano: tira frases que
 * prometem prazo de retorno e — com `semNumeros` — frases com número de
 * negócio; garante que o cliente saiba que alguém da equipe retoma por aqui.
 */
export function ajustarMensagemHandoff(
  texto: string,
  opts: {
    readonly semNumeros?: boolean | undefined
    readonly retomada?: string | undefined
    /** false: só tira as frases; quem chama confere a retomada no conjunto das mensagens. */
    readonly anexarRetomada?: boolean | undefined
  } = {},
): { texto: string; alterado: boolean; ocorrencias: OcorrenciaFiltro[] } {
  const ocorrencias: OcorrenciaFiltro[] = []
  const mantidas = frasesDe(texto).filter((f) => {
    if (PROMESSA_PRAZO_RE.test(f)) {
      ocorrencias.push({ id: 'promessa_prazo_handoff', gravidade: 'ALTA', acao: 'removido', trecho: f.trim() })
      return false
    }
    if (opts.semNumeros && NUMERO_DE_NEGOCIO_RE.test(f)) {
      ocorrencias.push({ id: 'numero_no_handoff', gravidade: 'MEDIA', acao: 'removido', trecho: f.trim() })
      return false
    }
    return true
  })
  let out = mantidas.join('').replace(/\n{3,}/g, '\n\n').trim()
  if (opts.anexarRetomada !== false && !mencionaQuemRetoma(out)) {
    const retomada = opts.retomada ?? TEXTO_RETOMADA
    out = out ? `${out} ${retomada}` : retomada
    ocorrencias.push({ id: 'retomada_handoff', gravidade: 'INFO', acao: 'anexado' })
  }
  return { texto: out, alterado: out !== texto.trim(), ocorrencias }
}
