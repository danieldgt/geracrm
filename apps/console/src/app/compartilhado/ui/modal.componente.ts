import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, input, output, untracked, viewChild,
} from '@angular/core'
import { devolverFoco, primeiroAlvoDeFoco, prenderTab } from './foco.js'

export type LarguraModal = 'p' | 'm' | 'g'

let serie = 0

/**
 * Modal de verdade: véu fixo, foco no primeiro campo e preso, Esc/véu fecham,
 * foco devolvido ao fechar. Corpo rola; o slot [rodape] fica fixo.
 * Abaixo de 720 px ocupa a tela inteira.
 *
 *   <ui-modal [aberto]="aberto()" titulo="Novo contato" largura="m" (fechar)="aberto.set(false)">
 *     ...corpo...
 *     <div rodape>botões</div>
 *   </ui-modal>
 */
@Component({
  selector: 'ui-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (aberto()) {
      <div class="overlay" (click)="fechar.emit()">
        <div #caixa class="modal" [class.modal--p]="largura() === 'p'" [class.modal--g]="largura() === 'g'"
             role="dialog" aria-modal="true" tabindex="-1"
             [attr.aria-labelledby]="idTitulo" (click)="$event.stopPropagation()"
             (keydown)="aoTeclar($event)">
          <header class="cab">
            <h2 [id]="idTitulo" class="txt-secao">{{ titulo() }}</h2>
            <button type="button" class="x" aria-label="Fechar" (click)="fechar.emit()">×</button>
          </header>
          <div class="corpo"><ng-content /></div>
          <footer class="rodape"><ng-content select="[rodape]" /></footer>
        </div>
      </div>
    }
  `,
  styles: `
    .overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
      padding: var(--espacamento-4); background: var(--fundo-sobreposicao, rgb(0 0 0 / .4)); }
    .modal { display: flex; flex-direction: column; width: 100%; max-width: 640px; max-height: 100%; min-height: 0;
      background: var(--superficie-elevada); color: var(--texto); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); outline: none; }
    .modal--p { max-width: 420px; }
    .modal--g { max-width: 960px; }
    .cab { flex: none; display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3);
      padding: var(--espacamento-4) var(--espacamento-6); border-bottom: 1px solid var(--borda); }
    h2 { margin: 0; }
    .x { flex: none; min-width: var(--densidade-alvo-clique-console); min-height: var(--densidade-alvo-clique-console);
      border: 0; background: transparent; color: var(--texto-secundario); font: inherit; font-size: 20px;
      border-radius: var(--raio-controle); cursor: pointer; }
    .x:hover { background: var(--superficie-hover); color: var(--texto); }
    .x:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .corpo { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--espacamento-6); }
    .rodape { flex: none; display: flex; justify-content: flex-end; gap: var(--espacamento-2); flex-wrap: wrap;
      padding: var(--espacamento-4) var(--espacamento-6); border-top: 1px solid var(--borda); }
    .rodape:empty { display: none; }
    @media (max-width: 719px) {
      .overlay { padding: 0; }
      .modal { max-width: none; height: 100%; border-radius: 0; border: 0; }
    }
  `,
})
export class ModalComponente {
  readonly aberto = input(false)
  readonly titulo = input('')
  readonly largura = input<LarguraModal>('m')
  readonly fechar = output<void>()

  protected readonly idTitulo = `ui-modal-titulo-${++serie}`
  private readonly caixa = viewChild<ElementRef<HTMLElement>>('caixa')
  private anterior: Element | null = null

  constructor() {
    afterRenderEffect(() => {
      const el = this.caixa()?.nativeElement
      if (this.aberto() && el) {
        untracked(() => {
          if (!el.contains(document.activeElement)) {
            this.anterior ??= document.activeElement
            ;(primeiroAlvoDeFoco(el) ?? el).focus()
          }
        })
      } else if (!this.aberto() && this.anterior) {
        const volta = this.anterior
        this.anterior = null
        devolverFoco(volta)
      }
    })
  }

  protected aoTeclar(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); this.fechar.emit(); return }
    const el = this.caixa()?.nativeElement
    if (el && prenderTab(el, e, document.activeElement)) e.preventDefault()
  }
}
