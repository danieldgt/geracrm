import { ChangeDetectionStrategy, Component, Injectable, signal } from '@angular/core'

/** Um aviso efêmero. Tom por token; some sozinho. */
export interface Toast {
  readonly id: number
  readonly texto: string
  readonly tom: 'neutro' | 'sucesso' | 'erro'
}

@Injectable({ providedIn: 'root' })
export class ToastServico {
  readonly toasts = signal<readonly Toast[]>([])
  private seq = 0

  mostrar(texto: string, tom: Toast['tom'] = 'neutro', duracaoMs = 4000): void {
    const id = ++this.seq
    this.toasts.update((ts) => [...ts, { id, texto, tom }])
    setTimeout(() => this.fechar(id), duracaoMs)
  }
  sucesso(texto: string): void { this.mostrar(texto, 'sucesso') }
  erro(texto: string): void { this.mostrar(texto, 'erro', 6000) }
  fechar(id: number): void { this.toasts.update((ts) => ts.filter((t) => t.id !== id)) }
}

/** Container global — montar UMA vez na raiz. */
@Component({
  selector: 'ui-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pilha" role="status" aria-live="polite">
      @for (t of servico.toasts(); track t.id) {
        <div class="toast" [attr.data-tom]="t.tom" (click)="servico.fechar(t.id)">{{ t.texto }}</div>
      }
    </div>
  `,
  styles: `
    .pilha { position: fixed; bottom: var(--espacamento-4); right: var(--espacamento-4);
      display: flex; flex-direction: column; gap: var(--espacamento-2); z-index: 1000; }
    .toast { padding: var(--espacamento-3) var(--espacamento-4); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); border: 1px solid var(--borda);
      box-shadow: var(--elevacao-dropdown); cursor: pointer; max-width: 360px; font-size: 14px; }
    .toast[data-tom='sucesso'] { border-color: var(--sucesso); }
    .toast[data-tom='erro'] { border-color: var(--erro); }
  `,
})
export class ToastsComponente {
  constructor(readonly servico: ToastServico) {}
}
