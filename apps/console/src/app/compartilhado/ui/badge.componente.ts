import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/** Badge do bloco 1 (R-12). Tom por token — ordem fixa na leitura periférica. */
@Component({
  selector: 'ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge" [attr.data-tom]="tom()"><ng-content /></span>`,
  styles: `
    .badge { display: inline-flex; align-items: center; gap: var(--espacamento-1);
      font-size: 11px; font-weight: 600; line-height: 1; padding: 3px 8px;
      border-radius: var(--raio-completo); border: 1px solid transparent; white-space: nowrap; }
    .badge[data-tom='neutro'] { color: var(--texto-secundario); border-color: var(--borda); }
    .badge[data-tom='sucesso'] { color: var(--sucesso); border-color: var(--sucesso); }
    .badge[data-tom='atencao'] { color: var(--atencao); border-color: var(--atencao); }
    .badge[data-tom='erro'] { color: var(--erro); border-color: var(--erro); }
    .badge[data-tom='info'] { color: var(--acao); border-color: var(--acao); }
  `,
})
export class BadgeComponente {
  readonly tom = input<'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'>('neutro')
}
