import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal, computed } from '@angular/core'
import { DatePipe } from '@angular/common'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { FormsModule } from '@angular/forms'
import { rotuloSegmento, type AcaoEmMassaContato } from '@geracrm/shared'
import {
  AcoesLoteComponente, BadgeComponente, BotaoCsvComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva,
  EstadoComponente, FiltrosComponente, IconeComponente, ModalComponente, PaginacaoComponente, SelectComponente,
  TabelaComponente, ToastServico, formatarReais,
  type ColunaCsv, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { ClientesServico, type ClienteRfv, type ResultadoAcaoEmMassa } from './clientes.servico.js'
import { ClientesAcaoModalComponente } from './clientes-acao-modal.componente.js'
import { tokenDaCor } from './etiquetas.regras.js'
import {
  FILTROS_CONTATOS_VAZIOS, OPCAO_SEM_DONO, OPCOES_QUALIFICACAO, OPCOES_SEGMENTO, acoesVisiveis, filtrosDaQuery, idsDoLote,
  periodoInvalido, queryDosFiltros, rotuloQualificacao, temFiltroAtivo, textoResultadoAcao, tomQualificacao,
  type FiltrosContatos, type QueryContatos,
} from './clientes.regras.js'

/**
 * Contatos — a base de clientes no padrão Lista (A2): filtros que vivem na URL, tabela
 * selecionável, faixa de ações em massa e paginação por cursor. A cor do segmento (rampa
 * RFV) sempre vem com rótulo. Regra de RFV e de filtros: `@geracrm/shared` e `clientes.regras`.
 */
@Component({
  selector: 'app-clientes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe, RouterLink, FormsModule, AcoesLoteComponente, BadgeComponente, BotaoCsvComponente, CabecalhoTelaComponente,
    CampoComponente, CelulaDiretiva, EstadoComponente, FiltrosComponente, IconeComponente, ModalComponente,
    PaginacaoComponente, SelectComponente, TabelaComponente, ClientesAcaoModalComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Contatos"
      subtitulo="Todos os contatos, dos que mais compraram aos que ainda não compraram. A cor mostra onde cada um está no ciclo de recompra.">
      <button class="btn btn--secundario" type="button" (click)="abrirImport()">Importar CSV</button>
      <a class="btn btn--primario" routerLink="/contato/novo">+ Novo contato</a>
    </ui-cabecalho-tela>

    <ui-filtros placeholder="Nome, telefone, e-mail ou CNPJ/CPF" rotuloBusca="Busca"
      (buscar)="aoBuscar($event)" (aplicar)="aplicar()" (limpar)="limpar()">
      <ui-select rotulo="Qualificação" placeholder="Todas" [opcoes]="opcoesQualificacao" [(valor)]="qualificacao" />
      <ui-select rotulo="Segmento" placeholder="Todos" [opcoes]="opcoesSegmento" [(valor)]="segmento" />
      @if (servico.gestao()) {
        <ui-select rotulo="Vendedor" placeholder="Todos" [opcoes]="opcoesVendedor()" [(valor)]="vendedorId" />
        @if (servico.filiais().length > 0) {
          <ui-select rotulo="Filial" placeholder="Todas" [opcoes]="servico.filiais()" [(valor)]="filialId" />
        }
      }
      <ui-select rotulo="Origem" placeholder="Todas" [opcoes]="servico.origens()" [(valor)]="origemId" />
      <ui-select rotulo="Etiqueta" placeholder="Todas" [opcoes]="opcoesEtiqueta()" [(valor)]="etiquetaId" />
      <ui-select rotulo="Próximo passo" placeholder="Todos" [opcoes]="opcoesProximoPasso" [(valor)]="proximoPasso" />
      <ui-campo rotulo="Criado de" tipo="date" [(valor)]="criadoDe" [erro]="periodoErrado() ? 'A data inicial é depois da final.' : null" />
      <ui-campo rotulo="Criado até" tipo="date" [(valor)]="criadoAte" />
    </ui-filtros>

    @if (aplicados().q) {
      <p class="chip-filtro">Busca: <strong>{{ aplicados().q }}</strong> · <a href="javascript:void(0)" (click)="limparBusca()">limpar</a></p>
    }

    <div class="legenda" aria-label="Legenda dos segmentos">
      @for (s of legenda; track s.codigo) {
        <span class="chip"><i class="ponto" [style.background]="cor(s.codigo)"></i>{{ s.rotulo }}</span>
      }
    </div>

    <ui-acoes-lote [quantidade]="selecionados().size" (limpar)="selecionados.set(vazio)">
      @for (a of acoes(); track a.acao) {
        <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirAcao(a.acao)">{{ a.rotulo }}</button>
      }
    </ui-acoes-lote>

    @switch (servico.estado()) {
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à base de clientes"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os contatos" [descricao]="servico.erro() ?? ''">
          <button type="button" class="btn btn--primario" (click)="servico.carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        <ui-tabela [colunas]="colunas" [linhas]="linhas()" [selecionavel]="true" [(selecionados)]="selecionados"
          [rotuloLinha]="rotuloLinha" [carregando]="servico.estado() === 'carregando'">
          <ng-template uiCelula="segmento" let-c>
            <span class="segmento" [title]="c.segmento.acao">
              <i class="ponto" [style.background]="cor(c.segmento.codigo)"></i>{{ c.segmento.rotulo }}
            </span>
          </ng-template>
          <ng-template uiCelula="nome" let-c>
            <span class="pessoa">
              <a class="nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>
              <span class="suave">{{ c.email || c.telefone || '—' }}</span>
              @if (c.semProximoPasso) { <ui-badge tom="atencao">Sem próximo passo</ui-badge> }
            </span>
          </ng-template>
          <ng-template uiCelula="qualificacao" let-c>
            <ui-badge [tom]="tom(c.qualificacao)">{{ rotuloQ(c.qualificacao) }}</ui-badge>
          </ng-template>
          <ng-template uiCelula="origem" let-c>{{ c.origem ?? '—' }}</ng-template>
          <ng-template uiCelula="vendedor" let-c>{{ c.vendedor ?? 'Sem dono' }}</ng-template>
          <ng-template uiCelula="etiquetas" let-c>
            <span class="etiquetas">
              @for (e of c.etiquetas; track e.id) {
                <span class="etiqueta"><i class="ponto" [style.background]="corEtiqueta(e.cor)"></i>{{ e.nome }}</span>
              }
              @if (c.etiquetasTotal > c.etiquetas.length) { <span class="suave">+{{ c.etiquetasTotal - c.etiquetas.length }}</span> }
            </span>
          </ng-template>
          <ng-template uiCelula="ultimaCompraEm" let-c>{{ c.ultimaCompraEm ? (c.ultimaCompraEm | date: 'dd/MM/yyyy') : '—' }}</ng-template>
          <ng-template uiCelula="total" let-c>{{ reais(c.totalCentavos) }}</ng-template>
          <ng-template uiCelula="criadoEm" let-c>{{ c.criadoEm | date: 'dd/MM/yyyy' }}</ng-template>
          <ng-template uiCelula="acoes" let-c>
            <span class="acoes">
              <button type="button" class="btn btn--secundario btn--pequeno" title="Conversar no WhatsApp"
                [attr.aria-label]="'Conversar com ' + c.nome + ' no WhatsApp'" (click)="conversar(c.id)">
                <ui-icone nome="message-circle" [tamanho]="14" />
              </button>
              <a class="btn btn--fantasma btn--pequeno" [routerLink]="['/contato', c.id]">Ver</a>
            </span>
          </ng-template>
          <div uiVazio>
            @if (temFiltro()) {
              <ui-estado titulo="Nenhum contato com esses filtros" descricao="Ajuste a busca ou limpe os filtros.">
                <button type="button" class="btn btn--secundario" (click)="limpar()">Limpar filtros</button>
              </ui-estado>
            } @else {
              <ui-estado titulo="Nenhum contato ainda"
                descricao="Importe um CSV, conecte seu ERP ou comece uma conversa: os contatos aparecem nesta lista.">
                <button type="button" class="btn btn--primario" (click)="abrirImport()">Importar CSV</button>
              </ui-estado>
            }
          </div>
        </ui-tabela>

        @if (servico.estado() === 'pronto') {
          <div class="rodape">
            <ui-paginacao [mostrados]="servico.clientes().length" [temMais]="servico.temMais()"
              [carregando]="servico.buscandoMais()" (mais)="servico.carregarMais()" />
            <ui-botao-csv [colunas]="colunasCsv" [linhas]="linhasCsv()" arquivo="contatos">Exportar CSV (carregados)</ui-botao-csv>
          </div>
          @if (servico.erro() && !servico.buscandoMais()) {
            <!-- Estado PARCIAL: o que carregou continua utilizável; o aviso é local. -->
            <p class="parcial" role="alert">Não foi possível carregar mais agora. {{ servico.erro() }}</p>
          }
        }
      }
    }

    <app-clientes-acao-modal [acao]="acaoAberta()" [contatoIds]="idsAcao()"
      (fechar)="acaoAberta.set(null)" (concluida)="aoConcluir($event)" />

    <ui-modal [aberto]="importAberto()" titulo="Importar contatos por CSV" largura="m" (fechar)="importAberto.set(false)">
      <p class="import-ajuda">
        Cole ou envie um CSV com colunas <b>nome</b>, <b>telefone</b> e <b>cnpj/cpf</b>
        (só nome é obrigatório). Separador vírgula ou ponto-e-vírgula.
      </p>
      <input class="import-arquivo" type="file" accept=".csv,text/csv" (change)="arquivoCsv($event)" [disabled]="servico.importando()" />
      <textarea class="import-texto" placeholder="nome,telefone,cnpj&#10;Zé,81998617049,11222333000181"
                [ngModel]="csvTexto()" (ngModelChange)="csvTexto.set($event)" rows="6"
                [disabled]="servico.importando()"></textarea>
      @if (servico.erroImport(); as e) { <p class="erro-form" role="alert">{{ e }}</p> }
      @if (servico.resultadoImport(); as r) {
        <div class="import-resultado" role="status">
          <strong>{{ r.criados }} criados</strong> · {{ r.atualizados }} atualizados ·
          <span [class.ruim]="r.rejeitados > 0">{{ r.rejeitados }} rejeitados</span> (de {{ r.total }})
          @if (r.rejeicoes.length) {
            <ul class="rejeicoes">
              @for (rj of r.rejeicoes; track rj.linha) { <li>Linha {{ rj.linha }}: {{ rotuloRejeicao(rj.motivo) }}</li> }
            </ul>
          }
        </div>
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="importAberto.set(false)">Fechar</button>
        <button type="button" class="btn btn--primario" (click)="importar()" [disabled]="servico.importando() || !csvTexto().trim()">
          {{ servico.importando() ? 'Importando…' : 'Importar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-filtros, ui-acoes-lote, ui-tabela { display: block; }
    ui-filtros { margin-bottom: var(--espacamento-3); }
    ui-acoes-lote { margin-bottom: var(--espacamento-3); }
    .chip-filtro { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .chip-filtro a { color: var(--acao); }
    .legenda { display: flex; flex-wrap: wrap; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .ponto { width: 9px; height: 9px; border-radius: var(--raio-completo); display: inline-block; flex: none; }
    .segmento { display: inline-flex; align-items: center; gap: var(--espacamento-2); font-size: 12px; font-weight: 500; white-space: nowrap; }
    .pessoa { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; padding: var(--espacamento-1) 0; }
    .nome { color: var(--texto); text-decoration: none; font-weight: 500; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    .suave { color: var(--texto-suave); font-size: 12px; }
    .etiquetas { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-1); }
    .etiqueta { display: inline-flex; align-items: center; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); white-space: nowrap; }
    .acoes { display: inline-flex; gap: var(--espacamento-1); }
    .rodape { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .rodape ui-paginacao { flex: 1 1 auto; }
    .parcial { text-align: center; color: var(--atencao); font-size: 13px; }
    .import-ajuda { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .import-arquivo { display: block; margin-bottom: var(--espacamento-3); }
    .import-texto { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font-family: var(--tipografia-familia-dados); font-size: 12px; resize: vertical; }
    .import-resultado { margin-top: var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .import-resultado strong { color: var(--texto); }
    .import-resultado .ruim, .erro-form { color: var(--erro); }
    .erro-form { margin: var(--espacamento-2) 0 0; font-size: 13px; }
    .rejeicoes { margin: var(--espacamento-2) 0 0; padding-left: var(--espacamento-4); color: var(--texto-suave); font-size: 12px; }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class ClientesPagina {
  protected readonly servico = inject(ClientesServico)
  private readonly inbox = inject(InboxServico)
  private readonly router = inject(Router)
  private readonly route = inject(ActivatedRoute)
  private readonly toast = inject(ToastServico)

  protected readonly vazio: ReadonlySet<string> = new Set()
  protected readonly opcoesQualificacao = OPCOES_QUALIFICACAO
  protected readonly opcoesSegmento = OPCOES_SEGMENTO
  protected readonly opcoesProximoPasso: OpcaoSelect[] = [{ valor: 'true', rotulo: 'Sem próximo passo' }]
  protected readonly legenda = OPCOES_SEGMENTO.map((o) => ({ codigo: o.valor, rotulo: o.rotulo }))

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'segmento', rotulo: 'Segmento' },
    { chave: 'nome', rotulo: 'Contato' },
    { chave: 'qualificacao', rotulo: 'Qualificação' },
    { chave: 'origem', rotulo: 'Origem' },
    { chave: 'vendedor', rotulo: 'Vendedor' },
    { chave: 'etiquetas', rotulo: 'Etiquetas' },
    { chave: 'ultimaCompraEm', rotulo: 'Última compra', mono: true },
    { chave: 'total', rotulo: 'Total', alinhamento: 'dir', mono: true },
    { chave: 'criadoEm', rotulo: 'Criado em', mono: true },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir' },
  ]
  protected readonly colunasCsv: readonly ColunaCsv[] = [
    { chave: 'nome', rotulo: 'Nome' }, { chave: 'email', rotulo: 'E-mail' }, { chave: 'telefone', rotulo: 'Telefone' },
    { chave: 'qualificacao', rotulo: 'Qualificação' }, { chave: 'segmento', rotulo: 'Segmento' },
    { chave: 'origem', rotulo: 'Origem' }, { chave: 'vendedor', rotulo: 'Vendedor' },
    { chave: 'etiquetas', rotulo: 'Etiquetas' }, { chave: 'ultimaCompraEm', rotulo: 'Última compra' },
    { chave: 'total', rotulo: 'Total (R$)' }, { chave: 'criadoEm', rotulo: 'Criado em' },
  ]
  protected readonly rotuloLinha = (l: LinhaTabela): string => String(l['nome'] ?? 'contato')

  // Filtros em edição (a URL é a fonte; `aplicados` é o que a lista está mostrando).
  protected readonly q = signal('')
  protected readonly qualificacao = signal('')
  protected readonly segmento = signal('')
  protected readonly vendedorId = signal('')
  protected readonly filialId = signal('')
  protected readonly origemId = signal('')
  protected readonly etiquetaId = signal('')
  protected readonly proximoPasso = signal('')
  protected readonly criadoDe = signal('')
  protected readonly criadoAte = signal('')
  protected readonly aplicados = signal<FiltrosContatos>(FILTROS_CONTATOS_VAZIOS)

  protected readonly selecionados = signal<ReadonlySet<string>>(new Set())
  protected readonly acaoAberta = signal<AcaoEmMassaContato | null>(null)
  protected readonly idsAcao = signal<readonly string[]>([])

  protected readonly linhas = computed(() => this.servico.clientes() as unknown as LinhaTabela[])
  protected readonly acoes = computed(() => acoesVisiveis(this.servico.gestao()))
  protected readonly temFiltro = computed(() => temFiltroAtivo(this.aplicados()))
  protected readonly opcoesVendedor = computed<OpcaoSelect[]>(() => [OPCAO_SEM_DONO, ...this.servico.equipe()])
  protected readonly opcoesEtiqueta = computed<OpcaoSelect[]>(() =>
    this.servico.etiquetas().map((e) => ({ valor: e.valor, rotulo: e.rotulo })))
  protected readonly periodoErrado = computed(() => periodoInvalido(this.formulario()))
  protected readonly linhasCsv = computed(() => this.servico.clientes().map((c) => ({
    nome: c.nome, email: c.email ?? '', telefone: c.telefone ?? '', qualificacao: rotuloQualificacao(c.qualificacao ?? 'novo'),
    segmento: rotuloSegmento(c.segmento.codigo), origem: c.origem ?? '', vendedor: c.vendedor ?? '',
    etiquetas: (c.etiquetas ?? []).map((e) => e.nome).join(', '), ultimaCompraEm: c.ultimaCompraEm?.slice(0, 10) ?? '',
    total: c.totalCentavos / 100, criadoEm: c.criadoEm?.slice(0, 10) ?? '',
  })))

  constructor() {
    void this.servico.carregarCatalogos()
    // A URL manda: cada mudança de query (Filtrar, link compartilhado, voltar do navegador) recarrega do início.
    this.route.queryParams.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((query) => {
      const f = filtrosDaQuery(query as QueryContatos)
      this.aplicados.set(f)
      this.q.set(f.q); this.qualificacao.set(f.qualificacao); this.segmento.set(f.segmento)
      this.vendedorId.set(f.vendedorId); this.filialId.set(f.filialId); this.origemId.set(f.origemId)
      this.etiquetaId.set(f.etiquetaIds[0] ?? ''); this.proximoPasso.set(f.semProximoPasso ? 'true' : '')
      this.criadoDe.set(f.criadoDe); this.criadoAte.set(f.criadoAte)
      this.selecionados.set(this.vazio)
      void this.servico.carregar(f)
    })
  }

  private formulario(): FiltrosContatos {
    return {
      q: this.q().trim(), qualificacao: this.qualificacao(), segmento: this.segmento(), vendedorId: this.vendedorId(),
      filialId: this.filialId(), origemId: this.origemId(), etiquetaIds: this.etiquetaId() ? [this.etiquetaId()] : [],
      semProximoPasso: this.proximoPasso() === 'true', criadoDe: this.criadoDe(), criadoAte: this.criadoAte(),
    }
  }

  /** Busca (debounce do `ui-filtros`): aplica na hora junto com o que já está escolhido. */
  protected aoBuscar(texto: string): void { this.q.set(texto); this.aplicar() }

  protected aplicar(): void {
    const f = this.formulario()
    if (periodoInvalido(f)) return
    const query = queryDosFiltros(f)
    if (JSON.stringify(query) === JSON.stringify(queryDosFiltros(this.aplicados()))) {
      if (this.servico.estado() !== 'carregando') void this.servico.carregar(f)
      return
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams: query })
  }

  protected limpar(): void {
    this.q.set('')
    void this.router.navigate([], { relativeTo: this.route, queryParams: {} })
  }

  protected limparBusca(): void {
    this.q.set('')
    this.aplicar()
  }

  // ── ações em massa ──
  protected abrirAcao(acao: AcaoEmMassaContato): void {
    const { ids, excedeu } = idsDoLote(this.selecionados())
    if (excedeu) this.toast.mostrar('Só os primeiros 500 contatos selecionados entram nesta ação.', 'neutro')
    this.idsAcao.set(ids)
    this.acaoAberta.set(acao)
  }

  protected aoConcluir(r: ResultadoAcaoEmMassa): void {
    this.acaoAberta.set(null)
    this.selecionados.set(this.vazio)
    this.toast.sucesso(textoResultadoAcao(r))
    void this.servico.carregar()
  }

  // ── importação CSV ──
  protected readonly importAberto = signal(false)
  protected readonly csvTexto = signal('')
  protected abrirImport(): void { this.importAberto.set(true) }
  protected async arquivoCsv(ev: Event): Promise<void> {
    const arq = (ev.target as HTMLInputElement).files?.[0]
    if (arq) this.csvTexto.set(await arq.text())
  }
  protected async importar(): Promise<void> {
    const csv = this.csvTexto().trim()
    if (csv) await this.servico.importarCsv(csv)
  }
  protected rotuloRejeicao(m: string): string {
    switch (m) {
      case 'nome_vazio': return 'nome em branco'
      case 'telefone_invalido': return 'telefone inválido'
      case 'documento_invalido': return 'CNPJ/CPF inválido'
      case 'sem_coluna_nome': return 'faltou a coluna "nome"'
      case 'csv_sem_dados': return 'sem linhas de dados'
      default: return m
    }
  }

  /** "Puxa o contato para o chat": inicia/abre a conversa e a abre no rail lateral. */
  protected async conversar(contatoId: string): Promise<void> {
    const conversaId = await this.servico.iniciarConversa(contatoId)
    if (conversaId) void this.inbox.abrir(conversaId)
  }

  // ── apresentação ──
  /** A cor vem da rampa RFV dos design tokens — nunca literal. */
  protected cor(codigo: string): string { return `var(--rfv-${codigo})` }
  protected corEtiqueta(cor: string): string { return tokenDaCor(cor) }
  protected reais(centavos: number): string { return formatarReais(centavos) }
  protected rotuloQ(q: string): string { return rotuloQualificacao(q) }
  protected tom(q: string): 'neutro' | 'sucesso' | 'erro' { return tomQualificacao(q) }
}

export type { ClienteRfv }
