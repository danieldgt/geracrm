import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { ModoAgente } from '@geracrm/shared'
import { falhaDe, type Resultado } from './agente.servico.js'
import type { TetoDoTenant } from './modo.regras.js'

/**
 * A porta HTTP do TETO DA CONTA — o kill switch geral do agente (ADR-028, P14).
 *
 *   GET/PUT /v1/agente/tenant — `modoMaximo` vale para todos os números.
 *
 * ⚠️ Escrita exige admin (403) e confirmação digitada para autônomo/desligado
 *    (422 `agente.confirmacao_necessaria`); volta tipificada, nunca lança.
 */
@Injectable({ providedIn: 'root' })
export class ModoServico {
  private readonly http = inject(HttpClient)

  carregarTeto(): Promise<TetoDoTenant> {
    return firstValueFrom(this.http.get<TetoDoTenant>('/v1/agente/tenant'))
  }

  async salvarTeto(modoMaximo: ModoAgente, confirmacao: string | null): Promise<Resultado<{ modoMaximo: ModoAgente }>> {
    try {
      const r = await firstValueFrom(this.http.put<{ ok: true; modoMaximo: ModoAgente }>(
        '/v1/agente/tenant', confirmacao ? { modoMaximo, confirmacao } : { modoMaximo }))
      return { ok: true, modoMaximo: r.modoMaximo }
    } catch (e) { return falhaDe(e) }
  }
}
