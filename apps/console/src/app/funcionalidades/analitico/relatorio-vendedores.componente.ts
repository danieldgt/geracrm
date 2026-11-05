import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import { csvVendedores, formatarPercentual, type RespostaVendedores } from './relatorios-gestao.regras.js'

/**
 * Desempenho dos vendedores (E2): top 10 por valor. Contatos novos, conversões, taxa, valor e ticket são a
 * coorte do relatório "Contatos por vendedor" (um número só); tarefas concluídas são as do período.
 */
@Component({
  selector: 'app-relatorio-vendedores',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, PainelComponente, RelatorioMolduraComponente,
    StatCardComponente, TabelaComponente,
  ],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="itens().length === 0" tituloVazio="Nenhum vendedor com atividade no período"
      descricaoVazio="Aparecem vendedores com contatos novos na carteira ou tarefas concluídas no período."
      (aplicar)="carregar()" (tentar)="carregar()">
      <div class="cartoes">
        <ui-stat-card [valor]="c.dados()?.totalVendedores ?? 0" rotulo="Vendedores com atividade" />
        <ui-stat-card [valor]="soma().contatos" rotulo="Contatos novos" />
        <ui-stat-card [valor]="soma().conversoes" rotulo="Conversões" tom="sucesso" />
        <ui-stat-card [valor]="valorTexto()" rotulo="Valor dos pedidos" tom="acao" />
      </div>

      <ui-painel>
        <h2 class="txt-secao">Ranking por valor</h2>
        <app-barras-horizontais [itens]="barras()" descricao="Ranking de vendedores por valor" />
      </ui-painel>

      <div class="barra-tabela">
        <span class="txt-denso nota">
          Período {{ c.inicio() }} a {{ c.fim() }}.
          @if (maisQueTop()) { Mostrando os 10 primeiros de {{ c.dados()?.totalVendedores }}. }
        </span>
        <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" />
      </div>
      <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chave">
        <ng-template uiCelula="taxa" let-l>{{ pct(l['taxa']) }}</ng-template>
        <ng-template uiCelula="valor" let-l>{{ reais(l['valorCentavos']) }}</ng-template>
        <ng-template uiCelula="ticket" let-l>{{ reais(l['ticketMedioCentavos']) }}</ng-template>
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
export class RelatorioVendedoresComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaVendedores>(inject(HttpClient), () => '/v1/relatorios/vendedores')

  protected readonly itens = computed(() => this.c.dados()?.itens ?? [])
  protected readonly maisQueTop = computed(() => (this.c.dados()?.totalVendedores ?? 0) > this.itens().length)
  protected readonly soma = computed(() => ({
    contatos: this.itens().reduce((s, v) => s + v.contatosNovos, 0),
    conversoes: this.itens().reduce((s, v) => s + v.conversoes, 0),
    valorCentavos: this.itens().reduce((s, v) => s + v.valorCentavos, 0),
  }))
  protected readonly valorTexto = computed(() => formatarReais(this.soma().valorCentavos))
  protected readonly barras = computed(() =>
    this.itens().map((v) => ({ chave: v.usuarioId, rotulo: v.nome, valor: v.valorCentavos, texto: formatarReais(v.valorCentavos) })))
  protected readonly linhas = computed<LinhaTabela[]>(() => this.itens().map((v) => ({ ...v })))
  protected readonly csv = computed(() => csvVendedores(this.itens()))
  protected readonly arquivoCsv = computed(() => `vendedores-${this.c.inicio()}-a-${this.c.fim()}`)
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Vendedor' },
    { chave: 'contatosNovos', rotulo: 'Contatos novos', alinhamento: 'dir' },
    { chave: 'tarefasConcluidas', rotulo: 'Tarefas concluídas', alinhamento: 'dir' },
    { chave: 'conversoes', rotulo: 'Conversões', alinhamento: 'dir' },
    { chave: 'taxa', rotulo: 'Conversão', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
    { chave: 'ticket', rotulo: 'Ticket médio', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['usuarioId'])

  ngOnInit(): void { void this.carregar() }

  protected reais(v: unknown): string { return formatarReais(Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(v === null || v === undefined ? null : Number(v)) }
  protected carregar(): Promise<void> { return this.c.carregar() }
}
