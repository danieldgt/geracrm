import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core'
import { textoMostrando } from './lista.regras.js'

/** Rodapé do padrão Lista. Paginação por CURSOR: só "Carregar mais", nunca página numerada. */
@Component({
  selector: 'ui-paginacao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rodape">
      <span class="txt-denso contagem" aria-live="polite">{{ texto() }}</span>
      @if (temMais()) {
        <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="carregando()" (click)="mais.emit()">
          {{ carregando() ? 'Carregando…' : 'Carregar mais' }}
        </button>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .rodape { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3);
      padding: var(--espacamento-2) var(--espacamento-1); }
    .contagem { color: var(--texto-secundario); }
  `,
})
export class PaginacaoComponente {
  readonly mostrados = input.required<number>()
  readonly total = input<number | null | undefined>(undefined)
  readonly temMais = input(false)
  readonly carregando = input(false)
  readonly mais = output<void>()
  protected readonly texto = computed(() => textoMostrando(this.mostrados(), this.total()))
}
