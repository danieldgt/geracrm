import { ChangeDetectionStrategy, Component } from '@angular/core'

/** Painel/cartão do bloco 1 (R-12): superfície elevada com borda e raio. */
@Component({
  selector: 'ui-painel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="painel"><ng-content /></section>`,
  styles: `
    .painel {
      background: var(--superficie-elevada);
      border: 1px solid var(--borda);
      border-radius: var(--raio-painel);
      padding: var(--espacamento-6);
    }
  `,
})
export class PainelComponente {}
