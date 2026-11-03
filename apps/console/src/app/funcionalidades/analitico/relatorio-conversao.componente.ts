import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  barrasDeFaixas, csvConversao, formatarDias, formatarPercentual, nomeDaFaixa, type RespostaConversao,
} from './relatorios-gestao.regras.js'

/**
 * Tempo de conversão (E2): do cadastro do contato até a PRIMEIRA compra, para os contatos cuja 1ª compra
 * (pedido efetivado) caiu no período. Média, extremos, faixas em barras e a tabela por vendedor.
 */
@Component({
  selector: 'app-relatorio-conversao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, PainelComponente, RelatorioMolduraComponente,
    StatCardComponente, TabelaComponente,
  ],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="(c.dados()?.contatos ?? 0) === 0" tituloVazio="Nenhuma primeira compra no período"
      descricaoVazio="Conta o contato cuja primeira compra efetivada aconteceu no período. Recompras não entram."
      (aplicar)="carregar()" (tentar)="carregar()">
      <div class="cartoes">
        <ui-stat-card [valor]="c.dados()?.contatos ?? 0" rotulo="Contatos que compraram" />
        <ui-stat-card [valor]="dias(c.dados()?.mediaDias ?? null)" rotulo="Tempo médio" tom="acao" />
        <ui-stat-card [valor]="dias(c.dados()?.maisRapidaDias ?? null)" rotulo="Mais rápida" tom="sucesso" />
        <ui-stat-card [valor]="dias(c.dados()?.maisLentaDias ?? null)" rotulo="Mais lenta" tom="atencao" />
      </div>

      <ui-painel>
        <h2 class="txt-secao">Contatos por faixa de tempo até a 1ª compra</h2>
        <app-barras-horizontais [itens]="barras()" descricao="Contatos por faixa de tempo até a primeira compra" />
      </ui-painel>

      <div class="barra-tabela">
        <span class="txt-denso nota">
          Período {{ c.inicio() }} a {{ c.fim() }}. Dias entre o cadastro do contato e o primeiro pedido efetivado.
          @if (c.dados()?.porVendedorTruncado) { Mostrando só os 100 vendedores com mais contatos. }
        </span>
        <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" />
      </div>

      <ui-tabela [colunas]="colunasFaixa" [linhas]="linhasFaixa()" [chaveLinha]="chave">
        <ng-template uiCelula="percentual" let-l>{{ pct(l['percentual']) }}</ng-template>
      </ui-tabela>
      <ui-tabela [colunas]="colunasVendedor" [linhas]="linhasVendedor()" [chaveLinha]="chave">
        <ng-template uiCelula="media" let-l>{{ dias(l['mediaDias']) }}</ng-template>
        <ng-template uiCelula="rapida" let-l>{{ dias(l['maisRapidaDias']) }}</ng-template>
        <ng-template uiCelula="lenta" let-l>{{ dias(l['maisLentaDias']) }}</ng-template>
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
export class RelatorioConversaoComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaConversao>(inject(HttpClient), () => '/v1/relatorios/tempo-conversao')

  protected readonly barras = computed(() => barrasDeFaixas(this.c.dados()?.faixas ?? []))
  protected readonly linhasFaixa = computed<LinhaTabela[]>(() =>
    (this.c.dados()?.faixas ?? []).map((f) => ({ chave: f.faixa, faixa: nomeDaFaixa(f.faixa), contatos: f.contatos, percentual: f.percentual })))
  protected readonly linhasVendedor = computed<LinhaTabela[]>(() => (this.c.dados()?.porVendedor ?? []).map((v) => ({ ...v })))
  protected readonly csv = computed(() => csvConversao(this.c.dados()?.faixas ?? [], this.c.dados()?.porVendedor ?? []))
  protected readonly arquivoCsv = computed(() => `tempo-de-conversao-${this.c.inicio()}-a-${this.c.fim()}`)
  protected readonly colunasFaixa: ColunaTabela[] = [
    { chave: 'faixa', rotulo: 'Faixa de tempo' },
    { chave: 'contatos', rotulo: 'Contatos', alinhamento: 'dir' },
    { chave: 'percentual', rotulo: 'Participação', alinhamento: 'dir' },
  ]
  protected readonly colunasVendedor: ColunaTabela[] = [
    { chave: 'rotulo', rotulo: 'Vendedor' },
    { chave: 'contatos', rotulo: 'Contatos', alinhamento: 'dir' },
    { chave: 'media', rotulo: 'Tempo médio', alinhamento: 'dir' },
    { chave: 'rapida', rotulo: 'Mais rápida', alinhamento: 'dir' },
    { chave: 'lenta', rotulo: 'Mais lenta', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['chave'])

  ngOnInit(): void { void this.carregar() }

  protected dias(v: unknown): string { return formatarDias(v === null || v === undefined ? null : Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(Number(v)) }
  protected carregar(): Promise<void> { return this.c.carregar() }
}
