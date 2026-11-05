import { Component, ChangeDetectionStrategy, computed, inject, OnInit, signal } from '@angular/core'
import {
  BotaoCsvComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente,
  FiltrosComponente, FiltroPeriodoComponente, ListaDefinicaoComponente, ModalComponente, PaginacaoComponente,
  SelectComponente, TabelaComponente, mensagemDeErro, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { AuditoriaServico, type EntradaAuditoria } from './auditoria.servico.js'
import {
  ACOES_AUDITORIA, COLUNAS_CSV, FILTRO_VAZIO, definicoesDoEvento, filtrosAtivos, jsonDoEvento,
  linhasDoRastroCsv, montarQueryAuditoria, quemDoEvento, detalheDoEvento, formatarQuando, rotuloAcao,
  type FiltroAuditoria,
} from './auditoria.regras.js'

type EstadoDetalhe = 'ocioso' | 'carregando' | 'pronto' | 'erro'

/**
 * Gestão → Auditoria (EP-07 / PLT-05), padrão Lista (L).
 *
 * ⚠️ Os cinco estados são ramos explícitos (@switch). Um rastro vazio ("nada aconteceu
 * ainda") e uma falha de carga pedem telas opostas — derivar do tamanho da lista
 * mostraria "nenhuma ação" quando a API caiu.
 *
 * Lê sob RLS: cada tenant só vê o próprio rastro. Paginação por cursor
 * ("carregar mais") — nunca a lista inteira. Filtros vão para o servidor; a tela
 * não filtra linha em memória.
 */
@Component({
  selector: 'app-auditoria',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BotaoCsvComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente,
    FiltrosComponente, FiltroPeriodoComponente, ListaDefinicaoComponente, ModalComponente, PaginacaoComponente,
    SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Auditoria" subtitulo="Quem fez o quê e quando. O rastro não é editável — é registro.">
      <ui-botao-csv [colunas]="colunasCsv" [linhas]="linhasCsv()" arquivo="auditoria">Exportar CSV</ui-botao-csv>
    </ui-cabecalho-tela>

    <ui-filtros placeholder="Buscar em ações e detalhes" rotuloBusca="Busca"
                (buscar)="setBusca($event)" (aplicar)="aplicar()" (limpar)="limpar()">
      <ui-select rotulo="Ação" placeholder="Todas as ações" [opcoes]="opcoesAcao"
                 [valor]="acao()" (valorChange)="setAcao($event)" />
      <ui-select rotulo="Usuário" placeholder="Todos os usuários" [opcoes]="servico.usuarios()"
                 [valor]="atorId()" (valorChange)="setAtor($event)"
                 [dica]="servico.usuariosFalharam() ? 'Não foi possível carregar os usuários. O filtro segue disponível pela ação e pelo período.' : ''" />
      <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="aplicar()" />
    </ui-filtros>

    @switch (servico.estado()) {
      @case ('carregando') {
        <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à auditoria"
                   descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar a auditoria" [descricao]="servico.erro() ?? ''">
          <button type="button" class="btn btn--secundario" (click)="recarregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (servico.janelaPadraoDias(); as dias) {
          <p class="aviso-janela" role="status">Buscando nos últimos {{ dias }} dias. Escolha um período para buscar em outras datas.</p>
        }
        <ui-tabela [colunas]="colunas" [linhas]="linhas()">
          <ng-template uiCelula="ver" let-linha>
            <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirDetalhe(linha.id)">Ver</button>
          </ng-template>
          <div uiVazio>
            @if (temFiltro()) {
              <ui-estado titulo="Nenhuma ação com esses filtros"
                         descricao="Amplie o período ou tire um dos filtros.">
                <button type="button" class="btn btn--secundario" (click)="limpar()">Limpar filtros</button>
              </ui-estado>
            } @else {
              <ui-estado titulo="Nenhuma ação registrada ainda"
                         descricao="Assim que alguém assumir, editar ou apagar algo, aparece aqui." />
            }
          </div>
        </ui-tabela>
        <ui-paginacao [mostrados]="servico.itens().length" [temMais]="!!servico.proximoCursor()"
                      [carregando]="servico.carregandoMais()" (mais)="servico.carregarMais()" />
      }
    }

    <ui-modal [aberto]="detalheAberto()" titulo="Evento de auditoria" largura="m" (fechar)="fecharDetalhe()">
      @switch (detalheEstado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true"><ui-esqueleto altura="16px" /><ui-esqueleto altura="16px" /><ui-esqueleto altura="120px" /></div>
        }
        @case ('erro') {
          <p class="erro" role="alert">{{ detalheErro() }}</p>
        }
        @case ('pronto') {
          @if (detalhe()) {
            <ui-lista-definicao [itens]="definicoes()" [colunas]="2" />
            <h3 class="txt-rotulo secao">Dados do evento</h3>
            <pre class="json txt-dados">{{ json() }}</pre>
          }
        }
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharDetalhe()">Fechar</button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; }
    .esqueletos { display: grid; gap: var(--espacamento-3); }
    .erro { margin: 0; color: var(--erro); }
    .aviso-janela { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .secao { margin: var(--espacamento-5) 0 var(--espacamento-2); }
    .json { margin: 0; padding: var(--espacamento-3); max-height: 320px; overflow: auto;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      color: var(--texto); white-space: pre; }
  `,
})
export class AuditoriaPagina implements OnInit {
  protected readonly servico = inject(AuditoriaServico)

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'quando', rotulo: 'Quando', mono: true, largura: '150px' },
    { chave: 'quem', rotulo: 'Quem', largura: '160px' },
    { chave: 'acao', rotulo: 'Ação', largura: '200px' },
    { chave: 'entidade', rotulo: 'Entidade', largura: '120px' },
    { chave: 'detalhe', rotulo: 'Detalhe' },
    { chave: 'ver', rotulo: 'Evento', alinhamento: 'dir', largura: '90px' },
  ]
  protected readonly colunasCsv = COLUNAS_CSV
  protected readonly opcoesAcao: OpcaoSelect[] = [...ACOES_AUDITORIA]

  // Filtros: a tela guarda o que foi escolhido; só `aplicar` manda para o servidor.
  protected readonly busca = signal('')
  protected readonly acao = signal('')
  protected readonly atorId = signal('')
  protected readonly inicio = signal('')
  protected readonly fim = signal('')
  private ultimaQuery: string | null = null

  protected readonly temFiltro = computed(() => filtrosAtivos(this.filtroAtual()))
  protected readonly linhas = computed<LinhaTabela[]>(() =>
    this.servico.itens().map((e) => ({
      id: e.id,
      quando: formatarQuando(e.criadoEm),
      quem: quemDoEvento(e),
      acao: rotuloAcao(e.acao),
      entidade: e.entidade,
      detalhe: detalheDoEvento(e.acao, e.dados),
    })),
  )
  protected readonly linhasCsv = computed(() => linhasDoRastroCsv(this.servico.itens()))

  // Modal de detalhe.
  protected readonly detalheAberto = signal(false)
  protected readonly detalheEstado = signal<EstadoDetalhe>('ocioso')
  protected readonly detalhe = signal<EntradaAuditoria | null>(null)
  protected readonly detalheErro = signal('')
  protected readonly definicoes = computed(() => {
    const d = this.detalhe()
    return d ? definicoesDoEvento(d) : []
  })
  protected readonly json = computed(() => jsonDoEvento(this.detalhe()?.dados))

  ngOnInit(): void {
    void this.servico.carregarUsuarios()
    this.recarregar()
  }

  protected setBusca(texto: string): void {
    this.busca.set(texto)
    this.aplicar()
  }

  protected setAcao(valor: string): void {
    this.acao.set(valor)
    this.aplicar()
  }

  protected setAtor(valor: string): void {
    this.atorId.set(valor)
    this.aplicar()
  }

  /** Dispara a consulta só se algo mudou: busca + Enter emite dois eventos para o mesmo filtro. */
  protected aplicar(): void {
    const query = montarQueryAuditoria(this.filtroAtual())
    if (query === this.ultimaQuery) return
    this.recarregar()
  }

  protected limpar(): void {
    this.busca.set('')
    this.acao.set('')
    this.atorId.set('')
    this.inicio.set('')
    this.fim.set('')
    this.aplicar()
  }

  protected recarregar(): void {
    const f = this.filtroAtual()
    this.ultimaQuery = montarQueryAuditoria(f)
    void this.servico.carregar(f)
  }

  protected abrirDetalhe(id: string): void {
    const e = this.servico.itens().find((x) => x.id === id)
    if (!e) return
    this.detalheAberto.set(true)
    this.detalhe.set(null)
    this.detalheErro.set('')
    this.detalheEstado.set('carregando')
    void this.servico.buscarDetalhe(e.criadoEm, e.id)
      .then((d) => {
        this.detalhe.set(d)
        this.detalheEstado.set('pronto')
      })
      .catch((err: unknown) => {
        this.detalheErro.set(mensagemDeErro(err, 'Não foi possível carregar este evento. Tente de novo.'))
        this.detalheEstado.set('erro')
      })
  }

  protected fecharDetalhe(): void {
    this.detalheAberto.set(false)
  }

  private filtroAtual(): FiltroAuditoria {
    return {
      ...FILTRO_VAZIO,
      busca: this.busca(),
      acao: this.acao(),
      atorId: this.atorId(),
      inicio: this.inicio(),
      fim: this.fim(),
    }
  }
}
