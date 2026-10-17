import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { falhaDe, type Resultado } from './agente.servico.js'

/**
 * A porta HTTP de CUSTO E TETOS do agente (ADR-032, raia P6). As regras puras
 * da tela moram em `custo.regras.ts` (testadas em custo.regras.spec.ts).
 *
 *   GET/PUT /v1/agente/orcamento        — orçamento mensal do tenant (só alerta)
 *   GET/PUT /v1/canais/:id/agente/custo — teto por conversa do número
 *
 * ⚠️ Dinheiro em centavos inteiros; a tela converte texto ↔ centavos pelo
 *    `dinheiro.ts` (nunca `Number(x) * 100`).
 * ⚠️ Leituras lançam (403 vira "sem permissão" via `ehSemPermissao`); escritas
 *    voltam tipificadas — 403 = só admin, 422 = campo inválido.
 */

export interface OrcamentoMensal {
  /** 'YYYY-MM' no fuso da loja. */
  readonly mes: string
  readonly mensalCentavos: number | null
  readonly gastoMesCentavos: number
  readonly limiarAtingido: 0 | 80 | 100
  readonly alertado80: boolean
  readonly alertado100: boolean
  /** Modelos usados no mês sem preço no catálogo — custo estimado pelo MAIOR preço. */
  readonly modelosSemPreco: readonly string[]
  readonly cambioBrl: number
}

export interface CustoDoNumero {
  /** null = usa o padrão do servidor; 0 = sem teto. */
  readonly tetoSessaoCentavos: number | null
  readonly tetoSessaoPadraoCentavos: number
  /** null = sem teto por conversa. */
  readonly tetoSessaoEfetivoCentavos: number | null
  readonly orcamentoDiaCentavos: number | null
  readonly gastoHojeCentavos: number
  readonly sessoes30Dias: { readonly quantidade: number; readonly mediaCentavos: number | null; readonly maiorCentavos: number | null }
}

@Injectable({ providedIn: 'root' })
export class CustoServico {
  readonly #http = inject(HttpClient)

  orcamento(): Promise<OrcamentoMensal> {
    return firstValueFrom(this.#http.get<OrcamentoMensal>('/v1/agente/orcamento'))
  }

  async salvarOrcamento(mensalCentavos: number | null): Promise<Resultado<{ mensalCentavos: number | null }>> {
    try {
      const r = await firstValueFrom(this.#http.put<{ mensalCentavos: number | null }>('/v1/agente/orcamento', { mensalCentavos }))
      return { ok: true, mensalCentavos: r.mensalCentavos }
    } catch (e) { return falhaDe(e) }
  }

  doNumero(canalId: string): Promise<CustoDoNumero> {
    return firstValueFrom(this.#http.get<CustoDoNumero>(`/v1/canais/${canalId}/agente/custo`))
  }

  async salvarTeto(canalId: string, tetoSessaoCentavos: number | null): Promise<Resultado<{ tetoSessaoEfetivoCentavos: number | null }>> {
    try {
      const r = await firstValueFrom(this.#http.put<{ tetoSessaoEfetivoCentavos: number | null }>(
        `/v1/canais/${canalId}/agente/custo`, { tetoSessaoCentavos }))
      return { ok: true, tetoSessaoEfetivoCentavos: r.tetoSessaoEfetivoCentavos }
    } catch (e) { return falhaDe(e) }
  }
}
