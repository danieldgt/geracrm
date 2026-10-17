import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { ComplianceExtra } from '@geracrm/shared'
import { falhaDe, type Resultado } from './agente.servico.js'

/**
 * A porta HTTP do compliance do número (`/v1/canais/:id/agente/compliance`,
 * raia P2). A leitura lança (403 → sem permissão, via `ehSemPermissao`); a
 * gravação devolve falha TIPIFICADA (422 com `campos`, 403 sem papel).
 */

export interface RegraBase {
  readonly id: string
  readonly rotulo: string
  readonly exemplo: string
}

export interface ComplianceDoNumero extends ComplianceExtra {
  /** O que o código já garante sempre — só leitura. */
  readonly base: readonly RegraBase[]
  readonly limites: { readonly maxItens: number; readonly maxCaracteres: number; readonly minCaracteres: number }
  /** Só admin grava; os demais veem. */
  readonly podeEditar: boolean
}

@Injectable({ providedIn: 'root' })
export class ComplianceServico {
  private readonly http = inject(HttpClient)

  ler(canalId: string): Promise<ComplianceDoNumero> {
    return firstValueFrom(this.http.get<ComplianceDoNumero>(`/v1/canais/${canalId}/agente/compliance`))
  }

  async salvar(canalId: string, corpo: ComplianceExtra): Promise<Resultado<{ salvo: ComplianceExtra }>> {
    try {
      const r = await firstValueFrom(this.http.put<{ ok: true } & ComplianceExtra>(`/v1/canais/${canalId}/agente/compliance`, corpo))
      return { ok: true, salvo: { frasesProibidas: r.frasesProibidas, gatilhosHandoff: r.gatilhosHandoff } }
    } catch (e) { return falhaDe(e) }
  }
}
