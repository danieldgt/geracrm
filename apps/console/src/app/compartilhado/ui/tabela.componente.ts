import {
  ChangeDetectionStrategy, Component, Directive, TemplateRef, computed, contentChildren, effect, inject, input, isDevMode,
  model, untracked,
} from '@angular/core'
import { NgTemplateOutlet } from '@angular/common'
import { EsqueletoComponente } from './esqueleto.componente.js'
import {
  alternarChave, alternarPagina, chavePadraoDaLinha, estadoSelecaoPagina, podarSelecao, rotuloSelecaoDaLinha, textoDaCelula,
} from './lista.regras.js'

export interface ColunaTabela {
  chave: string
  rotulo: string
  alinhamento?: 'esq' | 'dir' | 'centro'
  /** Código/ID/valor: sem quebra de linha e com algarismos tabulares. */
  mono?: boolean
  largura?: string
}

/**
 * Template de célula por coluna: `<ng-template uiCelula="status" let-linha>...</ng-template>`.
 * A linha chega como `let-linha` (tipo solto de propósito: a tabela é genérica).
 */
@Directive({ selector: 'ng-template[uiCelula]' })
export class CelulaDiretiva {
  readonly chave = input.required<string>({ alias: 'uiCelula' })
  readonly modelo = inject<TemplateRef<unknown>>(TemplateRef)
}

/** Linha da tabela: objeto qualquer, lido por chave de coluna. */
export type LinhaTabela = Record<string, unknown>

/**
 * Tabela de lista (padrão Lista, §4 do plano de paridade). `<table>` real, linha de 40 px,
 * rola na horizontal dentro da própria caixa. Paginação é por CURSOR e mora em `ui-paginacao`.
 * Slot de vazio: `<div uiVazio>...</div>`.
 *
 * Seleção: quando `linhas` muda (outra página, filtro, busca), `selecionados` é PODADO às chaves
 * visíveis — nunca sobra seleção de linha que o usuário não vê (a ação em lote rodaria às cegas).
 * A poda não roda enquanto `carregando` (linhas transitoriamente vazias não apagam a seleção).
 * Quem mostra o contador (`ui-acoes-lote`) deve ler o MESMO `selecionados`, já podado.
 */
@Component({
  selector: 'ui-tabela',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, EsqueletoComponente],
  template: `
    <div class="caixa rolagem-x">
      <table class="tabela">
        <thead>
          <tr>
            @if (selecionavel()) {
              <th class="sel" scope="col">
                <input type="checkbox" aria-label="Selecionar todos desta página"
                  [checked]="estadoPagina() === 'todos'" [indeterminate]="estadoPagina() === 'parcial'"
                  [disabled]="carregando() || linhas().length === 0" (change)="alternarTodos()" />
              </th>
            }
            @for (c of colunas(); track c.chave) {
              <th scope="col" class="txt-rotulo" [attr.data-alinhamento]="c.alinhamento ?? 'esq'"
                  [style.width]="c.largura ?? null">{{ c.rotulo }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @if (carregando()) {
            @for (i of esqueletos(); track i) {
              <tr class="linha-esqueleto" aria-hidden="true">
                @if (selecionavel()) { <td class="sel"></td> }
                @for (c of colunas(); track c.chave) {
                  <td><ui-esqueleto altura="14px" /></td>
                }
              </tr>
            }
          } @else {
            @for (l of linhas(); track chaveLinha()(l); let i = $index) {
              <tr [attr.data-selecionada]="selecionados().has(chaveLinha()(l)) ? 'true' : null">
                @if (selecionavel()) {
                  <td class="sel">
                    <input type="checkbox" [attr.aria-label]="rotuloCheckbox(l, i)"
                      [checked]="selecionados().has(chaveLinha()(l))" (change)="alternarLinha(l)" />
                  </td>
                }
                @for (c of colunas(); track c.chave) {
                  <td class="txt-denso" [class.mono]="c.mono" [attr.data-alinhamento]="c.alinhamento ?? 'esq'">
                    @if (modelos().get(c.chave); as m) {
                      <ng-container *ngTemplateOutlet="m; context: { $implicit: l, linha: l }" />
                    } @else {
                      {{ texto(l[c.chave]) }}
                    }
                  </td>
                }
              </tr>
            }
          }
        </tbody>
      </table>
      @if (!carregando() && linhas().length === 0) {
        <div class="vazio"><ng-content select="[uiVazio]" /></div>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .caixa { background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); max-width: 100%; }
    .tabela { width: 100%; border-collapse: collapse; }
    th, td { height: 40px; padding: 0 var(--espacamento-3); border-bottom: 1px solid var(--borda); text-align: left;
      vertical-align: middle; color: var(--texto); }
    th { background: var(--superficie-elevada); white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: var(--superficie-hover); }
    tbody tr[data-selecionada='true'] { background: var(--superficie-selecionada); }
    .linha-esqueleto:hover { background: transparent; }
    [data-alinhamento='dir'] { text-align: right; }
    [data-alinhamento='centro'] { text-align: center; }
    .mono { font-family: var(--tipografia-familia-dados); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .sel { width: 40px; text-align: center; padding: 0 var(--espacamento-2); }
    .vazio:not(:empty) { border-top: 1px solid var(--borda); }
  `,
})
export class TabelaComponente {
  readonly colunas = input.required<readonly ColunaTabela[]>()
  readonly linhas = input<readonly LinhaTabela[]>([])
  /** Chave estável da linha; o padrão é `id` e lança erro claro em dev se faltar. */
  readonly chaveLinha = input<(linha: LinhaTabela) => string>((l) => chavePadraoDaLinha(l, isDevMode()))
  /** Rótulo humano da linha para leitor de tela ("Selecionar <rótulo>"); padrão "Selecionar linha N". */
  readonly rotuloLinha = input<((linha: LinhaTabela) => string) | null>(null)
  readonly selecionavel = input(false)
  readonly selecionados = model<ReadonlySet<string>>(new Set())
  readonly carregando = input(false)
  readonly linhasEsqueleto = input(5)

  protected readonly celulas = contentChildren(CelulaDiretiva)
  protected readonly modelos = computed(() => new Map(this.celulas().map((c) => [c.chave(), c.modelo])))
  protected readonly esqueletos = computed(() => Array.from({ length: this.linhasEsqueleto() }, (_, i) => i))
  private readonly chaves = computed(() => this.linhas().map((l) => this.chaveLinha()(l)))
  protected readonly estadoPagina = computed(() => estadoSelecaoPagina(this.selecionados(), this.chaves()))

  constructor() {
    effect(() => {
      const chaves = this.chaves()
      if (this.carregando()) return
      const atual = untracked(this.selecionados)
      const podada = podarSelecao(atual, chaves)
      if (podada !== atual) this.selecionados.set(podada)
    })
  }

  protected rotuloCheckbox(l: LinhaTabela, i: number): string {
    return rotuloSelecaoDaLinha(this.rotuloLinha()?.(l), i)
  }
  protected texto(v: unknown): string { return textoDaCelula(v) }
  protected alternarTodos(): void { this.selecionados.set(alternarPagina(this.selecionados(), this.chaves())) }
  protected alternarLinha(l: LinhaTabela): void { this.selecionados.set(alternarChave(this.selecionados(), this.chaveLinha()(l))) }
}
