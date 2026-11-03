import { Directive, ElementRef, forwardRef, inject, input } from '@angular/core'
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms'
import { digitosDaMascara, formatarMascara, type TipoMascara } from './mascaras.js'

/**
 * `<input uiMascara="cnpj" [formControl]="c">` — exibe formatado, o controle
 * guarda SÓ dígitos. Substitui o accessor padrão do input.
 */
@Directive({
  selector: 'input[uiMascara]',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MascaraDiretiva), multi: true }],
  host: {
    '(input)': 'aoDigitar($any($event.target).value)',
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

  aoDigitar(texto: string): void {
    const tipo = this.uiMascara()
    this.el.nativeElement.value = formatarMascara(tipo, texto)
    this.aoMudar(digitosDaMascara(tipo, texto))
  }
  aoSair(): void { this.aoTocar() }
}
