import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { RouterLink } from '@angular/router'
import { itensDaTrilha, type ItemTrilha } from './breadcrumb.regras.js'

/** Trilha de navegação: A › B › C. O último item é texto (página atual). */
@Component({
  selector: 'ui-breadcrumb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <nav aria-label="Trilha">
      <ol>
        @for (i of vista(); track $index; let ultimo = $last) {
          <li class="txt-denso">
            @if (i.link) { <a [routerLink]="i.rota">{{ i.rotulo }}</a> }
            @else { <span [attr.aria-current]="ultimo ? 'page' : null" [class.atual]="ultimo">{{ i.rotulo }}</span> }
            @if (!ultimo) { <span class="sep" aria-hidden="true">›</span> }
          </li>
        }
      </ol>
    </nav>
  `,
  styles: `
    ol { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin: 0; padding: 0; list-style: none; }
    li { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); }
    a { color: var(--texto-secundario); text-decoration: none; border-radius: var(--raio-controle); }
    a:hover { color: var(--texto); text-decoration: underline; }
    a:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .atual { color: var(--texto); }
    .sep { color: var(--texto-suave); }
  `,
})
export class BreadcrumbComponente {
  readonly itens = input<readonly ItemTrilha[]>([])
  protected readonly vista = computed(() => itensDaTrilha(this.itens()))
}
