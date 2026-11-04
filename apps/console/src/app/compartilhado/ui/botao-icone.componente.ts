import { ChangeDetectionStrategy, Component, input } from '@angular/core'
import { IconeComponente } from './icone.componente.js'

/**
 * Botão quadrado só com ícone (subir/descer, remover, menu ⋯). Acessível: `rotulo` é obrigatório e vira
 * `aria-label` e `title`. Tamanhos `p` (28 px, para linhas densas) e `m` (alvo de clique do console).
 * Variante `perigo` para ações destrutivas. O clique sai pelo host: `(click)` no `<ui-botao-icone>`;
 * desabilitado não dispara.
 *
 *   <ui-botao-icone icone="trash-2" rotulo="Remover telefone 2" variante="perigo" (click)="remover(1)" />
 */
@Component({
  selector: 'ui-botao-icone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconeComponente],
  host: { '[style.pointer-events]': "desabilitado() ? 'none' : null" },
  template: `
    <button type="button" [disabled]="desabilitado()" [attr.aria-label]="rotulo()" [attr.title]="rotulo()"
            [attr.data-tamanho]="tamanho()" [attr.data-variante]="variante()">
      <ui-icone [nome]="icone()" [tamanho]="tamanho() === 'p' ? 14 : 18" />
    </button>
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
    button { display: inline-grid; place-items: center; padding: 0; border: 1px solid transparent;
      border-radius: var(--raio-controle); background: transparent; color: var(--texto-secundario); cursor: pointer; }
    button[data-tamanho='m'] { width: var(--densidade-alvo-clique-console); height: var(--densidade-alvo-clique-console); }
    button[data-tamanho='p'] { width: 28px; height: 28px; }
    button:hover:not(:disabled) { background: var(--superficie-hover); color: var(--texto); }
    button[data-variante='perigo'] { color: var(--erro); }
    button[data-variante='perigo']:hover:not(:disabled) { background: var(--erro-suave); color: var(--erro); }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `,
})
export class BotaoIconeComponente {
  /** Nome do `ui-icone` (Lucide, kebab-case). */
  readonly icone = input.required<string>()
  /** Obrigatório: nome acessível e dica de passar o mouse. */
  readonly rotulo = input.required<string>()
  readonly tamanho = input<'p' | 'm'>('m')
  readonly variante = input<'neutro' | 'perigo'>('neutro')
  readonly desabilitado = input(false)
}
