import { ehFalhaDeProvedor } from './porta.js'

/**
 * ESTADO DO PROVEDOR DE IA NO PROCESSO (ADR-030, raia P5).
 *
 * Uma instância por processo (`estadoLlmDoProcesso`), somando TODAS as
 * conversas e tenants — a chave do fornecedor é uma só, então a saúde dela
 * também é. O `RoteadorLlm` (`llm-reserva.ts`) é quem escreve aqui; a saúde
 * detalhada (P8) lê por `estadoDoLlm()`.
 *
 *   • 2 falhas DE PROVEDOR seguidas de um principal → reserva por N min (alerta
 *     `llm_reserva_ativo`); vencida a janela, volta sozinho (`llm_reserva_encerrado`).
 *     Sucesso do principal zera a contagem. Erro de requisição/formato não conta.
 *     ⚠️ Contado POR PRINCIPAL (`fornecedor:modelo`): cada número pode ter
 *     escolhido um modelo no catálogo, e um fornecedor fora do ar não pode
 *     desviar quem usa outro.
 *   • `acesso_negado` num modelo → aquele modelo fica bloqueado por 1 h
 *     (alerta `modelo_bloqueado`); as chamadas seguintes vão direto ao `IA_MODELO`.
 *
 * ⚠️ Estado em MEMÓRIA, de propósito: restart volta ao principal — é o
 *    comportamento que se quer depois de um deploy que trocou a chave. Com
 *    mais de uma instância, cada uma decide pela própria experiência.
 * ⚠️ Os alertas daqui são de PROCESSO (sem tenant): vão para o log
 *    estruturado. O alerta por tenant (`agente_llm_indisponivel`, tabela
 *    `alerta`) é gravado pela política do turno (`pipeline/falha-llm.ts`).
 */
export interface EstadoDoLlm {
  /** 'reserva' se ALGUM principal está desviado para a reserva agora. */
  readonly situacao: 'principal' | 'reserva'
  /** Até quando a reserva fica ativa (a mais distante); null = nenhum desvio. */
  readonly reservaAteEm: Date | null
  /** Maior sequência de falhas de provedor entre os principais (zera no sucesso). */
  readonly falhasSeguidas: number
  readonly modelosBloqueados: readonly { readonly modelo: string; readonly ateEm: Date }[]
  /**
   * Cada principal visto no processo (`fornecedor:modelo`): o do ambiente e os
   * escolhidos no catálogo por número. ⚠️ A reserva é POR PRINCIPAL — o Groq
   * fora do ar desvia só os números que usam Groq; quem está no Claude segue.
   */
  readonly principais: readonly {
    readonly principal: string
    readonly reserva: string | null
    readonly situacao: 'principal' | 'reserva'
    readonly reservaAteEm: Date | null
    readonly falhasSeguidas: number
    readonly ativacoes: number
  }[]
  /** Última falha de provedor (principal ou reserva). Sem mensagem do fornecedor: só o motivo. */
  readonly ultimaFalha: { readonly em: Date; readonly principal: string; readonly motivo: string; readonly origem: 'principal' | 'reserva' } | null
}

/** Uma linha de log com `alerta=<codigo>` — nunca com chave, mensagem de cliente ou detalhe do fornecedor. */
export type LogAlertaLlm = (nivel: 'warn' | 'error', campos: Readonly<Record<string, unknown>>, mensagem: string) => void

/** Padrão: uma linha JSON no stderr (o Railway coleta; o pino do app não alcança este módulo). */
export const logAlertaNoStderr: LogAlertaLlm = (nivel, campos, mensagem) => {
  process.stderr.write(`${JSON.stringify({ nivel, contexto: 'agente.llm', ...campos, msg: mensagem, em: new Date().toISOString() })}\n`)
}

export const FALHAS_ATE_RESERVA = 2
export const JANELA_RESERVA_PADRAO_MS = 30 * 60_000
export const BLOQUEIO_MODELO_MS = 60 * 60_000
export const ALERTA_RESERVA_ATIVA = 'llm_reserva_ativo'
export const ALERTA_MODELO_BLOQUEADO = 'modelo_bloqueado'

export interface OpcoesEstadoLlm {
  /** Relógio (ms). Testes passam um falso. */
  readonly agora?: (() => number) | undefined
  readonly falhasParaAtivar?: number | undefined
  readonly bloqueioModeloMs?: number | undefined
  readonly log?: LogAlertaLlm | undefined
}

interface Trilha {
  reserva: string | null
  falhasSeguidas: number
  reservaAte: number | null
  ativacoes: number
}

export class EstadoLlmProcesso {
  readonly #agora: () => number
  readonly #falhasParaAtivar: number
  readonly #bloqueioMs: number
  readonly #log: LogAlertaLlm
  readonly #trilhas = new Map<string, Trilha>()
  #ultimaFalha: { em: number; principal: string; motivo: string; origem: 'principal' | 'reserva' } | null = null
  readonly #bloqueados = new Map<string, number>()

  constructor(opts: OpcoesEstadoLlm = {}) {
    this.#agora = opts.agora ?? Date.now
    this.#falhasParaAtivar = Math.max(1, opts.falhasParaAtivar ?? FALHAS_ATE_RESERVA)
    this.#bloqueioMs = opts.bloqueioModeloMs ?? BLOQUEIO_MODELO_MS
    this.#log = opts.log ?? logAlertaNoStderr
  }

  /** Lembra o principal e sua reserva (para a saúde e para o log). */
  conhecer(principal: string, reserva: string | null): void {
    const t = this.#trilha(principal)
    t.reserva = reserva
  }

  /** A reserva deste principal está ligada agora? Vencida a janela, desliga (e loga a volta). */
  reservaAtiva(principal: string): boolean {
    const t = this.#trilhas.get(principal)
    if (!t || t.reservaAte === null) return false
    if (this.#agora() < t.reservaAte) return true
    t.reservaAte = null
    t.falhasSeguidas = 0
    this.#log('warn', { alerta: 'llm_reserva_encerrado', principal }, 'Janela da reserva de IA venceu: voltando ao principal')
    return false
  }

  registrarSucessoPrincipal(principal: string): void {
    this.#trilha(principal).falhasSeguidas = 0
  }

  /**
   * Falha do PRINCIPAL. Só falha de provedor conta. Devolve `true` se ESTA
   * falha ligou a reserva agora (só liga havendo reserva configurada).
   */
  registrarFalhaPrincipal(principal: string, motivo: string, p: { readonly reserva: string | null; readonly janelaMs: number }): boolean {
    if (!ehFalhaDeProvedor(motivo)) return false
    // Primeiro vence a janela antiga (se venceu): a contagem recomeça dela.
    const jaAtiva = this.reservaAtiva(principal)
    const t = this.#trilha(principal)
    this.#ultimaFalha = { em: this.#agora(), principal, motivo, origem: 'principal' }
    t.falhasSeguidas += 1
    if (!p.reserva || jaAtiva || t.falhasSeguidas < this.#falhasParaAtivar) return false
    t.reservaAte = this.#agora() + p.janelaMs
    t.reserva = p.reserva
    t.ativacoes += 1
    this.#log('error', {
      alerta: ALERTA_RESERVA_ATIVA, principal, reserva: p.reserva, motivo,
      falhasSeguidas: t.falhasSeguidas, janelaMin: Math.round(p.janelaMs / 60_000), ate: new Date(t.reservaAte).toISOString(),
    }, 'Provedor principal de IA falhou seguidamente: usando a reserva')
    return true
  }

  registrarFalhaReserva(principal: string, motivo: string): void {
    if (!ehFalhaDeProvedor(motivo)) return
    const reserva = this.#trilhas.get(principal)?.reserva ?? null
    this.#ultimaFalha = { em: this.#agora(), principal, motivo, origem: 'reserva' }
    this.#log('error', { alerta: 'llm_reserva_falhou', principal, reserva, motivo }, 'A reserva de IA também falhou')
  }

  modeloBloqueado(modelo: string): boolean {
    const ate = this.#bloqueados.get(modelo)
    if (ate === undefined) return false
    if (ate <= this.#agora()) {
      this.#bloqueados.delete(modelo)
      return false
    }
    return true
  }

  /** Bloqueia `modelo` por 1 h; loga só quando o bloqueio é novo. */
  bloquearModelo(modelo: string, usaraNoLugar: string): void {
    const novo = !this.modeloBloqueado(modelo)
    this.#bloqueados.set(modelo, this.#agora() + this.#bloqueioMs)
    if (novo) {
      this.#log('warn', { alerta: ALERTA_MODELO_BLOQUEADO, modelo, fallback: usaraNoLugar, horas: this.#bloqueioMs / 3_600_000 },
        'O fornecedor negou acesso ao modelo: usando o modelo padrão')
    }
  }

  retrato(): EstadoDoLlm {
    for (const m of Array.from(this.#bloqueados.keys())) this.modeloBloqueado(m)
    const principais = [...this.#trilhas].map(([principal, t]) => {
      const ativa = this.reservaAtiva(principal)
      return {
        principal, reserva: t.reserva, situacao: ativa ? 'reserva' as const : 'principal' as const,
        reservaAteEm: ativa && t.reservaAte !== null ? new Date(t.reservaAte) : null,
        falhasSeguidas: t.falhasSeguidas, ativacoes: t.ativacoes,
      }
    })
    const ates = principais.flatMap((p) => (p.reservaAteEm ? [p.reservaAteEm.getTime()] : []))
    return {
      situacao: ates.length > 0 ? 'reserva' : 'principal',
      reservaAteEm: ates.length > 0 ? new Date(Math.max(...ates)) : null,
      falhasSeguidas: Math.max(0, ...principais.map((p) => p.falhasSeguidas)),
      modelosBloqueados: [...this.#bloqueados].map(([modelo, ate]) => ({ modelo, ateEm: new Date(ate) })),
      principais,
      ultimaFalha: this.#ultimaFalha ? { ...this.#ultimaFalha, em: new Date(this.#ultimaFalha.em) } : null,
    }
  }

  #trilha(principal: string): Trilha {
    let t = this.#trilhas.get(principal)
    if (!t) {
      // ⚠️ Teto de trilhas: o catálogo é pequeno, mas um nome de objeto nulo com
      //    texto variável não pode crescer o mapa sem limite num processo longo.
      if (this.#trilhas.size >= MAX_TRILHAS) {
        const maisAntiga = this.#trilhas.keys().next().value
        if (maisAntiga !== undefined) this.#trilhas.delete(maisAntiga)
      }
      t = { reserva: null, falhasSeguidas: 0, reservaAte: null, ativacoes: 0 }
      this.#trilhas.set(principal, t)
    }
    return t
  }
}

const MAX_TRILHAS = 100

/** O estado do processo — o único que a produção usa. */
export const estadoLlmDoProcesso = new EstadoLlmProcesso()

/**
 * Retrato do provedor de IA neste processo — CONTRATO da saúde detalhada (P8):
 * `situacao === 'reserva'` ou `modelosBloqueados.length > 0` ⇒ `degradado`.
 */
export function estadoDoLlm(): EstadoDoLlm {
  return estadoLlmDoProcesso.retrato()
}
