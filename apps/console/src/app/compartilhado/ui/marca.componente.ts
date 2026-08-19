import { Component, ChangeDetectionStrategy, input } from '@angular/core'

/**
 * Marca Drezz Hub — o arranjo de blocos do sistema da família drezz: duas pilhas
 * laterais (a empresa e o cliente) e uma peça que atravessa e une os dois lados.
 * A união é o único elemento em cor cheia, porque é ela o assunto do produto.
 *
 * A cor sai de `currentColor` (que herda `var(--marca)`) — nada de hex aqui, para
 * respeitar o lint R-12 da biblioteca. O segundo tom do sistema é obtido por
 * opacidade sobre a mesma cor, não por um hex terracota.
 *
 * `rotulo` liga o wordmark "Drezz Hub" ao lado do símbolo (o lockup padrão).
 */
@Component({
  selector: 'app-marca',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="simbolo" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <g opacity="0.55">
          <rect x="16" y="16" width="24" height="24" rx="7" />
          <rect x="88" y="16" width="24" height="24" rx="7" />
          <rect x="16" y="88" width="24" height="24" rx="7" />
          <rect x="88" y="88" width="24" height="24" rx="7" />
        </g>
        <rect x="16" y="52" width="96" height="24" rx="7" />
      </g>
    </svg>
    @if (rotulo()) {
      <span class="wordmark" [class.claro]="sobreCor()">
        <strong>Drezz</strong><span class="hub">Hub</span>
      </span>
    }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--espacamento-2); line-height: 0; color: var(--marca); }
    :host(.sobre-cor) { color: var(--acao-texto); }
    .simbolo { width: var(--marca-tam, 28px); height: var(--marca-tam, 28px); flex: none; }
    .wordmark { display: inline-flex; align-items: baseline; gap: 4px; line-height: 1; font-size: var(--marca-fonte, 17px); letter-spacing: -0.01em; }
    .wordmark strong { color: var(--texto); font-weight: 700; }
    .wordmark .hub { color: var(--marca); font-weight: 600; }
    :host(.sobre-cor) .wordmark strong { color: var(--acao-texto); }
    :host(.sobre-cor) .wordmark .hub { color: var(--acao-texto); opacity: .85; }
  `,
})
export class MarcaComponente {
  /** Mostra o wordmark "Drezz Hub" ao lado do símbolo. */
  readonly rotulo = input(false)
  /** Marca sobre superfície colorida (usa acao-texto). Aplique também a classe host `sobre-cor`. */
  readonly sobreCor = input(false)
}
