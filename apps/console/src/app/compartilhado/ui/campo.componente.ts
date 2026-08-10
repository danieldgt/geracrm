import { ChangeDetectionStrategy, Component, input, model } from '@angular/core'

/** Campo de texto do bloco 1 (R-12): rótulo + input + erro tipificado. */
@Component({
  selector: 'ui-campo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="campo">
      @if (rotulo()) { <span class="rotulo">{{ rotulo() }}</span> }
      <input [type]="tipo()" [placeholder]="placeholder()" [value]="valor()"
             [disabled]="desabilitado()" [attr.autocomplete]="autocomplete()"
             [attr.aria-invalid]="erro() ? 'true' : null"
             (input)="valor.set($any($event.target).value)" />
      @if (erro()) { <span class="msg-erro">{{ erro() }}</span> }
    </label>
  `,
  styles: `
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); }
    .rotulo { font-size: 13px; color: var(--texto); }
    input {
      min-height: var(--densidade-alvo-clique-console);
      padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--fundo); color: var(--texto); font: inherit;
    }
    input::placeholder { color: var(--texto-secundario); }
    input:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    input[aria-invalid='true'] { border-color: var(--borda-erro); }
    input:disabled { opacity: .6; }
    .msg-erro { font-size: 12px; color: var(--erro); }
  `,
})
export class CampoComponente {
  readonly valor = model('')
  readonly rotulo = input('')
  readonly placeholder = input('')
  readonly tipo = input<'text' | 'password' | 'email' | 'tel' | 'search'>('text')
  readonly erro = input<string | null>(null)
  readonly desabilitado = input(false)
  readonly autocomplete = input<string | null>(null)
}
