import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Bi {
  readonly dias: number
  readonly topClientes: { contatoId: string; nome: string; receitaCentavos: number; qtdVendas: number }[]
  readonly topProdutos: { rotulo: string; quantidade: number; receitaCentavos: number }[]
  readonly porVendedor: { usuarioId: string | null; nome: string; receitaCentavos: number; qtdVendas: number }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const PERIODOS = [{ dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }, { dias: 90, rotulo: '90 dias' }]

/**
 * Painéis (BI) — rankings de venda no período (top clientes/produtos/vendedores).
 * ⚠️ Vendas canceladas ficam fora (a API já exclui). Top 10 por ranking, rotulado.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-bi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Painéis (BI)</h1>
        <p class="sub">Quem mais compra, o que mais sai, quem mais vende — no período.</p>
      </div>
      <div class="abas">
        @for (p of periodos; track p.dias) {
          <button [class.on]="dias() === p.dias" (click)="trocar(p.dias)">{{ p.rotulo }}</button>
        }
      </div>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as bi) {
          <div class="grade">
            <section class="painel">
              <h2 class="txt-secao">Top clientes</h2>
              @if (bi.topClientes.length === 0) { <p class="vazio">Sem vendas no período.</p> }
              @else {
                <ul>
                  @for (c of bi.topClientes; track c.contatoId; let i = $index) {
                    <li>
                      <span class="pos">{{ i + 1 }}</span>
                      <a class="rot encolhe" [routerLink]="['/contato', c.contatoId]">{{ c.nome }}</a>
                      <span class="barra"><span class="fill" [style.width.%]="pct(c.receitaCentavos, maxCliente())"></span></span>
                      <span class="val txt-dados">{{ reais(c.receitaCentavos) }}</span>
                    </li>
                  }
                </ul>
              }
            </section>

            <section class="painel">
              <h2 class="txt-secao">Top produtos</h2>
              @if (bi.topProdutos.length === 0) { <p class="vazio">Sem itens vendidos no período.</p> }
              @else {
                <ul>
                  @for (p of bi.topProdutos; track p.rotulo; let i = $index) {
                    <li>
                      <span class="pos">{{ i + 1 }}</span>
                      <span class="rot encolhe">{{ p.rotulo }}</span>
                      <span class="barra"><span class="fill" [style.width.%]="pct(p.receitaCentavos, maxProduto())"></span></span>
                      <span class="val txt-dados">{{ reais(p.receitaCentavos) }}</span>
                    </li>
                  }
                </ul>
              }
            </section>

            <section class="painel">
              <h2 class="txt-secao">Por vendedor</h2>
              @if (bi.porVendedor.length === 0) { <p class="vazio">Sem vendas no período.</p> }
              @else {
                <ul>
                  @for (v of bi.porVendedor; track v.usuarioId ?? 'sem'; let i = $index) {
                    <li>
                      <span class="pos">{{ i + 1 }}</span>
                      <span class="rot encolhe">{{ v.nome }}</span>
                      <span class="barra"><span class="fill" [style.width.%]="pct(v.receitaCentavos, maxVendedor())"></span></span>
                      <span class="val txt-dados">{{ reais(v.receitaCentavos) }}</span>
                    </li>
                  }
                </ul>
              }
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .abas { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .abas button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--espacamento-4); align-items: start; }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 200px; border-radius: var(--raio-painel); background: var(--superficie); }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    li { display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: var(--espacamento-2); }
    .pos { color: var(--texto-suave); font-size: 12px; text-align: center; }
    .rot { color: var(--texto); font-size: 13px; text-decoration: none; }
    a.rot:hover { color: var(--acao); }
    .barra { grid-column: 2 / 3; height: 4px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; display: none; }
    .fill { display: block; height: 100%; background: var(--acao); }
    .val { color: var(--texto-secundario); font-size: 12px; }
    .vazio { color: var(--texto-suave); font-size: 13px; margin: 0; }
    @media (min-width: 480px) {
      li { grid-template-columns: 20px minmax(80px, 1fr) 3fr auto; }
      .barra { grid-column: auto; display: block; }
    }
  `,
})
export class BiPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly periodos = PERIODOS
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Bi | null>(null)
  readonly dias = signal(30)

  ngOnInit(): void { void this.carregar() }
  trocar(dias: number): void { this.dias.set(dias); void this.carregar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  pct(v: number, max: number): number { return max > 0 ? Math.round((v / max) * 100) : 0 }
  maxCliente(): number { return Math.max(1, ...(this.d()?.topClientes.map((c) => c.receitaCentavos) ?? [])) }
  maxProduto(): number { return Math.max(1, ...(this.d()?.topProdutos.map((p) => p.receitaCentavos) ?? [])) }
  maxVendedor(): number { return Math.max(1, ...(this.d()?.porVendedor.map((v) => v.receitaCentavos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Bi>(`/v1/bi?dias=${this.dias()}`))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
