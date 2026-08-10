import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/**
 * Botão do bloco 1 (R-12). ⚠️ Cor SÓ de token — nunca `#hex` (lint anti-cor).
 * Variantes: primário (ação), secundário (borda), perigo, fantasma (texto).
 */
@Component({
  selector: 'ui-botao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button [type]="tipo()" [disabled]="desabilitado() || carregando()"
            [attr.data-variante]="variante()" [class.bloco]="bloco()">
      @if (carregando()) { <span class="spin" aria-hidden="true"></span> }
      <ng-content />
    </button>
  `,
  styles: `
    button {
      display: inline-flex; align-items: center; justify-content: center; gap: var(--espacamento-2);
      min-height: var(--densidade-alvo-clique-console);
      padding: var(--espacamento-2) var(--espacamento-4);
      border-radius: var(--raio-controle); border: 1px solid transparent;
      font: inherit; font-weight: 600; cursor: pointer;
      transition: background var(--movimento-estado-duracao) var(--movimento-estado-curva);
    }
    button:disabled { opacity: .55; cursor: default; }
    button.bloco { width: 100%; }
    button[data-variante='primario'] { background: var(--acao); color: var(--acao-texto); }
    button[data-variante='primario']:hover:not(:disabled) { background: var(--acao-hover); }
    button[data-variante='primario']:active:not(:disabled) { background: var(--acao-pressionada); }
    button[data-variante='secundario'] { background: var(--fundo); color: var(--texto); border-color: var(--borda-controle); }
    button[data-variante='secundario']:hover:not(:disabled) { background: var(--superficie-elevada); }
    button[data-variante='perigo'] { background: var(--erro); color: var(--acao-texto); }
    button[data-variante='fantasma'] { background: transparent; color: var(--acao); }
    button[data-variante='fantasma']:hover:not(:disabled) { background: var(--superficie-elevada); }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .spin { width: 14px; height: 14px; border-radius: var(--raio-completo);
      border: 2px solid currentColor; border-top-color: transparent; animation: gira .7s linear infinite; }
    @keyframes gira { to { transform: rotate(360deg) } }
  `,
})
export class BotaoComponente {
  readonly variante = input<'primario' | 'secundario' | 'perigo' | 'fantasma'>('primario')
  readonly tipo = input<'button' | 'submit'>('button')
  readonly desabilitado = input(false)
  readonly carregando = input(false)
  readonly bloco = input(false)
}
