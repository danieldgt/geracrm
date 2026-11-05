import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  AbasComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, TabelaComponente,
  type Aba, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Bi {
  readonly dias: number
  readonly topClientes: { contatoId: string; nome: string; receitaCentavos: number; qtdVendas: number }[]
  readonly topProdutos: { rotulo: string; quantidade: number; receitaCentavos: number }[]
  readonly porVendedor: { usuarioId: string | null; nome: string; receitaCentavos: number; qtdVendas: number }[]
  /** Cada ranking: `Truncado` quando há mais grupos que os 10 listados; `Total` = grupos no período. */
  readonly topClientesTruncado: boolean
  readonly topClientesTotal: number
  readonly topProdutosTruncado: boolean
  readonly topProdutosTotal: number
  readonly porVendedorTruncado: boolean
  readonly porVendedorTotal: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const PERIODOS = [{ dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }, { dias: 90, rotulo: '90 dias' }]

/**
 * Painéis (BI) — rankings de venda no período (top clientes/produtos/vendedores).
 * ⚠️ Vendas canceladas ficam fora (a API já exclui). Top 10 por ranking, rotulado.
 * Padrão Lista de leitura: período em abas e três rankings em ui-tabela, cada
 * um com barra de receita na célula.
 */
@Component({
  selector: 'app-bi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbasComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, RouterLink, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Painéis (BI)" subtitulo="Quem mais compra, o que mais sai, quem mais vende — no período." />

    <div class="periodo">
      <ui-abas [abas]="abasPeriodo" [ativa]="periodoAtivo()" (ativaChange)="trocar($event)" />
    </div>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="grade" aria-busy="true">
            <ui-esqueleto altura="200px" />
            <ui-esqueleto altura="200px" />
            <ui-esqueleto altura="200px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso aos painéis" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os painéis" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as bi) {
            <div class="grade">
              <section class="painel" aria-labelledby="titulo-clientes">
                <h2 class="txt-secao" id="titulo-clientes">Top clientes</h2>
                <ui-tabela [colunas]="colunasCliente" [linhas]="linhasClientes()" [chaveLinha]="chaveClientes">
                  <ng-template uiCelula="nome" let-c>
                    <a class="rot" [routerLink]="['/contato', c.contatoId]">{{ c.nome }}</a>
                  </ng-template>
                  <ng-template uiCelula="receita" let-c>
                    <span class="barra-val">
                      <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(c.receitaCentavos, maxCliente())"></span></span>
                      <span class="val txt-dados">{{ reais(c.receitaCentavos) }}</span>
                    </span>
                  </ng-template>
                  <div uiVazio><ui-estado titulo="Sem vendas no período" descricao="Nenhum cliente comprou neste intervalo." /></div>
                </ui-tabela>
                @if (bi.topClientesTruncado) {
                  <p class="corte">Mostrando os 10 maiores de {{ bi.topClientesTotal }} clientes.</p>
                }
              </section>

              <section class="painel" aria-labelledby="titulo-produtos">
                <h2 class="txt-secao" id="titulo-produtos">Top produtos</h2>
                <ui-tabela [colunas]="colunasProduto" [linhas]="linhasProdutos()" [chaveLinha]="chaveProdutos">
                  <ng-template uiCelula="receita" let-p>
                    <span class="barra-val">
                      <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(p.receitaCentavos, maxProduto())"></span></span>
                      <span class="val txt-dados">{{ reais(p.receitaCentavos) }}</span>
                    </span>
                  </ng-template>
                  <div uiVazio><ui-estado titulo="Sem itens vendidos" descricao="Nenhum produto saiu neste período." /></div>
                </ui-tabela>
                @if (bi.topProdutosTruncado) {
                  <p class="corte">Mostrando os 10 maiores de {{ bi.topProdutosTotal }} produtos.</p>
                }
              </section>

              <section class="painel" aria-labelledby="titulo-vendedores">
                <h2 class="txt-secao" id="titulo-vendedores">Por vendedor</h2>
                <ui-tabela [colunas]="colunasVendedor" [linhas]="linhasVendedores()" [chaveLinha]="chaveVendedores">
                  <ng-template uiCelula="receita" let-v>
                    <span class="barra-val">
                      <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(v.receitaCentavos, maxVendedor())"></span></span>
                      <span class="val txt-dados">{{ reais(v.receitaCentavos) }}</span>
                    </span>
                  </ng-template>
                  <div uiVazio><ui-estado titulo="Sem vendas no período" descricao="Nenhum vendedor fechou venda neste intervalo." /></div>
                </ui-tabela>
                @if (bi.porVendedorTruncado) {
                  <p class="corte">Mostrando os 10 maiores de {{ bi.porVendedorTotal }} vendedores.</p>
                }
              </section>
            </div>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .periodo { margin-top: var(--espacamento-3); }
    .corpo { margin-top: var(--espacamento-4); min-width: 0; }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: var(--espacamento-4); align-items: start; min-width: 0; }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .rot { color: var(--texto); font-size: 13px; text-decoration: none; }
    a.rot:hover { color: var(--acao); text-decoration: underline; }
    .barra-val { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 120px; }
    .barra { flex: 1; height: 4px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--acao); }
    .val { color: var(--texto-secundario); font-size: 12px; white-space: nowrap; }
    .corte { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
  `,
})
export class BiPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly abasPeriodo: readonly Aba[] = PERIODOS.map((p) => ({ id: String(p.dias), rotulo: p.rotulo }))
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Bi | null>(null)
  readonly dias = signal(30)
  readonly periodoAtivo = computed(() => String(this.dias()))

  protected readonly colunasCliente: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '40px' },
    { chave: 'nome', rotulo: 'Cliente' },
    { chave: 'receita', rotulo: 'Receita', alinhamento: 'dir' },
  ]
  protected readonly colunasProduto: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '40px' },
    { chave: 'rotulo', rotulo: 'Produto' },
    { chave: 'receita', rotulo: 'Receita', alinhamento: 'dir' },
  ]
  protected readonly colunasVendedor: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '40px' },
    { chave: 'nome', rotulo: 'Vendedor' },
    { chave: 'receita', rotulo: 'Receita', alinhamento: 'dir' },
  ]

  protected readonly linhasClientes = computed<LinhaTabela[]>(() => (this.d()?.topClientes ?? []).map((c, i) => ({
    posicao: i + 1, nome: c.nome, contatoId: c.contatoId, receitaCentavos: c.receitaCentavos,
  })))
  protected readonly linhasProdutos = computed<LinhaTabela[]>(() => (this.d()?.topProdutos ?? []).map((p, i) => ({
    posicao: i + 1, rotulo: p.rotulo, receitaCentavos: p.receitaCentavos,
  })))
  protected readonly linhasVendedores = computed<LinhaTabela[]>(() => (this.d()?.porVendedor ?? []).map((v, i) => ({
    posicao: i + 1, nome: v.nome, chaveVendedor: v.usuarioId ?? 'sem', receitaCentavos: v.receitaCentavos,
  })))
  protected readonly chaveClientes = (l: LinhaTabela): string => String(l['contatoId'])
  protected readonly chaveProdutos = (l: LinhaTabela): string => String(l['rotulo'])
  protected readonly chaveVendedores = (l: LinhaTabela): string => String(l['chaveVendedor'])

  ngOnInit(): void { void this.carregar() }
  trocar(dias: string): void { this.dias.set(Number(dias)); void this.carregar() }
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
