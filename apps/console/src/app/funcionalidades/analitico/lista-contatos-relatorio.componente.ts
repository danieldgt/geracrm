import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { baixarCsv } from '../../compartilhado/ui/csv.js'
import { codigoDoErro } from '../../compartilhado/ui/erro-http.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { EsqueletoComponente } from '../../compartilhado/ui/esqueleto.componente.js'
import { EstadoComponente } from '../../compartilhado/ui/estado.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import {
  avisoCsv, formatarDataHora, localDoContato, ROTULO_QUALIFICACAO, ROTULO_TIPO_PESSOA, type LinhaContato, type RespostaContatos,
} from './relatorios-analise.regras.js'
import { mensagemDoErro } from './relatorios-gestao.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Lista de contatos do período (detalhamento da Visão geral e o corpo de "Lista de contatos"): paginada por
 * CURSOR no servidor (50 por página, "Carregar mais"), com os 5 estados e CSV gerado no servidor (até 1.000
 * linhas, em páginas por cursor). `inicio`/`fim`/`filtros` mudando recarrega do começo; `versao` força recarga.
 */
@Component({
  selector: 'app-lista-contatos-relatorio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CelulaDiretiva, EsqueletoComponente, EstadoComponente, TabelaComponente],
  template: `
    <div class="barra nao-imprimir">
      <span class="txt-denso nota" role="status">{{ resumo() }}</span>
      <button type="button" class="btn btn--secundario btn--pequeno" [disabled]="baixando() || estado() !== 'pronto' || linhas().length === 0"
              (click)="baixar()">{{ baixando() ? 'Gerando…' : 'Baixar CSV (até 1.000 linhas)' }}</button>
    </div>
    @if (avisoDownload()) { <p class="txt-denso nota" role="status">{{ avisoDownload() }}</p> }

    @switch (estado()) {
      @case ('carregando') { <ui-esqueleto altura="180px" /> }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso aos relatórios" descricao="Peça a um administrador a permissão de leitura." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os contatos" [descricao]="erroTexto()">
          <button type="button" class="btn btn--secundario" (click)="carregar(true)">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (linhas().length === 0) {
          <ui-estado tipo="vazio" titulo="Nenhum contato encontrado"
            descricao="Nenhum contato criado no período atende aos filtros. Amplie o período ou limpe os filtros." />
        } @else {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chave">
            <ng-template uiCelula="valor" let-l>{{ reais(l['valorCentavos']) }}</ng-template>
          </ui-tabela>
          @if (proximoCursor()) {
            <div class="mais nao-imprimir">
              <button type="button" class="btn btn--secundario" [disabled]="carregandoMais()" (click)="maisUma()">
                {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</button>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .barra { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); margin: 0; }
    .mais { display: flex; justify-content: center; }
  `,
})
export class ListaContatosRelatorioComponente {
  private readonly http = inject(HttpClient)
  readonly inicio = input.required<string>()
  readonly fim = input.required<string>()
  /** Query dos filtros já montada (`uf=SP&convertido=sim`), sem período. */
  readonly filtros = input('')
  /** Incrementa para recarregar mesmo sem mudar os parâmetros (botão Aplicar). */
  readonly versao = input(0)

  protected readonly estado = signal<Estado>('carregando')
  protected readonly erroTexto = signal('')
  protected readonly linhasBrutas = signal<readonly LinhaContato[]>([])
  protected readonly proximoCursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  protected readonly baixando = signal(false)
  protected readonly avisoDownload = signal('')
  private fuso = 'America/Sao_Paulo'
  private geracao = 0

  protected readonly linhas = computed<LinhaTabela[]>(() => this.linhasBrutas().map((l) => ({
    ...l, id: l.id, tipo: l.tipoPessoa ? ROTULO_TIPO_PESSOA[l.tipoPessoa] : '—', local: localDoContato(l), origem: l.origem ?? '—',
    vendedor: l.vendedor ?? '—', filial: l.filial ?? '—', formulario: l.formulario ?? '—', telefone: l.telefone ?? '—',
    status: ROTULO_QUALIFICACAO[l.qualificacao], criado: formatarDataHora(l.criadoEm, this.fuso),
    convertidoTexto: l.convertido ? `Sim (${l.pedidos})` : 'Não',
  })))
  protected readonly resumo = computed(() => {
    const n = this.linhasBrutas().length
    return this.estado() !== 'pronto' ? '' : `${n} ${n === 1 ? 'contato carregado' : 'contatos carregados'}${this.proximoCursor() ? ' (há mais)' : ''}.`
  })
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Contato' }, { chave: 'telefone', rotulo: 'Telefone', mono: true }, { chave: 'tipo', rotulo: 'Pessoa' },
    { chave: 'local', rotulo: 'Cidade / UF' }, { chave: 'origem', rotulo: 'Origem' }, { chave: 'formulario', rotulo: 'Formulário' },
    { chave: 'vendedor', rotulo: 'Vendedor' }, { chave: 'filial', rotulo: 'Filial' }, { chave: 'status', rotulo: 'Status' },
    { chave: 'criado', rotulo: 'Criado em' }, { chave: 'convertidoTexto', rotulo: 'Convertido', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['id'])

  constructor() {
    effect(() => {
      this.inicio(); this.fim(); this.filtros(); this.versao()
      untracked(() => { void this.carregar(false) })
    })
  }

  private consulta(extra: string): string {
    const partes = [this.inicio() ? `inicio=${this.inicio()}` : '', this.fim() ? `fim=${this.fim()}` : '', this.filtros(), extra]
    return partes.filter((p) => p !== '').join('&')
  }

  protected async carregar(_forcar: boolean): Promise<void> {
    const minha = ++this.geracao
    this.estado.set('carregando')
    this.avisoDownload.set('')
    try {
      const r = await firstValueFrom(this.http.get<RespostaContatos>(`/v1/relatorios/contatos?${this.consulta('')}`))
      if (minha !== this.geracao) return
      this.fuso = r.periodo.fuso
      this.linhasBrutas.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (minha !== this.geracao) return
      this.falhar(e)
    }
  }

  protected async maisUma(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    const minha = this.geracao
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<RespostaContatos>(`/v1/relatorios/contatos?${this.consulta(`cursor=${encodeURIComponent(cursor)}`)}`))
      if (minha !== this.geracao) return
      this.linhasBrutas.update((atual) => [...atual, ...r.itens])
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      if (minha === this.geracao) this.falhar(e)
    } finally {
      this.carregandoMais.set(false)
    }
  }

  protected async baixar(): Promise<void> {
    this.baixando.set(true)
    this.avisoDownload.set('')
    try {
      const r = await firstValueFrom(this.http.get(`/v1/relatorios/contatos.csv?${this.consulta('')}`, { responseType: 'text', observe: 'response' }))
      const texto = r.body ?? ''
      // O navegador descarta o BOM ao ler texto; o Excel precisa dele para abrir os acentos.
      baixarCsv(`contatos-${this.inicio()}-a-${this.fim()}`, texto.startsWith('\uFEFF') ? texto : `\uFEFF${texto}`)
      this.avisoDownload.set(avisoCsv(r.headers.get('x-truncado') === 'true'))
    } catch (e) {
      this.avisoDownload.set(`Não foi possível gerar o CSV. ${mensagemDoErro(codigoDoErro(e))}`)
    } finally {
      this.baixando.set(false)
    }
  }

  private falhar(e: unknown): void {
    if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
    this.erroTexto.set(mensagemDoErro(codigoDoErro(e)))
    this.estado.set('erro')
  }

  protected reais(v: unknown): string { return formatarReais(Number(v)) }
}
