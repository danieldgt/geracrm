import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { CorpoConferenciaGoLive, GoLiveDto, MetricasAgenteDto, ResumoObjecoesDto } from '@geracrm/shared'
import { queryDeLista } from '../../../compartilhado/ui/index.js'
import { falhaDe, type Resultado } from './agente.servico.js'

/**
 * A porta HTTP do painel de FASE e MÉTRICAS do agente (raia P19).
 *
 *   GET  /v1/agente/go-live?canalId          — fase atual e critérios para avançar (ADR-031)
 *   POST /v1/agente/go-live/conferencia      — admin registra a última rodada das douradas ou do smoke
 *   GET  /v1/agente/metricas?dias&canalId    — agregados do agente na janela
 *   GET  /v1/agente/objecoes/resumo?dias&canalId — objeções registradas por código (G2)
 *
 * ⚠️ Leituras lançam; a tela distingue 403 ("sem permissão") de erro. A
 *    conferência volta tipificada (403 só admin, 422 campo).
 * ⚠️ O painel não muda o modo: isso é a aba Configuração (P14), com confirmação.
 */
@Injectable({ providedIn: 'root' })
export class MetricasServico {
  readonly #http = inject(HttpClient)

  goLive(canalId: string): Promise<GoLiveDto> {
    return firstValueFrom(this.#http.get<GoLiveDto>(`/v1/agente/go-live${queryDeLista({ canalId })}`))
  }

  metricas(canalId: string, dias: number): Promise<MetricasAgenteDto> {
    return firstValueFrom(this.#http.get<MetricasAgenteDto>(`/v1/agente/metricas${queryDeLista({ canalId, dias })}`))
  }

  objecoes(canalId: string, dias: number): Promise<ResumoObjecoesDto> {
    return firstValueFrom(this.#http.get<ResumoObjecoesDto>(`/v1/agente/objecoes/resumo${queryDeLista({ canalId, dias })}`))
  }

  async conferir(corpo: CorpoConferenciaGoLive): Promise<Resultado<{ atualizadoEm: string }>> {
    try {
      const r = await firstValueFrom(this.#http.post<{ atualizadoEm: string }>('/v1/agente/go-live/conferencia', corpo))
      return { ok: true, atualizadoEm: r.atualizadoEm }
    } catch (e) {
      return falhaDe(e)
    }
  }
}
