import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { CorpoRegraRoteamento, NumeroRoteamento, RegraRoteamento, SimulacaoRoteamento } from '@geracrm/shared'
import { queryDeLista } from '../../compartilhado/ui/index.js'

export interface PaginaRegras { readonly itens: readonly RegraRoteamento[]; readonly proximoCursor: string | null }
export interface FilialOpcao { readonly id: string; readonly nome: string; readonly cor: string | null }

/** Roteamento por filial (G4). Regras por cursor; o tenant vem do token. */
@Injectable({ providedIn: 'root' })
export class RoteamentoServico {
  private readonly http = inject(HttpClient)

  regras(cursor?: string | null): Promise<PaginaRegras> {
    return firstValueFrom(this.http.get<PaginaRegras>(`/v1/roteamento/regras${queryDeLista({ cursor })}`))
  }
  criar(corpo: CorpoRegraRoteamento): Promise<{ id: string }> {
    return firstValueFrom(this.http.post<{ id: string }>('/v1/roteamento/regras', corpo))
  }
  editar(id: string, corpo: Partial<CorpoRegraRoteamento>): Promise<unknown> {
    return firstValueFrom(this.http.patch(`/v1/roteamento/regras/${id}`, corpo))
  }
  remover(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/v1/roteamento/regras/${id}`))
  }
  numeros(): Promise<{ itens: readonly NumeroRoteamento[]; truncado: boolean }> {
    return firstValueFrom(this.http.get<{ itens: readonly NumeroRoteamento[]; truncado: boolean }>('/v1/roteamento/numeros'))
  }
  /** `aviso`: ao ligar, o número não distribuiria para alguma filial (sem regra ou sem vendedor). */
  ligarRodizio(canalId: string, rodizioNaEntrada: boolean): Promise<{ ok: true; aviso: string | null }> {
    return firstValueFrom(this.http.put<{ ok: true; aviso: string | null }>(`/v1/roteamento/numeros/${canalId}`, { rodizioNaEntrada }))
  }
  filiais(): Promise<{ itens: readonly FilialOpcao[]; truncado: boolean }> {
    return firstValueFrom(this.http.get<{ itens: readonly FilialOpcao[]; truncado: boolean }>('/v1/roteamento/filiais'))
  }
  simular(p: { telefone: string; origemId: string; canalId: string }): Promise<SimulacaoRoteamento> {
    const q = new URLSearchParams()
    if (p.telefone) q.set('telefone', p.telefone)
    if (p.origemId) q.set('origemId', p.origemId)
    if (p.canalId) q.set('canalId', p.canalId)
    return firstValueFrom(this.http.get<SimulacaoRoteamento>(`/v1/roteamento/simular?${q.toString()}`))
  }
}
