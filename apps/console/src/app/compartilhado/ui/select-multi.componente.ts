import { ChangeDetectionStrategy, Component, computed, forwardRef, input, model, output, signal } from '@angular/core'
import { FormControl, NG_VALUE_ACCESSOR, ReactiveFormsModule, type ControlValueAccessor } from '@angular/forms'
import { IconeComponente } from './icone.componente.js'
import { SelectPaginadoComponente } from './select-paginado.componente.js'
import type { CarregarOpcoes, OpcaoPaginada, PaginaOpcoes } from './select-paginado.estado.js'
import { adicionarId, limiteAtingido, removerId, rotuloDoChip } from './select-multi.regras.js'

/**
 * Seleção MÚLTIPLA sobre o `ui-select-paginado` (que escolhe um por vez): cada escolha vira um chip
 * removível. Serve onde a lista cresce (listas, etiquetas, origens): busca no servidor, por cursor,
 * nunca carrega tudo. Dois usos: `[(valor)]` (ids) OU Reactive Forms (CVA com `string[]`).
 *
 * ⚠️ O select paginado devolve só o id; o rótulo do chip vem das `opcoesInjetadas` (valores já salvos,
 * na edição) e do cache preenchido pelo carregador à medida que as páginas passam.
 */
@Component({
  selector: 'ui-select-multi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, SelectPaginadoComponente, IconeComponente],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectMultiComponente), multi: true }],
  host: { '[class.largo]': 'largo()' },
  template: `
    <div class="multi">
      <ui-select-paginado [rotulo]="rotulo()" [placeholder]="placeholder()" [carregar]="carregarComCache"
        [dica]="dicaEfetiva()" [erro]="erro()" [obrigatorio]="obrigatorio()" [largo]="true"
        [desabilitado]="desabilitadoEfetivo() || atingiu()" [formControl]="escolha" />
      @if (itens().length > 0) {
        <ul class="chips" [attr.aria-label]="'Selecionados: ' + rotulo()">
          @for (o of itens(); track o.valor) {
            <li class="chip">
              <span class="chip-txt">{{ o.rotulo }}</span>
              @if (!desabilitadoEfetivo()) {
                <button type="button" class="chip-x" [attr.aria-label]="'Remover ' + o.rotulo" (click)="remover(o.valor)">
                  <ui-icone nome="x" [tamanho]="14" />
                </button>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .multi { display: grid; gap: var(--espacamento-2); }
    .chips { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin: 0; padding: 0; list-style: none; }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); max-width: 100%;
      padding: 2px var(--espacamento-1) 2px var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto); font-size: 13px; }
    .chip-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-x { display: inline-grid; place-items: center; min-width: 24px; min-height: 24px; border: 0; border-radius: var(--raio-completo);
      background: transparent; color: var(--texto-secundario); cursor: pointer; }
    .chip-x:hover { background: var(--superficie-hover); color: var(--texto); }
    .chip-x:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
  `,
})
export class SelectMultiComponente implements ControlValueAccessor {
  /** Ids selecionados (API `[(valor)]`; no CVA é o valor do controle). */
  readonly valor = model<readonly string[]>([])
  /** Contrato do select paginado: `carregar(cursor, termo)`. */
  readonly carregar = input.required<CarregarOpcoes>()
  /** Opções dos ids já salvos (rótulos na edição, sem chamada extra). */
  readonly opcoesInjetadas = input<readonly OpcaoPaginada[]>([])
  /** Limite de itens; ao atingir, o campo de busca desabilita e a dica avisa. */
  readonly max = input<number | null>(null)
  readonly rotulo = input.required<string>()
  readonly placeholder = input('Buscar e adicionar')
  readonly dica = input('')
  readonly erro = input<string | null>(null)
  readonly obrigatorio = input(false)
  readonly largo = input(false)
  readonly desabilitado = input(false)
  /** Lista completa (id + rótulo) a cada mudança feita pelo usuário: útil a quem guarda o rótulo junto. */
  readonly escolhidas = output<OpcaoPaginada[]>()

  protected readonly escolha = new FormControl<string | null>(null)
  private readonly cache = signal<ReadonlyMap<string, string>>(new Map())
  private readonly desabilitadoCva = signal(false)
  protected readonly desabilitadoEfetivo = computed(() => this.desabilitado() || this.desabilitadoCva())
  protected readonly atingiu = computed(() => limiteAtingido(this.valor().length, this.max()))
  protected readonly dicaEfetiva = computed(() =>
    this.atingiu() ? `Limite de ${this.max()} atingido. Remova um item para adicionar outro.` : this.dica())
  protected readonly itens = computed<OpcaoPaginada[]>(() =>
    this.valor().map((id) => ({ valor: id, rotulo: rotuloDoChip(id, this.cache(), this.opcoesInjetadas()) })))

  private aoMudar: (v: string[]) => void = () => undefined
  protected aoTocar: () => void = () => undefined

  constructor() {
    this.escolha.valueChanges.subscribe((v) => {
      if (!v) return
      // Volta o campo para vazio: é um "adicionar", não um valor guardado.
      this.escolha.setValue(null, { emitEvent: false })
      this.aplicar(adicionarId(this.valor(), v, this.max()))
    })
  }

  protected readonly carregarComCache: CarregarOpcoes = async (cursor, termo): Promise<PaginaOpcoes> => {
    const r = await this.carregar()(cursor, termo)
    const novo = new Map(this.cache())
    for (const o of r.itens as readonly OpcaoPaginada[]) novo.set(o.valor, o.rotulo)
    this.cache.set(novo)
    return r
  }

  protected remover(id: string): void { this.aplicar(removerId(this.valor(), id)) }

  private aplicar(ids: readonly string[]): void {
    if (ids === this.valor()) return
    this.valor.set(ids)
    this.aoMudar([...ids])
    this.aoTocar()
    this.escolhidas.emit(this.itens())
  }

  writeValue(v: readonly string[] | null): void { this.valor.set(v ?? []) }
  registerOnChange(fn: (v: string[]) => void): void { this.aoMudar = fn }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn }
  setDisabledState(d: boolean): void { this.desabilitadoCva.set(d) }
}
