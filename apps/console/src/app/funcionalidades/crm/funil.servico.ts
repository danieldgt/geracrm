import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface Etapa {
  readonly id: string
  readonly chave: string
  readonly nome: string
  readonly tipo: 'aberto' | 'ganho' | 'perdido'
  readonly total: number
}
export interface Card {
  readonly id: string
  readonly contatoId: string
  readonly nome: string
  readonly valorCentavos: number | null
  readonly responsavel: string | null
  readonly posicao: number
  readonly versao: number
}
export interface Coluna {
  readonly etapa: Etapa
  cards: Card[]
  proximoCursor: string | null
  carregandoMais: boolean
}
export interface Motivo { readonly codigo: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Kanban do funil (Onda 2). ⚠️ Paginado POR COLUNA (nunca virtual scroll — o CDK
 * não junta drag-drop com virtual scroll). O move usa concorrência otimista
 * (versao): se alguém moveu antes, a API devolve 409 e a tela recarrega.
 */
@Injectable({ providedIn: 'root' })
export class FunilServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly colunas = signal<readonly Coluna[]>([])
  readonly motivos = signal<readonly Motivo[]>([])
  readonly erroMove = signal<string | null>(null)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [etapas, motivos] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Etapa[] }>('/v1/funil/etapas')),
        firstValueFrom(this.http.get<{ itens: Motivo[] }>('/v1/funil/motivos')).catch(() => ({ itens: [] })),
      ])
      this.motivos.set(motivos.itens)
      const colunas = await Promise.all(etapas.itens.map(async (etapa) => {
        const r = await this.buscarColuna(etapa.id, null)
        return { etapa, cards: r.itens, proximoCursor: r.proximoCursor, carregandoMais: false } as Coluna
      }))
      this.colunas.set(colunas)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private buscarColuna(etapaId: string, cursor: string | null): Promise<{ itens: Card[]; proximoCursor: string | null }> {
    const url = cursor
      ? `/v1/funil/coluna/${etapaId}?cursor=${encodeURIComponent(cursor)}`
      : `/v1/funil/coluna/${etapaId}`
    return firstValueFrom(this.http.get<{ itens: Card[]; proximoCursor: string | null }>(url))
  }

  async carregarMais(etapaId: string): Promise<void> {
    const cols = [...this.colunas()]
    const col = cols.find((c) => c.etapa.id === etapaId)
    if (!col || !col.proximoCursor || col.carregandoMais) return
    col.carregandoMais = true
    this.colunas.set(cols)
    try {
      const r = await this.buscarColuna(etapaId, col.proximoCursor)
      col.cards = [...col.cards, ...r.itens]
      col.proximoCursor = r.proximoCursor
    } catch { /* mantém */ } finally {
      col.carregandoMais = false
      this.colunas.set([...cols])
    }
  }

  /**
   * Move o card para outra etapa na posição `indice`. Calcula a posição
   * fracionária a partir dos vizinhos na coluna de destino. Devolve o motivo do
   * erro (ex.: 'conflito') para a tela reagir.
   */
  async mover(card: Card, deEtapaId: string, paraEtapaId: string, indice: number, motivo?: string):
    Promise<{ ok: true } | { ok: false; motivo: string }> {
    const cols = this.colunas()
    const destino = cols.find((c) => c.etapa.id === paraEtapaId)
    const vizinhos = (destino?.cards ?? []).filter((c) => c.id !== card.id)
    const antes = vizinhos[indice - 1]?.posicao
    const depois = vizinhos[indice]?.posicao
    const posicao = antes !== undefined && depois !== undefined ? (antes + depois) / 2
      : antes !== undefined ? antes + 1
      : depois !== undefined ? depois - 1
      : 0

    try {
      await firstValueFrom(this.http.post(`/v1/funil/oportunidades/${card.id}/mover`,
        { etapaId: paraEtapaId, posicao, versao: card.versao, ...(motivo ? { motivo } : {}) }))
      return { ok: true }
    } catch (e) {
      const cod = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro ?? '' : ''
      // Conflito/erro: recarrega para refletir a verdade do servidor.
      await this.carregar()
      return { ok: false, motivo: cod }
    }
  }

  async criar(contatoId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post('/v1/funil/oportunidades', { contatoId }))
      await this.carregar()
      return true
    } catch { return false }
  }
}
