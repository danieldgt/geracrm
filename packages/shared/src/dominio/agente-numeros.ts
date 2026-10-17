/**
 * GUARDRAIL NUMÉRICO AMPLIADO (raia P7, ADR-029 §3; amplia o ADR-023).
 *
 * O guardrail de R$ (`verificarNumerosNaResposta`, agente-vendedor.ts) cobre
 * dinheiro. Este módulo cobre os OUTROS números que viram compromisso numa
 * venda B2B: percentual, quantidade e prazo (dias e horas). Puro, sem I/O —
 * consumido pela etapa `numeros-ampliados` do pipeline e pela qualidade (P12).
 *
 * Decisões (documentadas aqui porque são regra, não detalhe):
 * - Formato pt-BR: "1.234" é mil duzentos e trinta e quatro; "1,5" é um e meio;
 *   "10 %" e "10%" valem igual; "por cento" também.
 * - Por extenso: "dez por cento" (percentual) e "dois dias úteis" (prazo) são
 *   reconhecidos — de dois a noventa e nove e "cem". "um/uma" por extenso NÃO
 *   conta em prazo ("um dia desses" é idiomático) nem em quantidade ("temos duas
 *   cores" não é estoque).
 * - O que NÃO é número de negócio (mascarado antes de extrair): hora ("14h",
 *   "14:30", "às 9"), data ("12/10", "dia 15", "15 de outubro"), telefone, CPF,
 *   CNPJ, CEP (qualquer sequência com ≥ 8 dígitos e separadores), nº de pedido /
 *   nota / protocolo ("pedido 1234", "nº 1234", "#1234"), SKU e referência
 *   ("CAM-001", "ref. 4455", "AB123"). Dinheiro (R$, "reais") fica com o
 *   guardrail de R$.
 * - "N semanas"/"N meses" entram como prazo_dias com o valor COMO ESCRITO
 *   (a unidade vai em `unidade`; a fonte é comparada pelo número escrito).
 *   "Nx" (parcelas) NÃO é extraído — fora do contrato desta raia.
 * - Bloqueante (`bloqueante: true`, gravidade CRITICA): todo percentual;
 *   quantidade afirmada como disponibilidade ("temos 12 unidades", "12 em
 *   estoque", "saldo de 12"); prazo num contexto de compromisso (entrega, envio,
 *   chegada, prazo, pagamento, boleto, faturamento, produção). Os demais sem
 *   fonte são ALTA (registrados, a mensagem sai).
 */
export const TIPOS_NUMERO_DE_NEGOCIO = ['percentual', 'quantidade', 'prazo_dias', 'prazo_horas'] as const
export type TipoNumeroDeNegocio = (typeof TIPOS_NUMERO_DE_NEGOCIO)[number]

export const UNIDADES_NUMERO_DE_NEGOCIO = ['%', 'unidade', 'dia', 'semana', 'mes', 'hora'] as const
export type UnidadeNumeroDeNegocio = (typeof UNIDADES_NUMERO_DE_NEGOCIO)[number]

export interface NumeroDeNegocio {
  readonly tipo: TipoNumeroDeNegocio
  /** O número como escrito ("2 semanas" → 2, unidade 'semana'). */
  readonly valor: number
  /** Trecho como apareceu ("10%", "temos 12 unidades", "3 a 5 dias úteis"). */
  readonly trecho: string
  readonly unidade: UnidadeNumeroDeNegocio
  /** Sem fonte, barra a resposta (CRITICA); senão é só marca ALTA. */
  readonly bloqueante: boolean
}

/** As fontes de um turno. Percentual NUNCA vem do cliente (ver `numerosSemFonte`). */
export interface FontesDeNumeros {
  /** Ferramentas, políticas, conhecimento e o que nós já dissemos na conversa. */
  readonly gerais: ReadonlySet<number> | Iterable<number>
  /** O que o próprio cliente escreveu: vale para quantidade e prazo. */
  readonly doCliente?: ReadonlySet<number> | Iterable<number> | undefined
}

// ── parse pt-BR ──────────────────────────────────────────────────────────────

/** "1.234,56" → 1234.56; "1.234" → 1234; "1,5" → 1.5; "1.5" → 1.5; "12" → 12. */
export function numeroBr(bruto: string): number {
  const t = bruto.trim()
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'))
  if (/^\d+,\d+$/.test(t)) return Number(t.replace(',', '.'))
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t)
  return Number.NaN
}

const UNIDADES_EXTENSO: Readonly<Record<string, number>> = {
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
}
const SIMPLES_EXTENSO: Readonly<Record<string, number>> = {
  ...UNIDADES_EXTENSO, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15,
  dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, cem: 100,
}
const DEZENAS_EXTENSO: Readonly<Record<string, number>> = {
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, 'cinqüenta': 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
}
const alternativas = (o: Readonly<Record<string, number>>): string =>
  Object.keys(o).sort((a, b) => b.length - a.length).join('|')
const EXTENSO = String.raw`(?:(?:${alternativas(DEZENAS_EXTENSO)})(?:\s+e\s+(?:${alternativas(UNIDADES_EXTENSO)}))?|${alternativas(SIMPLES_EXTENSO)})`

/** "vinte e cinco" → 25; "dez" → 10; desconhecido → NaN. */
export function numeroPorExtenso(bruto: string): number {
  const partes = bruto.toLowerCase().trim().split(/\s+e\s+/)
  let total = 0
  for (const p of partes) {
    const v = SIMPLES_EXTENSO[p] ?? DEZENAS_EXTENSO[p]
    if (v === undefined) return Number.NaN
    total += v
  }
  return total
}

// ── máscara do que não é número de negócio ───────────────────────────────────

const L = String.raw`\p{L}`
const MESES = 'janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'
const IGNORAR: readonly RegExp[] = [
  // telefone, CPF, CNPJ, CEP, nº longo: ≥ 8 dígitos com separadores no meio
  /\+?\d(?:[\d()./\s-]*\d){7,}/g,
  // CEP curto escrito "60000-000" já cai acima; data dd/mm(/aaaa)
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  // hora: 14:30, 14h30, 9h, "às 14", "das 8 às 18 horas"
  /\b\d{1,2}(?::|h)\d{2}\b/giu,
  new RegExp(String.raw`(?:às|as|das|dàs|após as|depois das|antes das|até as|até às|ate as|a partir das)\s+\d{1,2}(?:\s*(?:h|hs|horas?)(?!${L}))?`, 'giu'),
  // "até 18h" sem "em" antes = hora do dia
  new RegExp(String.raw`(?<!\bem\s)\baté\s+\d{1,2}\s*(?:h|hs)(?!${L})`, 'giu'),
  // data por extenso: "dia 15", "15 de outubro"
  /\bdia\s+\d{1,2}\b/giu,
  new RegExp(String.raw`\b\d{1,2}\s+de\s+(?:${MESES})\b`, 'giu'),
  // nº de pedido, nota, protocolo, referência, SKU, código
  new RegExp(String.raw`(?:pedido|nota|nf-?e?|protocolo|ref\.?|referência|referencia|sku|código|codigo|cód\.?|cod\.?|número|numero|n[º°o]\.?|#)\s*(?:n[º°o]\.?\s*)?[:#]?\s*[\p{L}\d_-]*\d[\p{L}\d_-]*`, 'giu'),
  // token alfanumérico com letra antes do dígito: CAM-001, AB123, V2
  new RegExp(String.raw`(?<![\p{L}\d])${L}+[-_]?\d[\p{L}\d_-]*`, 'gu'),
  // dinheiro: fica com o guardrail de R$
  /R\$\s*\d[\d.,]*/g,
  /\d[\d.,]*\s*(?:reais|real)\b/giu,
]

function mascarar(texto: string): string {
  let t = texto
  for (const re of IGNORAR) {
    re.lastIndex = 0
    t = t.replace(re, (m) => ' '.repeat(m.length))
  }
  return t
}

// ── extração ─────────────────────────────────────────────────────────────────

const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`
/** Número solto: não colado em letra, dígito, nem separador de data/telefone. */
const ANTES = String.raw`(?<![\p{L}\d.,/:-])`
const DEPOIS = String.raw`(?![\d/:]|[.,]\d)`
const N = String.raw`${ANTES}(${NUM})${DEPOIS}`
/** Extenso só como palavra inteira. */
const X = String.raw`(?<!${L})(${EXTENSO})(?!${L})`
const INTERVALO = String.raw`\s*(?:a|até|ate|ou|e|-|–)\s*`

const UNIDADE_QTD = String.raw`(?:unidades?|un\.?|und\.?|pe[çc]as?|p[çc]s?|pares|caixas?|cx\.?|itens|kits?|fardos?|d[úu]zias?|pacotes?|rolos?|sacos?|metros?|kg|quilos?|litros?|frascos?|latas?|garrafas?)(?!${L})`
const VERBO_ESTOQUE = String.raw`(?:temos|tenho|h[áa]|tem|restam|restaram|resta|sobraram|sobrou|possu[íi]mos|dispomos\s+de|contamos\s+com)\s+(?:(?:apenas|s[óo]|somente|mais|ainda|exatamente|cerca\s+de)\s+)?`
const DISPONIVEL = String.raw`(?:em\s+estoque|no\s+estoque|dispon[íi]ve(?:l|is)|[àa]\s+pronta\s+entrega|pronta\s+entrega)`
const COMPROMISSO = /(?<!\p{L})(entreg|cheg|envi|despach|post|frete|prazo|pag|boleto|venc|fatur|produ[zçc]|separ|libera|retir|pront|transport|coleta)/iu

interface Padrao {
  readonly tipo: TipoNumeroDeNegocio
  readonly re: RegExp
  readonly unidade: (m: RegExpExecArray) => UnidadeNumeroDeNegocio
  /** Bloqueante por construção do padrão (null = decide pelo contexto). */
  readonly bloqueante: boolean | null
  readonly extenso?: boolean
}

const unidadeDePrazo = (m: RegExpExecArray): UnidadeNumeroDeNegocio => {
  const u = (m[0].match(/(dias?|semanas?|m[eê]s(?:es)?|horas?|hs?)\s*(?:[úu]teis|corridos)?\s*$/iu)?.[1] ?? 'dia').toLowerCase()
  if (u.startsWith('sem')) return 'semana'
  if (u.startsWith('m')) return 'mes'
  if (u.startsWith('h')) return 'hora'
  return 'dia'
}
const PRAZO_DIAS = String.raw`(?:dias?|semanas?|m[eê]s(?:es)?)(?:\s+(?:[úu]teis|corridos))?(?!${L})`

// ⚠️ A ordem importa: o primeiro padrão que cobre um trecho fica com ele.
const PADROES: readonly Padrao[] = [
  { tipo: 'percentual', re: new RegExp(String.raw`${N}\s*(?:%|por\s*cento(?!${L}))`, 'giu'), unidade: () => '%', bloqueante: true },
  { tipo: 'percentual', re: new RegExp(String.raw`${X}\s+por\s*cento(?!${L})`, 'giu'), unidade: () => '%', bloqueante: true, extenso: true },
  // quantidade afirmada como disponibilidade
  { tipo: 'quantidade', re: new RegExp(String.raw`${VERBO_ESTOQUE}${N}(?:\s+${UNIDADE_QTD})?(?:\s+(?:de\s+\S+\s+)?${DISPONIVEL})?(?=\s*(?:[.,;!?)]|$|${UNIDADE_QTD}|${DISPONIVEL}))`, 'giu'), unidade: () => 'unidade', bloqueante: true },
  { tipo: 'quantidade', re: new RegExp(String.raw`${VERBO_ESTOQUE}${N}\s+${UNIDADE_QTD}`, 'giu'), unidade: () => 'unidade', bloqueante: true },
  { tipo: 'quantidade', re: new RegExp(String.raw`${N}(?:\s+${UNIDADE_QTD})?\s+${DISPONIVEL}`, 'giu'), unidade: () => 'unidade', bloqueante: true },
  { tipo: 'quantidade', re: new RegExp(String.raw`(?:estoque|saldo)\s+(?:atual\s+)?(?:de|é\s+de|:)?\s*${N}`, 'giu'), unidade: () => 'unidade', bloqueante: true },
  // prazos (intervalo primeiro: "3 a 5 dias úteis" rende 3 e 5)
  { tipo: 'prazo_dias', re: new RegExp(String.raw`${N}${INTERVALO}${N}\s*${PRAZO_DIAS}`, 'giu'), unidade: unidadeDePrazo, bloqueante: null },
  { tipo: 'prazo_dias', re: new RegExp(String.raw`${N}\s*${PRAZO_DIAS}`, 'giu'), unidade: unidadeDePrazo, bloqueante: null },
  { tipo: 'prazo_dias', re: new RegExp(String.raw`${X}\s+${PRAZO_DIAS}`, 'giu'), unidade: unidadeDePrazo, bloqueante: null, extenso: true },
  { tipo: 'prazo_horas', re: new RegExp(String.raw`${N}${INTERVALO}${N}\s*(?:horas?|hs?)(?!${L})`, 'giu'), unidade: () => 'hora', bloqueante: null },
  { tipo: 'prazo_horas', re: new RegExp(String.raw`${N}\s*horas?(?!${L})`, 'giu'), unidade: () => 'hora', bloqueante: null },
  // "48h" abreviado só com cara de prazo ("em 48h", "dentro de 24h") ou > 24
  { tipo: 'prazo_horas', re: new RegExp(String.raw`(?:(?<=(?:\bem|\bem\s+até|\bdentro\s+de|\bprazo\s+de|\bapós|\bapos|\bpróximas|\bproximas)\s+)${N}|${ANTES}(\d{3,}|2[5-9]|[3-9]\d)${DEPOIS})\s*hs?(?!${L})`, 'giu'), unidade: () => 'hora', bloqueante: null },
  { tipo: 'prazo_horas', re: new RegExp(String.raw`${X}\s+horas?(?!${L})`, 'giu'), unidade: () => 'hora', bloqueante: null, extenso: true },
  // quantidade com unidade, sem afirmação de estoque
  { tipo: 'quantidade', re: new RegExp(String.raw`${N}${INTERVALO}${N}\s+${UNIDADE_QTD}`, 'giu'), unidade: () => 'unidade', bloqueante: false },
  { tipo: 'quantidade', re: new RegExp(String.raw`${N}\s*${UNIDADE_QTD}`, 'giu'), unidade: () => 'unidade', bloqueante: false },
  { tipo: 'quantidade', re: new RegExp(String.raw`(?:m[íi]nimo|lote)\s+(?:de\s+)?${N}`, 'giu'), unidade: () => 'unidade', bloqueante: false },
]

/** A oração em volta de `inicio` (até 80 caracteres antes, sem cruzar ponto final). */
function oracaoAntes(texto: string, inicio: number, fim: number): string {
  const antes = texto.slice(Math.max(0, inicio - 80), inicio)
  const corte = Math.max(antes.lastIndexOf('.'), antes.lastIndexOf('!'), antes.lastIndexOf('?'), antes.lastIndexOf('\n'))
  const depois = texto.slice(fim, fim + 40).split(/[.!?\n]/)[0] ?? ''
  return `${antes.slice(corte + 1)} ${texto.slice(inicio, fim)} ${depois}`
}

/**
 * Os números de negócio citados num texto: percentual, quantidade, prazo em
 * dias e em horas. Ignora hora, data, telefone, CPF/CNPJ, CEP, nº de pedido,
 * SKU/referência e dinheiro (este é do guardrail de R$). Contrato público —
 * usado pelo pipeline (P7) e pela qualidade em produção (P12).
 */
export function extrairNumerosDeNegocio(texto: string): readonly NumeroDeNegocio[] {
  const mascarado = mascarar(texto)
  const out: NumeroDeNegocio[] = []
  const ocupados: Array<readonly [number, number]> = []
  for (const p of PADROES) {
    p.re.lastIndex = 0
    for (const m of mascarado.matchAll(p.re)) {
      const ini = m.index
      const fim = ini + m[0].length
      if (ocupados.some(([a, b]) => ini < b && fim > a)) continue
      const brutos = m.slice(1).filter((g): g is string => !!g)
      const valores = brutos.map((g) => (p.extenso ? numeroPorExtenso(g) : numeroBr(g))).filter((v) => Number.isFinite(v))
      // "um/uma" por extenso não conta em prazo nem quantidade (idiomático)
      if (valores.length === 0 || (p.extenso && p.tipo !== 'percentual' && valores.every((v) => v === 1))) continue
      ocupados.push([ini, fim])
      const trecho = texto.slice(ini, fim).trim()
      const bloqueante = p.bloqueante ?? COMPROMISSO.test(oracaoAntes(texto, ini, fim))
      for (const valor of valores) out.push({ tipo: p.tipo, valor, trecho, unidade: p.unidade(m as RegExpExecArray), bloqueante })
    }
  }
  return out
}

// ── fontes ───────────────────────────────────────────────────────────────────

/**
 * Todo número que um texto-FONTE mostra (política, trecho de conhecimento, fala
 * do cliente): permissivo de propósito — fonte a mais só afrouxa um pouco; fonte
 * a menos bloqueia resposta certa. Inclui por extenso (exceto "um/uma").
 */
export function numerosDoTexto(texto: string, acc: Set<number> = new Set()): Set<number> {
  for (const m of texto.matchAll(new RegExp(NUM, 'g'))) {
    const v = numeroBr(m[0])
    if (Number.isFinite(v)) acc.add(v)
    // "1.5" também pode ter sido escrito como milhar ambíguo: aceita as duas leituras
    for (const parte of m[0].split(/[.,]/)) if (parte) acc.add(Number(parte))
  }
  for (const m of texto.matchAll(new RegExp(X, 'giu'))) {
    const v = numeroPorExtenso(m[1]!)
    if (Number.isFinite(v) && v !== 1) acc.add(v)
  }
  return acc
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATA = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * Números de uma saída de ferramenta (estruturada): valores numéricos e números
 * dentro de textos. Pula `*Centavos` (dinheiro é do guardrail de R$), ids
 * (`*Id`, UUID), `seq` e datas ISO — dígitos de identificador não são fonte.
 */
export function numerosDeSaida(saida: unknown, acc: Set<number> = new Set(), prof = 0): Set<number> {
  if (prof > 8 || saida === null || saida === undefined) return acc
  if (typeof saida === 'number') { if (Number.isFinite(saida)) acc.add(saida); return acc }
  if (typeof saida === 'string') {
    if (!UUID.test(saida) && !ISO_DATA.test(saida)) numerosDoTexto(saida, acc)
    return acc
  }
  if (Array.isArray(saida)) { for (const x of saida) numerosDeSaida(x, acc, prof + 1); return acc }
  if (typeof saida === 'object') {
    for (const [k, v] of Object.entries(saida as Record<string, unknown>)) {
      if (/centavos$/i.test(k) || /(?:^id|Id|_id)$/.test(k) || k === 'seq') continue
      numerosDeSaida(v, acc, prof + 1)
    }
  }
  return acc
}

/** Tolerância: percentual aceita arredondamento de 0,05 p.p.; quantidade e prazo, exato. */
function confere(n: NumeroDeNegocio, fonte: number): boolean {
  if (n.tipo === 'percentual') return Math.abs(fonte - n.valor) <= 0.05 || Math.abs(fonte * 100 - n.valor) <= 0.05
  return Math.abs(fonte - n.valor) < 1e-9
}

export function temFonte(n: NumeroDeNegocio, fontes: Iterable<number>): boolean {
  for (const f of fontes) if (confere(n, f)) return true
  return false
}

/**
 * Os números de negócio do texto que NÃO têm fonte. ⚠️ Percentual só vale com
 * fonte GERAL (ferramenta, política, conhecimento, o que nós já dissemos):
 * "vocês dão 10%?" do cliente não autoriza "sim, 10%". Quantidade e prazo ditos
 * pelo cliente valem ("quero 10 peças para daqui 5 dias" pode ser repetido).
 */
export function numerosSemFonte(texto: string, fontes: FontesDeNumeros): readonly NumeroDeNegocio[] {
  const gerais = [...fontes.gerais]
  const doCliente = [...(fontes.doCliente ?? [])]
  return extrairNumerosDeNegocio(texto).filter((n) =>
    !temFonte(n, gerais) && (n.tipo === 'percentual' || !temFonte(n, doCliente)))
}
