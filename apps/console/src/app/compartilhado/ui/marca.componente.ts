import { Component, ChangeDetectionStrategy, input } from '@angular/core'

/**
 * Marca Drezz Hub — o monograma "D" da identidade Drezz, adaptado ao contexto:
 * o cluster de pixels da Drezz vira os NÓS de um hub, e a cauda em ponta lê como
 * um balão de conversa (é um CRM de atendimento). A cor sai de `var(--marca)`
 * (token) — nada de hex aqui, para respeitar o lint R-12 da biblioteca; a máscara
 * usa `white`/`black` (palavras, não hex) porque luminância é o que importa nela.
 *
 * `rotulo` liga o wordmark "Drezz Hub" ao lado do símbolo (o lockup padrão).
 */
@Component({
  selector: 'app-marca',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="simbolo" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <defs>
        <mask id="marca-recorte">
          <rect width="128" height="128" fill="white" />
          <rect x="40" y="20" width="14" height="14" fill="black" />
        </mask>
      </defs>
      <g fill="currentColor">
        <g mask="url(#marca-recorte)">
          <rect x="40" y="20" width="18" height="88" rx="2" />
          <path d="M49 20 H74 a44 44 0 0 1 0 88 H49 V90 h25 a26 26 0 0 0 0-52 H49 Z" />
        </g>
        <path d="M41 90 L26 116 L59 103 Z" />
        <rect x="17" y="53" width="11" height="11" rx="2" />
        <rect x="3"  y="53" width="11" height="11" rx="2" />
        <rect x="17" y="39" width="11" height="11" rx="2" />
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
