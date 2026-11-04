import { ChangeDetectionStrategy, Component, computed, forwardRef, input, isDevMode, model, signal } from '@angular/core'
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms'
import {
  atributosAria, ESTILOS_CONTROLE, idDica, idErro, proximoIdCampo, textoDoValor, valorDoControle, type TipoCampo,
} from './campo.regras.js'
import { aplicarMascaraNoElemento, digitosDaMascara, formatarMascara, type TipoMascara } from './mascaras.js'

/**
 * Campo de formulário (R-12 + padrão "disposição AM, pele GeraCRM"): rótulo ligado
 * por for/id, obrigatório, dica, erro tipificado, `largo` (2 colunas) e slot
 * `[acao]`. Dois usos: `[(valor)]` (texto) OU Reactive Forms (CVA) — no CVA o
 * valor do controle é número para `number`, centavos para `dinheiro`, texto no resto.
 */
@Component({
  selector: 'ui-campo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => CampoComponente), multi: true }],
  host: { '[class.largo]': 'largo()' },
  template: `
    <div class="campo">
      @if (rotulo()) {
        <label class="rotulo txt-denso" [for]="id">{{ rotulo() }}@if (obrigatorio()) { <span class="obrigatorio" aria-hidden="true">*</span> }</label>
      }
      <div class="linha">
        @if (tipo() === 'textarea') {
          <textarea class="controle" [id]="id" [placeholder]="placeholder()" [value]="valor()" rows="3"
                    [attr.maxlength]="maxlength()"
                    [disabled]="desabilitadoEfetivo()" [attr.aria-invalid]="aria().ariaInvalid"
                    [attr.aria-required]="aria().ariaRequired" [attr.aria-describedby]="aria().ariaDescribedBy"
                    (input)="digitou($any($event.target).value)" (blur)="aoTocar()"></textarea>
        } @else {
          <input class="controle" [id]="id" [type]="tipoNativo()" [attr.inputmode]="inputmode() ?? (tipo() === 'dinheiro' ? 'decimal' : null)"
                 [placeholder]="placeholder()" [value]="valor()"
                 [disabled]="desabilitadoEfetivo()" [attr.autocomplete]="autocomplete()"
                 [attr.maxlength]="maxlength()" [attr.min]="min()" [attr.max]="max()" [attr.step]="step()"
                 [attr.aria-invalid]="aria().ariaInvalid" [attr.aria-required]="aria().ariaRequired"
                 [attr.aria-describedby]="aria().ariaDescribedBy"
                 (input)="aoInput($any($event.target))" (blur)="sair($any($event.target))" />
        }
        <ng-content select="[acao]" />
      </div>
      @if (dica()) { <span class="dica txt-denso" [id]="idDica">{{ dica() }}</span> }
      @if (erro()) { <span class="msg-erro txt-denso" [id]="idErro" role="alert">{{ erro() }}</span> }
      @if (tipo() === 'textarea' && maxlength() !== null) {
        <span class="contador txt-denso">{{ valor().length }}/{{ maxlength() }}</span>
      }
    </div>
  `,
  styles: [ESTILOS_CONTROLE, '.contador { align-self: flex-end; color: var(--texto-secundario); font-variant-numeric: tabular-nums; }'],
})
export class CampoComponente implements ControlValueAccessor {
  readonly id = proximoIdCampo('ui-campo')
  readonly idDica = idDica(this.id)
  readonly idErro = idErro(this.id)

  /** Texto exibido no controle (API legada `[(valor)]`). */
  readonly valor = model('')
  readonly rotulo = input('')
  readonly placeholder = input('')
  readonly tipo = input<TipoCampo>('text')
  readonly erro = input<string | null>(null)
  readonly dica = input('')
  readonly obrigatorio = input(false)
  readonly largo = input(false)
  readonly desabilitado = input(false)
  readonly autocomplete = input<string | null>(null)
  /** Teclado do celular (`numeric`, `decimal`, `tel`, `email`...), repassado ao `<input>`. Em `dinheiro` o padrão é `decimal`. */
  readonly inputmode = input<string | null>(null)
  /** Máscara opcional (cpf, cnpj, ...): exibe formatado; o CVA recebe só dígitos. */
  readonly mascara = input<TipoMascara | null>(null)
  /** Limites nativos, repassados ao controle. Em `textarea`, `maxlength` também mostra o contador "n/max". */
  readonly maxlength = input<number | null>(null)
  readonly min = input<string | number | null>(null)
  readonly max = input<string | number | null>(null)
  readonly step = input<string | number | null>(null)

  private readonly desabilitadoCva = signal(false)
  protected readonly desabilitadoEfetivo = computed(() => this.desabilitado() || this.desabilitadoCva())
  protected readonly tipoNativo = computed(() => (this.tipo() === 'dinheiro' ? 'text' : this.tipo()))
  protected readonly aria = computed(() =>
    atributosAria({ id: this.id, erro: this.erro(), dica: this.dica(), obrigatorio: this.obrigatorio() }))

  private aoMudar: (v: string | number | null) => void = () => undefined
  protected aoTocar: () => void = () => undefined

  /** Evento do input: com máscara, formata direto no elemento e preserva o cursor; depois segue o fluxo normal. */
  protected aoInput(el: HTMLInputElement): void {
    const m = this.mascara()
    const bruto = el.value
    if (m) aplicarMascaraNoElemento(el, m, document.activeElement === el)
    this.digitou(bruto)
  }

  protected digitou(texto: string): void {
    const m = this.mascara()
    this.valor.set(m ? formatarMascara(m, texto) : texto)
    this.aoMudar(m ? digitosDaMascara(m, texto) : valorDoControle(this.tipo(), texto))
  }

  /** Dinheiro: ao sair, normaliza "1234,5" para "1.234,50". */
  protected sair(el: HTMLInputElement): void {
    if (this.tipo() === 'dinheiro') {
      const texto = textoDoValor('dinheiro', valorDoControle('dinheiro', el.value))
      this.valor.set(texto)
      el.value = texto
    }
    this.aoTocar()
  }

  /**
   * Dinheiro NÃO aceita negativo (crédito/estorno é outro fluxo): `writeValue` com centavos negativos
   * vira `null` (campo vazio) e avisa em dev — melhor vazio visível que um "-" que o parser rejeitaria.
   */
  writeValue(v: unknown): void {
    if (this.tipo() === 'dinheiro' && typeof v === 'number' && v < 0) {
      if (isDevMode()) console.warn('ui-campo (dinheiro): valor negativo não é permitido; tratado como vazio.', v)
      v = null
    }
    const m = this.mascara()
    this.valor.set(m ? formatarMascara(m, v == null ? '' : String(v)) : textoDoValor(this.tipo(), v))
  }
  registerOnChange(fn: (v: string | number | null) => void): void { this.aoMudar = fn }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn }
  setDisabledState(d: boolean): void { this.desabilitadoCva.set(d) }
}
