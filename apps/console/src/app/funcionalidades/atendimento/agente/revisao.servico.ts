import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { AmostraRevisaoDto, ConcordanciaDto, CorpoRevisao, DetalheRevisaoDto, RevisaoDto } from '@geracrm/shared'
import { queryDeLista } from '../../../compartilhado/ui/index.js'
import { falhaDe, type Resultado } from './agente.servico.js'

/**
 * A porta HTTP da REVISÃO HUMANA (ADR-031 §5, raia P16). Regras puras da tela
 * em `revisao.regras.ts`. Gestor ou admin.
 *
 *   GET  /v1/agente/revisao/amostra?canalId&semana      — 20 conversas na ordem da P12, com "revisada"
 *   GET  /v1/agente/revisao/avaliacoes/:id              — transcrição mascarada, notas do juiz, violações
 *   POST /v1/agente/revisao                             — grava (ou regrava) a revisão de quem está logado
 *   GET  /v1/agente/revisao/concordancia?semana         — concordância por número
 *   GET  /v1/agente/revisao/planilha.csv?canalId&semana — planilha da semana
 *
 * ⚠️ Leituras lançam (403 → "sem permissão"); escritas voltam tipificadas.
 */
@Injectable({ providedIn: 'root' })
export class RevisaoServico {
  readonly #http = inject(HttpClient)

  amostra(canalId: string, semana: string): Promise<AmostraRevisaoDto> {
    return firstValueFrom(this.#http.get<AmostraRevisaoDto>(`/v1/agente/revisao/amostra${queryDeLista({ canalId, semana })}`))
  }

  detalhe(avaliacaoId: string): Promise<DetalheRevisaoDto> {
    return firstValueFrom(this.#http.get<DetalheRevisaoDto>(`/v1/agente/revisao/avaliacoes/${avaliacaoId}`))
  }

  concordancia(semana: string): Promise<ConcordanciaDto> {
    return firstValueFrom(this.#http.get<ConcordanciaDto>(`/v1/agente/revisao/concordancia${queryDeLista({ semana })}`))
  }

  async gravar(corpo: CorpoRevisao): Promise<Resultado<{ revisao: RevisaoDto }>> {
    try {
      const revisao = await firstValueFrom(this.#http.post<RevisaoDto>('/v1/agente/revisao', corpo))
      return { ok: true, revisao }
    } catch (e) { return falhaDe(e) }
  }

  async planilha(canalId: string, semana: string): Promise<Resultado<{ blob: Blob; nome: string }>> {
    try {
      const r = await firstValueFrom(this.#http.get(`/v1/agente/revisao/planilha.csv${queryDeLista({ canalId, semana })}`, { observe: 'response', responseType: 'blob' }))
      const nome = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `revisao-${semana}.csv`
      return { ok: true, blob: r.body ?? new Blob([]), nome }
    } catch (e) { return falhaDe(e) }
  }
}
