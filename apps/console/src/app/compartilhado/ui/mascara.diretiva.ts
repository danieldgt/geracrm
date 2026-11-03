import { Directive, ElementRef, forwardRef, inject, input } from '@angular/core'
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms'
import { aplicarMascaraNoElemento, digitosDaMascara, formatarMascara, type TipoMascara } from './mascaras.js'

/**
 * `<input uiMascara="cnpj" [formControl]="c">` — exibe formatado, o controle
 * guarda SÓ dígitos. Substitui o accessor padrão do input.
 */
@Directive({
  selector: 'input[uiMascara]',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MascaraDiretiva), multi: true }],
  host: {
    '(input)': 'aoDigitar()',
    '(blur)': 'aoSair()',
  },
})
export class MascaraDiretiva implements ControlValueAccessor {
  readonly uiMascara = input.required<TipoMascara>()
  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef)
  private aoMudar: (v: string) => void = () => undefined
  private aoTocar: () => void = () => undefined

  writeValue(v: string | null): void {
    this.el.nativeElement.value = formatarMascara(this.uiMascara(), v ?? '')
  }
  registerOnChange(fn: (v: string) => void): void { this.aoMudar = fn }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn }
  setDisabledState(desabilitado: boolean): void { this.el.nativeElement.disabled = desabilitado }

  /** Formata direto no elemento e mantém o cursor no mesmo dígito (ver `posicaoDoCursor`). */
  aoDigitar(): void {
    const el = this.el.nativeElement
    const tipo = this.uiMascara()
    const texto = el.value
    aplicarMascaraNoElemento(el, tipo, document.activeElement === el)
    this.aoMudar(digitosDaMascara(tipo, texto))
  }
  aoSair(): void { this.aoTocar() }
}
