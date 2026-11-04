import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { FormsModule } from '@angular/forms'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { SelectPaginadoComponente } from '../../compartilhado/ui/select-paginado.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { carregarOpcoesRelatorio } from './opcoes-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  adicionarVendedor, csvComparativo, queryVendedores, removerVendedor, textoLimiteVendedores,
  type RespostaComparativo, type VendedorEscolhido,
} from './relatorios-analise.regras.js'
import { formatarPercentual } from './relatorios-gestao.regras.js'

const ZERO = { contatosNovos: 0, tarefasConcluidas: 0, conversoes: 0, taxa: null, pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0 }

/**
 * Comparativo de vendedores (E3): de 1 a 10 vendedores escolhidos num select paginado por cursor, lado a lado
 * (contatos novos, tarefas, conversões, taxa, pedidos, valor e ticket). Mesma coorte e mesmas réguas do relatório
 * "Vendedores". O escopo vale: quem não enxerga um vendedor não o compara.
 */
@Component({
  selector: 'app-relatorio-comparativo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, FormsModule, PainelComponente, RelatorioMolduraComponente,
    SelectPaginadoComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <ui-painel class="nao-imprimir">
      <h2 class="txt-secao">Vendedores do comparativo</h2>
      <div class="escolha">
        <ui-select-paginado rotulo="Adicionar vendedor" placeholder="Busque pelo nome" [carregar]="carregarVendedores"
          [desabilitado]="escolhidos().length >= maximo" [ngModel]="escolha()" (ngModelChange)="adicionar($event)" name="vendedor" />
        <span class="txt-denso nota" role="status">{{ contagem() }}</span>
      </div>
      @if (aviso()) { <p class="txt-denso aviso" role="alert">{{ aviso() }}</p> }
      <ul class="chips" aria-label="Vendedores escolhidos">
        @for (v of escolhidos(); track v.id) {
          <li class="chip"><span>{{ v.nome }}</span>
            <button type="button" class="remover" [attr.aria-label]="'Remover ' + v.nome" (click)="remover(v.id)">×</button></li>
        }
      </ul>
    </ui-painel>

    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="escolhidos().length === 0 || itens().length === 0"
      [tituloVazio]="escolhidos().length === 0 ? 'Escolha os vendedores' : 'Nenhum vendedor disponível'"
      [descricaoVazio]="escolhidos().length === 0 ? 'Adicione de 1 a 10 vendedores para compará-los lado a lado.' : 'Os vendedores escolhidos não estão no seu escopo.'"
      (aplicar)="carregar()" (tentar)="carregar()">
      @if (c.dados(); as d) {
        <div class="cartoes">
          <ui-stat-card [valor]="d.totais.contatosNovos" rotulo="Contatos novos" />
          <ui-stat-card [valor]="d.totais.conversoes" rotulo="Conversões" tom="sucesso" />
          <ui-stat-card [valor]="pct(d.totais.taxa)" rotulo="Conversão" />
          <ui-stat-card [valor]="reais(d.totais.valorCentavos)" rotulo="Valor dos pedidos" tom="acao" />
        </div>
        <ui-painel>
          <h2 class="txt-secao">Valor dos pedidos</h2>
          <app-barras-horizontais [itens]="barras()" descricao="Valor dos pedidos por vendedor" />
        </ui-painel>
        <div class="barra-tabela">
          <span class="txt-denso nota">Período {{ c.inicio() }} a {{ c.fim() }}.</span>
          <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="'comparativo-' + c.inicio() + '-a-' + c.fim()" />
        </div>
        <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chave">
          <ng-template uiCelula="taxa" let-l>{{ pct(l['taxa']) }}</ng-template>
          <ng-template uiCelula="valor" let-l>{{ reais(l['valorCentavos']) }}</ng-template>
          <ng-template uiCelula="ticket" let-l>{{ reais(l['ticketMedioCentavos']) }}</ng-template>
        </ui-tabela>
      }
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .escolha { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3); }
    .chips { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-1) var(--espacamento-3);
            border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie); }
    .remover { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer; font-size: 16px; line-height: 1; }
    .barra-tabela { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); }
    .aviso { color: var(--erro); margin: var(--espacamento-2) 0 0; }
  `,
})
export class RelatorioComparativoComponente implements OnInit {
  private readonly http = inject(HttpClient)
  protected readonly maximo = 10
  protected readonly escolhidos = signal<readonly VendedorEscolhido[]>([])
  protected readonly escolha = signal<string | null>(null)
  protected readonly aviso = signal('')
  private readonly nomes = new Map<string, string>()

  protected readonly c = new CarregadorRelatorio<RespostaComparativo>(
    this.http, () => '/v1/relatorios/comparativo', () => queryVendedores(this.escolhidos()))
  protected readonly carregarVendedores = carregarOpcoesRelatorio(this.http, 'vendedor', (o) => this.nomes.set(o.valor, o.rotulo))

  protected readonly contagem = computed(() => textoLimiteVendedores(this.escolhidos().length))
  protected readonly itens = computed(() => this.c.dados()?.itens ?? [])
  protected readonly barras = computed(() =>
    this.itens().map((v) => ({ chave: v.usuarioId, rotulo: v.nome, valor: v.valorCentavos, texto: formatarReais(v.valorCentavos) })))
  protected readonly linhas = computed<LinhaTabela[]>(() => this.itens().map((v) => ({ ...v })))
  protected readonly csv = computed(() => csvComparativo(this.c.dados() ?? { itens: [], totais: ZERO }))
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Vendedor' },
    { chave: 'contatosNovos', rotulo: 'Contatos novos', alinhamento: 'dir' },
    { chave: 'tarefasConcluidas', rotulo: 'Tarefas concluídas', alinhamento: 'dir' },
    { chave: 'conversoes', rotulo: 'Conversões', alinhamento: 'dir' },
    { chave: 'taxa', rotulo: 'Conversão', alinhamento: 'dir' },
    { chave: 'pedidos', rotulo: 'Pedidos', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
    { chave: 'ticket', rotulo: 'Ticket médio', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['usuarioId'])

  ngOnInit(): void { this.c.estado.set('pronto') }

  protected adicionar(id: string | null): void {
    this.escolha.set(null)
    if (!id) return
    const r = adicionarVendedor(this.escolhidos(), { id, nome: this.nomes.get(id) ?? 'Vendedor' })
    this.aviso.set(r.motivo === 'repetido' ? 'Esse vendedor já está na lista.' : r.motivo === 'limite' ? 'O comparativo aceita no máximo 10 vendedores.' : '')
    if (r.motivo === null) { this.escolhidos.set(r.lista); void this.recarregar() }
  }
  protected remover(id: string): void {
    this.aviso.set('')
    this.escolhidos.set(removerVendedor(this.escolhidos(), id))
    void this.recarregar()
  }
  protected carregar(): Promise<void> { return this.recarregar() }
  private async recarregar(): Promise<void> {
    if (this.escolhidos().length === 0) { this.c.dados.set(null); this.c.estado.set('pronto'); return }
    await this.c.carregar()
  }

  protected reais(v: unknown): string { return formatarReais(Number(v)) }
  protected pct(v: unknown): string { return formatarPercentual(v === null || v === undefined ? null : Number(v)) }
}
