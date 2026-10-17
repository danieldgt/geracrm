import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type {
  AcaoPlaybook, ComplianceExtra, ConteudoPlaybook, DiffSecaoPlaybook, EscopoPlaybook, ErroCampoPlaybook, VersaoPlaybook,
} from '@geracrm/shared'
import { falhaDe, type Resultado } from './agente.servico.js'

/**
 * A porta HTTP do PLAYBOOK COMERCIAL (`/v1/agente/playbook`, raia P17).
 * `canalId` null = o playbook DA CONTA. Leitura lança (403 → sem permissão);
 * escrita devolve falha TIPIFICADA (422 com `erros[{campo, mensagem}]`, 403, 409).
 */

export interface RegraBasePlaybook { readonly id: string; readonly rotulo: string; readonly exemplo?: string }

export interface EstadoPlaybookApi {
  readonly escopo: EscopoPlaybook
  readonly canalId: string | null
  readonly rascunho: VersaoPlaybook | null
  readonly publicada: VersaoPlaybook | null
  /** O que vale para o número agora (o dele ou o da conta). */
  readonly vigente: { readonly escopo: EscopoPlaybook; readonly versaoId: string; readonly numero: number | null; readonly publicadaEm: string | null } | null
  readonly diff: readonly DiffSecaoPlaybook[] | null
  readonly importavel: boolean
  readonly complianceDoNumero: ComplianceExtra | null
  readonly base: {
    readonly frasesBase: readonly RegraBasePlaybook[]
    readonly sempreLigadas: readonly { readonly id: string; readonly rotulo: string }[]
    readonly acoes: readonly { readonly id: AcaoPlaybook; readonly rotulo: string; readonly descricao: string; readonly ferramentas: readonly string[] }[]
  }
  readonly podeEditar: boolean
}

export type ResumoVersao = Omit<VersaoPlaybook, 'conteudo'>

export interface PaginaVersoes { readonly itens: readonly ResumoVersao[]; readonly proximoCursor: string | null }

/** 422 do playbook: além de `mensagem`, a lista de campos com a frase de cada um. */
export function errosDaFalha(f: { readonly erro: unknown }): readonly ErroCampoPlaybook[] {
  const e = f.erro as { erros?: unknown }
  return Array.isArray(e?.erros) ? (e.erros as ErroCampoPlaybook[]) : []
}

@Injectable({ providedIn: 'root' })
export class PlaybookServico {
  private readonly http = inject(HttpClient)

  ler(canalId: string | null): Promise<EstadoPlaybookApi> {
    return firstValueFrom(this.http.get<EstadoPlaybookApi>(canalId ? `/v1/agente/playbook?canalId=${canalId}` : '/v1/agente/playbook'))
  }

  async importar(canalId: string): Promise<Resultado<{ importada: boolean }>> {
    try {
      const r = await firstValueFrom(this.http.post<{ importada: boolean }>('/v1/agente/playbook/importar', { canalId }))
      return { ok: true, importada: r.importada }
    } catch (e) { return falhaDe(e) }
  }

  async criarRascunho(canalId: string | null): Promise<Resultado<{ versao: VersaoPlaybook }>> {
    try {
      const r = await firstValueFrom(this.http.post<{ versao: VersaoPlaybook }>('/v1/agente/playbook/rascunho', { canalId }))
      return { ok: true, versao: r.versao }
    } catch (e) { return falhaDe(e) }
  }

  async salvarRascunho(canalId: string | null, conteudo: ConteudoPlaybook): Promise<Resultado<{ versao: VersaoPlaybook }>> {
    try {
      const r = await firstValueFrom(this.http.put<{ versao: VersaoPlaybook }>('/v1/agente/playbook/rascunho', { canalId, conteudo }))
      return { ok: true, versao: r.versao }
    } catch (e) { return falhaDe(e) }
  }

  async descartarRascunho(canalId: string | null): Promise<Resultado<Record<never, never>>> {
    try {
      await firstValueFrom(this.http.delete(canalId ? `/v1/agente/playbook/rascunho?canalId=${canalId}` : '/v1/agente/playbook/rascunho'))
      return { ok: true }
    } catch (e) { return falhaDe(e) }
  }

  async publicar(canalId: string | null, observacao: string): Promise<Resultado<{ versao: VersaoPlaybook; numerosAlcancados: number }>> {
    try {
      const r = await firstValueFrom(this.http.post<{ versao: VersaoPlaybook; numerosAlcancados: number }>('/v1/agente/playbook/publicar', { canalId, observacao }))
      return { ok: true, versao: r.versao, numerosAlcancados: r.numerosAlcancados }
    } catch (e) { return falhaDe(e) }
  }

  listarVersoes(canalId: string | null, cursor: string | null): Promise<PaginaVersoes> {
    const q = new URLSearchParams()
    if (canalId) q.set('canalId', canalId)
    if (cursor) q.set('cursor', cursor)
    const s = q.toString()
    return firstValueFrom(this.http.get<PaginaVersoes>(`/v1/agente/playbook/versoes${s ? `?${s}` : ''}`))
  }

  lerVersao(id: string): Promise<{ versao: VersaoPlaybook; diffContraPublicada: readonly DiffSecaoPlaybook[] | null }> {
    return firstValueFrom(this.http.get<{ versao: VersaoPlaybook; diffContraPublicada: readonly DiffSecaoPlaybook[] | null }>(`/v1/agente/playbook/versoes/${id}`))
  }

  async restaurar(id: string, observacao: string): Promise<Resultado<{ versao: VersaoPlaybook }>> {
    try {
      const r = await firstValueFrom(this.http.post<{ versao: VersaoPlaybook }>(`/v1/agente/playbook/versoes/${id}/restaurar`, { observacao }))
      return { ok: true, versao: r.versao }
    } catch (e) { return falhaDe(e) }
  }

  async aPartirDeDocumento(corpo: {
    canalId: string | null; nome?: string; tipo?: string; conteudoBase64?: string; texto?: string
  }): Promise<Resultado<{ versao: VersaoPlaybook; resumoMudancas: readonly string[]; diff: readonly DiffSecaoPlaybook[]; custoCentavos: number }>> {
    try {
      const r = await firstValueFrom(this.http.post<{ versao: VersaoPlaybook; resumoMudancas: string[]; diff: DiffSecaoPlaybook[]; custoCentavos: number }>(
        '/v1/agente/playbook/a-partir-de-documento', corpo))
      return { ok: true, versao: r.versao, resumoMudancas: r.resumoMudancas, diff: r.diff, custoCentavos: r.custoCentavos }
    } catch (e) { return falhaDe(e) }
  }
}
