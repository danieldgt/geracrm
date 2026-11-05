import { ChangeDetectionStrategy, Component, input } from '@angular/core'
import { baixarCsv, paraCsv, type ColunaCsv } from './csv.js'

/** Exporta as linhas JÁ carregadas na tela (a página atual do cursor) para CSV com BOM, separador ponto e vírgula. */
@Component({
  selector: 'ui-botao-csv',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="linhas().length === 0" (click)="exportar()">
      <ng-content>Exportar CSV</ng-content>
    </button>
  `,
  styles: `:host { display: inline-block; }`,
})
export class BotaoCsvComponente {
  readonly colunas = input.required<readonly ColunaCsv[]>()
  readonly linhas = input<readonly Record<string, unknown>[]>([])
  readonly arquivo = input('exportacao')
  readonly virgulaDecimal = input(true)

  protected exportar(): void {
    baixarCsv(this.arquivo(), paraCsv(this.colunas(), this.linhas(), { virgulaDecimal: this.virgulaDecimal() }))
  }
}
