import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core'

/**
 * Grade de campos: 2 (ou 3) colunas, 1 coluna abaixo de 640 px DO CONTÊINER
 * (container query — o trilho de chat muda a largura útil, não o viewport).
 * Filho com a classe `largo` (ou atributo `largo`) ocupa a linha toda.
 */
@Component({
  selector: 'ui-grade-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `<div class="ui-grade-form" [class.ui-grade-form--3]="colunas() === 3"><ng-content /></div>`,
  styles: `
    ui-grade-form { display: block; container-type: inline-size; }
    .ui-grade-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--espacamento-4); }
    @container (min-width: 640px) {
      .ui-grade-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ui-grade-form--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ui-grade-form > .largo, .ui-grade-form > [largo] { grid-column: 1 / -1; }
    }
  `,
})
export class GradeFormComponente {
  readonly colunas = input<2 | 3>(2)
}
