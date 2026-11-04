import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core'
import { Router, RouterLink } from '@angular/router'
import { ESTADOS_DESTINATARIO, ROTULO_ESTADO_DESTINATARIO, ROTULO_MOTIVO_EXCLUSAO, MOTIVOS_EXCLUSAO, rotuloSegmento, type AcaoCampanha } from '@geracrm/shared'
import {
  AbasComponente, BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva,
  ConfirmacaoServico, EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, ModalComponente, ModalRodapeDiretiva, PaginacaoComponente,
  SelectComponente, StatCardComponente, TabelaComponente, ToastServico, codigoDoErro, corpoDoErro, ehStatus, formatarReais, mensagemDeErro,
  mesclarPagina,
  type Aba, type ColunaTabela, type ItemDefinicao, type ItemTrilha, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import {
  AVISO_PAUSA_DE_RISCO, ROTULO_ORIGEM_JANELA, acoesDaTela, avisoDeBloqueio, avisoDePausa, avisoJanelaAjustada, confirmacaoDaAcao,
  ehPausaDeRisco, erroDoTeste, degrausDoFunil, ehPausaAutomatica, excluidosOrdenados,
  marcoDoDestinatario, mapearErro, mensagemDeAcao, podeIniciar, resumoJanela, rotuloEstado, rotuloFalha,
  rotuloMotivoPausa, rotuloResultadoTeste, textoCustoPorVenda, textoTaxa, tomDoDestinatario, tomDoEstado, validarTelefonesTeste,
  type DestinatarioApi, type RelatorioApi,
} from './campanhas.regras.js'
import { CampanhasServico, type CampanhaDetalhe, type ResultadoTeste, type RoiLegado } from './campanhas.servico.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao' | 'nao_encontrada'
const ATUALIZA_A_CADA_MS = 15000
const OPCOES_ESTADO_DEST: OpcaoSelect[] = [
  { valor: '', rotulo: 'Todos os estados' },
  ...ESTADOS_DESTINATARIO.map((e) => ({ valor: e, rotulo: ROTULO_ESTADO_DESTINATARIO[e] })),
]

/**
 * Detalhe da campanha (F1b, padrão D): funil até a venda, custo, opt-outs, falhas, progresso, pausa e as ações
 * que a API libera (`acoes`). Campanha legada (`modeloVersao` 1) é só leitura, com o ROI de sempre.
 *
 * ⚠️ Pedido (atribuição exata) e vendas na janela (estimada) aparecem SEPARADOS — somar infla o número.
 * Falha de negócio das ações (número suspenso, sem elegíveis…) vira mensagem com a ação corretiva, nunca erro genérico.
 */
@Component({
  selector: 'app-campanha-detalhe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, AbasComponente, BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva,
    EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, ModalComponente, ModalRodapeDiretiva, PaginacaoComponente, SelectComponente,
    StatCardComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="c()?.nome ?? 'Campanha'" [subtitulo]="subtitulo()">
      <ui-breadcrumb trilha [itens]="trilha()" />
      @if (c(); as camp) {
        @for (a of acoes(); track a.acao) {
          <button type="button" class="btn" [class.btn--primario]="a.acao === 'iniciar' || a.acao === 'retomar'"
            [class.btn--secundario]="!a.perigo && a.acao !== 'iniciar' && a.acao !== 'retomar'" [class.btn--perigo]="a.perigo"
            [disabled]="ocupada()" (click)="executar(a.acao, camp)">{{ a.rotulo }}</button>
        }
      }
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="esqueleto" aria-busy="true" aria-label="Carregando campanha">
          @for (i of [1, 2, 3]; track i) { <ui-esqueleto altura="72px" /> }
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso a campanhas" descricao="Peça acesso a um administrador, gestor ou supervisor." />
      }
      @case ('nao_encontrada') {
        <ui-estado titulo="Campanha não encontrada" descricao="Ela pode ter sido excluída.">
          <a class="btn btn--secundario" routerLink="/campanhas">Voltar às campanhas</a>
        </ui-estado>
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar a campanha" [descricao]="erroCarga()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        @if (c(); as camp) {
          <div class="selos">
            <ui-badge [tom]="tomEstado(camp.estado)">{{ rotulo(camp.estado) }}</ui-badge>
            @if (legada()) { <ui-badge>Campanha antiga · somente leitura</ui-badge> }
            @if (camp.canal?.tipo === 'whatsapp_nao_oficial') { <ui-badge tom="atencao">Número não oficial · risco de banimento</ui-badge> }
          </div>

          @if (erroAcao(); as e) { <p class="aviso aviso--erro" role="alert">{{ e }}</p> }

          @if (bloqueio(); as b) {
            <p class="aviso aviso--erro" role="alert"><strong>{{ b.titulo }}.</strong> {{ b.acao }}</p>
          }
          @if (camp.estado === 'pausada' && pausaDeRisco()) {
            <p class="aviso aviso--erro" role="alert"><strong>{{ avisoRisco.titulo }}.</strong> {{ avisoRisco.acao }}</p>
          }
          @if (camp.estado === 'pausada' && !pausaDeRisco() && motivoPausa(); as m) {
            <p class="aviso aviso--atencao" role="status">
              <strong>{{ pausaAutomatica() ? 'Pausa automática.' : 'Pausada.' }}</strong> {{ m }}
              @if (camp.pausadaEm) { Desde {{ dataHora(camp.pausadaEm) }}. }
              @if (pausaAutomatica()) { Corrija a causa antes de retomar: se o problema continuar, a campanha pausa de novo. }
            </p>
          }
          @if (avisoQualidade(); as a) {
            <p class="aviso aviso--atencao" role="status"><strong>{{ a.titulo }}.</strong> {{ a.detalhe }}</p>
          }

          @if (legada()) {
            <section class="cartao">
              <h2 class="txt-secao">Resumo</h2>
              <ui-lista-definicao [colunas]="2" [itens]="itensLegado()" />
              @if (roi(); as r) {
                <div class="kpis">
                  <ui-stat-card tom="sucesso" [valor]="reais(r.exata.receitaCentavos)" [rotulo]="'receita atribuída (exata) · ' + r.exata.pedidos + ' pedidos'" />
                  <ui-stat-card tom="acao" [valor]="reais(r.estimada.receitaCentavos)" [rotulo]="'receita estimada (' + r.janelaDias + 'd) · ' + r.estimada.vendas + ' compras'" />
                  <ui-stat-card tom="neutro" [valor]="r.enviados" rotulo="mensagens enviadas" />
                </div>
                <p class="ajuda">Atribuição exata e estimada ficam separadas: a estimada é correlação (comprou na janela), não causa.</p>
              } @else if (erroRoi(); as e) {
                <p class="aviso aviso--erro" role="alert">{{ e }}</p>
              }
            </section>
          } @else {
            <ui-abas [abas]="abas()" [ativa]="aba()" (ativaChange)="trocarAba($event)" />

            @if (aba() === 'resumo') {
              <section class="cartao" aria-label="Funil">
                <h2 class="txt-secao">Funil até a venda</h2>
                @if (rel(); as r) {
                  <ol class="funil">
                    @for (d of funil(); track d.chave) {
                      <li class="degrau">
                        <span class="degrau-nome">{{ d.rotulo }}@if (d.chave === 'pedidos') { <small> (exato)</small> }</span>
                        <span class="barra" aria-hidden="true"><span class="barra-cheia" [style.width.%]="d.larguraPct"></span></span>
                        <span class="degrau-valor txt-dados">{{ d.valor }}</span>
                        <span class="degrau-taxa">@if (d.taxaDoAnterior !== null) { {{ d.taxaDoAnterior }}% do anterior }</span>
                      </li>
                    }
                  </ol>
                  <p class="ajuda">Vendas na janela de {{ r.roi.janelaDias }} dias (estimada): <strong>{{ r.funil.vendasEstimadas }}</strong>
                    · receita {{ reais(r.roi.estimada.receitaCentavos) }}. É correlação, não causa: fica separada dos pedidos.</p>

                  <div class="kpis">
                    <ui-stat-card tom="sucesso" [valor]="reais(r.roi.exata.receitaCentavos)" [rotulo]="'receita atribuída · ' + r.roi.exata.pedidos + ' pedidos'" />
                    <ui-stat-card tom="neutro" [valor]="reais(r.custo.totalCentavos)" [rotulo]="'custo de ' + r.custo.mensagensCobradas + ' cobradas'" />
                    <ui-stat-card tom="neutro" [valor]="custoVenda(r.custo.porPedidoCentavos)" rotulo="custo por pedido" />
                    <ui-stat-card tom="neutro" [valor]="custoVenda(r.custo.porVendaEstimadaCentavos)" rotulo="custo por venda estimada" />
                    <ui-stat-card [tom]="optOutAlto() ? 'erro' : 'neutro'" [valor]="r.optOuts" [rotulo]="'pediram para sair · ' + taxa(r.optOuts, r.funil.enviadas) + ' das enviadas'" />
                    <ui-stat-card [tom]="r.falhas > 0 ? 'atencao' : 'neutro'" [valor]="r.falhas" rotulo="falhas de envio" />
                  </div>
                  <p class="ajuda">Custo conta só as mensagens cobradas: as enviadas sem falha devolvida pela Meta. Falha de envio não paga.</p>
                } @else if (erroRel(); as e) {
                  <p class="aviso aviso--erro" role="alert">{{ e }}
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="carregarRelatorio()">Tentar de novo</button></p>
                } @else {
                  <ui-esqueleto altura="120px" />
                }
              </section>

              @if (rel(); as r) {
                <section class="cartao" aria-label="Progresso">
                  <h2 class="txt-secao">Progresso</h2>
                  <div class="progresso" role="progressbar" [attr.aria-valuenow]="r.progresso.percentual" aria-valuemin="0" aria-valuemax="100"
                    [attr.aria-label]="'Progresso da campanha: ' + r.progresso.percentual + '%'">
                    <span class="progresso-cheio" [style.width.%]="r.progresso.percentual"></span>
                  </div>
                  <p class="ajuda">{{ r.progresso.processados }} de {{ r.funil.elegiveis }} processados ({{ r.progresso.percentual }}%)
                    · {{ r.progresso.pendentes }} na fila · {{ r.progresso.enviando }} enviando agora.</p>
                </section>

                @if (r.falhasPorCodigo.length > 0) {
                  <section class="cartao" aria-label="Falhas">
                    <h2 class="txt-secao">Falhas por código</h2>
                    <ul class="linhas">
                      @for (f of r.falhasPorCodigo; track f.codigo) {
                        <li><span>{{ rotuloFalha(f.codigo) }}</span><span class="txt-dados">{{ f.n }}</span></li>
                      }
                    </ul>
                  </section>
                }

                @if (excluidos().length > 0) {
                  <section class="cartao" aria-label="Excluídos">
                    <h2 class="txt-secao">Ficaram de fora</h2>
                    <ul class="linhas">
                      @for (x of excluidos(); track x.motivo) {
                        <li><span>{{ rotuloExclusao(x.motivo) }}</span><span class="txt-dados">{{ x.n }}</span></li>
                      }
                    </ul>
                  </section>
                }
              }

              <section class="cartao" aria-label="Configuração">
                <h2 class="txt-secao">Configuração</h2>
                <ui-lista-definicao [colunas]="2" [itens]="itensConfig()" />
                @if (avisoJanela(); as a) { <p class="aviso aviso--atencao" role="status">{{ a }}</p> }
              </section>
            }

            @if (aba() === 'destinatarios') {
              <section class="cartao" aria-label="Destinatários">
                <div class="filtro">
                  <ui-select rotulo="Estado" [opcoes]="opcoesEstadoDest" [valor]="filtroEstado()" (valorChange)="filtrarDestinatarios($event)" />
                </div>
                @if (erroDest(); as e) {
                  <ui-estado tipo="erro" titulo="Não foi possível carregar os destinatários" [descricao]="e">
                    <button type="button" class="btn btn--secundario" (click)="carregarDestinatarios()">Tentar de novo</button>
                  </ui-estado>
                } @else {
                  <ui-tabela [colunas]="colunasDest" [linhas]="linhasDest()" [carregando]="carregandoDest()">
                    <ng-template uiCelula="contatoNome" let-d>
                      <a class="nome" [routerLink]="['/contato', d.contatoId]">{{ d.contatoNome }}</a>
                    </ng-template>
                    <ng-template uiCelula="estado" let-d>
                      <ui-badge [tom]="tomDest(d.estado)">{{ rotuloDest(d.estado) }}</ui-badge>
                    </ng-template>
                    <ng-template uiCelula="quando" let-d>{{ quando(d) }}</ng-template>
                    <ng-template uiCelula="detalhe" let-d>{{ detalheDest(d) }}</ng-template>
                    <div uiVazio>
                      <ui-estado titulo="Nenhum destinatário aqui"
                        [descricao]="c()?.estado === 'rascunho' ? 'Os destinatários são definidos quando a campanha é iniciada.' : 'Nenhum contato neste estado (dentro do seu escopo).'" />
                    </div>
                  </ui-tabela>
                  @if (!carregandoDest()) {
                    <ui-paginacao [mostrados]="destinatarios().length" [temMais]="cursorDest() !== null"
                      [carregando]="carregandoMaisDest()" (mais)="carregarMaisDestinatarios()" />
                  }
                }
              </section>
            }
          }
        }
      }
    }

    <ui-modal [aberto]="modalTeste()" titulo="Enviar teste" largura="m" (fechar)="fecharTeste()">
      <p class="ajuda">Envia a campanha agora para até 5 números, fora do lote e fora do relatório. Quem pediu para não receber é respeitado.</p>
      <div class="telefones">
        @for (t of telefones(); track $index; let i = $index) {
          <div class="tel-linha">
            <ui-campo [rotulo]="'Telefone ' + (i + 1)" tipo="tel" mascara="telefone" [valor]="t" (valorChange)="setTelefone(i, $event)" />
            @if (telefones().length > 1) {
              <button type="button" class="btn btn--secundario btn--pequeno" (click)="removerTelefone(i)" [attr.aria-label]="'Remover telefone ' + (i + 1)">Remover</button>
            }
          </div>
        }
      </div>
      @if (telefones().length < 5) {
        <button type="button" class="btn btn--secundario btn--pequeno" (click)="adicionarTelefone()">+ Adicionar telefone</button>
      }
      @if (erroTeste(); as e) { <p class="erro" role="alert">{{ e }}</p> }
      @if (resultadosTeste().length > 0) {
        <ul class="linhas" aria-label="Resultado do teste">
          @for (r of resultadosTeste(); track r.telefone) {
            <li><span class="txt-dados">{{ r.telefone }}</span><ui-badge [tom]="r.ok ? 'sucesso' : 'erro'">{{ rotuloTeste(r) }}</ui-badge></li>
          }
        </ul>
      }
      <ng-template uiModalRodape>
        <button type="button" class="btn btn--secundario" (click)="fecharTeste()">Fechar</button>
        <button type="button" class="btn btn--primario" [disabled]="enviandoTeste()" (click)="enviarTeste()">
          {{ enviandoTeste() ? 'Enviando…' : 'Enviar teste' }}
        </button>
      </ng-template>
    </ui-modal>

    <ui-modal [aberto]="modalIniciar()" titulo="Iniciar campanha" largura="m" (fechar)="fecharIniciar()">
        <p class="txt-corpo">Ao iniciar, o público é <strong>congelado</strong> com as exclusões de agora e os envios são agendados
          (lote de {{ c()?.loteDiario ?? 500 }} por dia, dentro da janela). O que já saiu não dá para desfazer; dá para pausar ou cancelar.</p>
        <ui-campo [obrigatorio]="true" [rotulo]="'Digite o nome da campanha para confirmar: ' + (c()?.nome ?? '')" [valor]="digitado()"
          (valorChange)="digitado.set($event)" [erro]="erroIniciarCampo()" autocomplete="off" />
        @if (erroIniciar(); as e) { <p class="erro" role="alert">{{ e }}</p> }
      <ng-template uiModalRodape>
          <button type="button" class="btn btn--secundario" (click)="fecharIniciar()">Voltar</button>
          <button type="button" class="btn btn--primario" [disabled]="!confereNome() || iniciando()" (click)="iniciar()">
            {{ iniciando() ? 'Iniciando…' : 'Iniciar campanha' }}
          </button>
      </ng-template>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .esqueleto { display: grid; gap: var(--espacamento-3); }
    .selos { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); }
    .cartao { min-width: 0; margin-top: var(--espacamento-4); padding: var(--espacamento-5); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); background: var(--superficie-elevada); display: grid; gap: var(--espacamento-4); }
    h2 { margin: 0; }
    .ajuda { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .aviso { margin: 0 0 var(--espacamento-3); padding: var(--espacamento-3); border-radius: var(--raio-controle); font-size: 14px; color: var(--texto); }
    .aviso--atencao { background: var(--atencao-suave); border: 1px solid var(--atencao); }
    .aviso--erro { background: var(--erro-suave); border: 1px solid var(--erro); }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: var(--espacamento-3); }
    .funil { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--espacamento-2); }
    .degrau { display: grid; grid-template-columns: 110px minmax(0, 1fr) 70px 130px; align-items: center; gap: var(--espacamento-3); font-size: 14px; }
    .degrau-nome small { color: var(--texto-suave); }
    .degrau-valor { text-align: right; }
    .degrau-taxa { color: var(--texto-secundario); font-size: 12px; }
    .barra, .progresso { display: block; height: 12px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .barra-cheia, .progresso-cheio { display: block; height: 100%; background: var(--acao); border-radius: var(--raio-completo); }
    @media (max-width: 640px) { .degrau { grid-template-columns: 90px minmax(0, 1fr) 56px; } .degrau-taxa { grid-column: 1 / -1; } }
    .linhas { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--espacamento-2); font-size: 14px; }
    .linhas li { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-3); }
    .filtro { max-width: 260px; }
    .nome { color: var(--texto); font-weight: 500; text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .telefones { display: grid; gap: var(--espacamento-2); margin: var(--espacamento-3) 0; }
    .tel-linha { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--espacamento-2); align-items: end; }
  `,
})
export class CampanhaDetalhePagina implements OnInit {
  readonly id = input.required<string>()

  private readonly api = inject(CampanhasServico)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly destruir = inject(DestroyRef)

  protected readonly opcoesEstadoDest = OPCOES_ESTADO_DEST
  protected readonly colunasDest: ColunaTabela[] = [
    { chave: 'contatoNome', rotulo: 'Contato' },
    { chave: 'estado', rotulo: 'Estado', largura: '150px' },
    { chave: 'quando', rotulo: 'Quando', largura: '150px' },
    { chave: 'detalhe', rotulo: 'Detalhe' },
  ]

  protected readonly estado = signal<Estado>('carregando')
  protected readonly erroCarga = signal('')
  protected readonly c = signal<CampanhaDetalhe | null>(null)
  protected readonly rel = signal<RelatorioApi | null>(null)
  protected readonly erroRel = signal<string | null>(null)
  protected readonly roi = signal<RoiLegado | null>(null)
  protected readonly erroRoi = signal<string | null>(null)
  protected readonly aba = signal('resumo')
  protected readonly ocupada = signal(false)
  protected readonly erroAcao = signal<string | null>(null)

  protected readonly filtroEstado = signal('')
  protected readonly destinatarios = signal<readonly DestinatarioApi[]>([])
  protected readonly cursorDest = signal<string | null>(null)
  protected readonly carregandoDest = signal(false)
  protected readonly carregandoMaisDest = signal(false)
  protected readonly erroDest = signal<string | null>(null)
  protected readonly linhasDest = computed(() => this.destinatarios() as unknown as readonly LinhaTabela[])
  private destCarregado = false

  protected readonly modalTeste = signal(false)
  protected readonly telefones = signal<readonly string[]>([''])
  protected readonly enviandoTeste = signal(false)
  protected readonly erroTeste = signal<string | null>(null)
  protected readonly resultadosTeste = signal<readonly ResultadoTeste[]>([])

  protected readonly modalIniciar = signal(false)
  protected readonly digitado = signal('')
  protected readonly iniciando = signal(false)
  protected readonly erroIniciar = signal<string | null>(null)
  protected readonly erroIniciarCampo = signal<string | null>(null)

  protected readonly legada = computed(() => (this.c()?.modeloVersao ?? 2) !== 2)
  protected readonly acoes = computed(() => { const c = this.c(); return c ? acoesDaTela(c.modeloVersao, c.acoes) : [] })
  protected readonly funil = computed(() => { const r = this.rel(); return r ? degrausDoFunil(r.funil) : [] })
  protected readonly excluidos = computed(() => { const r = this.rel(); return r ? excluidosOrdenados(r.excluidos, MOTIVOS_EXCLUSAO) : [] })
  protected readonly bloqueio = computed(() => avisoDeBloqueio(this.c()?.bloqueio))
  protected readonly pausaDeRisco = computed(() => ehPausaDeRisco(this.c()?.pausaMotivo))
  protected readonly avisoRisco = AVISO_PAUSA_DE_RISCO
  protected readonly avisoJanela = computed(() => avisoJanelaAjustada(this.c()?.janelaEfetiva.ajustada))
  protected readonly motivoPausa = computed(() => rotuloMotivoPausa(this.c()?.pausaMotivo))
  protected readonly pausaAutomatica = computed(() => ehPausaAutomatica(this.c()?.pausaMotivo))
  protected readonly avisoQualidade = computed(() => avisoDePausa(this.c()?.pausadaPorQualidade))
  protected readonly confereNome = computed(() => podeIniciar(this.c()?.nome ?? '', this.digitado()))
  protected readonly optOutAlto = computed(() => { const r = this.rel(); return !!r && r.funil.enviadas > 0 && r.optOuts * 100 > 2 * r.funil.enviadas })
  protected readonly abas = computed<Aba[]>(() => [{ id: 'resumo', rotulo: 'Resumo' }, { id: 'destinatarios', rotulo: 'Destinatários' }])
  protected readonly trilha = computed<ItemTrilha[]>(() => [{ rotulo: 'Campanhas', rota: '/campanhas' }, { rotulo: this.c()?.nome ?? 'Campanha' }])
  protected readonly subtitulo = computed(() => {
    const c = this.c()
    if (!c) return ''
    const onde = c.canal?.nome ? `Número ${c.canal.nome}` : 'Segmento ' + rotuloSegmento(c.segmentoAlvo)
    return `${onde} · criada em ${this.data(c.criadoEm)}`
  })

  protected readonly itensLegado = computed<ItemDefinicao[]>(() => {
    const c = this.c()
    if (!c) return []
    return [
      { rotulo: 'Segmento', valor: rotuloSegmento(c.segmentoAlvo) },
      { rotulo: 'Disparada em', valor: c.disparadaEm ? this.dataHora(c.disparadaEm) : null },
      { rotulo: 'Janela de retorno', valor: `${c.janelaDias} dias` },
      { rotulo: 'Estado', valor: rotuloEstado(c.estado) },
    ]
  })

  protected readonly itensConfig = computed<ItemDefinicao[]>(() => {
    const c = this.c()
    if (!c) return []
    const j = c.janelaEfetiva
    return [
      { rotulo: 'Número', valor: c.canal?.nome ?? null },
      c.template ? { rotulo: 'Template', valor: c.template.nome } : { rotulo: 'Texto', valor: c.mensagem },
      { rotulo: 'Lote diário', valor: c.loteDiario === null ? null : `${c.loteDiario} por dia` },
      { rotulo: 'Início agendado', valor: c.inicioEm ? this.dataHora(c.inicioEm) : 'Ao iniciar' },
      { rotulo: 'Janela de envio', valor: `${resumoJanela(j.horario)} (${ROTULO_ORIGEM_JANELA[j.origem] ?? j.origem})` },
      { rotulo: 'Janela de resposta', valor: `${c.janelaDias} dias` },
      { rotulo: 'Iniciada em', valor: c.iniciadaEm ? this.dataHora(c.iniciadaEm) : null },
      { rotulo: 'Concluída em', valor: c.concluidaEm ? this.dataHora(c.concluidaEm) : null },
    ]
  })

  ngOnInit(): void {
    void this.carregar()
    // Campanha em andamento muda sozinha: atualiza o funil sem piscar a tela (nunca com modal aberto).
    const t = setInterval(() => {
      const e = this.c()?.estado
      if ((e === 'enviando' || e === 'agendada') && !this.modalIniciar() && !this.modalTeste() && !this.ocupada()) void this.atualizarSilencioso()
    }, ATUALIZA_A_CADA_MS)
    this.destruir.onDestroy(() => clearInterval(t))
  }

  protected rotulo(e: string): string { return rotuloEstado(e) }
  protected tomEstado(e: string) { return tomDoEstado(e) }
  protected reais(c: number): string { return formatarReais(c) }
  protected custoVenda(c: number | null): string { return textoCustoPorVenda(c) }
  protected taxa(p: number, t: number): string { return textoTaxa(p, t) }
  protected rotuloFalha(c: string): string { return rotuloFalha(c) }
  protected rotuloExclusao(m: string): string { return (ROTULO_MOTIVO_EXCLUSAO as Record<string, string>)[m] ?? m }
  protected rotuloDest(e: string): string { return (ROTULO_ESTADO_DESTINATARIO as Record<string, string>)[e] ?? e }
  protected tomDest(e: string) { return tomDoDestinatario(e) }
  protected rotuloTeste(r: ResultadoTeste): string { return rotuloResultadoTeste(r) }
  protected dataHora(iso: string): string { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }
  protected data(iso: string): string { return new Date(iso).toLocaleDateString('pt-BR') }
  protected quando(d: DestinatarioApi): string { const m = marcoDoDestinatario(d); return m ? this.dataHora(m) : '—' }
  protected detalheDest(d: DestinatarioApi): string {
    if (d.motivoExclusao) return this.rotuloExclusao(d.motivoExclusao)
    if (d.erroCodigo) return rotuloFalha(d.erroCodigo)
    return ''
  }

  // ── carga ──
  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const d = await this.api.obter(this.id())
      this.c.set(d)
      this.estado.set('pronto')
      if (d.modeloVersao === 2) void this.carregarRelatorio()
      else void this.carregarRoi()
    } catch (e) {
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else if (ehStatus(e, 404)) this.estado.set('nao_encontrada')
      else { this.erroCarga.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  protected async carregarRelatorio(): Promise<void> {
    this.erroRel.set(null)
    try { this.rel.set(await this.api.relatorio(this.id())) }
    catch (e) { this.erroRel.set(mensagemDeErro(e, 'Não foi possível carregar o funil.')) }
  }

  private async carregarRoi(): Promise<void> {
    this.erroRoi.set(null)
    try { this.roi.set(await this.api.roiLegado(this.id())) }
    catch (e) { this.erroRoi.set(mensagemDeErro(e, 'Não foi possível carregar o ROI.')) }
  }

  private async atualizarSilencioso(): Promise<void> {
    try {
      const [d, r] = await Promise.all([this.api.obter(this.id()), this.api.relatorio(this.id())])
      this.c.set(d); this.rel.set(r)
    } catch { /* a próxima volta tenta de novo; a tela já tem dado */ }
  }

  /** Recarrega tudo depois de uma ação (estado, ações liberadas e funil). */
  private async recarregar(): Promise<void> {
    const d = await this.api.obter(this.id())
    this.c.set(d)
    if (d.modeloVersao === 2) await this.carregarRelatorio()
    if (this.aba() === 'destinatarios') await this.carregarDestinatarios()
  }

  // ── destinatários ──
  protected async carregarDestinatarios(): Promise<void> {
    this.carregandoDest.set(true); this.erroDest.set(null)
    try {
      const r = await this.api.destinatarios(this.id(), this.filtroEstado() || null, null)
      this.destinatarios.set(r.itens); this.cursorDest.set(r.proximoCursor); this.destCarregado = true
    } catch (e) { this.erroDest.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')) }
    finally { this.carregandoDest.set(false) }
  }

  protected async carregarMaisDestinatarios(): Promise<void> {
    const cursor = this.cursorDest()
    if (!cursor || this.carregandoMaisDest()) return
    this.carregandoMaisDest.set(true)
    try {
      const r = await this.api.destinatarios(this.id(), this.filtroEstado() || null, cursor)
      this.destinatarios.update((a) => mesclarPagina(a, r.itens, (d) => d.id))
      this.cursorDest.set(r.proximoCursor)
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais destinatários.')) }
    finally { this.carregandoMaisDest.set(false) }
  }

  protected trocarAba(id: string): void {
    this.aba.set(id)
    // Destinatários só são buscados quando a aba abre (a primeira página; o resto por cursor).
    if (id === 'destinatarios' && !this.destCarregado) void this.carregarDestinatarios()
  }

  protected filtrarDestinatarios(estado: string): void {
    // Filtro novo volta ao início do cursor.
    this.filtroEstado.set(estado)
    void this.carregarDestinatarios()
  }

  // ── ações ──
  protected async executar(acao: AcaoCampanha, camp: CampanhaDetalhe): Promise<void> {
    this.erroAcao.set(null)
    switch (acao) {
      case 'iniciar': this.digitado.set(''); this.erroIniciar.set(null); this.erroIniciarCampo.set(null); this.modalIniciar.set(true); return
      case 'testar': this.erroTeste.set(null); this.resultadosTeste.set([]); this.modalTeste.set(true); return
      case 'editar': void this.router.navigate(['/campanhas', camp.id, 'editar']); return
      case 'pausar': case 'retomar': case 'cancelar': case 'excluir': await this.confirmarEExecutar(acao, camp); return
    }
  }

  private async confirmarEExecutar(acao: 'pausar' | 'retomar' | 'cancelar' | 'excluir', camp: CampanhaDetalhe): Promise<void> {
    const t = confirmacaoDaAcao(acao, camp.nome)
    const ok = await this.confirmacao.confirmar({ titulo: t.titulo, mensagem: t.mensagem, acao: t.acao, perigo: acao === 'cancelar' || acao === 'excluir' })
    if (!ok) return
    this.ocupada.set(true)
    try {
      if (acao === 'pausar') await this.api.pausar(camp.id)
      else if (acao === 'retomar') await this.api.retomar(camp.id)
      else if (acao === 'cancelar') await this.api.cancelar(camp.id)
      else { await this.api.excluir(camp.id); this.toast.sucesso('Rascunho excluído.'); await this.router.navigate(['/campanhas']); return }
      this.toast.sucesso({ pausar: 'Campanha pausada.', retomar: 'Campanha retomada.', cancelar: 'Campanha cancelada.' }[acao])
      await this.recarregar()
    } catch (e) {
      this.erroAcao.set(mensagemDeAcao(codigoDoErro(e), corpoDoErro(e)?.mensagem, mensagemDeErro(e, 'Não foi possível concluir a ação.')))
      await this.recarregar().catch(() => undefined)
    } finally { this.ocupada.set(false) }
  }

  // ── teste ──
  protected setTelefone(i: number, v: string): void { this.telefones.update((a) => a.map((x, k) => (k === i ? v : x))) }
  protected adicionarTelefone(): void { if (this.telefones().length < 5) this.telefones.update((a) => [...a, '']) }
  protected removerTelefone(i: number): void { this.telefones.update((a) => a.filter((_, k) => k !== i)) }
  protected fecharTeste(): void { if (!this.enviandoTeste()) this.modalTeste.set(false) }

  protected async enviarTeste(): Promise<void> {
    if (this.enviandoTeste()) return
    const v = validarTelefonesTeste(this.telefones())
    if (v.erro) { this.erroTeste.set(v.erro); return }
    this.enviandoTeste.set(true); this.erroTeste.set(null); this.resultadosTeste.set([])
    try {
      const r = await this.api.testar(this.id(), v.telefones)
      this.resultadosTeste.set(r.resultados)
      const falhas = r.resultados.filter((x) => !x.ok).length
      if (falhas === 0) this.toast.sucesso('Teste enviado.')
    } catch (e) {
      this.erroTeste.set(erroDoTeste(codigoDoErro(e), corpoDoErro(e), mensagemDeErro(e, 'Não foi possível enviar o teste.')).mensagem)
    } finally { this.enviandoTeste.set(false) }
  }

  // ── iniciar ──
  protected fecharIniciar(): void { if (!this.iniciando()) this.modalIniciar.set(false) }

  protected async iniciar(): Promise<void> {
    const camp = this.c()
    if (!camp || this.iniciando() || !this.confereNome()) return
    this.iniciando.set(true); this.erroIniciar.set(null); this.erroIniciarCampo.set(null)
    try {
      const r = await this.api.iniciar(camp.id, this.digitado().trim())
      this.modalIniciar.set(false)
      this.toast.sucesso(`Campanha iniciada: ${r.destinatarios} destinatário${r.destinatarios === 1 ? '' : 's'}, ${r.excluidos} excluído${r.excluidos === 1 ? '' : 's'}.`)
      await this.recarregar()
    } catch (e) {
      const corpo = corpoDoErro(e)
      const m = mapearErro(corpo, mensagemDeErro(e, 'Não foi possível iniciar a campanha.'))
      if (m.campos['confirmacaoNome']) this.erroIniciarCampo.set(m.campos['confirmacaoNome'])
      else this.erroIniciar.set(mensagemDeAcao(codigoDoErro(e), corpo?.mensagem, m.geral ?? Object.values(m.campos)[0] ?? 'Não foi possível iniciar a campanha.'))
    } finally { this.iniciando.set(false) }
  }
}
