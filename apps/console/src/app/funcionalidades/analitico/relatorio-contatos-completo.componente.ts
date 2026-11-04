import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { FormsModule } from '@angular/forms'
import { CampoComponente } from '../../compartilhado/ui/campo.componente.js'
import { FiltroPeriodoComponente } from '../../compartilhado/ui/filtro-periodo.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { periodoInvertido } from '../../compartilhado/ui/periodo.js'
import { SelectPaginadoComponente } from '../../compartilhado/ui/select-paginado.componente.js'
import { SelectComponente, type OpcaoSelect } from '../../compartilhado/ui/select.componente.js'
import { ListaContatosRelatorioComponente } from './lista-contatos-relatorio.componente.js'
import { carregarOpcoesRelatorio } from './opcoes-relatorio.js'
import {
  erroDosFiltros, FILTROS_VAZIOS, filtrosAtivos, queryDosFiltros, type FiltrosContatosUi,
} from './relatorios-analise.regras.js'

const QUALIFICACOES: OpcaoSelect[] = [
  { valor: '', rotulo: 'Todas' }, { valor: 'novo', rotulo: 'Novo' }, { valor: 'qualificado', rotulo: 'Qualificado' }, { valor: 'descartado', rotulo: 'Descartado' },
]
const TIPOS: OpcaoSelect[] = [
  { valor: '', rotulo: 'Todos' }, { valor: 'cpf', rotulo: 'Pessoa física (CPF)' }, { valor: 'cnpj', rotulo: 'Pessoa jurídica (CNPJ)' }, { valor: 'sem', rotulo: 'Sem documento' },
]
const CONVERTIDO: OpcaoSelect[] = [{ valor: '', rotulo: 'Todos' }, { valor: 'sim', rotulo: 'Convertidos' }, { valor: 'nao', rotulo: 'Não convertidos' }]

/**
 * Lista de contatos completa (E3): contatos criados no período com filtros extras (qualificação, origem,
 * vendedor, filial, formulário, UF, tipo de pessoa, convertido e nome), paginada por cursor, e CSV de até 1.000
 * linhas gerado no servidor. Os filtros só valem ao clicar em Aplicar.
 */
@Component({
  selector: 'app-relatorio-contatos-completo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CampoComponente, FiltroPeriodoComponente, FormsModule, ListaContatosRelatorioComponente, PainelComponente, SelectComponente, SelectPaginadoComponente],
  template: `
    <ui-painel class="nao-imprimir">
      <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="aplicar()" />
      <p class="txt-denso nota">Sem datas, vale o mês atual (no fuso da empresa). Período máximo de 366 dias.</p>
      <div class="filtros" role="group" aria-label="Filtros dos contatos">
        <ui-campo rotulo="Nome" placeholder="Parte do nome" [valor]="rascunho().busca" (valorChange)="mudar('busca', $event)" />
        <ui-select rotulo="Qualificação" [opcoes]="qualificacoes" [valor]="rascunho().qualificacao" (valorChange)="mudar('qualificacao', $event)" />
        <ui-select rotulo="Tipo de pessoa" [opcoes]="tipos" [valor]="rascunho().tipoPessoa" (valorChange)="mudar('tipoPessoa', $event)" />
        <ui-select rotulo="Conversão" [opcoes]="convertido" [valor]="rascunho().convertido" (valorChange)="mudar('convertido', $event)" />
        <ui-campo rotulo="UF" placeholder="SP" [valor]="rascunho().uf" (valorChange)="mudar('uf', $event)" />
        <ui-select-paginado rotulo="Origem" placeholder="Todas" [carregar]="origens" [ngModel]="rascunho().origemId" (ngModelChange)="mudar('origemId', $event ?? '')" name="origem" />
        <ui-select-paginado rotulo="Vendedor" placeholder="Todos" [carregar]="vendedores" [ngModel]="rascunho().vendedorId" (ngModelChange)="mudar('vendedorId', $event ?? '')" name="vendedor" />
        <ui-select-paginado rotulo="Filial" placeholder="Todas" [carregar]="filiais" [ngModel]="rascunho().filialId" (ngModelChange)="mudar('filialId', $event ?? '')" name="filial" />
        <ui-select-paginado rotulo="Formulário" placeholder="Todos" [carregar]="formularios" [ngModel]="rascunho().formularioId" (ngModelChange)="mudar('formularioId', $event ?? '')" name="formulario" />
      </div>
      <div class="acoes">
        <button type="button" class="btn btn--primario btn--pequeno" [disabled]="!!erroFiltro() || periodoInvertido()" (click)="aplicar()">Aplicar filtros</button>
        <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="ativos() === 0 && !temRascunho()" (click)="limpar()">Limpar</button>
        <span class="txt-denso nota" role="status">{{ ativos() }} {{ ativos() === 1 ? 'filtro aplicado' : 'filtros aplicados' }}</span>
        @if (erroFiltro()) { <span class="txt-denso erro" role="alert">{{ erroFiltro() }}</span> }
      </div>
    </ui-painel>

    <app-lista-contatos-relatorio [inicio]="aplicadoInicio()" [fim]="aplicadoFim()" [filtros]="aplicados()" [versao]="versao()" />
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .filtros { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
    .acoes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
    .nota { color: var(--texto-secundario); }
    .erro { color: var(--erro); }
  `,
})
export class RelatorioContatosCompletoComponente {
  private readonly http = inject(HttpClient)
  protected readonly qualificacoes = QUALIFICACOES
  protected readonly tipos = TIPOS
  protected readonly convertido = CONVERTIDO
  protected readonly origens = carregarOpcoesRelatorio(this.http, 'origem')
  protected readonly vendedores = carregarOpcoesRelatorio(this.http, 'vendedor')
  protected readonly filiais = carregarOpcoesRelatorio(this.http, 'filial')
  protected readonly formularios = carregarOpcoesRelatorio(this.http, 'formulario')

  protected readonly inicio = signal('')
  protected readonly fim = signal('')
  protected readonly rascunho = signal<FiltrosContatosUi>({ ...FILTROS_VAZIOS })
  private readonly aplicadosFiltros = signal<FiltrosContatosUi>({ ...FILTROS_VAZIOS })
  protected readonly aplicadoInicio = signal('')
  protected readonly aplicadoFim = signal('')
  protected readonly versao = signal(0)

  protected readonly aplicados = computed(() => queryDosFiltros(this.aplicadosFiltros()))
  protected readonly ativos = computed(() => filtrosAtivos(this.aplicadosFiltros()))
  protected readonly temRascunho = computed(() => filtrosAtivos(this.rascunho()) > 0)
  protected readonly erroFiltro = computed(() => erroDosFiltros(this.rascunho()))
  protected readonly periodoInvertido = computed(() => periodoInvertido(this.inicio(), this.fim()))

  protected mudar<K extends keyof FiltrosContatosUi>(campo: K, valor: string): void {
    this.rascunho.update((r) => ({ ...r, [campo]: valor }))
  }

  protected aplicar(): void {
    if (this.erroFiltro() || this.periodoInvertido()) return
    this.aplicadosFiltros.set({ ...this.rascunho() })
    this.aplicadoInicio.set(this.inicio())
    this.aplicadoFim.set(this.fim())
    this.versao.update((v) => v + 1)
  }

  protected limpar(): void {
    this.rascunho.set({ ...FILTROS_VAZIOS })
    this.aplicar()
  }
}
