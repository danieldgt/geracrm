import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core'

export interface ItemDefinicao { readonly rotulo: string; readonly valor?: string | number | null; readonly mono?: boolean }

/** Valor vazio (null, undefined, string em branco) vira traço. */
export function valorDefinicao(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const s = String(v).trim()
  return s === '' ? '—' : s
}

/** Lista de definição (rótulo/valor) em 1 a 3 colunas. */
@Component({
  selector: 'ui-lista-definicao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <dl class="ui-lista-definicao" [class.ui-lista-definicao--2]="colunas() === 2" [class.ui-lista-definicao--3]="colunas() === 3">
      @for (i of itens(); track $index) {
        <div class="ui-lista-definicao__item">
          <dt class="txt-rotulo">{{ i.rotulo }}</dt>
          <dd class="txt-corpo" [class.txt-dados]="i.mono">{{ valor(i.valor) }}</dd>
        </div>
      }
    </dl>
  `,
  styles: `
    ui-lista-definicao { display: block; container-type: inline-size; }
    .ui-lista-definicao { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--espacamento-4); margin: 0; }
    .ui-lista-definicao__item { min-width: 0; }
    .ui-lista-definicao dt { margin: 0 0 var(--espacamento-1); }
    .ui-lista-definicao dd { margin: 0; color: var(--texto); overflow-wrap: anywhere; }
    @container (min-width: 480px) {
      .ui-lista-definicao--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ui-lista-definicao--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  `,
})
export class ListaDefinicaoComponente {
  readonly itens = input<readonly ItemDefinicao[]>([])
  readonly colunas = input<1 | 2 | 3>(1)
  protected readonly valor = valorDefinicao
}
