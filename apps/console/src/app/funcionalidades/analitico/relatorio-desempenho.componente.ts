import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import { avisoTruncado, csvDesempenho, type GrupoCoorte, type RespostaDesempenho } from './relatorios-analise.regras.js'
import { formatarPercentual } from './relatorios-gestao.regras.js'

interface Quadro { readonly titulo: string; readonly itens: readonly GrupoCoorte[]; readonly truncado: boolean }

/**
 * Desempenho do cadastro (E3): da coorte de contatos criados no período, quanto do cadastro está completo
 * (telefone, e-mail, CPF/CNPJ, cidade e UF, origem, vendedor) e como ela se divide por tipo de pessoa, status,
 * origem, canal, UF, cidade e etapa do funil (top 20, com aviso quando há corte).
 */
@Component({
  selector: 'app-relatorio-desempenho',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarrasHorizontaisComponente, BotaoCsvComponente, PainelComponente, RelatorioMolduraComponente, StatCardComponente],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="(c.dados()?.contatos ?? 0) === 0" tituloVazio="Nenhum contato criado no período"
      descricaoVazio="Amplie o período: o desempenho mede os contatos criados nele." (aplicar)="carregar()" (tentar)="carregar()">
      @if (c.dados(); as d) {
        <div class="cartoes">
          <ui-stat-card [valor]="d.contatos" rotulo="Contatos criados" />
          <ui-stat-card [valor]="d.cadastroCompleto" rotulo="Cadastros completos" tom="sucesso" />
          <ui-stat-card [valor]="completos()" rotulo="% de cadastros completos" />
        </div>
        <div class="barra"><span class="txt-denso nota">Período {{ c.inicio() }} a {{ c.fim() }}. Completo = os seis campos abaixo preenchidos.</span>
          <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="'desempenho-' + c.inicio() + '-a-' + c.fim()" /></div>

        <ui-painel>
          <h2 class="txt-secao">Completude dos dados</h2>
          <app-barras-horizontais [itens]="barrasCompletude()" descricao="Percentual de contatos com cada campo preenchido" />
        </ui-painel>

        <div class="grade">
          @for (q of quadros(); track q.titulo) {
            <ui-painel>
              <h2 class="txt-secao">{{ q.titulo }}</h2>
              @if (q.itens.length === 0) { <p class="txt-denso nota">Sem dados.</p> }
              @else { <app-barras-horizontais [itens]="barras(q.itens)" alturaMax="360px" [descricao]="q.titulo" /> }
              @if (q.truncado) { <p class="txt-denso nota">{{ aviso }}</p> }
            </ui-painel>
          }
        </div>
      }
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--espacamento-4); }
    .barra { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); margin: var(--espacamento-2) 0 0; }
  `,
})
export class RelatorioDesempenhoComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaDesempenho>(inject(HttpClient), () => '/v1/relatorios/desempenho')
  protected readonly aviso = avisoTruncado(true, 20)

  protected readonly completos = computed(() => {
    const d = this.c.dados()
    return formatarPercentual(d && d.contatos > 0 ? d.cadastroCompleto / d.contatos : null)
  })
  protected readonly barrasCompletude = computed(() =>
    (this.c.dados()?.completude ?? []).map((x) => ({
      chave: x.campo, rotulo: x.rotulo, valor: x.percentual * 100, texto: `${x.preenchidos} de ${x.total} (${formatarPercentual(x.percentual)})`,
    })))
  protected readonly quadros = computed<Quadro[]>(() => {
    const d = this.c.dados()
    if (!d) return []
    return [
      { titulo: 'Tipo de pessoa', itens: d.tipoPessoa, truncado: false },
      { titulo: 'Status (qualificação)', itens: d.qualificacao, truncado: false },
      { titulo: 'Origem', itens: d.origem, truncado: d.truncado.origem },
      { titulo: 'Canal', itens: d.canal, truncado: d.truncado.canal },
      { titulo: 'UF', itens: d.uf, truncado: d.truncado.uf },
      { titulo: 'Cidade', itens: d.cidade, truncado: d.truncado.cidade },
      { titulo: 'Etapa do funil', itens: d.funil, truncado: d.truncado.funil },
    ]
  })
  protected readonly csv = computed(() => csvDesempenho(this.c.dados() ?? VAZIO))

  ngOnInit(): void { void this.c.carregar() }

  protected carregar(): Promise<void> { return this.c.carregar() }
  protected barras(itens: readonly GrupoCoorte[]) {
    return itens.map((g) => ({ chave: g.chave, rotulo: g.rotulo, valor: g.contatos, texto: `${g.contatos} (${formatarPercentual(g.percentual)})` }))
  }
}

const VAZIO: RespostaDesempenho = {
  periodo: { inicio: '', fim: '', fuso: '' }, contatos: 0, completude: [], cadastroCompleto: 0, tipoPessoa: [], qualificacao: [],
  origem: [], canal: [], uf: [], cidade: [], funil: [], truncado: { origem: false, canal: false, uf: false, cidade: false, funil: false },
}
