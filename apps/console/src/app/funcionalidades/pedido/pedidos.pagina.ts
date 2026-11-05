import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit, input, effect } from '@angular/core'
import { NgTemplateOutlet } from '@angular/common'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import {
  ToastServico, mensagemDeErro, mesclarPagina, formatarReais,
  CabecalhoTelaComponente, AbasComponente, FiltrosComponente, FiltroPeriodoComponente, TabelaComponente,
  CelulaDiretiva, PaginacaoComponente, ModalComponente, ListaDefinicaoComponente, BadgeComponente,
  EstadoComponente, EsqueletoComponente, PainelComponente,
  type ColunaTabela, type LinhaTabela, IconeComponente } from '../../compartilhado/ui/index.js'
import {
  rotuloDoEstado, tomDoEstado, variacaoDaGrade, formatarDataHora, indicadoresDosContadores, montarQueryPedidos, abasDeEstado,
  ABA_TODOS, type ContadoresPedidos,
} from './pedidos.regras.js'

interface PedidoItem {
  readonly id: string; readonly estado: string; readonly contatoId: string | null; readonly contato: string | null
  readonly rotulo: string | null; readonly totalCentavos: number; readonly totalPecas: number
  readonly itens: number; readonly numeroExterno: string | null; readonly criadoEm: string
}
interface LinhaItem { readonly descricaoSnapshot: string; readonly grade: Record<string, string>; readonly quantidade: number; readonly valorUnitarioCentavos: number }
interface EtapaDef { readonly etapa: string; readonly rotulo: string; readonly descricao: string; readonly disponivel: boolean; readonly motivoIndisponivel?: string }
interface PedidoDetalhe {
  readonly id: string; readonly estado: string; readonly contatoId: string | null; readonly contato: string | null
  /** A conversa onde o pedido nasceu (ADR-005) — `null` quando montado fora do chat. */
  readonly conversaId?: string | null
  readonly nome: string | null; readonly numeroExterno: string | null; readonly criadoEm: string; readonly confirmadoEm: string | null
  readonly formaPagamento: string | null; readonly observacao: string | null
  readonly canceladoEm: string | null; readonly canceladoMotivo: string | null
  readonly totalCentavos: number; readonly totalPecas: number; readonly itens: LinhaItem[]
  readonly proximasEtapas?: readonly EtapaDef[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Lista de pedidos no padrão de lista (cabeçalho, abas de estado com contagem, filtros, tabela, cursor) com
 * um detalhe em modal ao clicar em Ver. Filtro por estado e por cliente vão ao servidor
 * (cursor); a busca por texto só vale para o que já está carregado. Segue geracrm-layout-ui
 * (5 estados como ramos explícitos, tokens, responsivo, sem sobreposição).
 */
@Component({
  selector: 'app-pedidos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet, RouterLink,
    CabecalhoTelaComponente, AbasComponente, FiltrosComponente, FiltroPeriodoComponente, TabelaComponente,
    CelulaDiretiva, PaginacaoComponente, ModalComponente, ListaDefinicaoComponente, BadgeComponente,
    EstadoComponente, EsqueletoComponente, PainelComponente, IconeComponente,
  ],
  template: `
    <!-- O pedido assistido saiu do menu: "Novo pedido" é a entrada (plano de reorganização). -->
    <ui-cabecalho-tela titulo="Pedidos" subtitulo="Rascunhos, aguardando confirmação, efetivados e os que falharam no ERP.">
      <a class="btn btn--primario" routerLink="/pedido">Novo pedido</a>
    </ui-cabecalho-tela>

    @if (contatoFiltro(); as c) {
      <p class="chip-filtro">Só os pedidos de um cliente ·
        <a [routerLink]="['/contato', c]">ver ficha</a> ·
        <a routerLink="/pedidos">ver todos</a></p>
    }

    <!-- Estado como abas, com a contagem do servidor no rótulo — no lugar dos cartões que repetiam o filtro. -->
    <ui-abas class="estados" [abas]="abasEstado()" [ativa]="filtro() || ABA_TODOS" (ativaChange)="trocarAba($event)" />
    @if (valorNoErp(); as v) { <p class="resumo txt-denso">Orçamentos no ERP neste filtro: <span class="txt-dados">{{ v }}</span></p> }

    <ui-filtros placeholder="Buscar: cliente, nome, nº ERP ou código" (buscar)="buscar($event)" (aplicar)="aplicar()" (limpar)="limparFiltros()">
      <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="carregar()" />
    </ui-filtros>

    <div class="corpo">
      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso aos pedidos" descricao="Peça a um administrador para liberar o perfil de vendas." /></ui-painel>
        }
        @case ('erro') {
          <ui-painel>
            <ui-estado tipo="erro" titulo="Não foi possível carregar os pedidos" descricao="O servidor não respondeu. Dá para tentar de novo.">
              <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
            </ui-estado>
          </ui-painel>
        }
        @case ('carregando') {
          <ng-container [ngTemplateOutlet]="tabela" [ngTemplateOutletContext]="{ carregando: true }" />
        }
        @case ('pronto') {
          <ng-container [ngTemplateOutlet]="tabela" [ngTemplateOutletContext]="{ carregando: false }" />
          <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximoCursor()" [carregando]="carregandoMais()" (mais)="carregarMais()" />
          @if (avisoMais(); as aviso) {
            <p class="aviso" role="status">{{ aviso }}</p>
          }
        }
      }
    </div>

    <ng-template #tabela let-carregando="carregando">
      <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="carregando">
        <ng-template uiCelula="numeroExterno" let-p>
          {{ p.numeroExterno ?? '—' }}
        </ng-template>
        <ng-template uiCelula="cliente" let-p>
          @if (p.contato && p.contatoId) {
            <a class="cliente" [routerLink]="['/contato', p.contatoId]">{{ p.contato }}</a>
          } @else { <span class="sem">Sem cliente</span> }
          @if (p.rotulo) { <span class="sub">{{ p.rotulo }}</span> }
        </ng-template>
        <ng-template uiCelula="estado" let-p>
          <ui-badge [tom]="tomDoEstado(p.estado)">{{ rotuloDoEstado(p.estado) }}</ui-badge>
        </ng-template>
        <ng-template uiCelula="itens" let-p>
          <span class="nowrap txt-dados">{{ p.itens }} {{ p.itens === 1 ? 'item' : 'itens' }} · {{ p.totalPecas }} pç</span>
        </ng-template>
        <ng-template uiCelula="total" let-p>
          {{ reais(p.totalCentavos) }}
        </ng-template>
        <ng-template uiCelula="criadoEm" let-p>
          {{ dataHora(p.criadoEm) }}
        </ng-template>
        <ng-template uiCelula="acao" let-p>
          <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrir(p.id)">Ver</button>
        </ng-template>
        <div uiVazio>
          @if (itens().length === 0 && !temFiltro()) {
            <ui-estado titulo="Nenhum pedido ainda" icone="🧾" descricao="O pedido nasce na conversa ou aqui, pela grade do catálogo.">
              <a class="btn btn--secundario btn--pequeno" routerLink="/pedido">Novo pedido</a>
            </ui-estado>
          } @else {
            <ui-estado titulo="Nenhum pedido bate com a busca" icone="🔍" descricao="Mude a busca ou amplie o período." />
          }
        </div>
      </ui-tabela>
    </ng-template>

    @if (detalhe(); as d) {
      <ui-modal [aberto]="true" [titulo]="d.nome || 'Pedido'" largura="g" (fechar)="fechar()">
        <div class="m-topo">
          <ui-badge [tom]="tomDoEstado(d.estado)">{{ rotuloDoEstado(d.estado) }}</ui-badge>
          <div class="m-meta">
            @if (d.conversaId) {
              <button type="button" class="m-conversa" (click)="abrirConversa(d.conversaId)" title="Abrir a conversa onde este pedido nasceu"><ui-icone nome="message-circle" [tamanho]="14" /> Conversa de origem</button>
            }
            @if (d.estado === 'rascunho' && d.contatoId) {
              <a class="m-link" routerLink="/pedido" [queryParams]="{ contato: d.contatoId }">✎ Continuar montando</a>
            }
            @if (d.confirmadoEm) { <span class="ok">✓ Confirmado pelo cliente {{ dataHora(d.confirmadoEm) }}</span> }
          </div>
        </div>

        <ui-lista-definicao [colunas]="2" [itens]="[
          { rotulo: 'Cliente', valor: d.contato ?? 'Sem cliente' },
          { rotulo: 'Estado', valor: rotuloDoEstado(d.estado) },
          { rotulo: 'Forma de pagamento', valor: d.formaPagamento },
          { rotulo: 'Observação', valor: d.observacao },
          { rotulo: 'Nº ERP', valor: d.numeroExterno, mono: true },
          { rotulo: 'Criado em', valor: dataHora(d.criadoEm), mono: true }
        ]" />

        @if (carregandoDet()) {
          <div class="esqueletos" aria-hidden="true"><ui-esqueleto altura="14px" /><ui-esqueleto altura="14px" /><ui-esqueleto altura="14px" /></div>
        } @else {
          <div class="rolagem-x itens-caixa">
            <table class="itens-tab">
              <thead><tr><th>Qtd</th><th>Item</th><th>Variação</th><th class="dir">Unit.</th><th class="dir">Subtotal</th></tr></thead>
              <tbody>
                @for (i of d.itens; track $index) {
                  <tr>
                    <td class="txt-dados">{{ i.quantidade }}×</td>
                    <td class="encolhe">{{ i.descricaoSnapshot }}</td>
                    <td>{{ variacao(i.grade) || '—' }}</td>
                    <td class="dir txt-dados">{{ reais(i.valorUnitarioCentavos) }}</td>
                    <td class="dir txt-dados">{{ reais(i.quantidade * i.valorUnitarioCentavos) }}</td>
                  </tr>
                }
                @if (d.itens.length === 0) { <tr><td colspan="5" class="vazio">Sem itens.</td></tr> }
              </tbody>
            </table>
          </div>

          @if (d.formaPagamento || d.observacao) {
            <div class="m-ctx">
              @if (d.formaPagamento) { <div><span class="lab">Pagamento</span> {{ d.formaPagamento }}</div> }
              @if (d.observacao) { <div><span class="lab">Obs.</span> {{ d.observacao }}</div> }
            </div>
          }

          <!-- ⚠️ Cancelado NÃO é um sumiço: mostra por quê e deixa reaproveitar.
               Um pedido superado por um resumo novo continua valendo como
               trabalho de montagem — o vendedor abre, ajusta e reenvia. -->
          <!-- ⚠️ O ERP recebe ORÇAMENTO, não venda: o status é fixo nessa via.
               Sem dizer isso aqui, o operador lê "no ERP" e entende que a
               venda fechou — e descobre o contrário no fim do mês. -->
          @if (d.estado === 'efetivado') {
            <p class="m-orcamento">
              <strong>Orçamento criado no ERP.</strong>
              Para faturar, converta em venda no GeraCloud.
            </p>
          }

          @if (d.estado === 'cancelado') {
            <div class="m-cancel">
              <div><strong>Cancelado</strong> — {{ d.canceladoMotivo ?? 'sem motivo registrado' }}</div>
              <button type="button" class="btn btn--secundario btn--pequeno" (click)="reabrir(d.id)" [disabled]="reabrindo()">
                {{ reabrindo() ? 'Reabrindo…' : 'Reabrir como rascunho' }}</button>
              @if (erroReabrir()) { <span class="err">{{ erroReabrir() }}</span> }
            </div>
          }

          <div class="m-total">
            <span>{{ d.totalPecas }} peças · {{ d.itens.length }} {{ d.itens.length === 1 ? 'item' : 'itens' }}</span>
            <strong class="txt-dados">{{ reais(d.totalCentavos) }}</strong>
          </div>

          <!-- Próximas etapas: só no pedido confirmado. Cada uma DEGRADA honesto
               enquanto o GeraCloud não está ligado (ADR-008) — nunca finge sucesso. -->
          @if (d.estado === 'confirmado' && d.proximasEtapas?.length) {
            <div class="m-etapas">
              <h3 class="txt-secao">Próximas etapas</h3>
              <p class="dica">O cliente confirmou. Estes passos entram quando o GeraCloud for conectado.</p>
              @for (e of d.proximasEtapas!; track e.etapa) {
                <div class="etapa">
                  <div class="e-txt">
                    <span class="e-rot">{{ e.rotulo }}</span>
                    <span class="e-desc">{{ e.descricao }}</span>
                  </div>
                  <button type="button" class="e-btn" [disabled]="!e.disponivel || acionando() === e.etapa"
                          (click)="acionarEtapa(d.id, e.etapa)"
                          [title]="e.disponivel ? '' : (e.motivoIndisponivel || '')">
                    @if (!e.disponivel) { 🔒 Em breve } @else { {{ acionando() === e.etapa ? '…' : 'Gerar' }} }
                  </button>
                </div>
              }
              @if (etapaMsg(); as m) {
                <div class="e-msg" [class.e-msg--ok]="m.ok">{{ m.ok ? '✅ ' : '⚠️ ' }}{{ m.texto }}</div>
              }
            </div>
          }
        }
      </ui-modal>
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .chip-filtro { margin: 0 0 var(--espacamento-4); font-size: 12px; color: var(--texto-secundario); }
    .chip-filtro a { color: var(--acao); }
    .estados { margin-bottom: var(--espacamento-3); }
    .resumo { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); }
    .nowrap { white-space: nowrap; }
    .corpo { margin-top: var(--espacamento-4); }
    .cliente { color: var(--acao); text-decoration: none; }
    .cliente:hover { text-decoration: underline; }
    .sem { color: var(--texto-suave); }
    .sub { display: block; color: var(--texto-suave); font-size: 12px; }
    .aviso { margin: var(--espacamento-2) 0 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--atencao); font-size: 13px; }
    /* Detalhe (dentro do ui-modal) */
    .m-topo { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3);
      margin-bottom: var(--espacamento-4); }
    .m-meta { display: flex; flex-wrap: wrap; gap: var(--espacamento-3); font-size: 12px; color: var(--texto-secundario); }
    .m-link { color: var(--acao); text-decoration: none; }
    .m-conversa { border: 0; background: transparent; color: var(--acao); font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
    .m-conversa:hover, .m-link:hover { text-decoration: underline; }
    .m-meta .ok { color: var(--sucesso); }
    .esqueletos { display: grid; gap: var(--espacamento-2); margin-top: var(--espacamento-5); }
    .itens-caixa { margin-top: var(--espacamento-5); }
    .itens-tab { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 460px; }
    .itens-tab th, .itens-tab td { padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); text-align: left; }
    .itens-tab th { color: var(--texto-suave); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .itens-tab .dir { text-align: right; }
    .itens-tab .vazio { text-align: center; color: var(--texto-suave); }
    .m-ctx { display: grid; gap: var(--espacamento-1); margin: var(--espacamento-4) 0; font-size: 13px; color: var(--texto); }
    .m-ctx .lab { color: var(--texto-suave); margin-right: var(--espacamento-1); }
    .m-cancel { margin-top: var(--espacamento-3); padding: var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto);
      font-size: 13px; display: grid; gap: var(--espacamento-2); justify-items: start; }
    .m-cancel .err { color: var(--erro); font-size: 12px; }
    .m-orcamento { margin-top: var(--espacamento-3); padding: var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto);
      font-size: 13px; line-height: 1.5; }
    .m-total { display: flex; justify-content: space-between; align-items: baseline; padding-top: var(--espacamento-3); border-top: 2px solid var(--borda); font-size: 14px; }
    .m-total strong { font-size: 18px; color: var(--texto); }
    .dica { color: var(--texto-suave); font-size: 13px; }
    /* Próximas etapas (pós-confirmação) */
    .m-etapas { margin-top: var(--espacamento-5); padding-top: var(--espacamento-4); border-top: 1px solid var(--borda); }
    .m-etapas h3 { margin: 0 0 var(--espacamento-1); }
    .m-etapas .dica { margin: 0 0 var(--espacamento-3); }
    .etapa { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); }
    .etapa:last-of-type { border-bottom: none; }
    .e-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .e-rot { color: var(--texto); font-size: 14px; }
    .e-desc { color: var(--texto-suave); font-size: 12px; }
    .e-btn { flex: none; padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .e-btn:not(:disabled) { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); cursor: pointer; }
    .e-btn:disabled { cursor: not-allowed; opacity: .85; }
    .e-msg { margin-top: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--atencao); font-size: 13px; }
    .e-msg--ok { background: var(--sucesso-suave); color: var(--sucesso); }
  `,
})
export class PedidosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly inbox = inject(InboxServico)
  private readonly toast = inject(ToastServico)
  /** Deep link `/pedido/:id` (component input binding): abre o detalhe por cima da lista. */
  readonly id = input<string>()
  /** `?contatoId=` — a ficha do cliente manda para cá. */
  readonly contatoFiltro = signal<string | null>(null)

  /** Colunas da tabela: nº ERP (mono), cliente, estado, itens, total (dir, mono), criado em, ação. */
  readonly colunas: readonly ColunaTabela[] = [
    { chave: 'numeroExterno', rotulo: 'Nº ERP', mono: true, largura: '120px' },
    { chave: 'cliente', rotulo: 'Cliente' },
    { chave: 'estado', rotulo: 'Estado', largura: '160px' },
    { chave: 'itens', rotulo: 'Itens', largura: '180px' },
    { chave: 'total', rotulo: 'Total', alinhamento: 'dir', mono: true, largura: '140px' },
    { chave: 'criadoEm', rotulo: 'Criado em', mono: true, largura: '150px' },
    { chave: 'acao', rotulo: '', alinhamento: 'dir', largura: '90px' },
  ]
  protected readonly ABA_TODOS = ABA_TODOS

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly PedidoItem[]>([])
  readonly filtro = signal('')
  readonly termo = signal('')
  readonly inicio = signal('')
  readonly fim = signal('')
  readonly contadores = signal<ContadoresPedidos | null>(null)
  readonly temFiltro = computed(() => !!(this.termo().trim() || this.filtro() || (this.inicio() && this.fim())))
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  /** Estado PARCIAL: a lista já carregada segue na tela; só a próxima página falhou. */
  readonly avisoMais = signal<string | null>(null)
  readonly detalhe = signal<PedidoDetalhe | null>(null)
  readonly reabrindo = signal(false)
  readonly erroReabrir = signal<string | null>(null)
  readonly carregandoDet = signal(false)
  readonly acionando = signal<string | null>(null)
  readonly etapaMsg = signal<{ ok: boolean; texto: string } | null>(null)

  /** Linhas da tabela: o que o servidor devolveu para a busca, o período e o estado. */
  readonly linhas = computed<LinhaTabela[]>(() => this.itens().map((p) => ({ ...p })))

  /** Abas de estado: contagem do SERVIDOR (todo o filtro, não só a página); sem contadores, sem número. */
  readonly abasEstado = computed(() => abasDeEstado(this.contadores()))
  /** Valor dos orçamentos efetivados no filtro — linha discreta, só quando há valor. */
  readonly valorNoErp = computed(() => {
    const c = this.contadores()
    const i = c ? indicadoresDosContadores(c) : null
    return i && i.valorEfetivadoCentavos > 0 ? `${i.efetivados} · ${formatarReais(i.valorEfetivadoCentavos)}` : null
  })

  constructor() {
    effect(() => {
      const id = this.id()
      if (id) void this.abrir(id)
    })
  }

  ngOnInit(): void {
    this.contatoFiltro.set(this.route.snapshot.queryParamMap.get('contatoId'))
    void this.carregar()
  }

  /** Abre o chat onde o pedido nasceu (o rail expande sozinho). */
  abrirConversa(conversaId: string): void {
    this.fechar()
    void this.inbox.abrir(conversaId)
  }

  protected readonly rotuloDoEstado = rotuloDoEstado
  protected readonly tomDoEstado = tomDoEstado
  protected readonly dataHora = formatarDataHora

  reais(c: number): string { return formatarReais(c) }
  variacao(g: Record<string, string> | null | undefined): string { return variacaoDaGrade(g) }

  trocar(f: string): void { this.filtro.set(f); void this.carregar() }
  trocarAba(id: string): void { this.trocar(id === ABA_TODOS ? '' : id) }

  buscar(texto: string): void {
    if (texto.trim() === this.termo().trim()) return
    this.termo.set(texto); void this.carregar()
  }

  /** Enter/Filtrar: só recarrega se algo mudou (a busca e o Enter emitem dois eventos para o mesmo filtro). */
  aplicar(): void {
    if (this.query(null, true) !== this.consultaFeita) void this.carregar()
  }
  private consultaFeita = ''

  limparFiltros(): void {
    this.termo.set(''); this.inicio.set(''); this.fim.set(''); this.filtro.set('')
    void this.carregar()
  }

  /** Filtros da lista; os contadores usam os mesmos, menos o estado (é o que os cards particionam). */
  private query(cursor: string | null, comEstado: boolean): string {
    const p = montarQueryPedidos({
      estado: comEstado ? this.filtro() : '', contatoId: this.contatoFiltro(), q: this.termo(),
      inicio: this.inicio(), fim: this.fim(), cursor,
    }).toString()
    return p ? '?' + p : ''
  }

  private url(cursor: string | null): string { return `/v1/pedidos${this.query(cursor, true)}` }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.avisoMais.set(null)
    this.consultaFeita = this.query(null, true)
    // Contadores em paralelo: se falharem, os cards mostram traço e a lista segue.
    const cont = firstValueFrom(this.http.get<ContadoresPedidos>(`/v1/pedidos/contadores${this.query(null, false)}`))
      .then((c) => this.contadores.set(c), () => this.contadores.set(null))
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(null)))
      this.itens.set(r.itens); this.proximoCursor.set(r.proximoCursor); this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
    await cont
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    this.avisoMais.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(cursor)))
      this.itens.update((a) => mesclarPagina(a, r.itens, (p) => p.id)); this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      this.avisoMais.set(mensagemDeErro(e, 'Não foi possível carregar mais pedidos.') + ' Os que já aparecem continuam aqui.')
    }
    finally { this.carregandoMais.set(false) }
  }

  /**
   * Reabre um pedido cancelado como rascunho.
   *
   * ⚠️ Cancelar não pode ser um sumiço: o pedido superado por um resumo novo
   * continua valendo como trabalho de montagem. Reabrir devolve ao rascunho para
   * o vendedor ajustar e enviar de novo.
   */
  async reabrir(id: string): Promise<void> {
    if (this.reabrindo()) return
    this.reabrindo.set(true); this.erroReabrir.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/pedidos/${id}/reabrir`, {}))
      await this.abrir(id)     // relê o detalhe já como rascunho
      await this.carregar()    // e a lista, que mudou de estado
    } catch (e) {
      // ⚠️ A API devolve a frase pronta com a ação corretiva — não invente outra.
      this.erroReabrir.set(e instanceof HttpErrorResponse && typeof e.error?.mensagem === 'string'
        ? e.error.mensagem : 'Não foi possível reabrir.')
    } finally { this.reabrindo.set(false) }
  }

  async abrir(id: string): Promise<void> {
    this.carregandoDet.set(true)
    // Abre o modal já com um esqueleto mínimo enquanto carrega os itens.
    this.detalhe.set({ id, estado: '', contatoId: null, contato: null, nome: null, numeroExterno: null, criadoEm: new Date().toISOString(), confirmadoEm: null, canceladoEm: null, canceladoMotivo: null, formaPagamento: null, observacao: null, totalCentavos: 0, totalPecas: 0, itens: [] })
    try {
      const d = await firstValueFrom(this.http.get<PedidoDetalhe>(`/v1/pedidos/${id}`))
      this.detalhe.set(d)
    } catch (e) {
      this.fechar()
      this.toast.erro(e instanceof HttpErrorResponse && e.status === 404
        ? 'Pedido não encontrado — pode ter sido removido.' : mensagemDeErro(e, 'Não foi possível abrir o pedido.'))
    } finally { this.carregandoDet.set(false) }
  }
  /** Fecha o detalhe; se veio pelo deep link `/pedido/:id`, volta para a lista. */
  fechar(): void {
    this.detalhe.set(null); this.etapaMsg.set(null); this.acionando.set(null)
    if (this.id()) void this.router.navigate(['/pedidos'], { queryParams: this.contatoFiltro() ? { contatoId: this.contatoFiltro() } : {} })
  }

  /** Aciona uma próxima etapa. Hoje DEGRADA honesto: mostra o motivo, não finge. */
  async acionarEtapa(id: string, etapa: string): Promise<void> {
    if (this.acionando()) return
    this.acionando.set(etapa); this.etapaMsg.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; motivo?: string; mensagem?: string }>(`/v1/pedidos/${id}/etapa/${etapa}`, {}))
      this.etapaMsg.set({ ok: r.ok, texto: r.mensagem || (r.ok ? 'Feito.' : 'Etapa ainda não disponível.') })
    } catch (e) {
      const erro = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string })?.mensagem : undefined
      this.etapaMsg.set({ ok: false, texto: erro || 'Não foi possível acionar a etapa.' })
    } finally { this.acionando.set(null) }
  }
}
