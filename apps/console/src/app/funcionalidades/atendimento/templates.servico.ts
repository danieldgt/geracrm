import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface CorpoTemplate {
  header?: { texto: string }
  body: { texto: string }
  footer?: { texto: string }
  botoes?: { texto: string }[]
}
export interface ItemTemplate {
  readonly id: string; readonly nome: string; readonly categoria: string; readonly idioma: string
  readonly versao: number; readonly statusMeta: string; readonly motivoRejeicao: string | null
  readonly corpo: CorpoTemplate; readonly submetido: boolean; readonly criadoEm: string
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Templates (HSM). Catálogo paginado por cursor; criar rascunho PENDING, editar
 * (nova versão), apagar rascunho não submetido. A aprovação vem da Meta — a tela
 * apresenta o status, não o inventa.
 */
@Injectable({ providedIn: 'root' })
export class TemplatesServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly ItemTemplate[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erro = signal<string | null>(null)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.buscar(null)
      this.itens.set(r.itens); this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private buscar(cursor: string | null): Promise<{ itens: ItemTemplate[]; proximoCursor: string | null }> {
    const url = `/v1/templates${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    return firstValueFrom(this.http.get<{ itens: ItemTemplate[]; proximoCursor: string | null }>(url))
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.buscar(cursor)
      this.itens.set([...this.itens(), ...r.itens]); this.proximoCursor.set(r.proximoCursor)
    } catch { /* mantém */ } finally { this.carregandoMais.set(false) }
  }

  /** Cria um rascunho. Retorna null em sucesso ou um código de erro tipificado. */
  async criar(nome: string, categoria: string, corpo: CorpoTemplate): Promise<string | null> {
    try {
      await firstValueFrom(this.http.post('/v1/templates', { nome, categoria, corpo }))
      await this.carregar()
      return null
    } catch (e) {
      return e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro ?? 'erro' : 'erro'
    }
  }

  async novaVersao(id: string, corpo: CorpoTemplate): Promise<string | null> {
    try {
      await firstValueFrom(this.http.post(`/v1/templates/${id}/versao`, { corpo }))
      await this.carregar()
      return null
    } catch (e) {
      return e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro ?? 'erro' : 'erro'
    }
  }

  async apagar(id: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.delete(`/v1/templates/${id}`))
      await this.carregar()
      this.erro.set(null)
      return true
    } catch (e) {
      const cod = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro : ''
      this.erro.set(cod === 'template.submetido' ? 'Já foi enviado à Meta — não dá para apagar aqui.' : 'Não foi possível apagar.')
      return false
    }
  }
}
