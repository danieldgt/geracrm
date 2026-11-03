import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import {
  ChipsEtiquetaComponente, EstadoComponente, EsqueletoComponente, ToastServico, mensagemDeErro, type OpcaoChip,
} from '../../compartilhado/ui/index.js'
import { EtiquetasServico, type Etiqueta } from './etiquetas.servico.js'
import { diferencaSelecao, tokenDaCor } from './etiquetas.regras.js'

/** Teto de páginas lidas do catálogo: etiquetas são poucas; passou disso, algo está errado. */
const MAX_PAGINAS_CATALOGO = 10

/**
 * Etiquetas de UM contato: mostra e edita (chips + Salvar). Reutilizável (ficha, lista).
 * O catálogo é o do tenant (só ativas) somado ao que o contato já tem — etiqueta desativada
 * depois de vinculada continua visível e pode ser removida.
 */
@Component({
  selector: 'app-etiquetas-contato',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChipsEtiquetaComponente, EstadoComponente, EsqueletoComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') { <ui-esqueleto altura="32px" /> }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as etiquetas" [descricao]="erro()">
          <button type="button" class="btn btn--secundario btn--pequeno" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        @if (opcoes().length === 0) {
          <p class="vazio txt-denso">Nenhuma etiqueta cadastrada. Crie em Gestão, Etiquetas e origens.</p>
        } @else {
          <ui-chips-etiqueta [opcoes]="opcoes()" [(selecionadas)]="selecao" />
          @if (mudou()) {
            <div class="acoes">
              <button type="button" class="btn btn--primario btn--pequeno" [disabled]="salvando()" (click)="salvar()">
                {{ salvando() ? 'Salvando…' : 'Salvar etiquetas' }}
              </button>
              <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="salvando()" (click)="descartar()">Descartar</button>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .vazio { margin: 0; color: var(--texto-secundario); }
    .acoes { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
  `,
})
export class EtiquetasContatoComponente {
  private readonly api = inject(EtiquetasServico)
  private readonly toast = inject(ToastServico)

  readonly contatoId = input.required<string>()

  protected readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  protected readonly erro = signal('')
  protected readonly salvando = signal(false)
  private readonly catalogo = signal<readonly Etiqueta[]>([])
  private readonly salvas = signal<readonly string[]>([])
  private readonly dasSalvas = signal<readonly Etiqueta[]>([])
  protected readonly selecao = signal<string[]>([])

  protected readonly opcoes = computed<OpcaoChip[]>(() => {
    const porId = new Map<string, Etiqueta>()
    for (const e of this.catalogo()) porId.set(e.id, e)
    for (const e of this.dasSalvas()) porId.set(e.id, e)
    return [...porId.values()].map((e) => ({ valor: e.id, rotulo: e.ativa ? e.nome : `${e.nome} (inativa)`, cor: tokenDaCor(e.cor) }))
  })
  protected readonly mudou = computed(() => diferencaSelecao(this.selecao(), this.salvas()).mudou)

  constructor() {
    effect(() => {
      this.contatoId()
      untracked(() => void this.carregar())
    })
  }

  async carregar(): Promise<void> {
    const id = this.contatoId()
    this.estado.set('carregando')
    try {
      const catalogo: Etiqueta[] = []
      let cursor: string | null = null
      for (let i = 0; i < MAX_PAGINAS_CATALOGO; i++) {
        const p = await this.api.etiquetas(cursor, true)
        catalogo.push(...p.itens)
        cursor = p.proximoCursor
        if (!cursor) break
      }
      const doContato = await this.api.doContato(id)
      if (id !== this.contatoId()) return // a ficha trocou de contato no meio
      this.catalogo.set(catalogo)
      this.dasSalvas.set(doContato.itens)
      this.salvas.set(doContato.itens.map((e) => e.id))
      this.selecao.set(doContato.itens.map((e) => e.id))
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Erro ao carregar as etiquetas.'))
      this.estado.set('erro')
    }
  }

  protected descartar(): void { this.selecao.set([...this.salvas()]) }

  protected async salvar(): Promise<void> {
    if (this.salvando()) return
    this.salvando.set(true)
    try {
      await this.api.salvarDoContato(this.contatoId(), this.selecao())
      this.toast.sucesso('Etiquetas salvas.')
      await this.carregar()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível salvar as etiquetas.'))
    } finally { this.salvando.set(false) }
  }
}
