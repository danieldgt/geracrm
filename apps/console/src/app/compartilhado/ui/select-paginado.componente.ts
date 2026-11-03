import {
  ChangeDetectionStrategy, Component, computed, DestroyRef, forwardRef, inject, input, signal,
} from '@angular/core'
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms'
import { atributosAria, ESTILOS_CONTROLE, idDica, idErro, proximoIdCampo } from './campo.regras.js'
import {
  EstadoBuscaPaginada, moverAtivo, rotuloDoValor, type CarregarOpcoes, type OpcaoPaginada,
} from './select-paginado.estado.js'

/**
 * Select com busca no servidor, paginado e acessível (combobox + listbox).
 * Teclado: setas movem, Enter escolhe, Esc fecha. Rolar até o fim traz a próxima
 * página. Na edição, `opcaoInjetada` dá o rótulo do valor salvo sem precisar
 * carregar a página onde ele está.
 */
@Component({
  selector: 'ui-select-paginado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectPaginadoComponente), multi: true }],
  host: { '[class.largo]': 'largo()', '(document:click)': 'cliqueFora($event)' },
  template: `
    <div class="campo">
      @if (rotulo()) {
        <label class="rotulo txt-denso" [for]="id">{{ rotulo() }}@if (obrigatorio()) { <span class="obrigatorio" aria-hidden="true">*</span> }</label>
      }
      <div class="ancora">
        <input class="controle" [id]="id" type="text" role="combobox" autocomplete="off"
               [attr.aria-expanded]="aberto()" [attr.aria-controls]="idLista" aria-haspopup="listbox"
               aria-autocomplete="list" [attr.aria-activedescendant]="idAtivo()"
               [attr.aria-invalid]="aria().ariaInvalid" [attr.aria-required]="aria().ariaRequired"
               [attr.aria-describedby]="aria().ariaDescribedBy"
               [placeholder]="placeholder()" [disabled]="desabilitadoEfetivo()"
               [value]="aberto() ? termo() : rotuloAtual()"
               (focus)="abrir()" (click)="abrir()" (input)="digitou($any($event.target).value)"
               (keydown)="teclou($event)" (blur)="aoSairFoco($event)" />
        @if (aberto()) {
          <ul class="lista" role="listbox" [id]="idLista" (scroll)="rolou($any($event.target))"
              (mousedown)="$event.preventDefault()">
            @for (o of estado.itens(); track o.valor; let i = $index) {
              <li role="option" class="opcao" [id]="idOpcao(i)" [class.ativa]="i === ativo()"
                  [attr.aria-selected]="o.valor === valor()"
                  (click)="escolher(o)">
                <span>{{ o.rotulo }}</span>
                @if (o.dica) { <span class="opcao-dica txt-denso">{{ o.dica }}</span> }
              </li>
            }
            @if (estado.carregando()) { <li class="aviso txt-denso" role="presentation">Carregando…</li> }
            @else if (estado.falhou()) {
              <li class="aviso aviso-erro txt-denso" role="presentation">
                Não foi possível carregar.
                <button type="button" class="tentar" (click)="estado.tentarNovamente()">Tentar novamente</button>
              </li>
            }
            @else if (estado.itens().length === 0) { <li class="aviso txt-denso" role="presentation">Nada encontrado.</li> }
          </ul>
        }
      </div>
      @if (dica()) { <span class="dica txt-denso" [id]="idDica">{{ dica() }}</span> }
      @if (erro()) { <span class="msg-erro txt-denso" [id]="idErro" role="alert">{{ erro() }}</span> }
    </div>
  `,
  styles: [ESTILOS_CONTROLE, `
    .ancora { position: relative; }
    .lista {
      position: absolute; z-index: 20; left: 0; right: 0; margin: var(--espacamento-1) 0 0; padding: var(--espacamento-1);
      list-style: none; max-height: 240px; overflow-y: auto;
      background: var(--superficie-elevada); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
    }
    .opcao { display: flex; flex-direction: column; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); cursor: pointer; }
    .opcao.ativa, .opcao:hover { background: var(--superficie-hover); }
    .opcao[aria-selected='true'] { font-weight: 600; }
    .opcao-dica { color: var(--texto-secundario); }
    .aviso { padding: var(--espacamento-2) var(--espacamento-3); color: var(--texto-secundario); }
    .aviso-erro { color: var(--erro); }
    .tentar { margin-left: var(--espacamento-2); border: 0; background: transparent; color: var(--acao-texto);
      font: inherit; text-decoration: underline; cursor: pointer; }
    .tentar:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `],
})
export class SelectPaginadoComponente implements ControlValueAccessor {
  readonly id = proximoIdCampo('ui-select-paginado')
  readonly idDica = idDica(this.id)
  readonly idErro = idErro(this.id)
  readonly idLista = `${this.id}-lista`

  /** Busca uma página por CURSOR (nulo = primeira) para o termo digitado. */
  readonly carregar = input.required<CarregarOpcoes>()
  /** Opção do valor já salvo, para mostrar o rótulo na edição. */
  readonly opcaoInjetada = input<OpcaoPaginada | null>(null)
  readonly rotulo = input('')
  readonly placeholder = input('Selecione')
  readonly erro = input<string | null>(null)
  readonly dica = input('')
  readonly obrigatorio = input(false)
  readonly largo = input(false)
  readonly desabilitado = input(false)

  readonly valor = signal<string | null>(null)
  protected readonly aberto = signal(false)
  protected readonly termo = signal('')
  protected readonly ativo = signal(-1)
  private readonly escolhida = signal<OpcaoPaginada | null>(null)
  private readonly desabilitadoCva = signal(false)

  protected readonly estado = new EstadoBuscaPaginada(() => this.carregar(), 300)
  protected readonly desabilitadoEfetivo = computed(() => this.desabilitado() || this.desabilitadoCva())
  protected readonly aria = computed(() =>
    atributosAria({ id: this.id, erro: this.erro(), dica: this.dica(), obrigatorio: this.obrigatorio() }))
  protected readonly rotuloAtual = computed(() =>
    rotuloDoValor(this.valor(), this.estado.itens(), this.escolhida() ?? this.opcaoInjetada()))
  protected readonly idAtivo = computed(() => (this.ativo() >= 0 ? this.idOpcao(this.ativo()) : null))

  private aoMudar: (v: string | null) => void = () => undefined
  protected aoTocar: () => void = () => undefined

  constructor() {
    inject(DestroyRef).onDestroy(() => this.estado.destruir())
  }

  protected idOpcao(i: number): string { return `${this.id}-op-${i}` }

  protected abrir(): void {
    if (this.aberto() || this.desabilitadoEfetivo()) return
    this.aberto.set(true)
    this.termo.set('')
    this.ativo.set(-1)
    void this.estado.iniciar('')
  }

  protected fechar(): void { this.aberto.set(false); this.ativo.set(-1) }

  protected cliqueFora(e: Event): void {
    if (this.aberto() && !(e.target as HTMLElement).closest(`#${this.id}, #${this.idLista}`)) this.fechar()
  }

  /** Foco saiu da âncora (Tab ou clique fora): fecha a lista. Foco ainda dentro dela não fecha. */
  protected aoSairFoco(e: FocusEvent): void {
    const ancora = (e.currentTarget as HTMLElement | null)?.closest('.ancora')
    const para = e.relatedTarget as Node | null
    if (!(ancora && para && ancora.contains(para))) this.fechar()
    this.aoTocar()
  }

  protected digitou(texto: string): void {
    if (!this.aberto()) { this.aberto.set(true) }
    this.termo.set(texto)
    this.ativo.set(-1)
    this.estado.digitar(texto)
  }

  protected rolou(el: HTMLElement): void {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) void this.estado.proximaPagina()
  }

  protected teclou(e: KeyboardEvent): void {
    const total = this.estado.itens().length
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp':
        e.preventDefault()
        if (!this.aberto()) { this.abrir(); return }
        this.ativo.set(moverAtivo(this.ativo(), total, e.key))
        if (e.key === 'ArrowDown' && this.ativo() === total - 1) void this.estado.proximaPagina()
        break
      case 'Enter': {
        const o = this.estado.itens()[this.ativo()]
        if (this.aberto() && o) { e.preventDefault(); this.escolher(o) }
        break
      }
      case 'Escape':
        if (this.aberto()) { e.preventDefault(); e.stopPropagation(); this.fechar() }
        break
    }
  }

  protected escolher(o: OpcaoPaginada): void {
    this.escolhida.set(o)
    this.valor.set(o.valor)
    this.aoMudar(o.valor)
    this.fechar()
  }

  writeValue(v: string | null): void {
    this.valor.set(v ?? null)
    if (this.escolhida()?.valor !== v) this.escolhida.set(null)
  }
  registerOnChange(fn: (v: string | null) => void): void { this.aoMudar = fn }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn }
  setDisabledState(d: boolean): void { this.desabilitadoCva.set(d) }
}
