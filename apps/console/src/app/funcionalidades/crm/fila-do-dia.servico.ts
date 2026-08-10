import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { ClienteRfv } from './clientes.servico.js'

/**
 * A Fila do Dia — quem precisa de ação HOJE, por urgência.
 *
 * ⚠️ Mesmo padrão da lista de clientes (5 estados, cursor), mas a leitura é
 * outra: aqui a ordem é urgência (atraso ao ritmo), não valor. Reaproveita o
 * tipo `ClienteRfv` — é a mesma verdade vista por outro ângulo.
 */
export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

@Injectable({ providedIn: 'root' })
export class FilaDoDiaServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly itens = signal<readonly ClienteRfv[]>([])
  readonly erro = signal<string | null>(null)
  private readonly cursor = signal<string | null>(null)
  private readonly carregandoMais = signal(false)

  readonly temMais = computed(() => this.cursor() !== null)
  readonly buscandoMais = this.carregandoMais.asReadonly()
  readonly vazio = computed(() => this.estado() === 'pronto' && this.itens().length === 0)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    this.cursor.set(null)
    try {
      const r = await this.buscar(null)
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erro.set(this.mensagem(e))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.cursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.buscar(cursor)
      this.itens.update((atual) => [...atual, ...r.itens])
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      this.erro.set(this.mensagem(e))
    } finally {
      this.carregandoMais.set(false)
    }
  }

  private async buscar(cursor: string | null) {
    const params = new URLSearchParams({ limite: '30' })
    if (cursor) params.set('cursor', cursor)
    return firstValueFrom(
      this.http.get<{ itens: ClienteRfv[]; proximoCursor: string | null }>(
        `/v1/fila-do-dia?${params.toString()}`,
      ),
    )
  }

  private mensagem(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) return 'Não foi possível falar com o Drezz Hub. Verifique sua conexão.'
      return `O Drezz Hub respondeu com erro (${e.status}).`
    }
    return 'Erro inesperado.'
  }
}
