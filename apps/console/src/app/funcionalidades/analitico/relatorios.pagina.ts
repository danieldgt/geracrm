import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core'
import { AbasComponente } from '../../compartilhado/ui/abas.componente.js'
import type { Aba } from '../../compartilhado/ui/abas.regras.js'
import { CabecalhoTelaComponente } from '../../compartilhado/ui/cabecalho-tela.componente.js'
import { RelatorioConversaoComponente } from './relatorio-conversao.componente.js'
import { RelatorioDimensaoComponente } from './relatorio-dimensao.componente.js'
import { DIMENSOES_RELATORIO, type DimensaoRelatorio } from './relatorio-dimensao.config.js'
import { RelatorioOperacionalComponente } from './relatorio-operacional.componente.js'
import { RelatorioVendasComponente } from './relatorio-vendas.componente.js'
import { RelatorioVendedoresComponente } from './relatorio-vendedores.componente.js'
import { RelatorioWhatsappComponente } from './relatorio-whatsapp.componente.js'

type Relatorio = 'contatos' | 'vendas' | 'conversao' | 'vendedores' | 'operacional' | 'whatsapp'

/**
 * Relatórios — abas: Contatos (por origem, etapa, vendedor, dia da semana, qualificação e UF), Vendas (por
 * dimensão), Tempo de conversão, Vendedores, Operacional e WhatsApp. Cada aba tem período livre e CSV.
 */
@Component({
  selector: 'app-relatorios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, CabecalhoTelaComponente, RelatorioConversaoComponente, RelatorioDimensaoComponente,
    RelatorioOperacionalComponente, RelatorioVendasComponente, RelatorioVendedoresComponente, RelatorioWhatsappComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Relatórios" subtitulo="Contatos, vendas, tempo de conversão, vendedores, operação e WhatsApp." />
    <ui-abas [abas]="abas" [ativa]="relatorio()" (ativaChange)="trocarRelatorio($event)" />
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
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); }
    .sub { margin-top: var(--espacamento-4); }
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
  ]
  protected readonly abasContatos: readonly Aba[] = DIMENSOES_RELATORIO.map((d) => ({ id: d.chave, rotulo: d.aba }))
  protected readonly relatorio = signal<Relatorio>('contatos')
  protected readonly aba = signal<string>(DIMENSOES_RELATORIO[0]!.chave)
  protected readonly dimensao = computed(() => this.aba() as DimensaoRelatorio)

  protected trocarRelatorio(id: string): void { this.relatorio.set(id as Relatorio) }
  protected trocar(id: string): void { this.aba.set(id) }
}
