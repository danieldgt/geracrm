import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export type ChaveLead = 'novo' | 'qualificado' | 'descartado'
export interface CardLead {
  readonly contatoId: string; readonly nome: string; readonly telefone: string | null
  readonly uf: string | null; readonly responsavel: string | null; readonly qtdVendas: number
  readonly ultimoToqueEm: string | null; readonly conversaId: string | null
}
export interface ColunaLead {
  chave: ChaveLead; nome: string; total: number
  cards: CardLead[]; proximoCursor: string | null; carregandoMais: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * CRM (Leads) — kanban de qualificação. Três colunas derivadas de
 * `contato.qualificado` (Leads / Qualificados / Descartados). Espelha o Funil:
 * colunas paginadas por cursor; mover = qualificar (last-write-wins).
 */
@Injectable({ providedIn: 'root' })
export class LeadsServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly colunas = signal<readonly ColunaLead[]>([])
  readonly erroMove = signal<string | null>(null)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ colunas: { chave: ChaveLead; nome: string; total: number }[] }>('/v1/leads/colunas'))
      const cols = await Promise.all(r.colunas.map(async (c) => {
        const p = await this.buscar(c.chave, null)
        return { ...c, cards: p.itens, proximoCursor: p.proximoCursor, carregandoMais: false } as ColunaLead
      }))
      this.colunas.set(cols)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private async buscar(chave: ChaveLead, cursor: string | null): Promise<{ itens: CardLead[]; proximoCursor: string | null }> {
    const url = `/v1/leads/coluna/${chave}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    return firstValueFrom(this.http.get<{ itens: CardLead[]; proximoCursor: string | null }>(url))
  }

  async carregarMais(chave: ChaveLead): Promise<void> {
    const cols = [...this.colunas()]
    const col = cols.find((c) => c.chave === chave)
    if (!col || !col.proximoCursor || col.carregandoMais) return
    col.carregandoMais = true; this.colunas.set(cols)
    try {
      const p = await this.buscar(chave, col.proximoCursor)
      col.cards = [...col.cards, ...p.itens]; col.proximoCursor = p.proximoCursor
    } catch { /* mantém */ } finally { col.carregandoMais = false; this.colunas.set([...this.colunas()]) }
  }

  /** Qualifica (move o lead para outra coluna). Recarrega para refletir totais. */
  async qualificar(contatoId: string, estado: ChaveLead): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(`/v1/leads/${contatoId}/qualificar`, { estado }))
      await this.carregar()
      this.erroMove.set(null)
      return true
    } catch {
      await this.carregar()
      this.erroMove.set('Não foi possível mover o lead — recarreguei.')
      return false
    }
  }
}
