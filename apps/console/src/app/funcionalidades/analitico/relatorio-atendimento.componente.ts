import { ChangeDetectionStrategy, Component } from '@angular/core'
import { RelatorioNpsComponente } from './relatorio-nps.componente.js'
import { RelatorioPerformanceComponente } from './relatorio-performance.componente.js'

/**
 * Atendimento (Relatórios): o tempo de 1ª resposta humana e o NPS por atendente, na mesma aba — eram as
 * telas Performance e NPS, que respondiam juntas à pergunta "como a equipe atende?".
 */
@Component({
  selector: 'app-relatorio-atendimento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RelatorioNpsComponente, RelatorioPerformanceComponente],
  template: `
    <app-relatorio-performance />
    <app-relatorio-nps />
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-8); min-width: 0; }
  `,
})
export class RelatorioAtendimentoComponente {}
