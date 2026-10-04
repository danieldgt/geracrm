import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { pontosQualidade, rotuloQualidade } from './modelos-ia.regras.js'

/**
 * Qualidade de 1 a 5 em pontos preenchidos. ⚠️ Os pontos são decorativos: o
 * leitor de tela recebe "Qualidade 4 de 5" pelo `aria-label`, nunca cinco
 * círculos sem sentido.
 */
@Component({
  selector: 'ui-qualidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="pontos" role="img" [attr.aria-label]="rotulo()" [title]="rotulo()">
      @for (cheio of pontos(); track $index) {
        <span class="ponto" [class.cheio]="cheio" aria-hidden="true"></span>
      }
    </span>
  `,
  styles: `
    .pontos { display: inline-flex; gap: 3px; align-items: center; vertical-align: middle; }
    .ponto { width: 7px; height: 7px; border-radius: var(--raio-completo); background: var(--borda-forte); }
    .ponto.cheio { background: var(--texto-secundario); }
  `,
})
export class QualidadeComponente {
  readonly valor = input.required<number>()
  readonly pontos = computed(() => pontosQualidade(this.valor()))
  readonly rotulo = computed(() => rotuloQualidade(this.valor()))
}
