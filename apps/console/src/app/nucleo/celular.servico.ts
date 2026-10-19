import { Injectable, DestroyRef, inject, signal } from '@angular/core'
import { MQ_CELULAR } from './casca.regras.js'

/**
 * "A janela está no modo celular?" como signal — só para a CASCA (menu-gaveta,
 * trilho, alertas), que é dona da janela inteira.
 *
 * ⚠️ Telas NÃO usam isto: tela responde à largura do próprio conteúdo por
 * container query (como clientes.pagina.ts). A janela pode ter 1280px e a tela
 * ter 400px com o trilho aberto ao lado.
 */
@Injectable({ providedIn: 'root' })
export class CelularServico {
  private readonly mq = typeof matchMedia === 'function' ? matchMedia(MQ_CELULAR) : null
  readonly celular = signal(this.mq?.matches ?? false)

  constructor() {
    if (!this.mq) return
    const ouvir = (e: MediaQueryListEvent) => this.celular.set(e.matches)
    this.mq.addEventListener('change', ouvir)
    inject(DestroyRef).onDestroy(() => this.mq?.removeEventListener('change', ouvir))
  }
}
