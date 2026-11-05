import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core'
import { comDebounce } from './lista.regras.js'

export const DEBOUNCE_BUSCA_MS = 300

/**
 * Cartão de filtros do padrão Lista: busca (debounce 300 ms) + controles projetados + Filtrar/Limpar.
 * `buscar` dispara com o texto já com debounce. Enter e o botão Filtrar disparam `aplicar` na hora —
 * e só `aplicar`: o texto vai por `buscar` se ainda não tinha sido entregue (nunca em duplicidade).
 */
@Component({
  selector: 'ui-filtros',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="cartao filtros" [class.compacto]="compacto()" (submit)="$event.preventDefault(); enviar()">
      <label class="campo busca">
        <span class="txt-rotulo" [class.so-leitor]="compacto()">{{ rotuloBusca() }}</span>
        <span class="entrada">
          <svg class="lupa" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" />
          </svg>
          <input type="search" [placeholder]="placeholder()"
                 [value]="termo" (input)="digitou($event)" />
        </span>
      </label>
      <ng-content />
      @if (!compacto()) {
        <div class="botoes">
          <button type="submit" class="btn btn--primario btn--pequeno">Filtrar</button>
          <button type="button" class="btn btn--secundario btn--pequeno" (click)="limparTudo()">Limpar</button>
        </div>
      }
    </form>
  `,
  styles: `
    :host { display: block; }
    .filtros { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3);
      padding: var(--espacamento-4); background: var(--superficie); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); }
    .busca { flex: 1 1 240px; min-width: 0; }
    .entrada { position: relative; display: block; }
    .lupa { position: absolute; left: var(--espacamento-3); top: 50%; transform: translateY(-50%); color: var(--texto-suave); pointer-events: none; }
    .entrada input { width: 100%; padding-left: calc(var(--espacamento-3) * 2 + 16px); }
    .compacto { padding: var(--espacamento-3); gap: var(--espacamento-2); }
    .compacto .busca { flex: 1 1 100%; }
    .so-leitor { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; border: 0; }
    .botoes { display: flex; gap: var(--espacamento-2); }
    @media (max-width: 640px) { .botoes { width: 100%; } .botoes .btn { flex: 1; } }
  `,
})
export class FiltrosComponente {
  readonly placeholder = input('Buscar')
  readonly rotuloBusca = input('Busca')
  /** Colunas estreitas (~300 px): sem Filtrar/Limpar (a busca já aplica com debounce; Enter aplica) e rótulo só para leitor de tela. */
  readonly compacto = input(false)
  readonly buscar = output<string>()
  readonly aplicar = output<void>()
  readonly limpar = output<void>()

  protected termo = ''
  /** Último texto entregue por `buscar`: o submit só reenvia se a digitação ainda não chegou. */
  private entregue = ''
  private readonly emitir = comDebounce((t: string) => { this.entregue = t; this.buscar.emit(t) }, DEBOUNCE_BUSCA_MS)

  constructor() { inject(DestroyRef).onDestroy(() => this.emitir.cancelar()) }

  protected digitou(e: Event): void {
    this.termo = (e.target as HTMLInputElement).value
    this.emitir(this.termo)
  }
  protected enviar(): void {
    this.emitir.cancelar()
    if (this.termo !== this.entregue) { this.entregue = this.termo; this.buscar.emit(this.termo) }
    this.aplicar.emit()
  }
  protected limparTudo(): void {
    this.emitir.cancelar()
    this.termo = ''
    this.entregue = ''
    this.buscar.emit('')
    this.limpar.emit()
  }
}
