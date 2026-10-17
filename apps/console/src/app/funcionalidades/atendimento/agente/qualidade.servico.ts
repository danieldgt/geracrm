import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { AvaliacaoQualidadeDto, ResumoQualidadeDto } from '@geracrm/shared'
import { queryDeLista } from '../../../compartilhado/ui/index.js'
import { falhaDe, type Resultado } from './agente.servico.js'
import { parametrosDoFiltro, type FiltroQualidade } from './qualidade.regras.js'

/**
 * A porta HTTP da QUALIDADE EM PRODUÇÃO do agente (ADR-031, raia P12). Regras
 * puras da tela em `qualidade.regras.ts` (testadas em qualidade.regras.spec.ts).
 *
 *   GET  /v1/agente/qualidade                     — avaliações por cursor
 *   GET  /v1/agente/qualidade/resumo              — contagens, notas, amostra, teto do juiz
 *   GET  /v1/agente/qualidade/amostra-semanal.csv — amostra da semana (mascarada)
 *   POST /v1/agente/qualidade/avaliar             — juiz sob demanda numa conversa
 *   GET/PUT /v1/canais/:id/agente/qualidade       — amostra e teto do número
 *
 * ⚠️ Leituras lançam (403 → "sem permissão" via `ehSemPermissao`); escritas e
 *    ações voltam tipificadas.
 */

export interface PaginaAvaliacoes {
  readonly itens: readonly AvaliacaoQualidadeDto[]
  readonly proximoCursor: string | null
}

export interface ConfigQualidade {
  /** null = padrão do modo. */
  readonly amostra: number | null
  readonly amostraPadrao: number
  readonly modo: string
  /** null = padrão do servidor; 0 = juiz desligado. */
  readonly tetoMesCentavos: number | null
  readonly tetoMesPadraoCentavos: number
  readonly tetoMesEfetivoCentavos: number
  readonly gastoMesCentavos: number
}

@Injectable({ providedIn: 'root' })
export class QualidadeServico {
  readonly #http = inject(HttpClient)

  listar(canalId: string, filtro: FiltroQualidade, cursor: string | null): Promise<PaginaAvaliacoes> {
    const q = queryDeLista({ canalId, cursor, ...parametrosDoFiltro(filtro) })
    return firstValueFrom(this.#http.get<PaginaAvaliacoes>(`/v1/agente/qualidade${q}`))
  }

  resumo(canalId: string, dias = 7): Promise<ResumoQualidadeDto> {
    return firstValueFrom(this.#http.get<ResumoQualidadeDto>(`/v1/agente/qualidade/resumo${queryDeLista({ canalId, dias })}`))
  }

  config(canalId: string): Promise<ConfigQualidade> {
    return firstValueFrom(this.#http.get<ConfigQualidade>(`/v1/canais/${canalId}/agente/qualidade`))
  }

  async salvarConfig(canalId: string, amostra: number | null, tetoMesCentavos: number | null): Promise<Resultado<{ tetoMesEfetivoCentavos: number }>> {
    try {
      const r = await firstValueFrom(this.#http.put<{ tetoMesEfetivoCentavos: number }>(`/v1/canais/${canalId}/agente/qualidade`, { amostra, tetoMesCentavos }))
      return { ok: true, tetoMesEfetivoCentavos: r.tetoMesEfetivoCentavos }
    } catch (e) { return falhaDe(e) }
  }

  async avaliar(conversaId: string): Promise<Resultado<{ avaliacao: AvaliacaoQualidadeDto | null; desfecho: string }>> {
    try {
      const r = await firstValueFrom(this.#http.post<{ avaliacao: AvaliacaoQualidadeDto | null; desfecho: string }>('/v1/agente/qualidade/avaliar', { conversaId }))
      return { ok: true, avaliacao: r.avaliacao, desfecho: r.desfecho }
    } catch (e) { return falhaDe(e) }
  }

  async amostraSemanal(canalId: string): Promise<Resultado<{ blob: Blob; nome: string }>> {
    try {
      const r = await firstValueFrom(this.#http.get(`/v1/agente/qualidade/amostra-semanal.csv${queryDeLista({ canalId })}`, { observe: 'response', responseType: 'blob' }))
      const disp = r.headers.get('content-disposition') ?? ''
      const nome = /filename="([^"]+)"/.exec(disp)?.[1] ?? 'qualidade-amostra.csv'
      return { ok: true, blob: r.body ?? new Blob([]), nome }
    } catch (e) { return falhaDe(e) }
  }
}
