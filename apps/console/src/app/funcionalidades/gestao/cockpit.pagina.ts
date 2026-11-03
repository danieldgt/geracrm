import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  ROTULO_CARD_COCKPIT,
  type AgrupamentoCockpit, type CardCockpit, type EventoAgenda, type FaixaAguardando, type ItemCockpit, type RespostaCockpit,
  type RespostaItensCockpit,
} from '@geracrm/shared'
import {
  BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, PaginacaoComponente,
  PainelComponente, SelectComponente, StatCardComponente, TabelaComponente, mesclarPagina, type ColunaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { EventosServico } from '../../nucleo/eventos.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { AgendaDetalheModalComponente } from '../agenda/agenda-detalhe-modal.componente.js'
import { TarefaModalComponente } from '../crm/tarefa-modal.componente.js'
import {
  EVENTOS_DO_COCKPIT, ROTULO_FAIXA, TOM_FAIXA, acoesDoItem, cartoesDoCockpit, colunasDosGrupos, criarRecargaAgendada,
  linhasDosGrupos, queryDosItens, resumoPorFaixa, textoAtualizado, textoHa, type AcaoItem, type RecargaAgendada,
} from './cockpit.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
type EstadoItens = 'ocioso' | 'carregando' | 'pronto' | 'erro'

/**
 * Cockpit do gestor (D1) — SLA, esquecidos, reuniões e quem está sem próximo passo, AGORA.
 * Cards clicáveis → tabela por filial/vendedor (células clicáveis) → lista do card por cursor com ações rápidas.
 * Tempo real: recarrega nos eventos SSE de atendimento (debounce de 5 s); sem evento, a cada 2 min.
 * Os cards de agenda somem com o módulo desligado. A faixa do SLA vem SEMPRE com rótulo, nunca só cor.
 */
@Component({
  selector: 'app-cockpit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, AgendaDetalheModalComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente,
    EstadoComponente, PaginacaoComponente, PainelComponente, SelectComponente, StatCardComponente, TabelaComponente,
    TarefaModalComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Cockpit" subtitulo="SLA, esquecidos, reuniões e quem está sem próximo passo — agora.">
      <span class="atualizado txt-denso" aria-live="polite">{{ atualizado() }}</span>
      <button type="button" class="btn btn--secundario" (click)="recarregarAgora()" [disabled]="estado() === 'carregando'">Atualizar</button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="cartoes"><ui-esqueleto altura="84px" /><ui-esqueleto altura="84px" /><ui-esqueleto altura="84px" /><ui-esqueleto altura="84px" /></div>
        <ui-esqueleto altura="180px" />
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Cockpit só para a gestão" descricao="Peça a um administrador o papel de gestor ou supervisor." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o Cockpit" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="recarregarAgora()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (dados(); as d) {
          <div class="cartoes">
            @for (c of cartoes(); track c.chave) {
              <div class="cartao" [class.ativo]="cardSel() === c.chave && !faixaSel()">
                <button type="button" class="cartao-btn" [attr.aria-pressed]="cardSel() === c.chave"
                  [attr.aria-label]="c.rotulo + ': ' + c.valor + '. Ver a lista.'" (click)="selecionar(c.chave, null, null)">
                  <ui-stat-card [valor]="c.valor" [rotulo]="c.rotulo" [tom]="c.tom" />
                </button>
                @if (c.chave === 'aguardandoHumano') {
                  <p class="faixas">
                    @for (f of faixas; track f) {
                      @if (d.cards.aguardandoHumano.porFaixa[f] > 0) {
                        <button type="button" class="faixa-btn" [class.ativo]="cardSel() === c.chave && faixaSel() === f"
                          (click)="selecionar('aguardandoHumano', null, f)">
                          <ui-badge [tom]="tomFaixa[f]">{{ rotuloFaixa[f] }}: {{ d.cards.aguardandoHumano.porFaixa[f] }}</ui-badge>
                        </button>
                      }
                    }
                    @if (d.cards.aguardandoHumano.total === 0) { <span class="suave txt-denso">Ninguém esperando</span> }
                  </p>
                  <span class="sr-only">{{ resumo() }}</span>
                }
              </div>
            }
          </div>

          <div class="barra">
            <div class="chips" role="group" aria-label="Agrupar por">
              @for (o of agrupamentos; track o.valor) {
                <button type="button" class="chip" [attr.aria-pressed]="agrupar() === o.valor" (click)="trocarAgrupamento(o.valor)">{{ o.rotulo }}</button>
              }
            </div>
            <ui-select rotulo="Esquecido = sem toque há" [opcoes]="opcoesDias" [valor]="diasTexto()" (valorChange)="trocarDias($event)" />
          </div>

          <ui-painel>
            <h2 class="txt-secao">Por {{ agrupar() === 'filial' ? 'filial' : 'vendedor' }}</h2>
            @if (linhas().length === 0) {
              <ui-estado tipo="vazio" titulo="Nada pendente" descricao="Nenhum grupo tem algo a olhar agora. Bom sinal." />
            } @else {
              <ui-tabela [colunas]="colunas()" [linhas]="linhas()" [chaveLinha]="chaveGrupo">
                @for (c of cartoes(); track c.chave) {
                  <ng-template [uiCelula]="c.chave" let-l>
                    @if (l.valores[c.chave] > 0) {
                      <button type="button" class="celula-btn" (click)="selecionar(c.chave, l.chave, null)"
                        [attr.aria-label]="l.rotulo + ', ' + c.rotulo + ': ' + l.valores[c.chave] + '. Ver a lista.'">{{ l.valores[c.chave] }}</button>
                    } @else { <span class="suave">0</span> }
                  </ng-template>
                }
              </ui-tabela>
            }
          </ui-painel>

          @if (cardSel(); as card) {
            <ui-painel>
              <h2 class="txt-secao" id="titulo-itens">
                {{ rotuloCard(card) }}
                @if (grupoSel()) { <span class="suave"> · {{ rotuloGrupoSel() }}</span> }
                @if (faixaSel(); as f) { <span class="suave"> · {{ rotuloFaixa[f] }}</span> }
              </h2>
              <p><button type="button" class="btn btn--fantasma btn--pequeno" (click)="fecharItens()">Fechar lista</button></p>
              @switch (estadoItens()) {
                @case ('erro') {
                  <ui-estado tipo="erro" titulo="Não foi possível carregar a lista" descricao="Tente de novo em instantes.">
                    <button type="button" class="btn btn--secundario" (click)="carregarItens()">Tentar de novo</button>
                  </ui-estado>
                }
                @default {
                  <ui-tabela [colunas]="colunasItens()" [linhas]="linhasItens()" [carregando]="estadoItens() === 'carregando'" [chaveLinha]="chaveItem">
                    <ng-template uiCelula="rotulo" let-i><span class="tit">{{ i.rotulo }}</span></ng-template>
                    <ng-template uiCelula="responsavel" let-i>{{ i.responsavel ?? 'Sem responsável' }}</ng-template>
                    <ng-template uiCelula="desde" let-i>{{ ha(i.desde) }}</ng-template>
                    <ng-template uiCelula="faixa" let-i>
                      @if (i.faixa) { <ui-badge [tom]="tomDaFaixa(i.faixa)">{{ rotuloDaFaixa(i.faixa) }}</ui-badge> }
                    </ng-template>
                    <ng-template uiCelula="acoes" let-i>
                      <span class="acoes">
                        @for (a of acoes(i); track a) {
                          @switch (a) {
                            @case ('abrirEvento') { <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirEvento(i)">Abrir evento</button> }
                            @case ('abrirConversa') { <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirConversa(i)">Abrir conversa</button> }
                            @case ('abrirFicha') { <a class="btn btn--secundario btn--pequeno" [routerLink]="['/contato', i.contatoId]">Abrir ficha</a> }
                            @case ('criarTarefa') { <button type="button" class="btn btn--fantasma btn--pequeno" (click)="criarTarefa(i)">Criar tarefa</button> }
                          }
                        }
                      </span>
                    </ng-template>
                    <div uiVazio>
                      <ui-estado titulo="Nada nesta lista" descricao="Nenhum item para este recorte agora." />
                    </div>
                  </ui-tabela>
                  @if (estadoItens() === 'pronto') {
                    <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximoCursor()" [carregando]="carregandoMais()" (mais)="carregarMais()" />
                  }
                }
              }
            </ui-painel>
          }
        }
      }
    }

    <app-tarefa-modal [aberto]="!!tarefaPara()" [contatoId]="tarefaPara()?.contatoId ?? null" [contatoNome]="tarefaPara()?.contato ?? null"
      (fechar)="tarefaPara.set(null)" (criada)="aoCriarTarefa()" />
    <app-agenda-detalhe-modal [evento]="eventoAberto()" (fechar)="eventoAberto.set(null)" (alterado)="aoAlterarEvento()" />
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); width: 100%; padding: var(--espacamento-6); align-content: start; }
    .atualizado { color: var(--texto-suave); margin-right: var(--espacamento-3); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--espacamento-3); }
    .cartao { display: grid; gap: var(--espacamento-1); align-content: start; min-width: 0; }
    .cartao-btn { padding: 0; border: 2px solid transparent; border-radius: var(--raio-painel); background: transparent; text-align: left; cursor: pointer; font: inherit; color: inherit; min-width: 0; }
    .cartao.ativo .cartao-btn { border-color: var(--acao); }
    .faixas { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); margin: 0; }
    .faixa-btn { padding: 0; border: 0; background: transparent; cursor: pointer; font: inherit; border-radius: var(--raio-completo); }
    .faixa-btn.ativo { outline: 2px solid var(--acao); outline-offset: 1px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .barra { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--espacamento-3); }
    .chips { display: inline-flex; gap: var(--espacamento-2); }
    .chip { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto); font: inherit; cursor: pointer; }
    .chip[aria-pressed='true'] { border-color: var(--acao); background: var(--acao-suave); }
    .celula-btn { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--acao); font: inherit; cursor: pointer; min-width: 40px; }
    .celula-btn:hover { background: var(--superficie-hover); }
    .suave { color: var(--texto-suave); }
    .tit { color: var(--texto); }
    .acoes { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-1); justify-content: flex-end; }
    ui-tabela { display: block; margin-top: var(--espacamento-2); }
  `,
})
export class CockpitPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly eventos = inject(EventosServico)
  private readonly inbox = inject(InboxServico)

  protected readonly faixas: readonly FaixaAguardando[] = ['estourado', 'atencao', 'ok']
  protected readonly rotuloFaixa = ROTULO_FAIXA
  protected readonly tomFaixa = TOM_FAIXA
  protected readonly agrupamentos: readonly { valor: AgrupamentoCockpit; rotulo: string }[] = [
    { valor: 'vendedor', rotulo: 'Por vendedor' }, { valor: 'filial', rotulo: 'Por filial' },
  ]
  protected readonly opcoesDias: OpcaoSelect[] = [7, 15, 30, 60].map((n) => ({ valor: String(n), rotulo: `${n} dias` }))

  protected readonly estado = signal<Estado>('carregando')
  protected readonly dados = signal<RespostaCockpit | null>(null)
  protected readonly agrupar = signal<AgrupamentoCockpit>('vendedor')
  protected readonly dias = signal(7)
  protected readonly diasTexto = computed(() => String(this.dias()))
  protected readonly agora = signal(new Date())

  protected readonly cardSel = signal<CardCockpit | null>(null)
  protected readonly grupoSel = signal<string | null>(null)
  protected readonly faixaSel = signal<FaixaAguardando | null>(null)
  protected readonly itens = signal<readonly ItemCockpit[]>([])
  protected readonly proximoCursor = signal<string | null>(null)
  protected readonly estadoItens = signal<EstadoItens>('ocioso')
  protected readonly carregandoMais = signal(false)

  protected readonly tarefaPara = signal<ItemCockpit | null>(null)
  protected readonly eventoAberto = signal<EventoAgenda | null>(null)

  protected readonly cartoes = computed(() => { const d = this.dados(); return d ? cartoesDoCockpit(d.cards) : [] })
  protected readonly colunas = computed(() => colunasDosGrupos(this.cartoes(), this.agrupar() === 'filial' ? 'Filial' : 'Vendedor'))
  protected readonly linhas = computed(() => { const d = this.dados(); return d ? linhasDosGrupos(d.grupos, this.cartoes()) : [] })
  protected readonly resumo = computed(() => { const d = this.dados(); return d ? resumoPorFaixa(d.cards.aguardandoHumano.porFaixa) : '' })
  protected readonly atualizado = computed(() => textoAtualizado(this.dados()?.geradoEm ?? null, this.agora()))
  protected readonly rotuloGrupoSel = computed(() => this.dados()?.grupos.find((g) => g.chave === this.grupoSel())?.rotulo ?? '')
  protected readonly colunasItens = computed<readonly ColunaTabela[]>(() => [
    { chave: 'rotulo', rotulo: 'Contato' },
    { chave: 'responsavel', rotulo: 'Responsável' },
    { chave: 'desde', rotulo: this.cardSel() === 'aguardandoHumano' ? 'Esperando' : 'Desde' },
    ...(this.cardSel() === 'aguardandoHumano' ? [{ chave: 'faixa', rotulo: 'Faixa do SLA' }] : []),
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir' as const },
  ])
  protected readonly linhasItens = computed(() => this.itens() as unknown as Record<string, unknown>[])
  protected readonly chaveGrupo = (l: Record<string, unknown>): string => String(l['chave'])
  protected readonly chaveItem = (l: Record<string, unknown>): string => String(l['id'])

  #recarga: RecargaAgendada | null = null
  #pedido = 0
  #pedidoItens = 0

  constructor() {
    const destroi = inject(DestroyRef)
    // Só o "atualizado há X" anda com o relógio; os DADOS só mudam por evento (ou pelo fallback de 2 min).
    const tique = setInterval(() => this.agora.set(new Date()), 30_000)
    const cancelar = EVENTOS_DO_COCKPIT.map((tipo) => this.eventos.escutar(tipo, () => this.#recarga?.acionar()))
    destroi.onDestroy(() => { clearInterval(tique); for (const c of cancelar) c(); this.#recarga?.parar() })
  }

  ngOnInit(): void {
    this.#recarga = criarRecargaAgendada(() => void this.carregar(true))
    void this.carregar(false)
  }

  recarregarAgora(): void { void this.carregar(false) }

  protected async carregar(silencioso: boolean): Promise<void> {
    const n = ++this.#pedido
    if (!silencioso || !this.dados()) this.estado.set('carregando')
    try {
      const d = await firstValueFrom(this.http.get<RespostaCockpit>(`/v1/gestao/cockpit?agrupar=${this.agrupar()}&dias=${this.dias()}`))
      if (n !== this.#pedido) return
      this.dados.set(d)
      this.agora.set(new Date())
      this.estado.set('pronto')
      // A lista aberta acompanha os números (sem perder a posição quando a recarga é silenciosa).
      if (this.cardSel() && silencioso) void this.carregarItens(true)
    } catch (e) {
      if (n !== this.#pedido) return
      if (silencioso && this.dados()) { /* mantém o que já está na tela; o "atualizado há" denuncia a defasagem */ }
      else this.estado.set(e instanceof HttpErrorResponse && (e.status === 403 || e.status === 401) ? 'sem_permissao' : 'erro')
    } finally {
      if (n === this.#pedido) this.#recarga?.recarregou()
    }
  }

  protected trocarAgrupamento(a: AgrupamentoCockpit): void {
    if (a === this.agrupar()) return
    this.agrupar.set(a)
    this.grupoSel.set(null)
    void this.carregar(false)
    if (this.cardSel()) void this.carregarItens()
  }

  protected trocarDias(v: string): void {
    const n = Number(v)
    if (!Number.isFinite(n) || n === this.dias()) return
    this.dias.set(n)
    void this.carregar(false)
    if (this.cardSel()) void this.carregarItens()
  }

  protected selecionar(card: CardCockpit, grupo: string | null, faixa: FaixaAguardando | null): void {
    this.cardSel.set(card)
    this.grupoSel.set(grupo)
    this.faixaSel.set(faixa)
    void this.carregarItens()
  }

  protected fecharItens(): void {
    this.cardSel.set(null); this.grupoSel.set(null); this.faixaSel.set(null)
    this.itens.set([]); this.proximoCursor.set(null); this.estadoItens.set('ocioso')
  }

  protected async carregarItens(silencioso = false): Promise<void> {
    const card = this.cardSel()
    if (!card) return
    const n = ++this.#pedidoItens
    if (!silencioso) { this.estadoItens.set('carregando'); this.itens.set([]); this.proximoCursor.set(null) }
    try {
      const r = await firstValueFrom(this.http.get<RespostaItensCockpit>(`/v1/gestao/cockpit/itens?${this.query(card, null)}`))
      if (n !== this.#pedidoItens) return
      this.itens.set(r.itens); this.proximoCursor.set(r.proximoCursor); this.estadoItens.set('pronto')
    } catch {
      if (n === this.#pedidoItens && !silencioso) this.estadoItens.set('erro')
    }
  }

  protected async carregarMais(): Promise<void> {
    const card = this.cardSel(); const cursor = this.proximoCursor()
    if (!card || !cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    const n = this.#pedidoItens
    try {
      const r = await firstValueFrom(this.http.get<RespostaItensCockpit>(`/v1/gestao/cockpit/itens?${this.query(card, cursor)}`))
      if (n !== this.#pedidoItens) return
      this.itens.update((a) => mesclarPagina(a, r.itens, (i) => i.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch { /* o botão "Carregar mais" continua; tentar de novo é um clique */ }
    finally { this.carregandoMais.set(false) }
  }

  private query(card: CardCockpit, cursor: string | null): string {
    return queryDosItens({ card, agrupar: this.agrupar(), grupo: this.grupoSel(), dias: this.dias(), faixa: this.faixaSel(), cursor })
  }

  protected tomDaFaixa(f: FaixaAguardando): 'sucesso' | 'atencao' | 'erro' { return TOM_FAIXA[f] }
  protected rotuloDaFaixa(f: FaixaAguardando): string { return ROTULO_FAIXA[f] }
  protected rotuloCard(c: CardCockpit): string { return ROTULO_CARD_COCKPIT[c] }
  protected ha(iso: string): string { return textoHa(iso, this.agora()) }
  protected acoes(i: ItemCockpit): readonly AcaoItem[] { return acoesDoItem(i) }

  protected abrirConversa(i: ItemCockpit): void { if (i.conversaId) void this.inbox.abrir(i.conversaId) }
  protected criarTarefa(i: ItemCockpit): void { this.tarefaPara.set(i) }
  protected aoCriarTarefa(): void { this.tarefaPara.set(null); void this.carregar(true) }

  protected async abrirEvento(i: ItemCockpit): Promise<void> {
    try {
      this.eventoAberto.set(await firstValueFrom(this.http.get<EventoAgenda>(`/v1/agenda/eventos/${i.id}`)))
    } catch { /* evento removido: a próxima recarga tira a linha */ }
  }
  protected aoAlterarEvento(): void { this.eventoAberto.set(null); void this.carregar(true); void this.carregarItens(true) }
}
