import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'

export interface Etiqueta { readonly id: string; readonly nome: string; readonly cor: string; readonly ativa: boolean }
export interface Origem { readonly id: string; readonly nome: string; readonly ativa: boolean; readonly ordem: number }
export interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }

/** Catálogos do CRM (A4). Todas as listas são por cursor; o tenant vem do token. */
@Injectable({ providedIn: 'root' })
export class EtiquetasServico {
  private readonly http = inject(HttpClient)

  etiquetas(cursor?: string | null, soAtivas = false, q: string | null = null): Promise<Pagina<Etiqueta>> {
    return firstValueFrom(this.http.get<Pagina<Etiqueta>>(
      `/v1/etiquetas${queryDeLista({ cursor, ativas: soAtivas ? 'true' : null, q })}`))
  }
  criarEtiqueta(corpo: { nome: string; cor: string }): Promise<Etiqueta> {
    return firstValueFrom(this.http.post<Etiqueta>('/v1/etiquetas', corpo))
  }
  editarEtiqueta(id: string, corpo: Partial<{ nome: string; cor: string; ativa: boolean }>): Promise<Etiqueta> {
    return firstValueFrom(this.http.patch<Etiqueta>(`/v1/etiquetas/${id}`, corpo))
  }

  origens(cursor?: string | null, soAtivas = false, q: string | null = null): Promise<Pagina<Origem>> {
    return firstValueFrom(this.http.get<Pagina<Origem>>(
      `/v1/origens${queryDeLista({ cursor, ativas: soAtivas ? 'true' : null, q })}`))
  }
  criarOrigem(corpo: { nome: string; ordem: number }): Promise<Origem> {
    return firstValueFrom(this.http.post<Origem>('/v1/origens', corpo))
  }
  editarOrigem(id: string, corpo: Partial<{ nome: string; ordem: number; ativa: boolean }>): Promise<Origem> {
    return firstValueFrom(this.http.patch<Origem>(`/v1/origens/${id}`, corpo))
  }

  doContato(contatoId: string): Promise<{ itens: readonly Etiqueta[] }> {
    return firstValueFrom(this.http.get<{ itens: readonly Etiqueta[] }>(`/v1/contatos/${contatoId}/etiquetas`))
  }
  salvarDoContato(contatoId: string, etiquetaIds: readonly string[]): Promise<unknown> {
    return firstValueFrom(this.http.put(`/v1/contatos/${contatoId}/etiquetas`, { etiquetaIds }))
  }
}
