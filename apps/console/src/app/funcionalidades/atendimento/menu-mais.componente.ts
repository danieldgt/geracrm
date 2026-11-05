import {
  ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild,
} from '@angular/core'
import { IconeComponente } from '../../compartilhado/ui/icone.componente.js'
import { ordenarItensMenu, proximoItemMenu, type ItemMenuMais } from './menu-mais.regras.js'

/**
 * Menu "⋯" das ações secundárias de um cabeçalho (conversa, ficha do contato).
 *
 * ⚠️ Uma ação cheia por área: o primário fica à vista; o resto mora aqui. Botão
 * com `aria-haspopup="menu"`, lista `role="menu"`, foco no primeiro item ao
 * abrir, setas/Home/End, Esc e clique fora fecham e devolvem o foco ao "⋯".
 * Destrutivo por último, em cor de perigo. Sem itens, o botão nem aparece.
 */
@Component({
  selector: 'app-menu-mais',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconeComponente],
  template: `
    @if (lista().length) {
      <button #gatilho type="button" class="mais" aria-haspopup="menu" [attr.aria-expanded]="aberto()"
              [attr.aria-label]="rotulo()" [title]="rotulo()" (click)="alternar()">
        <ui-icone nome="more-horizontal" [tamanho]="18" />
      </button>
      @if (aberto()) {
        <div class="fora" (click)="fechar(true)"></div>
        <div #menu class="menu" role="menu" [attr.aria-label]="rotulo()" (keydown)="aoTeclar($event)">
          @for (it of lista(); track it.id; let i = $index) {
            <button type="button" role="menuitem" class="item" tabindex="-1" [class.perigo]="it.perigo"
                    [disabled]="it.desabilitado" [attr.aria-disabled]="it.desabilitado || null"
                    [title]="it.dica ?? ''" (click)="escolherItem(it)">{{ it.rotulo }}</button>
          }
        </div>
      }
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; flex: none; }
    .mais { display: inline-grid; place-items: center; width: var(--densidade-alvo-clique-console, 32px);
      height: var(--densidade-alvo-clique-console, 32px); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: transparent; color: var(--texto-secundario); cursor: pointer; }
    .mais:hover, .mais[aria-expanded='true'] { background: var(--superficie-hover); color: var(--texto); }
    .mais:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    /* Fora: fecha no clique. Fixo, na camada dos menus (>= piso dos modais). */
    .fora { position: fixed; inset: 0; z-index: 44; }
    .menu { position: absolute; top: calc(100% + var(--espacamento-1)); right: 0; z-index: 45; min-width: 200px;
      display: flex; flex-direction: column; padding: var(--espacamento-1); background: var(--superficie-elevada);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); box-shadow: var(--elevacao-dropdown); }
    .item { text-align: left; padding: var(--espacamento-2) var(--espacamento-3); border: 0; border-radius: var(--raio-controle);
      background: transparent; color: var(--texto); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .item:hover:not(:disabled), .item:focus-visible { background: var(--superficie-hover); outline: none; }
    .item:disabled { color: var(--texto-suave); cursor: default; }
    .item.perigo { color: var(--erro); }
  `,
})
export class MenuMaisComponente {
  readonly itens = input<readonly ItemMenuMais[]>([])
  readonly rotulo = input('Mais ações')
  readonly escolher = output<string>()

  readonly aberto = signal(false)
  protected readonly lista = computed(() => ordenarItensMenu(this.itens()))
  private readonly gatilho = viewChild<ElementRef<HTMLButtonElement>>('gatilho')
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu')

  alternar(): void {
    if (this.aberto()) { this.fechar(true); return }
    this.aberto.set(true)
    requestAnimationFrame(() => this.focar(proximoItemMenu(this.lista(), -1, 'ArrowDown')))
  }

  fechar(devolverFoco: boolean): void {
    this.aberto.set(false)
    if (devolverFoco) this.gatilho()?.nativeElement.focus()
  }

  escolherItem(it: ItemMenuMais): void {
    if (it.desabilitado) return
    // Fecha sem devolver o foco ao "⋯": a ação costuma abrir um modal, que pega o foco.
    this.fechar(false)
    this.escolher.emit(it.id)
  }

  aoTeclar(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.fechar(true); return }
    if (ev.key === 'Tab') { this.fechar(false); return }
    const botoes = this.botoes()
    const atual = botoes.indexOf(document.activeElement as HTMLButtonElement)
    const prox = proximoItemMenu(this.lista(), atual, ev.key)
    if (prox === null) return
    ev.preventDefault()
    this.focar(prox)
  }

  private botoes(): HTMLButtonElement[] {
    const el = this.menu()?.nativeElement
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : []
  }

  private focar(i: number | null): void {
    if (i !== null) this.botoes()[i]?.focus()
  }
}
