import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { AlcadaAgente, ModoAgente, PersonaResolvida, RegrasDoAgente } from '@geracrm/shared'
import type { ErroApi } from './agente.regras.js'

/**
 * A porta HTTP do agente vendedor — tipos da resposta e chamadas, nada de tela.
 *
 * ⚠️ Falha de negócio volta TIPIFICADA (`{ ok: false, erro }`), nunca como
 * exceção solta: a tela precisa do código e dos campos para apontar onde
 * corrigir (PED-08). Só 403 vira estado "sem permissão".
 */

export interface CanalResumo { readonly id: string; readonly nomeAmigavel: string; readonly tipo: string; readonly estado: string }

export interface ConfigAgente {
  readonly ativo: boolean
  readonly modo: ModoAgente
  readonly politicas: string
  readonly persona: PersonaResolvida
  readonly objetivo: 'vender' | 'qualificar'
  readonly alcada: AlcadaAgente
  readonly qualificacao: readonly string[]
  readonly modelo: string | null
  readonly limiarConfianca: number
  readonly maxRodadas: number
  readonly prazoTurnoMs: number
  readonly orcamentoDiaCentavos: number | null
  readonly regras: RegrasDoAgente
  readonly padroes: RegrasDoAgente
  /** Variáveis de ambiente que faltam no servidor — pelo NOME, para quem resolve. */
  readonly faltaConfigurar: readonly string[]
  /** ⚠️ Opcional: a API anterior não manda; ver o aviso na tela de config. */
  readonly temMensagemAusencia?: boolean
}

export interface ChamadaFerramenta {
  readonly nome: string
  readonly entrada: unknown
  readonly saida: unknown
  readonly ms: number
  readonly erro?: string
}

export interface Rastro {
  readonly chamadas: readonly ChamadaFerramenta[]
  readonly rodadas: number
  readonly uso: { readonly entrada: number; readonly saida: number; readonly cacheLeitura: number; readonly cacheEscrita: number }
  readonly modelo: string
  readonly latenciaMs: number
}

export interface ResultadoSimulacao {
  readonly conversaId: string
  readonly desfecho: string
  readonly mensagens: readonly string[]
  readonly handoff: { readonly motivo: string; readonly resumo: string } | null
  readonly motivo: string | null
  readonly detalhe: string | null
  readonly decisaoId: string | null
  readonly rastro: Rastro | null
}

export interface Decisao {
  readonly id: string
  readonly conversaId: string
  readonly canalId: string
  readonly contato: string | null
  readonly modo: string
  readonly desfecho: string
  readonly portaoMotivo: string | null
  readonly modelo: string | null
  readonly ferramentas: readonly ChamadaFerramenta[]
  readonly resposta: {
    readonly mensagens: readonly string[]; readonly confianca: number; readonly fase?: string
    readonly handoff?: { motivo: string; resumo: string }; readonly slots?: Record<string, string>
  } | null
  readonly confianca: number | null
  readonly handoffMotivo: string | null
  readonly numerosBloqueados: readonly number[]
  readonly uso: Rastro['uso'] | Record<string, never>
  readonly custoCentavos: number
  readonly latenciaMs: number | null
  readonly rodadas: number
  readonly enviada: boolean
  readonly erro: string | null
  readonly criadoEm: string
}

export interface Sessao {
  readonly id: string
  readonly conversaId: string
  readonly contato: string | null
  readonly estado: string
  readonly turnos: number
  readonly motivoSaida: string | null
  readonly iniciadaEm: string
  readonly encerradaEm: string | null
  readonly extraido: Record<string, unknown>
  readonly descartados: readonly { campo: string; motivo: string }[]
  readonly tokens: number
  readonly fase: string | null
  readonly modo: string | null
  readonly slots: Record<string, unknown>
  readonly custoCentavos: number
}

export interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }

export type Falha = { readonly ok: false; readonly status: number; readonly erro: ErroApi }
export type Resultado<T> = ({ readonly ok: true } & T) | Falha

@Injectable({ providedIn: 'root' })
export class AgenteServico {
  private readonly http = inject(HttpClient)

  async listarCanais(): Promise<readonly CanalResumo[]> {
    const r = await firstValueFrom(this.http.get<{ itens: CanalResumo[] }>('/v1/canais'))
    return r.itens
  }

  carregarConfig(canalId: string): Promise<ConfigAgente> {
    return firstValueFrom(this.http.get<ConfigAgente>(`/v1/canais/${canalId}/agente`))
  }

  async salvarConfig(canalId: string, corpo: Record<string, unknown>): Promise<Resultado<{ modo: ModoAgente }>> {
    try {
      const r = await firstValueFrom(this.http.put<{ ok: true; modo: ModoAgente }>(`/v1/canais/${canalId}/agente`, corpo))
      return { ok: true, modo: r.modo }
    } catch (e) { return falhaDe(e) }
  }

  async simular(canalId: string, mensagem: string, conversaId: string | null): Promise<Resultado<{ resultado: ResultadoSimulacao }>> {
    try {
      const r = await firstValueFrom(this.http.post<ResultadoSimulacao>(
        `/v1/canais/${canalId}/agente/simular`, conversaId ? { mensagem, conversaId } : { mensagem }))
      return { ok: true, resultado: r }
    } catch (e) { return falhaDe(e) }
  }

  async reiniciarSimulacao(canalId: string): Promise<Resultado<Record<never, never>>> {
    try {
      await firstValueFrom(this.http.delete(`/v1/canais/${canalId}/agente/simular`))
      return { ok: true }
    } catch (e) { return falhaDe(e) }
  }

  listarDecisoes(canalId: string, cursor: string | null): Promise<Pagina<Decisao>> {
    const q = new URLSearchParams({ canalId })
    if (cursor) q.set('cursor', cursor)
    return firstValueFrom(this.http.get<Pagina<Decisao>>(`/v1/agente/decisoes?${q.toString()}`))
  }

  listarSessoes(cursor: string | null): Promise<Pagina<Sessao>> {
    const url = cursor ? `/v1/agente/sessoes?cursor=${encodeURIComponent(cursor)}` : '/v1/agente/sessoes'
    return firstValueFrom(this.http.get<Pagina<Sessao>>(url))
  }
}

/** 403 → sem permissão; corpo tipificado quando a API mandou; o resto é "inesperado". */
export function falhaDe(e: unknown): Falha {
  if (e instanceof HttpErrorResponse) {
    const corpo = e.error && typeof e.error === 'object' && 'erro' in e.error ? (e.error as ErroApi) : null
    return { ok: false, status: e.status, erro: corpo ?? { erro: 'erro.desconhecido', mensagem: 'Erro inesperado ao falar com o servidor.' } }
  }
  return { ok: false, status: 0, erro: { erro: 'erro.desconhecido', mensagem: 'Erro inesperado.' } }
}

export function ehSemPermissao(e: unknown): boolean {
  return e instanceof HttpErrorResponse && e.status === 403
}
