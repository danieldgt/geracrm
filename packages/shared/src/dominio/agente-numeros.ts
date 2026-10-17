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
 *   "10 %" e "10%" valem igual; "por cento" e "10 pct de desconto" também;
 *   "metade do preço" (ou "pela metade" com preço/valor/desconto) é 50%.
 * - Por extenso: "dez por cento", "dois dias úteis", "vinte unidades", "mil
 *   unidades" — de dois a noventa e nove, "cem" e "mil". "um/uma" por extenso
 *   NÃO conta em prazo ("um dia desses") nem em quantidade.
 * - O que NÃO é número de negócio (mascarado antes de extrair, sempre como
 *   palavra inteira): hora ("14h", "14:30", "às 9", "das 8 às 18h"), data
 *   ("12/10", "dia 15", "15 de outubro"), telefone, CPF, CNPJ, CEP (≥ 8 dígitos
 *   com separadores), nº de pedido / nota / protocolo ("pedido 1234", "nº 1234",
 *   "#1234" — nunca quando seguido de %), SKU e referência ("CAM-001", "ref.
 *   4455", "AB123"). Dinheiro (R$, "reais") fica com o guardrail de R$.
 *   "30/60/90 dias" é prazo, não data.
 * - "N semanas"/"N meses" entram como prazo_dias com o valor COMO ESCRITO
 *   (a unidade vai em `unidade`; a fonte é comparada pelo número escrito).
 *   "Nx" (parcelas) NÃO é extraído — fora do contrato desta raia.
 * - Grade (cor × tamanho): "Tamanho 42", "Numeração 40", "Tamanhos 38, 40 e 42"
 *   são atributo, mascarados; os valores de `atributos` das ferramentas são fonte
 *   de quantidade ("Temos o 42 em estoque"), nunca de percentual.
 * - Bloqueante (`bloqueante: true`, gravidade CRITICA): TODO percentual, por
 *   padrão (ADR-029). A exceção é uma lista FECHADA de usos que não são negócio,
 *   mascarados: "100% original/garantido/à disposição/natural…", composição
 *   ("95% algodão", "Algodão 100%", "5% elastano") e "N% de umidade/álcool";
 *   quantidade afirmada como disponibilidade ("temos 12 unidades", "12 em
 *   estoque", "saldo de 12", "restam 3"); prazo num contexto de compromisso
 *   (entrega, envio, chegada, recebimento, saída, prazo, pagamento, boleto,
 *   faturamento, produção). Os demais sem fonte são ALTA (a mensagem sai).
 * - Fontes TIPADAS: percentual só se confere contra percentuais de fonte
 *   (número com %/"por cento" num texto-fonte, ou campo explicitamente
 *   percentual numa ferramenta) — nunca contra um número qualquer ("CAM-010" não
 *   abona "10%"). Quantidade e prazo, contra o conjunto geral. O cliente só abona
 *   número NÃO bloqueante: "vocês têm 500?" não autoriza "temos 500".
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
  /**
   * A oração repete o desejo do cliente ("você precisa receber em 10 dias") ou
   * ressalva verificação ("vou confirmar se dá"), sem afirmação nossa no
   * indicativo ("entregamos", "vai receber"). Com o número dito pelo cliente,
   * rebaixa para ALTA.
   */
  readonly ecoDoCliente: boolean
}

/** As fontes de um turno, separadas por tipo. */
export interface FontesDeNumeros {
  /** Quantidade e prazo: ferramentas, políticas, conhecimento, vendedor humano. */
  readonly gerais: Iterable<number>
  /** Percentual: SÓ números escritos com % (ou campo percentual de ferramenta). */
  readonly percentuais?: Iterable<number> | undefined
  /** O que o próprio cliente escreveu: abona só número NÃO bloqueante. */
  readonly doCliente?: Iterable<number> | undefined
}

/**
 * O conjunto de números vistos em ferramenta num turno: o próprio Set (geral,
 * para quantidade e prazo) carrega à parte os percentuais. É um Set para caber
 * em `EntradaPosResposta.numerosVistos` sem mudar o contrato da P0.
 */
export class NumerosVistos extends Set<number> {
  readonly percentuais = new Set<number>()
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
  dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, cem: 100, mil: 1000,
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
/** Início de palavra (Unicode): `\b` do JS não entende acento. */
const P = String.raw`(?<![\p{L}\d])`
const FIM = String.raw`(?![\p{L}\d])`
const UNIDADE_QTD = String.raw`(?:unidades?|un\.?|und\.?|pe[çc]as?|p[çc]s?|pares|caixas?|cx\.?|itens|kits?|fardos?|d[úu]zias?|pacotes?|pct\.?|pcts|rolos?|sacos?|metros?|kg|quilos?|litros?|frascos?|latas?|garrafas?)(?!${L})`
/** Fibras e composições: "95% algodão", "Algodão 100%" descrevem o produto, não negócio. */
const FIBRA = String.raw`(?:algod[ãa]o|poli[ée]ster|elastano|viscose|linho|l[ãa]|seda|nylon|n[áa]ilon|poliamida|acr[íi]lico|couro|modal|lycra|spandex|cashmere|bambu)`
/**
 * Lista FECHADA de usos de % que não são negócio (ADR-029: % bloqueia por
 * padrão; a exceção é que se enumera, nunca o contrário).
 */
const PCT_NAO_NEGOCIO = String.raw`(?:original|originais|garantid[oa]s?|segur[oa]s?|certeza|cert[oa]s?|[àa]\s+(?:sua\s+)?disposi[çc][ãa]o|satisfeit[oa]s?|natural|naturais|nacional|nacionais|aut[êe]ntic[oa]s?|leg[íi]tim[oa]s?|pur[oa]s?|confi[áa]ve(?:l|is)|recicl[áa]ve(?:l|is)|reciclad[oa]s?|${FIBRA})`
const MESES = 'janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'
const IGNORAR: readonly RegExp[] = [
  // telefone, CPF, CNPJ, CEP, nº longo: ≥ 8 dígitos com separadores no meio
  /\+?\d(?:[\d()./\s-]*\d){7,}/g,
  // data dd/mm(/aaaa) — mas "30/60/90 dias" é prazo
  /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/])(?!\s*dias?(?![\p{L}]))/gu,
  // hora: 14:30, 14h30
  /(?<!\d)\d{1,2}(?::|h)\d{2}(?!\d)/giu,
  // "às 9", "a partir das 8" — crase/locução é hora
  new RegExp(String.raw`${P}(?:às|dàs|a\s+partir\s+das|depois\s+das|antes\s+das|após\s+as|até\s+às)\s+\d{1,2}(?:\s*(?:h|hs|horas?)${FIM})?${FIM}`, 'giu'),
  // "as/das N" só é hora com h/hs/horas depois ("das 18h", "as 9 horas")
  new RegExp(String.raw`${P}(?:as|das|até\s+as|ate\s+as)\s+\d{1,2}\s*(?:h|hs|horas?)${FIM}`, 'giu'),
  // verbo de horário + "das N" ("atendemos das 8", "abrimos as 9")
  new RegExp(String.raw`${P}(?:abr|fech|atend|funcion|expedient|hor[áa]ri)${L}*\s+(?:a\s+partir\s+)?d?as\s+\d{1,2}(?:\s*(?:h|hs|horas?))?${FIM}`, 'giu'),
  // "até 18h" sem "em" antes = hora do dia
  new RegExp(String.raw`(?<!${P}em\s)${P}até\s+\d{1,2}\s*(?:h|hs)${FIM}`, 'giu'),
  // data por extenso: "dia 15", "15 de outubro"
  new RegExp(String.raw`${P}dia\s+\d{1,2}${FIM}`, 'giu'),
  new RegExp(String.raw`${P}\d{1,2}\s+de\s+(?:${MESES})${FIM}`, 'giu'),
  // nº de pedido, nota, protocolo, referência, SKU, código — nunca seguido de %
  new RegExp(String.raw`(?:${P}(?:pedido|nota|nf-?e?|protocolo|ref\.?|referência|referencia|sku|código|codigo|cód\.?|cod\.?|número|numero|n[º°]\.?)|#)(?!${L})\s*(?:n[º°]\.?\s*)?[:#]?\s*[\p{L}\d_-]*\d[\p{L}\d_-]*(?![\p{L}\d_-])(?!\s*(?:%|por\s*cento))`, 'giu'),
  // grade: "Tamanho 42", "Tamanhos 38, 40 e 42", "Numeração 40", "tam. 44" — atributo, não quantidade
  new RegExp(String.raw`${P}(?:tamanhos?|numera[çc](?:ão|ao|ões|oes)|tam\.|n[úu]meros?)\s*:?\s*(?:(?:o|a|os|as|do|da)\s+)?\d+(?!\d|\s*${UNIDADE_QTD})(?:\s*(?:,|e|ou|/|a|-)\s*\d+(?!\d|\s*${UNIDADE_QTD}))*${FIM}`, 'giu'),
  // token alfanumérico com letra antes do dígito: CAM-001, AB123, V2
  new RegExp(String.raw`(?<![\p{L}\d])${L}+[-_]?\d[\p{L}\d_-]*`, 'gu'),
  // % que não é negócio (lista fechada): "100% original", "95% algodão", "Algodão 100%", "12% de umidade"
  new RegExp(String.raw`${P}100\s*%\s+(?:de\s+)?${PCT_NAO_NEGOCIO}${FIM}`, 'giu'),
  new RegExp(String.raw`${P}\d+(?:[.,]\d+)?\s*%\s+(?:de\s+)?(?:${FIBRA}|umidade|[áa]lcool|cacau|gordura|prote[íi]na)${FIM}`, 'giu'),
  new RegExp(String.raw`${P}${FIBRA}\s+\d+(?:[.,]\d+)?\s*%`, 'giu'),
  // dinheiro: fica com o guardrail de R$
  /R\$\s*\d[\d.,]*/g,
  new RegExp(String.raw`\d[\d.,]*\s*(?:reais|real)${FIM}`, 'giu'),
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
/** Número em dígitos OU por extenso, num grupo só (o parse decide). */
const NX = String.raw`(?:${ANTES}(${NUM})${DEPOIS}|(?<!${L})(${EXTENSO})(?!${L}))`
/** Lista/intervalo: "3 a 5", "30/60/90", "30, 60 e 90" — todos os números do grupo contam. */
const LISTA = String.raw`${ANTES}((?:${NUM})(?:\s*(?:/|,|e|ou|a|até|ate|-|–)\s*(?:${NUM}))+)${DEPOIS}`

const VERBO_ESTOQUE = String.raw`${P}(?:temos|tenho|restam|restaram|resta|sobraram|sobrou|possu[íi]mos|dispomos\s+de|contamos\s+com)\s+(?:(?:apenas|s[óo]|somente|mais|ainda|exatamente|cerca\s+de|as|os)\s+)*`
const DISPONIVEL = String.raw`(?:em\s+estoque|no\s+estoque|dispon[íi]ve(?:l|is)|[àa]\s+pronta\s+entrega|pronta\s+entrega)`
/** O cliente quer/precisa (eco) ou nós vamos verificar (ressalva)… */
const ECO_DESEJO = /(?<!\p{L})(?:voc[êe]|vc)\s+(?:\p{L}+\s+)?(?:precisa|quer|queria|gostaria|pediu|prefere|deseja|necessita)(?!\p{L})/iu
const ECO_RESSALVA = /(?<!\p{L})(?:(?:verificar|confirmar|consultar)\s+se|ver\s+se\s+d[áa])(?!\p{L})/iu
/**
 * …desde que a MENSAGEM inteira (não só a oração; "?" não corta) não tenha
 * afirmação nossa no indicativo, verbo nosso em 1ª pessoa nem resposta
 * afirmativa — "Você quer em 2 dias? Combinado!" é compromisso.
 */
const NOSSO_INDICATIVO = /(?<!\p{L})(?:(?:vai|vão|vao|vamos|iremos|ir[áa])\s+(?:receber|chegar|sair|entregar|enviar|despachar|postar|faturar)|recebe|recebem|chega|chegam|sai|saem|entregamos|entrega|entregam|enviamos|envia|despachamos|garantimos|garanto|garante|postamos|faturamos|consigo|conseguimos|d[áa]\s+sim|fechado|combinado|pode\s+deixar|sem\s+problemas?|garantido|envio|separo|despacho|mando|sim|ok)(?!\p{L})/iu
const COMPROMISSO = /(?<!\p{L})(entreg|cheg|envi|despach|post|frete|prazo|pag|boleto|venc|fatur|produ[zçc]|separ|libera|retir|pront|transport|coleta|receb|sai(?!\p{L})|saem|sair)/iu

interface Padrao {
  readonly tipo: TipoNumeroDeNegocio
  readonly re: RegExp
  readonly unidade: (m: RegExpExecArray) => UnidadeNumeroDeNegocio
  /** Bloqueante por construção do padrão (null = decide pelo contexto). */
  readonly bloqueante: boolean | null
  /** Contexto que torna o número bloqueante (padrão: compromisso de prazo). */
  readonly contexto?: RegExp
  /** Sem `contexto` na oração o trecho nem é número de negócio ("pela metade do caminho"). */
  readonly exigeContexto?: boolean
  /** Valor fixo (ex.: "metade do preço" = 50). */
  readonly valorFixo?: number
}

const unidadeDePrazo = (m: RegExpExecArray): UnidadeNumeroDeNegocio => {
  const u = (m[0].match(/(dias?|semanas?|m[eê]s(?:es)?|horas?|hs?)\s*(?:[úu]teis|corridos)?\s*$/iu)?.[1] ?? 'dia').toLowerCase()
  if (u.startsWith('sem')) return 'semana'
  if (u.startsWith('m')) return 'mes'
  if (u.startsWith('h')) return 'hora'
  return 'dia'
}
const PRAZO_DIAS = String.raw`(?:dias?|semanas?|m[eê]s(?:es)?)(?:\s+(?:[úu]teis|corridos))?(?!${L})`
const ESTOQUE: Omit<Padrao, 're'> = { tipo: 'quantidade', unidade: () => 'unidade', bloqueante: true }
const re = (s: string) => new RegExp(s, 'giu')

// ⚠️ A ordem importa: o primeiro padrão que cobre um trecho fica com ele.
const PADROES: readonly Padrao[] = [
  { tipo: 'percentual', re: re(String.raw`${NX}\s*(?:%|por\s*cento(?!${L}))`), unidade: () => '%', bloqueante: true },
  { tipo: 'percentual', re: re(String.raw`${NX}\s*pcts?\.?(?=\s+(?:de\s+desconto|off|de\s+abatimento)(?!${L}))`), unidade: () => '%', bloqueante: true },
  { tipo: 'percentual', re: re(String.raw`${P}metade\s+do\s+(?:pre[çc]o|valor)${FIM}`), unidade: () => '%', bloqueante: true, valorFixo: 50 },
  { tipo: 'percentual', re: re(String.raw`${P}pela\s+metade${FIM}`), unidade: () => '%', bloqueante: true, valorFixo: 50, contexto: /(?<!\p{L})(pre[çc]o|valor|desconto)/iu, exigeContexto: true },
  // quantidade afirmada como disponibilidade
  { ...ESTOQUE, re: re(String.raw`${VERBO_ESTOQUE}${NX}\s+${UNIDADE_QTD}`) },
  { ...ESTOQUE, re: re(String.raw`${VERBO_ESTOQUE}${N}(?:\s+(?:de\s+\S+\s+)?${DISPONIVEL})?(?=\s*(?:[.,;!?)]|$|${DISPONIVEL}))`) },
  { ...ESTOQUE, re: re(String.raw`${NX}(?:\s+${UNIDADE_QTD})?\s+${DISPONIVEL}`) },
  { ...ESTOQUE, re: re(String.raw`${P}(?:estoque|saldo)\s+(?:atual\s+)?(?:de|é\s+de|:)?\s*${N}`) },
  // prazos (lista primeiro: "3 a 5 dias úteis", "30/60/90 dias", "30, 60 e 90 dias")
  { tipo: 'prazo_dias', re: re(String.raw`${LISTA}\s*${PRAZO_DIAS}`), unidade: unidadeDePrazo, bloqueante: null },
  { tipo: 'prazo_dias', re: re(String.raw`${NX}\s*${PRAZO_DIAS}`), unidade: unidadeDePrazo, bloqueante: null },
  { tipo: 'prazo_horas', re: re(String.raw`${LISTA}\s*(?:horas?|hs?)(?!${L})`), unidade: () => 'hora', bloqueante: null },
  { tipo: 'prazo_horas', re: re(String.raw`${NX}\s*horas?(?!${L})`), unidade: () => 'hora', bloqueante: null },
  // "48h" abreviado só com cara de prazo ("em 48h", "dentro de 24h") ou > 24
  { tipo: 'prazo_horas', re: re(String.raw`(?:(?<=(?:${P}em|${P}em\s+até|${P}dentro\s+de|${P}prazo\s+de|${P}após|${P}apos|${P}próximas|${P}proximas)\s+)${N}|${ANTES}(\d{3,}|2[5-9]|[3-9]\d)${DEPOIS})\s*hs?(?!${L})`), unidade: () => 'hora', bloqueante: null },
  // quantidade com unidade, sem afirmação de estoque
  { tipo: 'quantidade', re: re(String.raw`${LISTA}\s+${UNIDADE_QTD}`), unidade: () => 'unidade', bloqueante: false },
  { tipo: 'quantidade', re: re(String.raw`${NX}\s*${UNIDADE_QTD}`), unidade: () => 'unidade', bloqueante: false },
  { tipo: 'quantidade', re: re(String.raw`${P}(?:m[íi]nimo|lote)\s+(?:de\s+)?${N}`), unidade: () => 'unidade', bloqueante: false },
]

/** A oração em volta do trecho (até 80 caracteres antes, 40 depois, sem cruzar ponto final). */
function oracaoEmVolta(texto: string, inicio: number, fim: number): string {
  const antes = texto.slice(Math.max(0, inicio - 80), inicio)
  const corte = Math.max(antes.lastIndexOf('.'), antes.lastIndexOf('!'), antes.lastIndexOf('?'), antes.lastIndexOf('\n'))
  const depois = texto.slice(fim, fim + 40).split(/[.!?\n]/)[0] ?? ''
  return `${antes.slice(corte + 1)} ${texto.slice(inicio, fim)} ${depois}`
}

/** Valores de um grupo capturado: lista ("30/60/90"), dígitos ou extenso. */
function valoresDoGrupo(g: string): number[] {
  if (/\d/.test(g)) return [...g.matchAll(new RegExp(NUM, 'g'))].map((m) => numeroBr(m[0]))
  return [numeroPorExtenso(g)]
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
      const grupos = m.slice(1).filter((g): g is string => !!g)
      const porExtenso = grupos.length > 0 && grupos.every((g) => !/\d/.test(g))
      const valores = p.valorFixo !== undefined ? [p.valorFixo] : grupos.flatMap(valoresDoGrupo).filter((v) => Number.isFinite(v))
      // "um/uma" por extenso não conta em prazo nem quantidade (idiomático)
      if (valores.length === 0 || (porExtenso && p.tipo !== 'percentual' && valores.every((v) => v === 1))) continue
      ocupados.push([ini, fim])
      const trecho = texto.slice(ini, fim).trim()
      const oracao = oracaoEmVolta(texto, ini, fim)
      const noContexto = (p.contexto ?? COMPROMISSO).test(oracao)
      if (p.exigeContexto && !noContexto) { ocupados.pop(); continue }
      // Prazo também é compromisso quando a mensagem traz afirmação nossa ("…e consigo te atender").
      const bloqueante = p.bloqueante ?? (noContexto || (!p.contexto && NOSSO_INDICATIVO.test(texto)))
      const ecoDoCliente = (ECO_DESEJO.test(oracao) || ECO_RESSALVA.test(oracao)) && !NOSSO_INDICATIVO.test(texto)
      for (const valor of valores) out.push({ tipo: p.tipo, valor, trecho, unidade: p.unidade(m as RegExpExecArray), bloqueante, ecoDoCliente })
    }
  }
  return out
}

// ── fontes ───────────────────────────────────────────────────────────────────

/**
 * Números de um texto-FONTE para quantidade e prazo (política, trecho de
 * conhecimento, fala do vendedor ou do cliente). Lê cada número inteiro como
 * escrito — "99,80" é 99.8, nunca 99 e 80. Inclui por extenso (exceto "um/uma").
 */
export function numerosDoTexto(texto: string, acc: Set<number> = new Set()): Set<number> {
  for (const m of texto.matchAll(new RegExp(NUM, 'g'))) {
    const v = numeroBr(m[0])
    if (Number.isFinite(v)) acc.add(v)
  }
  for (const m of texto.matchAll(new RegExp(X, 'giu'))) {
    const v = numeroPorExtenso(m[1]!)
    if (Number.isFinite(v) && v !== 1) acc.add(v)
  }
  return acc
}

/** Percentuais de um texto-FONTE: só número escrito com "%"/"por cento" (ou "metade do preço"). */
export function percentuaisDoTexto(texto: string, acc: Set<number> = new Set()): Set<number> {
  for (const n of extrairNumerosDeNegocio(texto)) if (n.tipo === 'percentual') acc.add(n.valor)
  return acc
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATA = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/
/** Chaves cujo valor numérico É um percentual. */
const CHAVE_PERCENTUAL = /(?:percentual|porcentagem|percentagem|percent|pct)$/i
/** Chaves que nunca são fonte: dinheiro, identificador, ordem e referência. */
const CHAVE_IGNORADA = /(?:centavos$|^id$|Id$|_id$|^seq$|^referencia$|^ref$|^sku$|^codigo$)/i
/**
 * Para PERCENTUAL, também os atributos da grade: "tamanho 10" nunca abona "10%".
 * (Para quantidade/prazo os atributos voltam a valer: "Temos o 42 em estoque".)
 */
const CHAVE_IGNORADA_PCT = /(?:centavos$|^id$|Id$|_id$|^seq$|^referencia$|^ref$|^sku$|^codigo$|^atributos$)/i

/**
 * Números de uma saída de ferramenta para quantidade e prazo: valores numéricos
 * e números dentro de textos. Pula `*Centavos` (dinheiro é do guardrail de R$),
 * ids (`*Id`, UUID), `seq`, referência/atributos e datas ISO.
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
      if (CHAVE_IGNORADA.test(k)) continue
      numerosDeSaida(v, acc, prof + 1)
    }
  }
  return acc
}

/**
 * Percentuais de uma saída de ferramenta: campo numérico com nome percentual
 * (`descontoPercentual`, `pct`) ou "N%" escrito num texto. Nunca um número solto.
 */
export function percentuaisDeSaida(saida: unknown, acc: Set<number> = new Set(), prof = 0, chave = ''): Set<number> {
  if (prof > 8 || saida === null || saida === undefined) return acc
  if (typeof saida === 'number') { if (Number.isFinite(saida) && CHAVE_PERCENTUAL.test(chave)) acc.add(saida); return acc }
  if (typeof saida === 'string') { if (!CHAVE_IGNORADA_PCT.test(chave)) percentuaisDoTexto(saida, acc); return acc }
  if (Array.isArray(saida)) { for (const x of saida) percentuaisDeSaida(x, acc, prof + 1, chave); return acc }
  if (typeof saida === 'object') {
    for (const [k, v] of Object.entries(saida as Record<string, unknown>)) {
      if (CHAVE_IGNORADA_PCT.test(k)) continue
      percentuaisDeSaida(v, acc, prof + 1, k)
    }
  }
  return acc
}

/** Tolerância: percentual aceita arredondamento de 0,05 p.p.; quantidade e prazo, exato. */
function confere(n: NumeroDeNegocio, fonte: number): boolean {
  if (n.tipo === 'percentual') return Math.abs(fonte - n.valor) <= 0.05
  return Math.abs(fonte - n.valor) < 1e-9
}

export function temFonte(n: NumeroDeNegocio, fontes: Iterable<number>): boolean {
  for (const f of fontes) if (confere(n, f)) return true
  return false
}

/**
 * Os números de negócio do texto que NÃO têm fonte.
 * - Percentual: só contra `percentuais` (nunca contra um número qualquer).
 * - Quantidade e prazo: contra `gerais`.
 * - `doCliente` abona só número NÃO bloqueante: "quero 50 peças" pode ser
 *   repetido; "vocês têm 500?" não autoriza "temos 500 em estoque".
 * - Bloqueante que é ECO do cliente (`ecoDoCliente`) com o número que ele disse
 *   desce para ALTA: "anotei que você precisa receber em 10 dias" sai marcado;
 *   "você vai receber em 10 dias" continua barrado.
 */
export function numerosSemFonte(texto: string, fontes: FontesDeNumeros): readonly NumeroDeNegocio[] {
  const gerais = [...fontes.gerais]
  const percentuais = [...(fontes.percentuais ?? [])]
  const doCliente = [...(fontes.doCliente ?? [])]
  const out: NumeroDeNegocio[] = []
  for (const n of extrairNumerosDeNegocio(texto)) {
    if (n.tipo === 'percentual') { if (!temFonte(n, percentuais)) out.push(n); continue }
    if (temFonte(n, gerais)) continue
    const disse = temFonte(n, doCliente)
    if (!n.bloqueante) { if (!disse) out.push(n); continue }
    out.push(disse && n.ecoDoCliente ? { ...n, bloqueante: false } : n)
  }
  return out
}
