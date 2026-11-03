import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core'
import { ATALHOS_PERIODO, atalhoAtivo, hojeIso, periodoDoAtalho, type AtalhoPeriodo } from './periodo.js'

/** Período por atalhos (Hoje, 7 dias, 30 dias, Mês atual, Mês passado) ou datas livres. Datas em ISO yyyy-mm-dd. */
@Component({
  selector: 'ui-filtro-periodo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="periodo">
      <div class="atalhos" role="group" aria-label="Atalhos de período">
        @for (a of atalhos; track a.chave) {
          <button type="button" class="btn btn--pequeno" [class.btn--primario]="ativo() === a.chave"
                  [class.btn--secundario]="ativo() !== a.chave" [attr.aria-pressed]="ativo() === a.chave"
                  (click)="escolher(a.chave)">{{ a.rotulo }}</button>
        }
      </div>
      <label class="campo"><span class="txt-rotulo">De</span>
        <input type="date" [value]="inicio()" [max]="fim() || null" (change)="inicio.set(valor($event))" /></label>
      <label class="campo"><span class="txt-rotulo">Até</span>
        <input type="date" [value]="fim()" [min]="inicio() || null" (change)="fim.set(valor($event))" /></label>
      <ng-content />
      <button type="button" class="btn btn--primario btn--pequeno" (click)="aplicar.emit()">Aplicar</button>
    </div>
  `,
  styles: `
    :host { display: block; }
    .periodo { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3); }
    .atalhos { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
  `,
})
export class FiltroPeriodoComponente {
  readonly inicio = model('')
  readonly fim = model('')
  /** "Hoje" injetável para testes e para fuso de negócio; padrão é a data local. */
  readonly hoje = input<string | null>(null)
  readonly aplicar = output<void>()

  protected readonly atalhos = ATALHOS_PERIODO
  protected readonly ativo = computed(() => atalhoAtivo(this.inicio(), this.fim(), this.hoje() ?? hojeIso()))

  protected escolher(a: AtalhoPeriodo): void {
    const p = periodoDoAtalho(a, this.hoje() ?? hojeIso())
    this.inicio.set(p.inicio)
    this.fim.set(p.fim)
    this.aplicar.emit()
  }
  protected valor(e: Event): string { return (e.target as HTMLInputElement).value }
}
