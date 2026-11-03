import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, CampoComponente, EsqueletoComponente, EstadoComponente, IconeComponente,
  PaginacaoComponente, ToastServico, mensagemDeErro,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico } from './ficha-blocos.servico.js'
import { itemParaExibicao, mesclarFeed, type ItemFeed } from './ficha.regras.js'

/**
 * Aba Feed: caixa "Adicionar observação" + linha do tempo do contato (observações, funil,
 * qualificação, tarefas, pedidos, atendimento, etiquetas, arquivos). Cursor + "Carregar mais".
 * Estado PRÓPRIO: se a linha do tempo falhar, o resto da ficha segue de pé.
 */
@Component({
  selector: 'app-ficha-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, CampoComponente, EsqueletoComponente, EstadoComponente, IconeComponente, PaginacaoComponente],
  template: `
    <form class="obs" (submit)="anotar($event)">
      <ui-campo rotulo="Adicionar observação" tipo="textarea" [largo]="true" placeholder="Anote algo sobre este contato"
                [(valor)]="texto" [erro]="erroObs()" />
      <div class="obs-acoes">
        <ui-botao variante="primario" [carregando]="salvando()" [desabilitado]="!texto().trim()" (click)="anotar($event)">Adicionar observação</ui-botao>
      </div>
    </form>

    @switch (estado()) {
      @case ('carregando') {
        <div aria-busy="true" aria-label="Carregando o feed" class="esq">
          @for (i of [1, 2, 3, 4]; track i) { <ui-esqueleto altura="44px" /> }
        </div>
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o feed" [descricao]="erro()">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado>
      }
      @default {
        @if (vistas().length === 0) {
          <ui-estado titulo="Nada por aqui ainda" descricao="Observações, mudanças de etapa, tarefas e pedidos deste contato aparecem aqui." icone="file-text" />
        } @else {
          <ol class="linha" aria-label="Linha do tempo">
            @for (i of vistas(); track i.id) {
              <li class="item">
                <span class="marca" [attr.data-tom]="i.tom" aria-hidden="true"><ui-icone [nome]="i.icone" [tamanho]="14" /></span>
                <div class="corpo">
                  <div class="topo">
                    <ui-badge [tom]="i.tom">{{ i.rotuloTipo }}</ui-badge>
                    <span class="txt-denso quem">{{ i.autor }} · {{ i.em | date: 'dd/MM/yyyy HH:mm' }}</span>
                  </div>
                  <p class="texto txt-corpo">{{ i.texto }}</p>
                </div>
              </li>
            }
          </ol>
          <ui-paginacao [mostrados]="vistas().length" [temMais]="!!proximo()" [carregando]="carregandoMais()" (mais)="maisItens()" />
          @if (erroMais()) { <p class="erro txt-denso" role="alert">{{ erroMais() }}</p> }
        }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .obs { display: grid; gap: var(--espacamento-2); margin-bottom: var(--espacamento-5); }
    .obs-acoes { display: flex; justify-content: flex-end; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .linha { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-4); }
    .item { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--espacamento-3); }
    .marca { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
      border-radius: var(--raio-completo); background: var(--superficie); border: 1px solid var(--borda); color: var(--texto-secundario); }
    .marca[data-tom='sucesso'] { color: var(--sucesso); border-color: var(--sucesso); }
    .marca[data-tom='atencao'] { color: var(--atencao); border-color: var(--atencao); }
    .marca[data-tom='info'] { color: var(--acao); border-color: var(--acao); }
    .corpo { min-width: 0; }
    .topo { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); }
    .quem { color: var(--texto-secundario); }
    .texto { margin: var(--espacamento-1) 0 0; color: var(--texto); white-space: pre-wrap; overflow-wrap: anywhere; }
    .erro { color: var(--erro); margin: var(--espacamento-2) 0 0; }
  `,
})
export class FichaFeedComponente {
  private readonly blocos = inject(FichaBlocosServico)
  private readonly toast = inject(ToastServico)

  readonly contatoId = input.required<string>()
  /** Muda quando algo fora do feed (tarefa, qualificação, etiqueta) pode ter gerado item novo. */
  readonly versao = input(0)

  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  readonly itens = signal<readonly ItemFeed[]>([])
  readonly proximo = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erroMais = signal('')
  readonly texto = signal('')
  readonly salvando = signal(false)
  readonly erroObs = signal<string | null>(null)
  readonly vistas = computed(() => this.itens().map(itemParaExibicao))

  constructor() {
    effect(() => {
      this.contatoId(); this.versao()
      untracked(() => { void this.carregar(this.estado() === 'pronto') })
    })
  }

  /** Recarrega a primeira página. `silencioso` mantém a lista na tela (sem piscar o esqueleto). */
  async carregar(silencioso = false): Promise<void> {
    if (!silencioso) this.estado.set('carregando')
    try {
      const p = await this.blocos.feed(this.contatoId(), null)
      this.itens.set(p.itens)
      this.proximo.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (silencioso) return
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }

  async maisItens(): Promise<void> {
    const cursor = this.proximo()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    this.erroMais.set('')
    try {
      const p = await this.blocos.feed(this.contatoId(), cursor)
      this.itens.update((atual) => mesclarFeed(atual, p.itens))
      this.proximo.set(p.proximoCursor)
    } catch (e) {
      this.erroMais.set(mensagemDeErro(e, 'Não foi possível carregar mais itens.'))
    } finally {
      this.carregandoMais.set(false)
    }
  }

  async anotar(ev: Event): Promise<void> {
    ev.preventDefault()
    const t = this.texto().trim()
    if (!t || this.salvando()) return
    this.salvando.set(true)
    this.erroObs.set(null)
    try {
      await this.blocos.comentar(this.contatoId(), t)
      this.texto.set('')
      this.toast.sucesso('Observação adicionada')
      await this.carregar(true)
    } catch (e) {
      this.erroObs.set(mensagemDeErro(e, 'Não foi possível salvar a observação.'))
    } finally {
      this.salvando.set(false)
    }
  }
}
