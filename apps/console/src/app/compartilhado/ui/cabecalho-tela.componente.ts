import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core'
import { TELA_EMBUTIDA } from './embutida.js'

/**
 * Cabeçalho de tela do bloco 1 (R-12): título + subtítulo + ações (slot).
 *
 * ⚠️ Embutida como aba (`TELA_EMBUTIDA`), o título e o subtítulo somem — a tela
 * com abas já diz o nome — e só a linha de ações fica, à direita. Sem ações, a
 * linha some (`:has(.acoes:empty)`).
 */
@Component({
  selector: 'ui-cabecalho-tela',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cab" [class.embutida]="embutida">
      @if (!embutida) {
        <div class="txt">
          <ng-content select="[trilha]" />
          <h1 class="txt-titulo">{{ titulo() }}</h1>
          @if (subtitulo()) { <p class="txt-corpo">{{ subtitulo() }}</p> }
        </div>
      }
      <div class="acoes"><ng-content /></div>
    </header>
  `,
  styles: `
    /* Quando o título e as ações não cabem lado a lado (celular, chat aberto), as
       ações descem para baixo do título — nunca espremem o título numa coluna. */
    .cab { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
      gap: var(--espacamento-3) var(--espacamento-4); margin-bottom: var(--espacamento-5); }
    .txt { flex: 1 1 280px; min-width: 0; }
    .cab.embutida { justify-content: flex-end; margin-bottom: var(--espacamento-4); }
    .cab.embutida:has(.acoes:empty) { display: none; }
    h1 { margin: 0; color: var(--texto); }
    p { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); }
    .acoes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--espacamento-2); flex: 0 1 auto; }
  `,
})
export class CabecalhoTelaComponente {
  readonly titulo = input('')
  readonly subtitulo = input('')
  protected readonly embutida = inject(TELA_EMBUTIDA, { optional: true }) === true
}
