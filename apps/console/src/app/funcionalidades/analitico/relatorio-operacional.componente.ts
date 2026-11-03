import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  csvOperacional, formatarVariacao, tendenciaDe, variacaoPct, type RespostaOperacional, type Tendencia,
} from './relatorios-gestao.regras.js'

interface CartaoMes {
  readonly rotulo: string
  readonly atual: string
  readonly anterior: string
  readonly variacao: string
  readonly tendencia: Tendencia
}

const SETA: Readonly<Record<Tendencia, string>> = { alta: '▲', queda: '▼', estavel: '■', 'sem-base': '·' }

/**
 * Operacional (E2): o mês do FIM do período contra o mês anterior até o mesmo dia do mês, o funil de agora
 * (oportunidades abertas por etapa) e os top 5 de origens e formulários. A variação sempre sai com sinal,
 * seta e texto — a cor só reforça.
 */
@Component({
  selector: 'app-relatorio-operacional',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarrasHorizontaisComponente, BotaoCsvComponente, PainelComponente, RelatorioMolduraComponente],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      (aplicar)="carregar()" (tentar)="carregar()">
      @if (c.dados(); as d) {
        <p class="txt-denso nota">
          Mês atual: {{ d.mesAtual.inicio }} a {{ d.mesAtual.fim }}. Mês anterior: {{ d.mesAnterior.inicio }} a {{ d.mesAnterior.fim }}
          (mesmo dia do mês). O mês de referência é o do fim do período.
        </p>
      }
      <div class="cartoes">
        @for (k of cartoes(); track k.rotulo) {
          <div class="cartao">
            <span class="txt-denso rotulo">{{ k.rotulo }}</span>
            <span class="txt-kpi valor">{{ k.atual }}</span>
            <span class="txt-denso anterior">Mês anterior: {{ k.anterior }}</span>
            <span class="txt-denso variacao" [attr.data-tendencia]="k.tendencia">{{ seta(k.tendencia) }} {{ k.variacao }}</span>
          </div>
        }
      </div>

      <ui-painel>
        <h2 class="txt-secao">Funil agora: oportunidades abertas por etapa</h2>
        @if (funil().length === 0) {
          <p class="txt-denso nota">Nenhuma etapa de funil configurada.</p>
        } @else {
          <app-barras-horizontais [itens]="funil()" descricao="Oportunidades abertas por etapa do funil" />
        }
      </ui-painel>

      <div class="duas">
        <ui-painel>
          <h2 class="txt-secao">Top 5 origens (contatos novos no mês)</h2>
          @if (origens().length === 0) {
            <p class="txt-denso nota">Nenhum contato novo no mês.</p>
          } @else {
            <app-barras-horizontais [itens]="origens()" descricao="Top 5 origens" />
          }
        </ui-painel>
        <ui-painel>
          <h2 class="txt-secao">Top 5 formulários (respostas no mês)</h2>
          @if (formularios().length === 0) {
            <p class="txt-denso nota">Nenhuma resposta de formulário no mês.</p>
          } @else {
            <app-barras-horizontais [itens]="formularios()" descricao="Top 5 formulários" />
          }
        </ui-painel>
      </div>

      <div class="barra-tabela"><ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" /></div>
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--espacamento-3); }
    .cartao { display: flex; flex-direction: column; gap: var(--espacamento-1); padding: var(--espacamento-4); min-width: 0;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); }
    .rotulo, .anterior, .nota { color: var(--texto-secundario); }
    .valor { color: var(--texto); }
    .variacao { font-weight: 600; color: var(--texto-secundario); }
    .variacao[data-tendencia='alta'] { color: var(--sucesso); }
    .variacao[data-tendencia='queda'] { color: var(--erro); }
    .duas { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--espacamento-4); }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    p { margin: 0; }
    .barra-tabela { display: flex; justify-content: flex-end; }
  `,
})
export class RelatorioOperacionalComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaOperacional>(inject(HttpClient), () => '/v1/relatorios/operacional')

  protected readonly cartoes = computed<CartaoMes[]>(() => {
    const d = this.c.dados()
    if (!d) return []
    const linha = (rotulo: string, a: number, b: number, fmt: (n: number) => string): CartaoMes => {
      const v = variacaoPct(a, b)
      return { rotulo, atual: fmt(a), anterior: fmt(b), variacao: formatarVariacao(v), tendencia: tendenciaDe(v) }
    }
    const n = (x: number): string => String(x)
    return [
      linha('Contatos novos', d.mesAtual.contatosNovos, d.mesAnterior.contatosNovos, n),
      linha('Conversões', d.mesAtual.conversoes, d.mesAnterior.conversoes, n),
      linha('Valor dos pedidos', d.mesAtual.valorCentavos, d.mesAnterior.valorCentavos, formatarReais),
    ]
  })
  protected readonly funil = computed(() => (this.c.dados()?.funil ?? []).map((e) => ({ chave: e.chave, rotulo: e.rotulo, valor: e.oportunidades })))
  protected readonly origens = computed(() => (this.c.dados()?.topOrigens ?? []).map((o) => ({ chave: o.chave, rotulo: o.rotulo, valor: o.total })))
  protected readonly formularios = computed(() => (this.c.dados()?.topFormularios ?? []).map((f) => ({ chave: f.chave, rotulo: f.rotulo, valor: f.total })))
  protected readonly csv = computed(() => {
    const d = this.c.dados()
    return d ? csvOperacional(d) : { colunas: [], linhas: [] }
  })
  protected readonly arquivoCsv = computed(() => `operacional-${this.c.inicio()}-a-${this.c.fim()}`)

  ngOnInit(): void { void this.carregar() }

  protected seta(t: Tendencia): string { return SETA[t] }
  protected carregar(): Promise<void> { return this.c.carregar() }
}
