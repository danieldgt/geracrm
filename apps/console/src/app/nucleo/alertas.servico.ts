import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface Alerta {
  readonly id: string
  readonly tipo: string
  readonly severidade: 'aviso' | 'critico'
  readonly mensagem: string
  readonly criadoEm: string
  readonly resolvido: boolean
}

/**
 * Alertas técnicos abertos (I-10). ⚠️ Sem polling: busca no início e a cada
 * evento `alerta.novo` do SSE. Alerta invisível não serve — por isso mora no
 * shell, sempre montado.
 */
@Injectable({ providedIn: 'root' })
export class AlertasServico {
  private readonly http = inject(HttpClient)
  readonly abertos = signal<readonly Alerta[]>([])

  async carregar(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Alerta[] }>('/v1/alertas'))
      this.abertos.set(r.itens)
    } catch {
      // silencioso: uma falha ao buscar alerta não pode derrubar a tela.
    }
  }
}
