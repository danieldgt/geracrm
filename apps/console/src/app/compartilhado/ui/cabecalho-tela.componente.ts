import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/** Cabeçalho de tela do bloco 1 (R-12): título + subtítulo + ações (slot). */
@Component({
  selector: 'ui-cabecalho-tela',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cab">
      <div class="txt">
        <h1>{{ titulo() }}</h1>
        @if (subtitulo()) { <p>{{ subtitulo() }}</p> }
      </div>
      <div class="acoes"><ng-content /></div>
    </header>
  `,
  styles: `
    .cab { display: flex; align-items: flex-start; justify-content: space-between;
      gap: var(--espacamento-4); margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    p { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .acoes { display: flex; gap: var(--espacamento-2); flex: none; }
  `,
})
export class CabecalhoTelaComponente {
  readonly titulo = input('')
  readonly subtitulo = input('')
}
