import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { EstadoComponente } from '../../compartilhado/ui/estado.componente.js'
import { FiltroPeriodoComponente } from '../../compartilhado/ui/filtro-periodo.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { EsqueletoComponente } from '../../compartilhado/ui/esqueleto.componente.js'
import { periodoInvertido } from '../../compartilhado/ui/periodo.js'
import { codigoDoErro } from '../../compartilhado/ui/erro-http.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { configDaDimensao, type DimensaoRelatorio } from './relatorio-dimensao.config.js'
import { formatarTaxa, linhasCsv, queryDoPeriodo, resumoDoRelatorio, type ItemRelatorio } from './relatorio-dimensao.regras.js'

interface Resposta {
  readonly periodo: { inicio: string; fim: string; fuso: string }
  readonly itens: readonly ItemRelatorio[]
  readonly truncado: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const MENSAGENS_PERIODO: Readonly<Record<string, string>> = {
  'periodo.longo_demais': 'O período pode ter no máximo 366 dias.',
  'periodo.invertido': 'A data inicial é depois da final.',
  'periodo.invalido': 'Datas inválidas. Use o seletor de datas.',
  'periodo.incompleto': 'Informe a data inicial e a final.',
}

/**
 * Relatório "Contatos por…" reutilizável: período livre, cards resumo, barras horizontais, tabela e CSV.
 * Configurado pela dimensão (`relatorio-dimensao.config.ts`); a coorte e a conversão são definidas na API
 * (contatos criados no período; convertido = pedido efetivado no período). Os 5 estados: carregando,
 * vazio, erro, sem permissão e pronto. O período é lido do servidor na 1ª carga (fuso do tenant).
 */
@Component({
  selector: 'app-relatorio-dimensao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente,
    FiltroPeriodoComponente, PainelComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <div class="filtros">
      <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="carregar()" />
    </div>

    @switch (estado()) {
      @case ('carregando') {
        <div class="cartoes"><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /></div>
        <ui-esqueleto altura="180px" />
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso aos relatórios" descricao="Peça a um administrador a permissão de leitura." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o relatório" [descricao]="erroTexto()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (itens().length === 0 || resumo().contatos === 0) {
          <ui-estado tipo="vazio" [titulo]="config().titulo" [descricao]="config().vazio" />
        } @else {
          <div class="cartoes">
            <ui-stat-card [valor]="resumo().contatos" rotulo="Contatos novos" />
            <ui-stat-card [valor]="resumo().convertidos" rotulo="Convertidos" tom="sucesso" />
            <ui-stat-card [valor]="taxaTexto()" rotulo="Conversão" tom="acao" />
            <ui-stat-card [valor]="valorTexto()" rotulo="Valor dos pedidos" />
          </div>

          <ui-painel>
            <h2 class="txt-secao">{{ config().titulo }}</h2>
            <app-barras-horizontais [itens]="barras()" [descricao]="config().titulo" />
          </ui-painel>

          <div class="barra-tabela">
            <span class="txt-denso nota">
              Período {{ periodoTexto() }}. Conversão = contatos novos com pedido efetivado no período.
              @if (truncado()) { Mostrando só os 100 maiores grupos. }
            </span>
            <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" />
          </div>
          <ui-tabela [colunas]="colunas()" [linhas]="linhas()" [chaveLinha]="chaveLinha">
            <ng-template uiCelula="taxa" let-l>{{ taxa(l) }}</ng-template>
            <ng-template uiCelula="valor" let-l>{{ valor(l) }}</ng-template>
          </ui-tabela>
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .barra-tabela { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-suave); }
  `,
})
export class RelatorioDimensaoComponente {
  private readonly http = inject(HttpClient)

  readonly dimensao = input.required<DimensaoRelatorio>()
  readonly inicio = signal('')
  readonly fim = signal('')
  readonly estado = signal<Estado>('carregando')
  readonly dados = signal<Resposta | null>(null)
  readonly erroTexto = signal('')

  protected readonly config = computed(() => configDaDimensao(this.dimensao()))
  protected readonly itens = computed(() => this.dados()?.itens ?? [])
  protected readonly truncado = computed(() => this.dados()?.truncado ?? false)
  protected readonly resumo = computed(() => resumoDoRelatorio(this.itens()))
  protected readonly taxaTexto = computed(() => formatarTaxa(this.resumo().taxa))
  protected readonly valorTexto = computed(() => formatarReais(this.resumo().valorCentavos))
  protected readonly barras = computed(() => this.itens().map((i) => ({ chave: i.chave, rotulo: i.rotulo, valor: i.contatos })))
  protected readonly linhas = computed<LinhaTabela[]>(() => this.itens().map((i) => ({ ...i })))
  protected readonly csv = computed(() => linhasCsv(this.itens(), this.config().colunaRotulo))
  protected readonly arquivoCsv = computed(() => `contatos-por-${this.dimensao()}-${this.inicio()}-a-${this.fim()}`)
  protected readonly periodoTexto = computed(() => `${this.inicio()} a ${this.fim()}`)
  protected readonly colunas = computed<ColunaTabela[]>(() => [
    { chave: 'rotulo', rotulo: this.config().colunaRotulo },
    { chave: 'contatos', rotulo: 'Contatos', alinhamento: 'dir' },
    { chave: 'convertidos', rotulo: 'Convertidos', alinhamento: 'dir' },
    { chave: 'taxa', rotulo: 'Conversão', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
  ])
  protected readonly chaveLinha = (l: LinhaTabela): string => String(l['chave'])

  private versao = 0

  constructor() {
    // Trocar a dimensão recarrega com o MESMO período (a instância persiste entre as abas).
    effect(() => {
      this.dimensao()
      untracked(() => void this.carregar())
    })
  }

  protected taxa(l: LinhaTabela): string { return formatarTaxa(l['taxa'] as number | null) }
  protected valor(l: LinhaTabela): string { return formatarReais(Number(l['valorCentavos'])) }

  async carregar(): Promise<void> {
    if (periodoInvertido(this.inicio(), this.fim())) return
    const minha = ++this.versao
    this.estado.set('carregando')
    const q = queryDoPeriodo(this.inicio(), this.fim())
    try {
      const r = await firstValueFrom(this.http.get<Resposta>(`/v1/relatorios/contatos-por/${this.dimensao()}${q ? `?${q}` : ''}`))
      if (minha !== this.versao) return   // resposta de uma dimensão/período que já não é o atual
      this.dados.set(r)
      this.inicio.set(r.periodo.inicio)
      this.fim.set(r.periodo.fim)
      this.estado.set('pronto')
    } catch (e) {
      if (minha !== this.versao) return
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroTexto.set(MENSAGENS_PERIODO[codigoDoErro(e) ?? ''] ?? 'Confira a conexão e tente de novo.')
      this.estado.set('erro')
    }
  }
}
