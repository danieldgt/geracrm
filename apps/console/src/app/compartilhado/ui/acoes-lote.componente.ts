import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core'
import { textoSelecionados } from './lista.regras.js'

/**
 * Faixa de seleção do padrão Lista: "N selecionado(s)" + botões projetados + Limpar seleção. Some em 0.
 * `quantidade` deve vir do `selecionados` da `ui-tabela`, que já é podado às linhas visíveis quando
 * `linhas` muda — a faixa nunca anuncia seleção que o usuário não enxerga.
 */
@Component({
  selector: 'ui-acoes-lote',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (quantidade() > 0) {
      <div class="faixa" role="region" aria-label="Ações em lote">
        <span class="txt-corpo contagem" aria-live="polite">{{ texto() }}</span>
        <div class="acoes"><ng-content /></div>
        <button type="button" class="btn btn--fantasma btn--pequeno" (click)="limpar.emit()">Limpar seleção</button>
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .faixa { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3);
      padding: var(--espacamento-2) var(--espacamento-4); background: var(--acao-suave);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); }
    .contagem { font-weight: 600; color: var(--texto); }
    .acoes { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); flex: 1 1 auto; min-width: 0; }
  `,
})
export class AcoesLoteComponente {
  readonly quantidade = input.required<number>()
  readonly limpar = output<void>()
  protected readonly texto = computed(() => textoSelecionados(this.quantidade()))
}
