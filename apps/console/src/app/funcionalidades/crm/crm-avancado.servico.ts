import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { colunaDeFrequencia } from './crm-avancado.regras.js'

export interface CardCliente {
  readonly contatoId: string; readonly nome: string; readonly telefone: string | null
  readonly uf: string | null; readonly responsavel: string | null
  readonly qtdVendas: number; readonly totalCentavos: number
  readonly ultimaVendaEm: string | null; readonly ultimoToqueEm: string | null
  readonly representante: boolean; readonly conversaId: string | null
  readonly segmento: { readonly codigo: string; readonly rotulo: string } | null
}
export interface ColunaCliente {
  chave: string; nome: string; total: number
  cards: CardCliente[]; proximoCursor: string | null; carregandoMais: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Por nº de pedidos (aba da Base) — board de LEITURA (colunas de frequência
 * derivadas; sem drag). Colunas paginadas por cursor.
 *
 * ⚠️ A API ainda devolve as colunas de qualificação (leads, descartados); a tela
 * não as mostra — a qualificação mora no Funil. Filtradas ANTES de buscar os
 * cards, para não pagar a página de uma coluna que ninguém vê.
 */
@Injectable({ providedIn: 'root' })
export class CrmAvancadoServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly colunas = signal<readonly ColunaCliente[]>([])

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ colunas: { chave: string; nome: string; total: number }[] }>('/v1/crm-avancado/colunas'))
      const cols = await Promise.all(r.colunas.filter((c) => colunaDeFrequencia(c.chave)).map(async (c) => {
        const p = await this.buscar(c.chave, null)
        return { ...c, cards: p.itens, proximoCursor: p.proximoCursor, carregandoMais: false } as ColunaCliente
      }))
      this.colunas.set(cols)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private async buscar(chave: string, cursor: string | null): Promise<{ itens: CardCliente[]; proximoCursor: string | null }> {
    const url = `/v1/crm-avancado/coluna/${chave}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    return firstValueFrom(this.http.get<{ itens: CardCliente[]; proximoCursor: string | null }>(url))
  }

  async carregarMais(chave: string): Promise<void> {
    const cols = [...this.colunas()]
    const col = cols.find((c) => c.chave === chave)
    if (!col || !col.proximoCursor || col.carregandoMais) return
    col.carregandoMais = true; this.colunas.set(cols)
    try {
      const p = await this.buscar(chave, col.proximoCursor)
      col.cards = [...col.cards, ...p.itens]; col.proximoCursor = p.proximoCursor
    } catch { /* mantém */ } finally { col.carregandoMais = false; this.colunas.set([...this.colunas()]) }
  }
}
