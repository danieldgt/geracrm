import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { CorpoAtivas, EstadoAtivas, TemplateAprovadoResumo } from '@geracrm/shared'
import { falhaDe, type Pagina, type Resultado } from './agente.servico.js'

/** A porta HTTP das mensagens ativas (P11). Falha de negócio volta tipificada. */
@Injectable({ providedIn: 'root' })
export class AtivasServico {
  private readonly http = inject(HttpClient)

  carregar(canalId: string): Promise<EstadoAtivas> {
    return firstValueFrom(this.http.get<EstadoAtivas>(`/v1/canais/${canalId}/agente/ativas`))
  }

  listarTemplates(canalId: string, cursor: string | null): Promise<Pagina<TemplateAprovadoResumo>> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return firstValueFrom(this.http.get<Pagina<TemplateAprovadoResumo>>(`/v1/canais/${canalId}/agente/ativas/templates${q}`))
  }

  async salvar(canalId: string, corpo: CorpoAtivas): Promise<Resultado<Record<never, never>>> {
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${canalId}/agente/ativas`, corpo))
      return { ok: true }
    } catch (e) { return falhaDe(e) }
  }

  async liberar(canalId: string): Promise<Resultado<Record<never, never>>> {
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${canalId}/agente/ativas/liberar`, {}))
      return { ok: true }
    } catch (e) { return falhaDe(e) }
  }
}
