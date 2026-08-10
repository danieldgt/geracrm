import { Injectable, signal } from '@angular/core'

export type Tema = 'sistema' | 'claro' | 'escuro'

/**
 * Tema claro/escuro (ADR-012). ⚠️ Três estados: 'sistema' não estampa nada (o
 * `@media prefers-color-scheme` decide), 'claro'/'escuro' estampam `data-tema`
 * na raiz e vencem a preferência do SO. A escolha persiste no navegador.
 */
const CHAVE = 'geracrm-tema'

@Injectable({ providedIn: 'root' })
export class TemaServico {
  readonly tema = signal<Tema>(this.lerInicial())

  private lerInicial(): Tema {
    const salvo = localStorage.getItem(CHAVE)
    return salvo === 'claro' || salvo === 'escuro' ? salvo : 'sistema'
  }

  aplicar(): void { this.estampar(this.tema()) }

  /** Cicla sistema → claro → escuro → sistema. */
  alternar(): void {
    const proximo: Tema = this.tema() === 'sistema' ? 'claro' : this.tema() === 'claro' ? 'escuro' : 'sistema'
    this.tema.set(proximo)
    if (proximo === 'sistema') localStorage.removeItem(CHAVE)
    else localStorage.setItem(CHAVE, proximo)
    this.estampar(proximo)
  }

  private estampar(t: Tema): void {
    const raiz = document.documentElement
    if (t === 'sistema') raiz.removeAttribute('data-tema')
    else raiz.setAttribute('data-tema', t)
  }
}
