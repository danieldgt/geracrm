import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core'
import type { DiffSecaoPlaybook } from '@geracrm/shared'

/**
 * Diff por seção do playbook (P17): só as seções que mudaram, campo a campo,
 * com antes e depois. Pura apresentação — o cálculo é `diffPorSecao` (shared).
 */
@Component({
  selector: 'app-playbook-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mudaram().length === 0) {
      <p class="dica">{{ vazio() }}</p>
    } @else {
      @for (s of mudaram(); track s.secao) {
        <section class="secao">
          <h4 class="txt-secao">{{ s.rotulo }} <span class="meta">{{ s.mudancas.length }} mudança(s)</span></h4>
          <dl class="linhas">
            @for (m of s.mudancas; track m.campo) {
              <dt class="encolhe">{{ m.campo }}</dt>
              <dd>
                @if (m.antes !== null) { <span class="antes">{{ m.antes }}</span> }
                @if (m.antes !== null && m.depois !== null) { <span class="seta" aria-hidden="true">→</span> }
                @if (m.depois !== null) { <span class="depois">{{ m.depois }}</span> } @else { <span class="antes">(removido)</span> }
              </dd>
            }
          </dl>
        </section>
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .dica { margin: 0; color: var(--texto-suave); font-size: 13px; }
    .secao + .secao { margin-top: var(--espacamento-3); }
    h4 { margin: 0 0 var(--espacamento-1); display: flex; gap: var(--espacamento-2); align-items: baseline; }
    .meta { color: var(--texto-suave); font-size: 12px; font-weight: 400; }
    .linhas { display: grid; grid-template-columns: minmax(120px, 220px) 1fr; gap: var(--espacamento-1) var(--espacamento-3); margin: 0; font-size: 13px; }
    dt { color: var(--texto-secundario); overflow-wrap: anywhere; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; display: flex; gap: var(--espacamento-1); flex-wrap: wrap; align-items: baseline; }
    .antes { color: var(--texto-suave); text-decoration: line-through; background: var(--erro-suave); padding: 0 var(--espacamento-1); border-radius: var(--raio-controle); }
    .depois { color: var(--texto); background: var(--sucesso-suave); padding: 0 var(--espacamento-1); border-radius: var(--raio-controle); }
    .seta { color: var(--texto-suave); }
    @media (max-width: 640px) { .linhas { grid-template-columns: 1fr; } }
  `,
})
export class PlaybookDiffComponente {
  readonly diff = input.required<readonly DiffSecaoPlaybook[]>()
  readonly vazio = input('Nenhuma diferença.')
  readonly mudaram = computed(() => this.diff().filter((d) => d.mudou))
}
