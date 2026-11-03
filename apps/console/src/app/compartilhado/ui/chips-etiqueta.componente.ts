import { ChangeDetectionStrategy, Component, input, model } from '@angular/core'

export interface OpcaoChip { readonly valor: string; readonly rotulo: string; readonly cor?: string }

/** Liga/desliga um valor na seleção (devolve nova lista, sem mutar). */
export function alternarChip(selecionadas: readonly string[], valor: string): string[] {
  return selecionadas.includes(valor) ? selecionadas.filter((v) => v !== valor) : [...selecionadas, valor]
}

/** Chips de etiqueta selecionáveis. `cor` é um token CSS, ex.: var(--sucesso). */
@Component({
  selector: 'ui-chips-etiqueta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chips" role="group">
      @for (o of opcoes(); track o.valor) {
        <button type="button" class="chip txt-denso" [class.chip--on]="selecionadas().includes(o.valor)"
                [attr.aria-pressed]="selecionadas().includes(o.valor)" (click)="alternar(o.valor)">
          @if (o.cor) { <span class="ponto" aria-hidden="true" [style.background]="o.cor"></span> }
          {{ o.rotulo }}
        </button>
      }
    </div>
  `,
  styles: `
    .chips { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-2); min-height: var(--densidade-alvo-clique-console);
      padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: 999px; background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; cursor: pointer; }
    .chip:hover { background: var(--superficie-hover); color: var(--texto); }
    .chip--on { border-color: var(--acao); color: var(--acao); font-weight: 600; }
    .chip:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .ponto { width: 8px; height: 8px; border-radius: 50%; }
  `,
})
export class ChipsEtiquetaComponente {
  readonly opcoes = input<readonly OpcaoChip[]>([])
  readonly selecionadas = model<string[]>([])
  protected alternar(valor: string): void { this.selecionadas.set(alternarChip(this.selecionadas(), valor)) }
}
