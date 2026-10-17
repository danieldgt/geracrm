import {
  avaliarRegrasQualidade, mascararTextoQualidade, numerosDeSaida, numerosDoTexto, percentuaisDeSaida, percentuaisDoTexto,
  perguntasJaRespondiveis, verificarNumerosNaResposta,
  type GravidadeQualidade, type ViolacaoQualidade,
} from '@geracrm/shared'

/**
 * TRANSCRIÇÃO OFFLINE (raia P15; playbook AM §7.5) — o formato que o
 * `agente:avaliar` lê e o que o juiz dos evals recebe. Puro, sem IO.
 *
 * Uma fala por linha, com prefixo:
 *   CLIENTE: (ou LEAD, USUÁRIO)        · AGENTE: (ou BOT, ASSISTENTE, IA)
 *   VENDEDOR: (ou HUMANO, ATENDENTE)   · TOOL: {json} (ou FERRAMENTA:) — saída de ferramenta,
 *                                        FONTE dos números das falas seguintes
 * Linha sem prefixo continua a fala anterior; linhas vazias, `#…` e `===` são ignoradas.
 * Aceita horário (`[10:02] AGENTE: …`) e emoji antes do prefixo.
 *
 * As regras são as MESMAS do pipeline em produção (`avaliarRegrasQualidade`,
 * P12) — avaliar offline e avaliar no turno dão o mesmo veredito. Sem nenhuma
 * linha TOOL, as regras de número não rodam (fontes desconhecidas): melhor
 * calar do que acusar número que veio de uma ferramenta que a transcrição não
 * mostra.
 */

export type AutorTranscricao = 'CLIENTE' | 'AGENTE' | 'VENDEDOR' | 'TOOL'

export interface FalaTranscrita {
  readonly autor: AutorTranscricao
  readonly texto: string
}

export interface Transcricao {
  readonly falas: readonly FalaTranscrita[]
}

const PREFIXO =
  /^\s*(?:\[[^\]]*\]\s*)?(?:[^\p{L}\p{N}\s[]+\s*)?(cliente|lead|usu[áa]rio|user|agente|bot|assistente|assistant|ia|vendedor(?:\s+humano)?|humano|atendente|tool|ferramenta)\s*(?:\([^)]*\))?\s*:\s?(.*)$/iu

function autorDe(p: string): AutorTranscricao {
  const k = p.toLowerCase()
  if (/^(cliente|lead|usu|user)/u.test(k)) return 'CLIENTE'
  if (/^(agente|bot|assist|ia$)/u.test(k)) return 'AGENTE'
  if (/^(tool|ferramenta)/u.test(k)) return 'TOOL'
  return 'VENDEDOR'
}

export function parseTranscricao(conteudo: string): Transcricao {
  const falas: FalaTranscrita[] = []
  let atual: { autor: AutorTranscricao; linhas: string[] } | null = null
  const fechar = () => {
    if (!atual) return
    const texto = atual.linhas.join('\n').trim()
    if (texto) falas.push({ autor: atual.autor, texto })
    atual = null
  }
  for (const linha of conteudo.split(/\r?\n/u)) {
    const t = linha.trim()
    if (!t || /^(?:#|===)/u.test(t)) continue
    const m = PREFIXO.exec(linha)
    if (m) {
      fechar()
      atual = { autor: autorDe(m[1]!), linhas: [m[2] ?? ''] }
    } else if (atual) atual.linhas.push(linha)
  }
  fechar()
  return { falas }
}

// ── fontes ──────────────────────────────────────────────────────────────────

function jsonOuTexto(texto: string): unknown {
  try { return JSON.parse(texto) } catch { return texto }
}

/** Centavos citados por uma saída de ferramenta: campos `*Centavos` e valores "R$ 12,34" em texto. */
function centavosDaSaida(saida: unknown, acc: Set<number>, chave = '', prof = 0): void {
  if (prof > 8 || saida === null || saida === undefined) return
  if (typeof saida === 'number') { if (/centavos$/i.test(chave) && Number.isInteger(saida)) acc.add(saida); return }
  if (typeof saida === 'string') {
    for (const m of saida.matchAll(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g)) {
      acc.add(Math.round(Number(m[1]!.replace(/\./g, '').replace(',', '.')) * 100))
    }
    return
  }
  if (Array.isArray(saida)) { for (const x of saida) centavosDaSaida(x, acc, chave, prof + 1); return }
  if (typeof saida === 'object') for (const [k, v] of Object.entries(saida as Record<string, unknown>)) centavosDaSaida(v, acc, k, prof + 1)
}

// ── avaliação ───────────────────────────────────────────────────────────────

export interface AvaliacaoDaFala {
  /** Índice da fala na transcrição (base 0). */
  readonly indice: number
  readonly texto: string
  readonly violacoes: readonly ViolacaoQualidade[]
}

export interface ResultadoTranscricao {
  readonly porFala: readonly AvaliacaoDaFala[]
  readonly totais: Readonly<Record<GravidadeQualidade, number>>
  readonly falasDoAgente: number
  /** Havia linha TOOL: as regras de número rodaram. */
  readonly comFontes: boolean
}

export interface OpcoesAvaliacao {
  /** Frases proibidas extras do número (`agente_config.compliance`). */
  readonly extras?: readonly string[] | undefined
  readonly maxCaracteres?: number | undefined
  /** Falas FIXAS do sistema que não são resposta do agente (abertura da P4): não são avaliadas. */
  readonly isentas?: readonly string[] | undefined
  /** Textos que valem como fonte de número desde o início (políticas da loja). */
  readonly fontesFixas?: readonly string[] | undefined
}

/**
 * Regras de qualidade (P12) em cada fala do AGENTE, com:
 *   - perguntas anteriores = as que o nosso lado fez ANTES de uma resposta do cliente;
 *   - fontes de número = saídas TOOL anteriores à fala, falas do VENDEDOR e as fontes fixas;
 *     o que o CLIENTE disse abona só número não bloqueante (mesma regra do P7);
 *   - R$ sem fonte em ferramenta = CRÍTICA (a mesma rede do pipeline, `verificarNumerosNaResposta`).
 */
export function avaliarTranscricao(t: Transcricao, o: OpcoesAvaliacao = {}): ResultadoTranscricao {
  const comFontes = t.falas.some((f) => f.autor === 'TOOL')
  const isentas = new Set((o.isentas ?? []).map((x) => x.trim()))
  const gerais = new Set<number>()
  const percentuais = new Set<number>()
  const doCliente = new Set<number>()
  const centavos = new Set<number>()
  for (const f of o.fontesFixas ?? []) { numerosDoTexto(f, gerais); percentuaisDoTexto(f, percentuais); centavosDaSaida(f, centavos) }
  const historico: { de: 'cliente' | 'nos'; texto: string }[] = []
  const porFala: AvaliacaoDaFala[] = []
  const totais: Record<GravidadeQualidade, number> = { CRITICA: 0, ALTA: 0, MEDIA: 0 }
  let falasDoAgente = 0

  t.falas.forEach((f, indice) => {
    if (f.autor === 'TOOL') {
      const saida = jsonOuTexto(f.texto)
      numerosDeSaida(saida, gerais)
      percentuaisDeSaida(saida, percentuais)
      centavosDaSaida(saida, centavos)
      return
    }
    if (f.autor === 'CLIENTE') {
      numerosDoTexto(f.texto, doCliente)
      historico.push({ de: 'cliente', texto: f.texto })
      return
    }
    if (f.autor === 'VENDEDOR') {
      // O vendedor humano é fonte (ele consultou o sistema) — a mesma regra do P7.
      numerosDoTexto(f.texto, gerais)
      percentuaisDoTexto(f.texto, percentuais)
      centavosDaSaida(f.texto, centavos)
      historico.push({ de: 'nos', texto: f.texto })
      return
    }
    falasDoAgente += 1
    if (!isentas.has(f.texto.trim())) {
      const violacoes: ViolacaoQualidade[] = [...avaliarRegrasQualidade({
        mensagens: [f.texto],
        extras: o.extras,
        maxCaracteres: o.maxCaracteres,
        perguntasAnteriores: perguntasJaRespondiveis(historico),
        fontes: comFontes ? { gerais, percentuais, doCliente } : null,
      })]
      if (comFontes) {
        for (const c of verificarNumerosNaResposta(f.texto, centavos)) {
          violacoes.push({
            regra: 'numero_sem_fonte', gravidade: 'CRITICA',
            trecho: mascararTextoQualidade(f.texto).slice(0, 160), detalhe: `R$ ${(c / 100).toFixed(2).replace('.', ',')} sem fonte`,
          })
        }
      }
      for (const v of violacoes) totais[v.gravidade] += 1
      porFala.push({ indice, texto: f.texto, violacoes })
    }
    historico.push({ de: 'nos', texto: f.texto })
  })
  return { porFala, totais, falasDoAgente, comFontes }
}

// ── formato para o juiz ─────────────────────────────────────────────────────

const ROTULO_JUIZ: Readonly<Record<AutorTranscricao, string>> = {
  CLIENTE: 'CLIENTE', AGENTE: 'AGENTE', VENDEDOR: 'VENDEDOR HUMANO', TOOL: 'FERRAMENTA',
}

/** Quanto de uma saída de ferramenta vai para o juiz (contexto para ele conferir a origem dos números). */
const MAX_FERRAMENTA_JUIZ = 600

/**
 * A transcrição no formato do juiz da P12 (`CLIENTE:`/`AGENTE:`/`VENDEDOR HUMANO:`),
 * MASCARADA, com as saídas de ferramenta resumidas como `FERRAMENTA:` (contexto:
 * o juiz confere se o número citado veio dali). Falas isentas (abertura fixa)
 * ficam de fora — o juiz julga a resposta do agente, não o texto do sistema.
 */
export function formatarParaJuiz(t: Transcricao, o: { isentas?: readonly string[] | undefined } = {}): string {
  const isentas = new Set((o.isentas ?? []).map((x) => x.trim()))
  return t.falas
    .filter((f) => !(f.autor === 'AGENTE' && isentas.has(f.texto.trim())))
    .map((f) => {
      const texto = f.texto.replace(/\s+/g, ' ').trim()
      const corpo = f.autor === 'TOOL' && texto.length > MAX_FERRAMENTA_JUIZ ? `${texto.slice(0, MAX_FERRAMENTA_JUIZ)}…` : texto
      return `${ROTULO_JUIZ[f.autor]}: ${mascararTextoQualidade(corpo)}`
    })
    .join('\n')
}
