import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { FormsModule } from '@angular/forms'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { SelectPaginadoComponente } from '../../compartilhado/ui/select-paginado.componente.js'
import { SelectComponente, type OpcaoSelect } from '../../compartilhado/ui/select.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { carregarOpcoesRelatorio } from './opcoes-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  avisoTruncado, csvRaioX, EIXOS_RAIOX, type EixoRaioX, type GrupoCoorte, type RespostaRaioX,
} from './relatorios-analise.regras.js'
import { formatarPercentual, rotuloDoDia } from './relatorios-gestao.regras.js'

const OPCOES_EIXO: OpcaoSelect[] = EIXOS_RAIOX.map((e) => ({ valor: e.chave, rotulo: e.rotulo }))

/**
 * Raio-X (E3): o retrato de UM formulário, vendedor ou filial no período — cartões, contatos novos por dia,
 * origens, qualificação e UF. Mesma coorte e réguas dos outros relatórios; o escopo vale (um vendedor não vê o
 * raio-x do colega: 404 da API vira "não encontramos").
 */
@Component({
  selector: 'app-relatorio-raio-x',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, FormsModule, PainelComponente, RelatorioMolduraComponente,
    SelectComponente, SelectPaginadoComponente, StatCardComponente,
  ],
  template: `
    <ui-painel class="nao-imprimir">
      <div class="escolha">
        <ui-select rotulo="Analisar por" [opcoes]="eixos" [valor]="eixo()" (valorChange)="trocarEixo($event)" />
        @for (e of [eixo()]; track e) {
          <ui-select-paginado [rotulo]="rotuloEixo()" placeholder="Busque pelo nome" [carregar]="carregarItens()"
            [ngModel]="itemId()" (ngModelChange)="escolher($event)" name="item" />
        }
      </div>
    </ui-painel>

    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="!itemId() || !c.dados()" [tituloVazio]="itemId() ? 'Sem dados' : 'Escolha o que analisar'"
      [descricaoVazio]="itemId() ? 'Nada encontrado para esse item no período.' : 'Escolha um formulário, vendedor ou filial para ver o raio-x.'"
      (aplicar)="carregar()" (tentar)="carregar()">
      @if (c.dados(); as d) {
        <h2 class="txt-secao titulo">{{ d.rotulo }} <span class="txt-denso nota">({{ rotuloEixo() }}, {{ c.inicio() }} a {{ c.fim() }})</span></h2>
        <div class="cartoes">
          <ui-stat-card [valor]="d.cartoes.contatos" rotulo="Contatos novos" />
          <ui-stat-card [valor]="d.cartoes.convertidos" rotulo="Convertidos" tom="sucesso" />
          <ui-stat-card [valor]="pct(d.cartoes.taxa)" rotulo="Conversão" />
          <ui-stat-card [valor]="d.cartoes.pedidos" rotulo="Pedidos" />
          <ui-stat-card [valor]="reais(d.cartoes.valorCentavos)" rotulo="Valor dos pedidos" tom="acao" />
          <ui-stat-card [valor]="reais(d.cartoes.ticketMedioCentavos)" rotulo="Ticket médio" />
          @if (d.cartoes.respostas !== null) { <ui-stat-card [valor]="d.cartoes.respostas" rotulo="Respostas do formulário" /> }
          @if (d.cartoes.tarefasConcluidas !== null) { <ui-stat-card [valor]="d.cartoes.tarefasConcluidas" rotulo="Tarefas concluídas" /> }
        </div>
        <div class="barra"><span class="txt-denso nota">Contatos criados no período; convertido = com pedido efetivado no período.</span>
          <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="'raio-x-' + d.eixo + '-' + c.inicio() + '-a-' + c.fim()" /></div>

        <div class="grade">
          <ui-painel><h2 class="txt-secao">Contatos novos por dia</h2>
            <app-barras-horizontais [itens]="barrasDia()" alturaMax="320px" descricao="Contatos novos por dia" /></ui-painel>
          <ui-painel><h2 class="txt-secao">Origens</h2>
            <app-barras-horizontais [itens]="barras(d.origens)" descricao="Contatos por origem" />
            @if (d.origensTruncado) { <p class="txt-denso nota">{{ aviso }}</p> }</ui-painel>
          <ui-painel><h2 class="txt-secao">Qualificação</h2>
            <app-barras-horizontais [itens]="barras(d.qualificacao)" descricao="Contatos por qualificação" /></ui-painel>
          <ui-painel><h2 class="txt-secao">UF</h2>
            <app-barras-horizontais [itens]="barras(d.ufs)" descricao="Contatos por UF" />
            @if (d.ufsTruncado) { <p class="txt-denso nota">{{ aviso }}</p> }</ui-painel>
        </div>
      }
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .titulo { margin: 0; }
    .escolha { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--espacamento-3); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--espacamento-4); }
    .barra { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); margin: var(--espacamento-2) 0 0; }
  `,
})
export class RelatorioRaioXComponente implements OnInit {
  private readonly http = inject(HttpClient)
  protected readonly eixos = OPCOES_EIXO
  protected readonly aviso = avisoTruncado(true, 10)
  protected readonly eixo = signal<EixoRaioX>('vendedor')
  protected readonly itemId = signal<string | null>(null)

  protected readonly c = new CarregadorRelatorio<RespostaRaioX>(this.http, () => `/v1/relatorios/raio-x/${this.eixo()}/${this.itemId() ?? ''}`)
  protected readonly rotuloEixo = computed(() => EIXOS_RAIOX.find((e) => e.chave === this.eixo())?.rotulo ?? '')
  protected readonly carregarItens = computed(() => carregarOpcoesRelatorio(this.http, this.eixo()))
  protected readonly csv = computed(() => csvRaioX(this.c.dados() ?? VAZIO))
  protected readonly barrasDia = computed(() =>
    (this.c.dados()?.porDia ?? []).map((d) => ({ chave: d.dia, rotulo: rotuloDoDia(d.dia), valor: d.contatos })))

  ngOnInit(): void { this.c.estado.set('pronto') }

  protected trocarEixo(v: string): void {
    this.eixo.set(v as EixoRaioX)
    this.itemId.set(null)
    this.c.dados.set(null)
    this.c.estado.set('pronto')
  }
  protected escolher(id: string | null): void {
    this.itemId.set(id)
    void this.carregar()
  }
  protected async carregar(): Promise<void> {
    if (!this.itemId()) { this.c.dados.set(null); this.c.estado.set('pronto'); return }
    await this.c.carregar()
  }

  protected barras(itens: readonly GrupoCoorte[]) {
    return itens.map((g) => ({ chave: g.chave, rotulo: g.rotulo, valor: g.contatos, texto: `${g.contatos} (${formatarPercentual(g.percentual)})` }))
  }
  protected reais(v: unknown): string { return formatarReais(Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(v === null || v === undefined ? null : Number(v)) }
}

const VAZIO: RespostaRaioX = {
  periodo: { inicio: '', fim: '', fuso: '' }, eixo: 'vendedor', chave: '', rotulo: '',
  cartoes: { contatos: 0, convertidos: 0, taxa: null, pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0, respostas: null, tarefasConcluidas: null },
  porDia: [], origens: [], origensTruncado: false, qualificacao: [], ufs: [], ufsTruncado: false,
}
