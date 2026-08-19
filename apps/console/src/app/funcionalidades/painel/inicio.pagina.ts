import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Painel {
  readonly vendas30d: { quantidade: number; totalCentavos: number; ticketMedioCentavos: number | null }
  readonly clientesComHistorico: number
  readonly clientesParaAgirHoje: number
  readonly pedidos: { rascunhos: number; efetivados: number; falharam: number }
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Início — o negócio hoje em 3 segundos. KPIs de leitura sobre venda/RFV/pedido.
 * Segue geracrm-layout-ui (KPI na escala .txt-kpi, tokens, responsivo).
 */
@Component({
  selector: 'app-inicio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Início</h1>
      <p class="sub">Como o negócio está hoje.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="kpis"><div class="esq"></div><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso ao painel</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as p) {
          <div class="kpis">
            <a class="kpi" routerLink="/pedidos">
              <span class="txt-rotulo">Vendas (30 dias)</span>
              <span class="txt-kpi">{{ reais(p.vendas30d.totalCentavos) }}</span>
              <span class="kpi-sub">{{ p.vendas30d.quantidade }} vendas</span>
            </a>
            <div class="kpi">
              <span class="txt-rotulo">Ticket médio (30d)</span>
              <span class="txt-kpi">{{ p.vendas30d.ticketMedioCentavos !== null ? reais(p.vendas30d.ticketMedioCentavos) : '—' }}</span>
              <span class="kpi-sub">por venda</span>
            </div>
            <a class="kpi" routerLink="/fila-do-dia">
              <span class="txt-rotulo">Para agir hoje</span>
              <span class="txt-kpi" [class.alerta]="p.clientesParaAgirHoje > 0">{{ p.clientesParaAgirHoje }}</span>
              <span class="kpi-sub">clientes atrasados/em risco</span>
            </a>
            <a class="kpi" routerLink="/contatos">
              <span class="txt-rotulo">Base com histórico</span>
              <span class="txt-kpi">{{ p.clientesComHistorico }}</span>
              <span class="kpi-sub">clientes com compra</span>
            </a>
          </div>

          <div class="pedidos">
            <h2 class="txt-secao">Pedidos</h2>
            <div class="ped-linha">
              <a routerLink="/pedidos"><b class="txt-dados">{{ p.pedidos.rascunhos }}</b> rascunhos</a>
              <a routerLink="/pedidos"><b class="txt-dados ok">{{ p.pedidos.efetivados }}</b> efetivados</a>
              <a routerLink="/pedidos"><b class="txt-dados ruim">{{ p.pedidos.falharam }}</b> falharam</a>
            </div>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .esq { height: 96px; border-radius: var(--raio-painel); background: var(--superficie); }
    .kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-decoration: none; color: inherit; }
    a.kpi:hover { border-color: var(--acao); }
    .kpi .txt-kpi { color: var(--texto); }
    .kpi .txt-kpi.alerta { color: var(--atencao); }
    .kpi-sub { font-size: 12px; color: var(--texto-suave); }
    .pedidos { margin-top: var(--espacamento-6); }
    .pedidos h2 { margin: 0 0 var(--espacamento-2); color: var(--texto); }
    .ped-linha { display: flex; flex-wrap: wrap; gap: var(--espacamento-6); }
    .ped-linha a { color: var(--texto-secundario); text-decoration: none; font-size: 14px; }
    .ped-linha b { font-size: 18px; color: var(--texto); margin-right: var(--espacamento-1); }
    .ped-linha b.ok { color: var(--sucesso); }
    .ped-linha b.ruim { color: var(--erro); }
  `,
})
export class InicioPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Painel | null>(null)

  ngOnInit(): void { void this.carregar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Painel>('/v1/painel/inicio'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
