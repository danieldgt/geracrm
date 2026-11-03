import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { AbasComponente } from '../../compartilhado/ui/abas.componente.js'
import type { Aba } from '../../compartilhado/ui/abas.regras.js'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  barrasDeVendas, csvVendas, formatarPercentual, type DimensaoVendas, type RespostaVendas,
} from './relatorios-gestao.regras.js'

interface ConfigVendas { readonly chave: DimensaoVendas; readonly aba: string; readonly titulo: string; readonly coluna: string }

const DIMENSOES: readonly ConfigVendas[] = [
  { chave: 'dia', aba: 'Dia', titulo: 'Vendas por dia', coluna: 'Dia' },
  { chave: 'dia-semana', aba: 'Dia da semana', titulo: 'Vendas por dia da semana', coluna: 'Dia da semana' },
  { chave: 'produto', aba: 'Produto', titulo: 'Vendas por produto', coluna: 'Produto' },
  { chave: 'cliente', aba: 'Cliente', titulo: 'Vendas por cliente', coluna: 'Cliente' },
  { chave: 'origem', aba: 'Origem', titulo: 'Vendas por origem do contato', coluna: 'Origem' },
  { chave: 'vendedor', aba: 'Vendedor', titulo: 'Vendas por vendedor', coluna: 'Vendedor' },
  { chave: 'canal', aba: 'Canal', titulo: 'Vendas por canal', coluna: 'Canal' },
]

/**
 * Vendas por dimensão (E2): pedidos EFETIVADOS no período (a mesma régua da conversão do Início). Sub-seleção
 * da dimensão, cards, barras por valor (rótulo e valor ao lado), tabela e CSV. Venda direta no PDV do ERP
 * (sem pedido no CRM) não entra — a nota da tela diz isso.
 */
@Component({
  selector: 'app-relatorio-vendas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, PainelComponente,
    RelatorioMolduraComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <ui-abas [abas]="abas" [ativa]="dimensao()" (ativaChange)="trocar($event)" />
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="itens().length === 0" tituloVazio="Nenhuma venda no período"
      descricaoVazio="Só contam pedidos efetivados no período. Rascunhos e pedidos cancelados ficam de fora."
      (aplicar)="carregar()" (tentar)="carregar()">
      <div class="cartoes">
        <ui-stat-card [valor]="totais().pedidos" rotulo="Pedidos efetivados" />
        <ui-stat-card [valor]="valorTexto()" rotulo="Valor vendido" tom="sucesso" />
        <ui-stat-card [valor]="ticketTexto()" rotulo="Ticket médio" tom="acao" />
      </div>
      <ui-painel>
        <h2 class="txt-secao">{{ config().titulo }}</h2>
        <app-barras-horizontais [itens]="barras()" [descricao]="config().titulo" alturaMax="360px" />
      </ui-painel>
      <div class="barra-tabela">
        <span class="txt-denso nota">
          Período {{ c.inicio() }} a {{ c.fim() }}. Pedidos efetivados no CRM; venda direta no ERP não entra.
          @if (truncado()) { Mostrando só os 100 maiores grupos. }
        </span>
        <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" />
      </div>
      <ui-tabela [colunas]="colunas()" [linhas]="linhas()" [chaveLinha]="chaveLinha">
        <ng-template uiCelula="valor" let-l>{{ reais(l['valorCentavos']) }}</ng-template>
        <ng-template uiCelula="ticket" let-l>{{ reais(l['ticketMedioCentavos']) }}</ng-template>
        <ng-template uiCelula="participacao" let-l>{{ pct(l['percentual']) }}</ng-template>
      </ui-tabela>
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .barra-tabela { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); }
  `,
})
export class RelatorioVendasComponente {
  protected readonly abas: readonly Aba[] = DIMENSOES.map((d) => ({ id: d.chave, rotulo: d.aba }))
  protected readonly dimensao = signal<DimensaoVendas>('dia')
  protected readonly c = new CarregadorRelatorio<RespostaVendas>(inject(HttpClient), () => `/v1/relatorios/vendas-por/${this.dimensao()}`)

  protected readonly config = computed(() => DIMENSOES.find((d) => d.chave === this.dimensao()) ?? DIMENSOES[0]!)
  protected readonly itens = computed(() => this.c.dados()?.itens ?? [])
  protected readonly truncado = computed(() => this.c.dados()?.truncado ?? false)
  protected readonly totais = computed(() => this.c.dados()?.totais ?? { pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0 })
  protected readonly valorTexto = computed(() => formatarReais(this.totais().valorCentavos))
  protected readonly ticketTexto = computed(() => formatarReais(this.totais().ticketMedioCentavos))
  protected readonly barras = computed(() => barrasDeVendas(this.itens(), formatarReais))
  protected readonly linhas = computed<LinhaTabela[]>(() => this.itens().map((i) => ({ ...i })))
  protected readonly csv = computed(() => csvVendas(this.itens(), this.config().coluna))
  protected readonly arquivoCsv = computed(() => `vendas-por-${this.dimensao()}-${this.c.inicio()}-a-${this.c.fim()}`)
  protected readonly colunas = computed<ColunaTabela[]>(() => [
    { chave: 'rotulo', rotulo: this.config().coluna },
    { chave: 'pedidos', rotulo: 'Pedidos', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
    { chave: 'ticket', rotulo: 'Ticket médio', alinhamento: 'dir' },
    { chave: 'participacao', rotulo: 'Participação', alinhamento: 'dir' },
  ])
  protected readonly chaveLinha = (l: LinhaTabela): string => String(l['chave'])

  constructor() {
    // Trocar a dimensão recarrega com o MESMO período (a instância persiste entre as sub-abas).
    effect(() => {
      this.dimensao()
      untracked(() => void this.carregar())
    })
  }

  protected trocar(id: string): void { this.dimensao.set(id as DimensaoVendas) }
  protected reais(v: unknown): string { return formatarReais(Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(Number(v)) }
  protected carregar(): Promise<void> { return this.c.carregar() }
}
