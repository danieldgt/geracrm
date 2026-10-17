import type { CapacidadesLlmFerramentas, PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco, RastroDoLaco } from './porta-llm.js'
import { estadoLlmDoProcesso, JANELA_RESERVA_PADRAO_MS, type EstadoLlmProcesso } from './llm-estado.js'

/**
 * ROTEADOR DE PROVEDOR (ADR-030, raia P5) — o mesmo `PortaLlmFerramentas`, por
 * fora; por dentro, três lados:
 *
 *   principal  o modelo escolhido (catálogo do número ou `IA_MODELO`)
 *   padrao     o `IA_MODELO` do ambiente — para onde vai quem levou 403/404
 *   reserva    `IA_RESERVA_PROVEDOR` + `IA_RESERVA_MODELO` — para quando o
 *              fornecedor principal cai
 *
 * Regras (porta do playbook da AM §8.3, adaptadas ao laço com ferramentas):
 *  1. `acesso_negado` no principal → o modelo fica bloqueado por 1 h e a MESMA
 *     chamada é refeita no padrão (se nenhuma ferramenta rodou); as próximas vão
 *     direto ao padrão.
 *  2. 2 falhas DE PROVEDOR seguidas DESTE principal no processo → reserva por
 *     `IA_RESERVA_JANELA_MIN` (30). A chamada que ligou a reserva é refeita
 *     nela SÓ se nenhuma ferramenta rodou: ⚠️ o laço pode ter alterado o pedido
 *     ou enviado proposta — efeito colateral em dobro é pior que um handoff.
 *     Nesse caso a falha volta ao turno, que aplica a política (`pipeline/falha-llm.ts`).
 *  3. Com a reserva ativa, tudo vai para ela até a janela vencer.
 *  4. Sem reserva configurada: só conta as falhas (aparece na saúde) e repassa.
 *
 * `rastro.provedor` diz quem respondeu de fato — o custo é calculado por ele.
 */

/** Um lado do roteador: a porta e o modelo que ela usa (para bloqueio e log). */
export interface LadoLlm {
  readonly porta: PortaLlmFerramentas
  readonly modelo: string
}

export interface OpcoesRoteadorLlm {
  readonly principal: LadoLlm
  /** O `IA_MODELO` do ambiente. Ausente ou igual ao principal = sem fallback de modelo. */
  readonly padrao?: LadoLlm | undefined
  readonly reserva?: LadoLlm | undefined
  readonly janelaMs?: number | undefined
  /** Estado compartilhado. Produção: o do processo; testes: um com relógio falso. */
  readonly estado?: EstadoLlmProcesso | undefined
}

export class RoteadorLlm implements PortaLlmFerramentas {
  readonly nome: string
  readonly capacidades: CapacidadesLlmFerramentas
  readonly #principal: LadoLlm
  readonly #padrao: LadoLlm | null
  readonly #reserva: LadoLlm | null
  readonly #janelaMs: number
  readonly #estado: EstadoLlmProcesso

  constructor(o: OpcoesRoteadorLlm) {
    this.#principal = o.principal
    this.#padrao = o.padrao && chave(o.padrao) !== chave(o.principal) ? o.padrao : null
    this.#reserva = o.reserva ?? null
    this.#janelaMs = o.janelaMs ?? JANELA_RESERVA_PADRAO_MS
    this.#estado = o.estado ?? estadoLlmDoProcesso
    this.nome = o.principal.porta.nome
    this.capacidades = o.principal.porta.capacidades
    this.#estado.conhecer(chave(o.principal), this.#reserva ? chave(this.#reserva) : null)
  }

  get #id(): string {
    return chave(this.#principal)
  }

  get reservaConfigurada(): boolean {
    return this.#reserva !== null
  }

  async rodar(pedido: PedidoDeLaco): Promise<ResultadoLaco> {
    if (this.#reserva && this.#estado.reservaAtiva(this.#id)) return this.#naReserva(pedido, null)

    const r = await this.#noPrincipal(pedido)
    if (r.ok) {
      this.#estado.registrarSucessoPrincipal(this.#id)
      return r
    }
    this.#estado.registrarFalhaPrincipal(this.#id, r.motivo, { reserva: this.#reserva ? chave(this.#reserva) : null, janelaMs: this.#janelaMs })
    // Ligou agora (ou outra conversa ligou enquanto esta esperava): refaz na reserva se for seguro.
    if (this.#reserva && this.#estado.reservaAtiva(this.#id) && !rodouFerramenta(r)) return this.#naReserva(pedido, r)
    return r
  }

  /** Principal, com o desvio de modelo bloqueado (403/404) para o padrão. */
  async #noPrincipal(pedido: PedidoDeLaco): Promise<ResultadoLaco> {
    const padrao = this.#padrao
    if (padrao && this.#estado.modeloBloqueado(chave(this.#principal))) return comProvedor(await padrao.porta.rodar(pedido), padrao.porta.nome)
    const r = comProvedor(await this.#principal.porta.rodar(pedido), this.#principal.porta.nome)
    if (r.ok || r.motivo !== 'acesso_negado' || !padrao) return r
    this.#estado.bloquearModelo(chave(this.#principal), chave(padrao))
    if (rodouFerramenta(r)) return r
    return somarAntes(comProvedor(await padrao.porta.rodar(pedido), padrao.porta.nome), r)
  }

  async #naReserva(pedido: PedidoDeLaco, falhaAnterior: ResultadoLaco | null): Promise<ResultadoLaco> {
    const reserva = this.#reserva!
    const r = comProvedor(await reserva.porta.rodar(pedido), reserva.porta.nome)
    if (!r.ok) this.#estado.registrarFalhaReserva(this.#id, r.motivo)
    return falhaAnterior ? somarAntes(r, falhaAnterior) : r
  }
}

/** Identidade de um lado para bloqueio/log: `fornecedor:modelo`. */
function chave(l: LadoLlm): string {
  return `${l.porta.nome}:${l.modelo}`
}

function rodouFerramenta(r: ResultadoLaco): boolean {
  return (r.rastro?.chamadas.length ?? 0) > 0
}

/** Marca no rastro o fornecedor que respondeu (o roteador sabe; o adaptador não). */
function comProvedor(r: ResultadoLaco, provedor: string): ResultadoLaco {
  if (!r.rastro || r.rastro.provedor) return r
  const rastro: RastroDoLaco = { ...r.rastro, provedor }
  return r.ok ? { ...r, rastro } : { ...r, rastro }
}

/**
 * A tentativa que falhou também gastou tokens e tempo: soma no rastro da que
 * veio depois — o custo do turno não pode esconder a tentativa perdida.
 */
function somarAntes(depois: ResultadoLaco, antes: ResultadoLaco): ResultadoLaco {
  const a = antes.rastro
  if (!a || !depois.rastro) return depois
  const d = depois.rastro
  const rastro: RastroDoLaco = {
    ...d,
    uso: {
      entrada: d.uso.entrada + a.uso.entrada, saida: d.uso.saida + a.uso.saida,
      cacheLeitura: d.uso.cacheLeitura + a.uso.cacheLeitura, cacheEscrita: d.uso.cacheEscrita + a.uso.cacheEscrita,
    },
    latenciaMs: d.latenciaMs + a.latenciaMs,
  }
  return depois.ok ? { ...depois, rastro } : { ...depois, rastro }
}
