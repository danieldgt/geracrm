import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core'
import { ATALHOS_PERIODO, atalhoAtivo, hojeIso, periodoDoAtalho, periodoInvertido, type AtalhoPeriodo } from './periodo.js'

/**
 * Período por atalhos (Hoje, 7 dias, 30 dias, Mês atual, Mês passado) ou datas livres. Datas em ISO yyyy-mm-dd.
 * O atalho aplica na hora (e fica marcado como selecionado, não como botão cheio); as datas livres
 * esperam o "Aplicar". Dentro de um `ui-filtros`, ocupa a linha inteira.
 */
@Component({
  selector: 'ui-filtro-periodo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="periodo">
      <div class="atalhos" role="group" aria-label="Atalhos de período">
        @for (a of atalhos; track a.chave) {
          <button type="button" class="atalho" [class.atalho--ativo]="ativo() === a.chave"
                  [attr.aria-pressed]="ativo() === a.chave" (click)="escolher(a.chave)">{{ a.rotulo }}</button>
        }
      </div>
      <div class="datas">
        <label class="campo"><span class="txt-rotulo">De</span>
          <input type="date" [value]="inicio()" [max]="fim() || null" (change)="inicio.set(valor($event))" /></label>
        <label class="campo"><span class="txt-rotulo">Até</span>
          <input type="date" [value]="fim()" [min]="inicio() || null" (change)="fim.set(valor($event))" /></label>
        <ng-content />
        <button type="button" class="btn btn--secundario aplicar" [disabled]="invertido()"
                (click)="aplicar.emit()">Aplicar</button>
      </div>
      @if (invertido()) {
        <span class="erro txt-denso" role="alert">A data inicial é depois da final.</span>
      }
    </div>
  `,
  styles: `
    /* Dentro de um ui-filtros (grade), o período ocupa a linha inteira. Fora dele, não tem efeito. */
    :host { display: block; grid-column: 1 / -1; min-width: 0; }
    /* Dois blocos que quebram INTEIROS: os atalhos (um controle segmentado) e o par De/Até + Aplicar. */
    .periodo { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3) var(--espacamento-4); }
    .atalhos { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); overflow: hidden; background: var(--superficie-elevada); }
    .atalho { min-height: var(--densidade-alvo-clique-console); padding: 0 var(--espacamento-3); border: 0;
      border-right: 1px solid var(--borda-controle); background: transparent; color: var(--texto-secundario);
      font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
    .atalho:last-child { border-right: 0; }
    .atalho:hover { background: var(--superficie-hover); color: var(--texto); }
    .atalho--ativo, .atalho--ativo:hover { background: var(--acao-suave); color: var(--acao); font-weight: 600; }
    .atalho:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .datas { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-2); min-width: 0; }
    .datas .campo { min-width: 0; }
    .datas input[type='date'] { width: 150px; max-width: 100%; }
    .aplicar { white-space: nowrap; }
    .erro { flex-basis: 100%; color: var(--erro); }
  `,
})
export class FiltroPeriodoComponente {
  readonly inicio = model('')
  readonly fim = model('')
  /** "Hoje" injetável para testes e para fuso de negócio; padrão é a data local. */
  readonly hoje = input<string | null>(null)
  readonly aplicar = output<void>()

  protected readonly atalhos = ATALHOS_PERIODO
  protected readonly invertido = computed(() => periodoInvertido(this.inicio(), this.fim()))
  protected readonly ativo = computed(() => atalhoAtivo(this.inicio(), this.fim(), this.hoje() ?? hojeIso()))

  protected escolher(a: AtalhoPeriodo): void {
    const p = periodoDoAtalho(a, this.hoje() ?? hojeIso())
    this.inicio.set(p.inicio)
    this.fim.set(p.fim)
    this.aplicar.emit()
  }
  protected valor(e: Event): string { return (e.target as HTMLInputElement).value }
}
