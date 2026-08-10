import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface Notificacao {
  readonly id: string
  readonly tipo: string
  readonly titulo: string
  readonly conversaId: string | null
  readonly lida: boolean
  readonly criadoEm: string
}

/**
 * Notificações pessoais (PLT-07) — o sino.
 *
 * ⚠️ SEM polling de fundo: o contador é buscado no início e refeito a cada
 * evento `notificacao.nova` do SSE. A lista só é carregada quando o sino abre.
 * O evento não traz conteúdo (ADR-007); tudo vem por API sob RLS.
 */
@Injectable({ providedIn: 'root' })
export class NotificacoesServico {
  private readonly http = inject(HttpClient)

  readonly naoLidas = signal(0)
  readonly itens = signal<readonly Notificacao[]>([])
  readonly carregando = signal(false)

  async carregarContador(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ naoLidas: number }>('/v1/notificacoes/contador'))
      this.naoLidas.set(r.naoLidas)
    } catch {
      // Silencioso: o sino é um aviso, não pode estragar a tela.
    }
  }

  async carregarLista(): Promise<void> {
    this.carregando.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Notificacao[] }>('/v1/notificacoes'))
      this.itens.set(r.itens)
    } catch {
      // mantém o que havia
    } finally {
      this.carregando.set(false)
    }
  }

  /** Marca todas as não-lidas como lidas (limpar o sino). */
  async marcarTodasLidas(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/v1/notificacoes/lidas', {}))
      this.naoLidas.set(0)
      this.itens.update((is) => is.map((i) => ({ ...i, lida: true })))
    } catch {
      // silencioso
    }
  }

  /** Marca uma como lida (ex.: ao abrir a conversa dela). */
  async marcarLida(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/v1/notificacoes/lidas', { ids: [id] }))
      this.itens.update((is) => is.map((i) => (i.id === id ? { ...i, lida: true } : i)))
      this.naoLidas.update((n) => Math.max(0, n - 1))
    } catch {
      // silencioso
    }
  }
}
