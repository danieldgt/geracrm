import { ChangeDetectionStrategy, Component, computed, forwardRef, input, model, signal } from '@angular/core'
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms'
import { atributosAria, ESTILOS_CONTROLE, idDica, idErro, proximoIdCampo } from './campo.regras.js'

export interface OpcaoSelect { valor: string; rotulo: string }

/** Select nativo com o mesmo rótulo/dica/erro/obrigatório/largo do `ui-campo`. */
@Component({
  selector: 'ui-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectComponente), multi: true }],
  host: { '[class.largo]': 'largo()' },
  template: `
    <div class="campo">
      @if (rotulo()) {
        <label class="rotulo txt-denso" [for]="id">{{ rotulo() }}@if (obrigatorio()) { <span class="obrigatorio" aria-hidden="true">*</span> }</label>
      }
      <select class="controle" [id]="id" [disabled]="desabilitadoEfetivo()"
              [attr.aria-invalid]="aria().ariaInvalid" [attr.aria-required]="aria().ariaRequired"
              [attr.aria-describedby]="aria().ariaDescribedBy"
              (change)="escolheu($any($event.target).value)" (blur)="aoTocar()">
        <option value="" [selected]="valor() === ''">{{ placeholder() }}</option>
        @for (o of opcoes(); track o.valor) {
          <option [value]="o.valor" [selected]="o.valor === valor()">{{ o.rotulo }}</option>
        }
      </select>
      @if (dica()) { <span class="dica txt-denso" [id]="idDica">{{ dica() }}</span> }
      @if (erro()) { <span class="msg-erro txt-denso" [id]="idErro" role="alert">{{ erro() }}</span> }
    </div>
  `,
  styles: ESTILOS_CONTROLE,
})
export class SelectComponente implements ControlValueAccessor {
  readonly id = proximoIdCampo('ui-select')
  readonly idDica = idDica(this.id)
  readonly idErro = idErro(this.id)

  /** Valor selecionado; '' = nada (placeholder). */
  readonly valor = model('')
  readonly opcoes = input<OpcaoSelect[]>([])
  readonly rotulo = input('')
  readonly placeholder = input('Selecione')
  readonly erro = input<string | null>(null)
  readonly dica = input('')
  readonly obrigatorio = input(false)
  readonly largo = input(false)
  readonly desabilitado = input(false)

  private readonly desabilitadoCva = signal(false)
  protected readonly desabilitadoEfetivo = computed(() => this.desabilitado() || this.desabilitadoCva())
  protected readonly aria = computed(() =>
    atributosAria({ id: this.id, erro: this.erro(), dica: this.dica(), obrigatorio: this.obrigatorio() }))

  private aoMudar: (v: string | null) => void = () => undefined
  protected aoTocar: () => void = () => undefined

  protected escolheu(v: string): void {
    this.valor.set(v)
    this.aoMudar(v === '' ? null : v)
  }

  writeValue(v: string | null): void { this.valor.set(v ?? '') }
  registerOnChange(fn: (v: string | null) => void): void { this.aoMudar = fn }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn }
  setDisabledState(d: boolean): void { this.desabilitadoCva.set(d) }
}
