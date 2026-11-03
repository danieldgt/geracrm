import { NgTemplateOutlet } from '@angular/common'
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router, RouterLink } from '@angular/router'
import { filter, map } from 'rxjs'
import { abaAtiva, abaFocada, idDaAba, proximaAba, seletorDaAba, type Aba } from './abas.regras.js'

/**
 * Abas acessíveis (tablist, setas/Home/End). Com `rota` na aba, usa routerLink e
 * a aba ativa vem da URL; senão, do model `ativa`. As setas partem da aba FOCADA (com
 * rotas a ativa não muda ao mover o foco). Com `idPainel`, a aba ativa recebe
 * `aria-controls` e cada aba ganha um id (`idDaAba`); o painel da tela deve ter
 * `role="tabpanel"`, `[id]=idPainel` e `aria-labelledby` apontando para a aba ativa.
 */
@Component({
  selector: 'ui-abas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgTemplateOutlet],
  template: `
    <div class="abas" role="tablist" (keydown)="aoTeclar($event)">
      @for (a of abas(); track a.id) {
        @if (a.rota) {
          <a class="aba txt-corpo" role="tab" [routerLink]="a.rota" [attr.data-aba]="a.id"
             [attr.id]="idDe(a.id)" [attr.aria-controls]="controlaPainel(a.id)"
             [class.aba--ativa]="a.id === atual()" [attr.aria-selected]="a.id === atual()"
             [attr.tabindex]="a.id === atual() ? 0 : -1">
            <ng-container *ngTemplateOutlet="conteudo; context: { $implicit: a }" />
          </a>
        } @else {
          <button type="button" class="aba txt-corpo" role="tab" [attr.data-aba]="a.id"
                  [attr.id]="idDe(a.id)" [attr.aria-controls]="controlaPainel(a.id)"
                  [class.aba--ativa]="a.id === atual()" [attr.aria-selected]="a.id === atual()"
                  [attr.tabindex]="a.id === atual() ? 0 : -1" (click)="ativa.set(a.id)">
            <ng-container *ngTemplateOutlet="conteudo; context: { $implicit: a }" />
          </button>
        }
      }
    </div>
    <ng-template #conteudo let-a>
      @if (a.icone) { <span aria-hidden="true">{{ a.icone }}</span> }
      <span>{{ a.rotulo }}</span>
      @if (a.contador !== undefined) { <span class="contador txt-denso">{{ a.contador }}</span> }
    </ng-template>
  `,
  styles: `
    :host { display: block; }
    .abas { display: flex; gap: var(--espacamento-1); overflow-x: auto; overflow-y: hidden;
      border-bottom: 1px solid var(--borda); scrollbar-width: none; }
    .abas::-webkit-scrollbar { display: none; }
    .aba { flex: none; display: inline-flex; align-items: center; gap: var(--espacamento-2);
      min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-4);
      border: 0; border-bottom: 2px solid transparent; background: transparent;
      color: var(--texto-secundario); font: inherit; text-decoration: none; cursor: pointer; white-space: nowrap; }
    .aba:hover { color: var(--texto); }
    .aba--ativa { color: var(--acao); border-bottom-color: var(--acao); font-weight: 600; }
    .aba:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; border-radius: var(--raio-controle); }
    .contador { padding: 0 var(--espacamento-2); border-radius: var(--raio-controle);
      background: var(--superficie-hover); color: var(--texto-secundario); }
  `,
})
export class AbasComponente {
  readonly abas = input<readonly Aba[]>([])
  readonly ativa = model('')
  /** Id do painel que as abas controlam (opcional; ver doc do componente). */
  readonly idPainel = input<string | null>(null)

  private readonly router = inject(Router)
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef)
  private readonly url = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => e.urlAfterRedirects)),
    { initialValue: this.router.url },
  )
  protected readonly atual = computed(() => abaAtiva(this.abas(), this.ativa(), this.url()))

  protected idDe(abaId: string): string | null {
    const p = this.idPainel()
    return p ? idDaAba(p, abaId) : null
  }
  protected controlaPainel(abaId: string): string | null {
    return abaId === this.atual() ? this.idPainel() : null
  }

  protected aoTeclar(e: KeyboardEvent): void {
    const focada = abaFocada(e.target as Element | null) ?? this.atual()
    const prox = proximaAba(this.abas(), focada, e.key)
    if (!prox) return
    e.preventDefault()
    const alvo = this.abas().find((a) => a.id === prox)
    // Com rota, a seta só move o foco; Enter segue o link (ativação manual).
    if (alvo && !alvo.rota) this.ativa.set(prox)
    this.host.nativeElement.querySelector<HTMLElement>(seletorDaAba(prox))?.focus()
  }
}
