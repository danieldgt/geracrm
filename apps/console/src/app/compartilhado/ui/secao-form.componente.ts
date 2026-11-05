import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core'

/** Seção de formulário: título em maiúsculas pequenas (slot [icone] antes) e conteúdo. */
@Component({
  selector: 'ui-secao-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <section class="ui-secao-form">
      <h3 class="ui-secao-form__titulo txt-rotulo"><ng-content select="[icone]" />{{ titulo() }}</h3>
      <ng-content />
    </section>
  `,
  styles: `
    ui-secao-form { display: block; }
    .ui-secao-form { display: flex; flex-direction: column; gap: var(--espacamento-4); }
    .ui-secao-form__titulo { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0; }
  `,
})
export class SecaoFormComponente {
  readonly titulo = input('')
}
