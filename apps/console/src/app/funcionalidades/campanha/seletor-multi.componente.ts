import { ChangeDetectionStrategy, Component, input, model } from '@angular/core'
import { FormControl, ReactiveFormsModule } from '@angular/forms'
import {
  IconeComponente, SelectPaginadoComponente, type CarregarOpcoes, type OpcaoPaginada, type PaginaOpcoes,
} from '../../compartilhado/ui/index.js'
import type { OpcaoEscolhida } from './campanhas.regras.js'

/**
 * Seleção MÚLTIPLA sobre o select paginado (que escolhe um por vez): cada escolha vira um chip removível.
 * Serve onde a lista cresce (listas, etiquetas, origens) — nunca carrega tudo de uma vez.
 *
 * ⚠️ O select paginado devolve só o id; o rótulo do chip vem do cache preenchido pelo próprio carregador
 * à medida que as páginas passam.
 */
@Component({
  selector: 'app-seletor-multi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, SelectPaginadoComponente, IconeComponente],
  template: `
    <div class="multi">
      <ui-select-paginado [rotulo]="rotulo()" [placeholder]="placeholder()" [carregar]="carregarComCache"
        [dica]="dica()" [erro]="erro()" [largo]="true" [formControl]="escolha" />
      @if (selecionadas().length > 0) {
        <ul class="chips" [attr.aria-label]="'Selecionados: ' + rotulo()">
          @for (o of selecionadas(); track o.valor) {
            <li class="chip">
              <span class="chip-txt">{{ o.rotulo }}</span>
              <button type="button" class="chip-x" [attr.aria-label]="'Remover ' + o.rotulo" (click)="remover(o.valor)">
                <ui-icone nome="x" [tamanho]="14" />
              </button>
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
export class SeletorMultiComponente {
  readonly rotulo = input.required<string>()
  readonly placeholder = input('Buscar e adicionar')
  readonly dica = input('')
  readonly erro = input<string | null>(null)
  /** Contrato do select paginado: `carregar(cursor, termo)`. */
  readonly carregar = input.required<CarregarOpcoes>()
  readonly selecionadas = model<readonly OpcaoEscolhida[]>([])

  protected readonly escolha = new FormControl<string | null>(null)
  private readonly rotulos = new Map<string, string>()

  constructor() {
    this.escolha.valueChanges.subscribe((v) => {
      if (!v) return
      const rotulo = this.rotulos.get(v) ?? v
      if (!this.selecionadas().some((o) => o.valor === v)) this.selecionadas.set([...this.selecionadas(), { valor: v, rotulo }])
      // Volta o campo para vazio: é um "adicionar", não um valor guardado.
      this.escolha.setValue(null, { emitEvent: false })
    })
  }

  protected readonly carregarComCache: CarregarOpcoes = async (cursor, termo): Promise<PaginaOpcoes> => {
    const r = await this.carregar()(cursor, termo)
    for (const o of r.itens as readonly OpcaoPaginada[]) this.rotulos.set(o.valor, o.rotulo)
    return r
  }

  protected remover(valor: string): void {
    this.selecionadas.set(this.selecionadas().filter((o) => o.valor !== valor))
  }
}
