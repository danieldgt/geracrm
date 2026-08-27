import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface PedidoItem {
  readonly id: string; readonly estado: string; readonly contatoId: string | null; readonly contato: string | null
  readonly rotulo: string | null; readonly totalCentavos: number; readonly totalPecas: number
  readonly itens: number; readonly numeroExterno: string | null; readonly criadoEm: string
}
interface LinhaItem { readonly descricaoSnapshot: string; readonly grade: Record<string, string>; readonly quantidade: number; readonly valorUnitarioCentavos: number }
interface EtapaDef { readonly etapa: string; readonly rotulo: string; readonly descricao: string; readonly disponivel: boolean; readonly motivoIndisponivel?: string }
interface PedidoDetalhe {
  readonly id: string; readonly estado: string; readonly contatoId: string | null; readonly contato: string | null
  readonly nome: string | null; readonly numeroExterno: string | null; readonly criadoEm: string; readonly confirmadoEm: string | null
  readonly formaPagamento: string | null; readonly observacao: string | null
  readonly canceladoEm: string | null; readonly canceladoMotivo: string | null
  readonly totalCentavos: number; readonly totalPecas: number; readonly itens: LinhaItem[]
  readonly proximasEtapas?: readonly EtapaDef[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const FILTROS = [
  { chave: '', rotulo: 'Todos' },
  { chave: 'rascunho', rotulo: 'Rascunhos' },
  { chave: 'aguardando_confirmacao', rotulo: 'Aguardando SIM' },
  { chave: 'confirmado', rotulo: 'Confirmados' },
  { chave: 'efetivado', rotulo: 'Efetivados' },
  { chave: 'falhou', rotulo: 'Falharam' },
]

/**
 * Lista de pedidos com vínculo ao cliente + detalhes por linha, e um MODAL com
 * todos os detalhes do pedido ao clicar. Filtro por estado + cursor. Segue
 * geracrm-layout-ui (5 estados, tokens, responsivo, sem sobreposição).
 */
@Component({
  selector: 'app-pedidos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Pedidos</h1>
      <p class="sub">Todos os pedidos por estado, vinculados ao cliente. Clique para ver os detalhes.</p>
    </header>

    <div class="filtros">
      @for (f of filtros; track f.chave) {
        <button [class.on]="filtro() === f.chave" (click)="trocar(f.chave)">{{ f.rotulo }}</button>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso aos pedidos</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhum pedido aqui</h2>
            <p>Monte um pedido pela conversa ou pelo <a routerLink="/pedido">Pedido Assistido</a>.</p></div>
        } @else {
          <ul class="lista">
            @for (p of itens(); track p.id) {
              <li class="ped" (click)="abrir(p.id)">
                <span class="badge" [class]="'badge--' + p.estado">{{ rotuloEstado(p.estado) }}</span>
                <div class="col encolhe">
                  @if (p.contato && p.contatoId) {
                    <a class="cliente" [routerLink]="['/contato', p.contatoId]" (click)="$event.stopPropagation()">{{ p.contato }}</a>
                  } @else { <span class="cliente sem">Sem cliente</span> }
                  <span class="sub-linha">
                    @if (p.rotulo) { {{ p.rotulo }} · } {{ p.itens }} {{ p.itens === 1 ? 'item' : 'itens' }} · {{ p.totalPecas }} pç
                    @if (p.numeroExterno) { · NF {{ p.numeroExterno }} }
                  </span>
                </div>
                <span class="total txt-dados">{{ reais(p.totalCentavos) }}</span>
                <span class="data txt-dados">{{ p.criadoEm | date: 'dd/MM/yy' }}</span>
                <span class="chevron" aria-hidden="true">›</span>
              </li>
            }
          </ul>
          @if (proximoCursor()) {
            <button class="btn btn--secundario mais" (click)="carregarMais()" [disabled]="carregandoMais()">{{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</button>
          }
        }
      }
    }

    <!-- Modal de detalhes do pedido -->
    @if (detalhe(); as d) {
      <div class="overlay" (click)="fechar()">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-topo">
            <div>
              <span class="badge" [class]="'badge--' + d.estado">{{ rotuloEstado(d.estado) }}</span>
              <h2 class="txt-secao">{{ d.nome || 'Pedido' }}</h2>
            </div>
            <button class="fechar" (click)="fechar()" aria-label="Fechar">×</button>
          </header>

          <div class="m-meta">
            @if (d.contato && d.contatoId) { <a class="m-cliente" [routerLink]="['/contato', d.contatoId]">👤 {{ d.contato }}</a> }
            <span>Criado {{ d.criadoEm | date: 'dd/MM/yy HH:mm' }}</span>
            @if (d.confirmadoEm) { <span class="ok">✓ Confirmado pelo cliente {{ d.confirmadoEm | date: 'dd/MM HH:mm' }}</span> }
            @if (d.numeroExterno) { <span>NF {{ d.numeroExterno }}</span> }
          </div>

          @if (carregandoDet()) { <p class="dica">Carregando itens…</p> }
          @else {
            <div class="rolagem-x">
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

            <div class="m-ctx">
              @if (d.formaPagamento) { <div><span class="lab">Pagamento</span> {{ d.formaPagamento }}</div> }
              @if (d.observacao) { <div><span class="lab">Obs.</span> {{ d.observacao }}</div> }
            </div>

            <!-- ⚠️ Cancelado NÃO é um sumiço: mostra por quê e deixa reaproveitar.
                 Um pedido superado por um resumo novo continua valendo como
                 trabalho de montagem — o vendedor abre, ajusta e reenvia. -->
            @if (d.estado === 'cancelado') {
              <div class="m-cancel">
                <div><strong>Cancelado</strong> — {{ d.canceladoMotivo ?? 'sem motivo registrado' }}</div>
                <button class="btn btn--secundario btn--pequeno" (click)="reabrir(d.id)" [disabled]="reabrindo()">
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
                    <button class="e-btn" [disabled]="!e.disponivel || acionando() === e.etapa"
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
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .filtros { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); }
    .filtros button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .filtros button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .bloco a { color: var(--acao); }
    .esq { height: 52px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .ped { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); font-size: 13px; cursor: pointer; }
    .ped:last-child { border-bottom: none; }
    .ped:hover { background: var(--superficie-hover); }
    .col { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .cliente { color: var(--acao); text-decoration: none; font-size: 14px; }
    .cliente.sem { color: var(--texto-suave); }
    .sub-linha { color: var(--texto-suave); font-size: 12px; }
    .total { color: var(--texto); font-weight: 600; flex: none; }
    .data { color: var(--texto-suave); flex: none; }
    .chevron { color: var(--texto-suave); flex: none; font-size: 18px; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); white-space: nowrap; flex: none; }
    .badge--rascunho { background: var(--superficie); color: var(--texto-secundario); }
    .badge--aguardando_confirmacao { background: var(--atencao-suave); color: var(--atencao); }
    .badge--confirmado { background: var(--acao-suave); color: var(--marca); }
    .badge--efetivado { background: var(--sucesso-suave); color: var(--sucesso); }
    .badge--falhou { background: var(--erro-suave); color: var(--erro); }
    .badge--cancelado { background: var(--superficie); color: var(--texto-suave); }
    .m-cancel { margin-top: var(--espacamento-3); padding: var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto);
      font-size: 13px; display: grid; gap: var(--espacamento-2); justify-items: start; }
    .m-cancel .err { color: var(--erro); font-size: 12px; }
    .badge--aguardando_conferencia { background: var(--atencao-suave); color: var(--atencao); }
    .mais { margin-top: var(--espacamento-4); }
    @media (max-width: 560px) { .data { display: none; } }
    /* Modal */
    .overlay { position: fixed; inset: 0; background: rgb(0 0 0 / .4); display: grid; place-items: center; padding: var(--espacamento-4); z-index: 50; }
    .modal { width: 100%; max-width: 620px; max-height: 88vh; overflow-y: auto; background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); padding: var(--espacamento-6); }
    .m-topo { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .m-topo h2 { margin: var(--espacamento-2) 0 0; }
    .fechar { border: 0; background: transparent; color: var(--texto-suave); font-size: 22px; cursor: pointer; line-height: 1; }
    .m-meta { display: flex; flex-wrap: wrap; gap: var(--espacamento-3); font-size: 12px; color: var(--texto-secundario); margin-bottom: var(--espacamento-4); }
    .m-cliente { color: var(--acao); text-decoration: none; }
    .m-meta .ok { color: var(--sucesso); }
    .itens-tab { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 460px; }
    .itens-tab th, .itens-tab td { padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); text-align: left; }
    .itens-tab th { color: var(--texto-suave); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .itens-tab .dir { text-align: right; }
    .itens-tab .vazio { text-align: center; color: var(--texto-suave); }
    .m-ctx { display: grid; gap: var(--espacamento-1); margin: var(--espacamento-4) 0; font-size: 13px; color: var(--texto); }
    .m-ctx .lab { color: var(--texto-suave); margin-right: var(--espacamento-1); }
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
  readonly filtros = FILTROS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly PedidoItem[]>([])
  readonly filtro = signal('')
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly detalhe = signal<PedidoDetalhe | null>(null)
  readonly reabrindo = signal(false)
  readonly erroReabrir = signal<string | null>(null)
  readonly carregandoDet = signal(false)
  readonly acionando = signal<string | null>(null)
  readonly etapaMsg = signal<{ ok: boolean; texto: string } | null>(null)

  ngOnInit(): void { void this.carregar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  variacao(g: Record<string, string> | null | undefined): string {
    if (!g) return ''
    const ordem = ['cor', 'tamanho', 'subTamanho']
    const vistos = new Set<string>(); const p: string[] = []
    for (const k of ordem) if (g[k]) { p.push(g[k]!); vistos.add(k) }
    for (const [k, v] of Object.entries(g)) if (!vistos.has(k) && v) p.push(v)
    return p.join(' · ')
  }
  rotuloEstado(e: string): string {
    return { rascunho: 'Rascunho', aguardando_confirmacao: 'Aguardando SIM', confirmado: 'Confirmado', efetivado: 'Efetivado', falhou: 'Falhou', cancelado: 'Cancelado', aguardando_conferencia: 'Conferência', enviando: 'Enviando', validando: 'Validando' }[e] ?? e
  }
  trocar(f: string): void { this.filtro.set(f); void this.carregar() }

  private url(cursor: string | null): string {
    const p = new URLSearchParams()
    if (this.filtro()) p.set('estado', this.filtro())
    if (cursor) p.set('cursor', cursor)
    const q = p.toString()
    return `/v1/pedidos${q ? '?' + q : ''}`
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(null)))
      this.itens.set(r.itens); this.proximoCursor.set(r.proximoCursor); this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(cursor)))
      this.itens.update((a) => [...a, ...r.itens]); this.proximoCursor.set(r.proximoCursor)
    } catch { /* mantém */ } finally { this.carregandoMais.set(false) }
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
    } catch { this.fechar() } finally { this.carregandoDet.set(false) }
  }
  fechar(): void { this.detalhe.set(null); this.etapaMsg.set(null); this.acionando.set(null) }

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
