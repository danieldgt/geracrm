import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core'
import { AbasComponente } from '../../compartilhado/ui/abas.componente.js'
import type { Aba } from '../../compartilhado/ui/abas.regras.js'
import { CabecalhoTelaComponente } from '../../compartilhado/ui/cabecalho-tela.componente.js'
import { RelatorioComparativoComponente } from './relatorio-comparativo.componente.js'
import { RelatorioContatosCompletoComponente } from './relatorio-contatos-completo.componente.js'
import { RelatorioDesempenhoComponente } from './relatorio-desempenho.componente.js'
import { RelatorioImprimiveisComponente } from './relatorio-imprimiveis.componente.js'
import { RelatorioRaioXComponente } from './relatorio-raio-x.componente.js'
import { RelatorioVisaoGeralComponente } from './relatorio-visao-geral.componente.js'
import { RelatorioConversaoComponente } from './relatorio-conversao.componente.js'
import { RelatorioDimensaoComponente } from './relatorio-dimensao.componente.js'
import { DIMENSOES_RELATORIO, type DimensaoRelatorio } from './relatorio-dimensao.config.js'
import { RelatorioOperacionalComponente } from './relatorio-operacional.componente.js'
import { RelatorioVendasComponente } from './relatorio-vendas.componente.js'
import { RelatorioVendedoresComponente } from './relatorio-vendedores.componente.js'
import { RelatorioWhatsappComponente } from './relatorio-whatsapp.componente.js'

type Relatorio =
  | 'contatos' | 'vendas' | 'conversao' | 'vendedores' | 'operacional' | 'whatsapp'
  | 'comparativo' | 'visao-geral' | 'lista' | 'raio-x' | 'desempenho' | 'imprimiveis'

/**
 * Relatórios — abas: Contatos (por origem, etapa, vendedor, dia da semana, qualificação e UF), Vendas (por
 * dimensão), Tempo de conversão, Vendedores, Operacional e WhatsApp (E2); e, na 2ª leva (E3), Comparativo, Visão
 * geral, Lista de contatos, Raio-X, Desempenho do cadastro e Imprimíveis. Cada aba tem período livre e CSV.
 */
@Component({
  selector: 'app-relatorios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, CabecalhoTelaComponente, RelatorioConversaoComponente, RelatorioDimensaoComponente,
    RelatorioOperacionalComponente, RelatorioVendasComponente, RelatorioVendedoresComponente, RelatorioWhatsappComponente,
    RelatorioComparativoComponente, RelatorioContatosCompletoComponente, RelatorioDesempenhoComponente,
    RelatorioImprimiveisComponente, RelatorioRaioXComponente, RelatorioVisaoGeralComponente,
  ],
  template: `
    <ui-cabecalho-tela class="nao-imprimir" titulo="Relatórios" subtitulo="Contatos, vendas, conversão, vendedores, operação, WhatsApp, comparativos e imprimíveis." />
    <ui-abas class="nao-imprimir" [abas]="abas" [ativa]="relatorio()" (ativaChange)="trocarRelatorio($event)" />
    <div class="corpo">
      @switch (relatorio()) {
        @case ('contatos') {
          <ui-abas [abas]="abasContatos" [ativa]="aba()" (ativaChange)="trocar($event)" />
          <div class="sub"><app-relatorio-dimensao [dimensao]="dimensao()" /></div>
        }
        @case ('vendas') { <app-relatorio-vendas /> }
        @case ('conversao') { <app-relatorio-conversao /> }
        @case ('vendedores') { <app-relatorio-vendedores /> }
        @case ('operacional') { <app-relatorio-operacional /> }
        @case ('whatsapp') { <app-relatorio-whatsapp /> }
        @case ('comparativo') { <app-relatorio-comparativo /> }
        @case ('visao-geral') { <app-relatorio-visao-geral /> }
        @case ('lista') { <app-relatorio-contatos-completo /> }
        @case ('raio-x') { <app-relatorio-raio-x /> }
        @case ('desempenho') { <app-relatorio-desempenho /> }
        @case ('imprimiveis') { <app-relatorio-imprimiveis /> }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); }
    .sub { margin-top: var(--espacamento-4); }
    @media print { :host { padding: 0; } .corpo { margin-top: 0; } }
  `,
})
export class RelatoriosPagina {
  protected readonly abas: readonly Aba[] = [
    { id: 'contatos', rotulo: 'Contatos' },
    { id: 'vendas', rotulo: 'Vendas' },
    { id: 'conversao', rotulo: 'Tempo de conversão' },
    { id: 'vendedores', rotulo: 'Vendedores' },
    { id: 'operacional', rotulo: 'Operacional' },
    { id: 'whatsapp', rotulo: 'WhatsApp' },
    { id: 'comparativo', rotulo: 'Comparativo' },
    { id: 'visao-geral', rotulo: 'Visão geral' },
    { id: 'lista', rotulo: 'Lista de contatos' },
    { id: 'raio-x', rotulo: 'Raio-X' },
    { id: 'desempenho', rotulo: 'Desempenho do cadastro' },
    { id: 'imprimiveis', rotulo: 'Imprimíveis' },
  ]
  protected readonly abasContatos: readonly Aba[] = DIMENSOES_RELATORIO.map((d) => ({ id: d.chave, rotulo: d.aba }))
  protected readonly relatorio = signal<Relatorio>('contatos')
  protected readonly aba = signal<string>(DIMENSOES_RELATORIO[0]!.chave)
  protected readonly dimensao = computed(() => this.aba() as DimensaoRelatorio)

  protected trocarRelatorio(id: string): void { this.relatorio.set(id as Relatorio) }
  protected trocar(id: string): void { this.aba.set(id) }
}
