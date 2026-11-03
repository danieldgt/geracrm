import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core'
import { EsqueletoComponente } from '../../compartilhado/ui/esqueleto.componente.js'
import { EstadoComponente } from '../../compartilhado/ui/estado.componente.js'
import { FiltroPeriodoComponente } from '../../compartilhado/ui/filtro-periodo.componente.js'
import type { EstadoRelatorio } from './carregador-relatorio.js'

/**
 * Moldura comum dos relatórios de gestão: filtro de período + os 5 estados da tela (carregando, vazio, erro,
 * sem permissão e pronto). O conteúdo do relatório entra por projeção e só aparece em `pronto` com dados.
 * Parâmetros extras do filtro (ex.: limite de minutos) entram no slot `[filtro]`.
 */
@Component({
  selector: 'app-relatorio-moldura',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EsqueletoComponente, EstadoComponente, FiltroPeriodoComponente],
  template: `
    <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="aplicar.emit()"><ng-content select="[filtro]" /></ui-filtro-periodo>

    @switch (estado()) {
      @case ('carregando') {
        <div class="cartoes"><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /></div>
        <ui-esqueleto altura="180px" />
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso aos relatórios" descricao="Peça a um administrador a permissão de leitura." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o relatório" [descricao]="erroTexto()">
          <button type="button" class="btn btn--secundario" (click)="tentar.emit()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (vazio()) {
          <ui-estado tipo="vazio" [titulo]="tituloVazio()" [descricao]="descricaoVazio()" />
        } @else {
          <ng-content />
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
  `,
})
export class RelatorioMolduraComponente {
  readonly inicio = model('')
  readonly fim = model('')
  readonly estado = input.required<EstadoRelatorio>()
  readonly erroTexto = input('')
  /** Pronto, mas sem nada a mostrar no período. */
  readonly vazio = input(false)
  readonly tituloVazio = input('Sem dados no período')
  readonly descricaoVazio = input('')
  readonly aplicar = output<void>()
  readonly tentar = output<void>()
}
