import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { ListaContatosRelatorioComponente } from './lista-contatos-relatorio.componente.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  avisoTruncado, csvFilialPorDia, csvVisaoGeral, intensidade, rotuloColunaDia, type RespostaVisaoGeral,
} from './relatorios-analise.regras.js'
import { formatarPercentual } from './relatorios-gestao.regras.js'

/**
 * Visão geral (E3): totais do período, por filial, filial × dia (contatos novos), por formulário e o
 * detalhamento (lista de contatos por cursor, com CSV gerado no servidor). Mesma coorte e réguas do E1/E2.
 * A filial do contato é a dele ou a do vendedor da carteira.
 */
@Component({
  selector: 'app-relatorio-visao-geral',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, ListaContatosRelatorioComponente, PainelComponente,
    RelatorioMolduraComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="(c.dados()?.totais?.contatos ?? 0) === 0 && (c.dados()?.totais?.respostasFormulario ?? 0) === 0"
      tituloVazio="Nenhum contato no período" descricaoVazio="Amplie o período para ver a visão geral."
      (aplicar)="aplicar()" (tentar)="aplicar()">
      @if (c.dados(); as d) {
        <div class="cartoes">
          <ui-stat-card [valor]="d.totais.contatos" rotulo="Contatos novos" />
          <ui-stat-card [valor]="d.totais.convertidos" rotulo="Convertidos" tom="sucesso" />
          <ui-stat-card [valor]="pct(d.totais.taxa)" rotulo="Conversão" />
          <ui-stat-card [valor]="d.totais.pedidos" rotulo="Pedidos" />
          <ui-stat-card [valor]="reais(d.totais.valorCentavos)" rotulo="Valor dos pedidos" tom="acao" />
          <ui-stat-card [valor]="reais(d.totais.ticketMedioCentavos)" rotulo="Ticket médio" />
          <ui-stat-card [valor]="d.totais.respostasFormulario" rotulo="Respostas de formulário" />
        </div>
        <div class="barra-tabela">
          <span class="txt-denso nota">Período {{ c.inicio() }} a {{ c.fim() }}.</span>
          <ui-botao-csv [colunas]="csvGeral().colunas" [linhas]="csvGeral().linhas" [arquivo]="'visao-geral-' + c.inicio() + '-a-' + c.fim()">
            Exportar resumo (CSV)</ui-botao-csv>
        </div>

        <ui-painel>
          <h2 class="txt-secao">Por filial</h2>
          @if (d.porFilial.length === 0) { <p class="txt-denso nota">Sem contatos no período.</p> }
          @else { <app-barras-horizontais [itens]="barrasFilial()" descricao="Contatos novos por filial" /> }
          @if (d.porFilialTruncado) { <p class="txt-denso nota">{{ avisoFilial }}</p> }
        </ui-painel>

        <ui-painel>
          <div class="barra-tabela">
            <h2 class="txt-secao">Filial × dia (contatos novos)</h2>
            <ui-botao-csv [colunas]="csvDia().colunas" [linhas]="csvDia().linhas" [arquivo]="'filial-por-dia-' + c.inicio() + '-a-' + c.fim()" />
          </div>
          @if (d.filialPorDia.series.length === 0) { <p class="txt-denso nota">Sem contatos no período.</p> }
          @else {
            <div class="rolagem-x">
              <table class="mapa" aria-label="Contatos novos por filial e por dia">
                <thead><tr><th scope="col" class="txt-rotulo">Filial</th>
                  @for (dia of d.filialPorDia.dias; track dia) { <th scope="col" class="txt-rotulo dia">{{ rotuloDia(dia) }}</th> }
                  <th scope="col" class="txt-rotulo">Total</th></tr></thead>
                <tbody>
                  @for (s of d.filialPorDia.series; track s.chave) {
                    <tr><th scope="row" class="txt-denso">{{ s.rotulo }}</th>
                      @for (n of s.porDia; track $index) {
                        <td class="celula txt-dados" [style.--i]="forca(n)" [title]="n + ' em ' + d.filialPorDia.dias[$index]">{{ n || '' }}</td>
                      }
                      <td class="txt-dados total">{{ s.total }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (d.filialPorDia.truncado) { <p class="txt-denso nota">Mostrando as 10 filiais com mais contatos.</p> }
        </ui-painel>

        <ui-painel>
          <h2 class="txt-secao">Por formulário</h2>
          <ui-tabela [colunas]="colunasForm" [linhas]="linhasForm()" [chaveLinha]="chave">
            <ng-template uiCelula="valor" let-l>{{ reais(l['valorCentavos']) }}</ng-template>
          </ui-tabela>
          @if (d.porFormularioTruncado) { <p class="txt-denso nota">{{ avisoForm }}</p> }
        </ui-painel>
      }
    </app-relatorio-moldura>

    @if (c.estado() === 'pronto') {
      <ui-painel>
        <h2 class="txt-secao">Detalhamento</h2>
        <app-lista-contatos-relatorio [inicio]="c.dados()?.periodo?.inicio ?? ''" [fim]="c.dados()?.periodo?.fim ?? ''" [versao]="versao()" />
      </ui-painel>
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--espacamento-3); }
    .barra-tabela { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); margin: var(--espacamento-2) 0 0; }
    .mapa { border-collapse: collapse; width: 100%; }
    .mapa th, .mapa td { padding: var(--espacamento-1) var(--espacamento-2); text-align: center; white-space: nowrap; }
    .mapa tbody th { text-align: left; position: sticky; left: 0; background: var(--superficie-elevada); }
    .celula { min-width: 28px; background: color-mix(in srgb, var(--acao) calc(var(--i, 0) * 70%), transparent); color: var(--texto); }
    .total { font-weight: 600; }
  `,
})
export class RelatorioVisaoGeralComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaVisaoGeral>(inject(HttpClient), () => '/v1/relatorios/visao-geral')
  protected readonly versao = signal(0)
  protected readonly avisoFilial = avisoTruncado(true, 20)
  protected readonly avisoForm = avisoTruncado(true, 100)

  protected readonly barrasFilial = computed(() =>
    (this.c.dados()?.porFilial ?? []).map((g) => ({ chave: g.chave, rotulo: g.rotulo, valor: g.contatos, texto: `${g.contatos} (${formatarPercentual(g.taxa)} conv.)` })))
  protected readonly linhasForm = computed<LinhaTabela[]>(() => (this.c.dados()?.porFormulario ?? []).map((f) => ({ ...f })))
  protected readonly csvGeral = computed(() => csvVisaoGeral(this.c.dados() ?? VAZIO))
  protected readonly csvDia = computed(() => csvFilialPorDia((this.c.dados() ?? VAZIO).filialPorDia))
  private readonly maximo = computed(() => Math.max(0, ...(this.c.dados()?.filialPorDia.series ?? []).flatMap((s) => s.porDia)))
  protected readonly colunasForm: ColunaTabela[] = [
    { chave: 'rotulo', rotulo: 'Formulário' }, { chave: 'respostas', rotulo: 'Respostas', alinhamento: 'dir' },
    { chave: 'contatos', rotulo: 'Contatos', alinhamento: 'dir' }, { chave: 'convertidos', rotulo: 'Convertidos', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['chave'])

  ngOnInit(): void { void this.c.carregar() }

  protected aplicar(): void { this.versao.update((v) => v + 1); void this.c.carregar() }
  protected forca(n: number): number { return intensidade(n, this.maximo()) }
  protected rotuloDia(iso: string): string { return rotuloColunaDia(iso) }
  protected reais(v: unknown): string { return formatarReais(Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(v === null || v === undefined ? null : Number(v)) }
}

const VAZIO: RespostaVisaoGeral = {
  periodo: { inicio: '', fim: '', fuso: '' },
  totais: { contatos: 0, convertidos: 0, taxa: null, pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0, respostasFormulario: 0 },
  porFilial: [], porFilialTruncado: false, filialPorDia: { dias: [], series: [], truncado: false }, porFormulario: [], porFormularioTruncado: false,
}
