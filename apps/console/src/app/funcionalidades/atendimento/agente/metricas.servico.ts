import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { GoLiveDto, MetricasAgenteDto } from '@geracrm/shared'
import { queryDeLista } from '../../../compartilhado/ui/index.js'

/**
 * A porta HTTP do painel de FASE e MÉTRICAS do agente (raia P19). Só leitura.
 *
 *   GET /v1/agente/go-live?canalId   — fase atual e critérios para avançar (ADR-031)
 *   GET /v1/agente/metricas?dias&canalId — agregados do agente na janela
 *
 * ⚠️ Leituras lançam; a tela distingue 403 ("sem permissão") de erro.
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
}
