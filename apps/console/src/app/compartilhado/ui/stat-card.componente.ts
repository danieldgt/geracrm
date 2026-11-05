import { ChangeDetectionStrategy, Component, input } from '@angular/core'

export type TomStat = 'acao' | 'sucesso' | 'atencao' | 'erro' | 'ia' | 'neutro'

/**
 * Cartão de indicador. Ícone entra por slot (`<svg uiIcone>` ou qualquer elemento com
 * atributo uiIcone) para não depender do componente de ícones.
 */
@Component({
  selector: 'ui-stat-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stat" [attr.data-tom]="tom()">
      <span class="icone" aria-hidden="true"><ng-content select="[uiIcone]" /></span>
      <div class="texto">
        @if (rotuloAcima()) { <span class="txt-rotulo">{{ rotulo() }}</span> }
        <span class="txt-kpi valor">{{ valor() }}</span>
        @if (!rotuloAcima()) { <span class="txt-denso rotulo">{{ rotulo() }}</span> }
      </div>
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .stat { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-4);
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); min-width: 0; }
    .icone { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 40px; height: 40px;
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); }
    .icone:empty { display: none; }
    .texto { display: flex; flex-direction: column; min-width: 0; }
    .valor { color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rotulo { color: var(--texto-secundario); }
    [data-tom='acao'] .icone { background: var(--acao-suave); color: var(--acao); }
    [data-tom='sucesso'] .icone { background: var(--sucesso-suave); color: var(--sucesso); }
    [data-tom='atencao'] .icone { background: var(--atencao-suave); color: var(--atencao); }
    [data-tom='erro'] .icone { background: var(--erro-suave); color: var(--erro); }
    [data-tom='ia'] .icone { background: var(--ia-suave); color: var(--ia); }
  `,
})
export class StatCardComponente {
  readonly valor = input.required<string | number>()
  readonly rotulo = input.required<string>()
  readonly tom = input<TomStat>('neutro')
  readonly rotuloAcima = input(false)
}
