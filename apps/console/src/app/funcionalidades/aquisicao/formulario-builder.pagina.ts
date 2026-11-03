import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core'
import { FormControl, ReactiveFormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import {
  AbasComponente, BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, EstadoComponente,
  EsqueletoComponente, GradeFormComponente, IconeComponente, ModalComponente, SelectComponente,
  SelectPaginadoComponente, ToastServico, codigoDoErro, ehStatus, mensagemDeErro,
  type Aba, type CarregarOpcoes, type OpcaoPaginada, type OpcaoSelect, type PaginaOpcoes,
} from '../../compartilhado/ui/index.js'
import { EtiquetasServico } from '../crm/etiquetas.servico.js'
import { FiliaisServico } from '../acesso/filiais.servico.js'
import { UsuariosServico } from '../acesso/usuarios.servico.js'
import { FormularioRenderComponente } from './formulario-render.componente.js'
import { FormularioRespostasComponente } from './formulario-respostas.componente.js'
import {
  CORES_FORM, PALETA_CAMPOS, ROTULO_TIPO_CAMPO, TIPOS_FORM, ROTULO_TIPO_FORM, adicionarCampo, alternarCondicao,
  alternarReferencia, alvosPossiveis, atualizarCampo, errosPorIdDeCampo, estiloDoBotao, linkIncorporado, linkPublico,
  moverPorId, novoCampo, opcoesDeTexto, removerCampo, snippetIframe, temOpcoes, validarEstruturaCampos,
  type CampoFormulario, type TipoCampo,
} from './formulario.regras.js'
import { FormulariosServico, type FormularioDetalhe } from './formularios.servico.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

const OPCOES_TIPO: OpcaoSelect[] = TIPOS_FORM.map((t) => ({ valor: t, rotulo: ROTULO_TIPO_FORM[t] }))
const OPCOES_COR: OpcaoSelect[] = CORES_FORM.map((c) => ({ valor: c.valor, rotulo: c.rotulo }))
const OPCOES_SITUACAO: OpcaoSelect[] = [{ valor: 'true', rotulo: 'Ativo' }, { valor: 'false', rotulo: 'Inativo' }]
const OPCOES_MARKETING: OpcaoSelect[] = [
  { valor: 'false', rotulo: 'Não pedir (só contato sobre a solicitação)' },
  { valor: 'true', rotulo: 'Pedir consentimento para ofertas' },
]
const COM_PLACEHOLDER: readonly TipoCampo[] = ['texto', 'texto_longo', 'numero', 'moeda', 'telefone', 'email', 'cpf', 'cnpj']
const MAX_PAGINAS_CATALOGO = 5

/**
 * Builder do formulário público (F3): três colunas — configurações, campos e pré-visualização ao vivo.
 *
 * ⚠️ A validação de verdade é da API (`@geracrm/shared`, a mesma regra); aqui ela só antecipa o erro e
 * o 422 volta por campo (`campos.<i>` → o card certo, `nome`/`slug`/… → o campo da configuração).
 * Condicionais: a lista condicional liga campos a opções; o campo ligado só aparece na pré-visualização
 * (e na página pública) depois da escolha.
 */
@Component({
  selector: 'app-formulario-builder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule, AbasComponente, BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente,
    EstadoComponente, EsqueletoComponente, GradeFormComponente, IconeComponente, ModalComponente, SelectComponente,
    SelectPaginadoComponente, FormularioRenderComponente, FormularioRespostasComponente,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="idAtual() ? (nome() || 'Formulário') : 'Novo formulário'"
      subtitulo="Monte os campos, defina para onde vai quem preencher e publique o link.">
      <ui-breadcrumb trilha [itens]="trilha()" />
      @if (idAtual()) {
        <button type="button" class="btn btn--secundario" (click)="abrirIncorporar()">Incorporar</button>
      }
      <button type="button" class="btn btn--primario" [disabled]="salvando() || estado() !== 'pronto'" (click)="salvar()">
        {{ salvando() ? 'Salvando…' : 'Salvar' }}
      </button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="esqueleto" aria-busy="true" aria-label="Carregando formulário">
          @for (i of [1, 2, 3, 4]; track i) { <ui-esqueleto altura="48px" /> }
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso aos formulários" descricao="Peça acesso a um gestor ou administrador." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível abrir o formulário" [descricao]="erroCarga()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        @if (idAtual()) { <ui-abas [abas]="abas()" [(ativa)]="aba" /> }

        @if (aba() === 'construtor') {
          <div class="tres">
            <!-- 1 · Configurações -->
            <section class="coluna" aria-labelledby="t-config">
              <h2 id="t-config" class="txt-secao">Configurações</h2>
              <ui-grade-form [colunas]="2">
                <ui-campo class="largo" rotulo="Nome (uso interno)" [obrigatorio]="true" [(valor)]="nome" [erro]="errosCfg()['nome'] ?? null" />
                <ui-campo class="largo" rotulo="Título exibido" [(valor)]="titulo" [erro]="errosCfg()['titulo'] ?? null"
                  dica="Em branco, usa o nome." />
                <ui-campo class="largo" tipo="textarea" rotulo="Descrição" [(valor)]="descricao" [erro]="errosCfg()['descricao'] ?? null" />
                <ui-select rotulo="Tipo" [opcoes]="opcoesTipo" [(valor)]="tipo" [erro]="errosCfg()['tipo'] ?? null" />
                <ui-select rotulo="Situação" [opcoes]="opcoesSituacao" [(valor)]="ativo" [erro]="errosCfg()['ativo'] ?? null"
                  dica="Só publica com o campo telefone." />
                <ui-select rotulo="Cor do botão" [opcoes]="opcoesCor" [(valor)]="cor" [erro]="errosCfg()['cor'] ?? null" />
                <ui-campo rotulo="Texto do botão" [(valor)]="textoBotao" [erro]="errosCfg()['textoBotao'] ?? null" />
                <ui-campo class="largo" rotulo="Mensagem de agradecimento" [(valor)]="mensagemSucesso" [erro]="errosCfg()['mensagemSucesso'] ?? null" />
                <ui-campo class="largo" rotulo="Endereço (slug)" [(valor)]="slug" [erro]="errosCfg()['slug'] ?? null"
                  dica="Só para identificar no painel. O link público usa uma chave própria." />
                <ui-select class="largo" rotulo="Origem do contato" placeholder="Formulário: nome do formulário" [opcoes]="opcoesOrigem()"
                  [(valor)]="origemId" [erro]="errosCfg()['origemId'] ?? null" />
                <ui-select class="largo" rotulo="Filial" placeholder="Sem filial" [opcoes]="opcoesFilial()"
                  [(valor)]="filialId" [erro]="errosCfg()['filialId'] ?? null" />
                <ui-select-paginado class="largo" rotulo="Responsável padrão" placeholder="Sem responsável"
                  [carregar]="carregarUsuarios" [opcaoInjetada]="responsavelInjetado()" [formControl]="responsavelCtl"
                  [erro]="errosCfg()['responsavelPadraoId'] ?? null" />
                <ui-select class="largo" rotulo="Etapa do funil" placeholder="Não criar oportunidade" [opcoes]="opcoesEtapa()"
                  [(valor)]="etapaDestinoId" [erro]="errosCfg()['etapaDestinoId'] ?? null"
                  dica="Se escolher, quem preencher já entra como oportunidade aberta nesta etapa." />
                <ui-select class="largo" rotulo="Consentimento de marketing (LGPD)" [opcoes]="opcoesMarketing" [(valor)]="marketing"
                  [erro]="errosCfg()['consentimentoMarketing'] ?? null"
                  dica="Se pedir, o aviso exibido diz que a pessoa aceita receber ofertas, e o contato novo entra em campanhas. Sem isso, não entra." />
              </ui-grade-form>
            </section>

            <!-- 2 · Campos -->
            <section class="coluna" aria-labelledby="t-campos">
              <h2 id="t-campos" class="txt-secao">Campos <small>{{ campos().length }}/60</small></h2>
              <div class="paleta" role="group" aria-label="Adicionar campo">
                @for (t of paleta; track t) {
                  <button type="button" class="chip-tipo" (click)="adicionar(t)">
                    <ui-icone nome="plus" [tamanho]="14" /> {{ rotuloTipo(t) }}
                  </button>
                }
              </div>
              @if (errosCampos()['campos']; as geral) { <p class="erro" role="alert">{{ geral }}</p> }
              @if (campos().length === 0) {
                <p class="vazio">Nenhum campo ainda. Comece pelo telefone: é por ele que o contato é identificado.</p>
              }
              <ol class="lista-campos">
                @for (c of campos(); track c.id; let i = $index) {
                  <li class="card" [class.card--erro]="!!errosPorId()[c.id]">
                    <div class="card-topo">
                      <ui-badge>{{ rotuloTipo(c.tipo) }}</ui-badge>
                      @if (c.id === idIdentidade()) { <ui-badge tom="info">Identifica o contato</ui-badge> }
                      <span class="ferramentas">
                        @if (c.tipo === 'texto') {
                          <button type="button" class="ico" [class.ico--ativo]="c.referencia" [attr.aria-pressed]="c.referencia"
                            aria-label="Usar como nome do contato" title="Usar como nome do contato" (click)="referencia(c.id)">★</button>
                        }
                        <button type="button" class="ico" aria-label="Mover para cima" [disabled]="i === 0" (click)="mover(c.id, -1)">↑</button>
                        <button type="button" class="ico" aria-label="Mover para baixo" [disabled]="i === campos().length - 1" (click)="mover(c.id, 1)">↓</button>
                        <button type="button" class="ico ico--perigo" aria-label="Remover campo" (click)="remover(c.id)">
                          <ui-icone nome="trash-2" [tamanho]="14" />
                        </button>
                      </span>
                    </div>
                    <ui-campo rotulo="Rótulo" [obrigatorio]="true" [valor]="c.rotulo"
                      (valorChange)="atualizar(c.id, { rotulo: $event })" [erro]="errosPorId()[c.id] ?? null" />
                    @if (comPlaceholder(c.tipo)) {
                      <ui-campo rotulo="Texto de ajuda (placeholder)" [valor]="c.placeholder ?? ''"
                        (valorChange)="atualizar(c.id, { placeholder: $event || null })" />
                    }
                    <label class="marca">
                      <input type="checkbox" [checked]="c.obrigatorio" [disabled]="c.id === idIdentidade()"
                        (change)="atualizar(c.id, { obrigatorio: $any($event.target).checked })" />
                      Obrigatório @if (c.id === idIdentidade()) { <small>(sempre, para identificar o contato)</small> }
                    </label>
                    @if (temOpcoes(c.tipo)) {
                      <label class="opcoes">
                        <span class="txt-denso">Opções (uma por linha)</span>
                        <textarea rows="4" [value]="rascunhoOpcoes()[c.id] ?? c.opcoes.join('\\n')"
                          (input)="digitarOpcoes(c.id, $any($event.target).value)"></textarea>
                      </label>
                    }
                    @if (c.tipo === 'selecao_condicional') {
                      <div class="condicoes">
                        <span class="txt-denso">Mostrar outros campos conforme a opção escolhida:</span>
                        @for (o of c.opcoes; track o) {
                          <div class="condicao">
                            <span class="quando">Se for «{{ o }}», mostrar:</span>
                            <span class="alvos">
                              @for (a of alvos(c); track a.id) {
                                <button type="button" class="alvo" [class.alvo--ligado]="liga(c, o, a.id)"
                                  [attr.aria-pressed]="liga(c, o, a.id)" (click)="alternar(c, o, a.id)">{{ a.rotulo }}</button>
                              } @empty { <em class="txt-denso">Adicione outros campos para ligar aqui.</em> }
                            </span>
                          </div>
                        }
                      </div>
                    }
                  </li>
                }
              </ol>
              @if (!temReferencia() && campos().length > 0) {
                <p class="dica txt-denso">Sem um campo ★ de nome, o contato novo entra como «Formulário: {{ nome() || '…' }}».</p>
              }
            </section>

            <!-- 3 · Pré-visualização -->
            <section class="coluna" aria-labelledby="t-previa">
              <h2 id="t-previa" class="txt-secao">Pré-visualização</h2>
              <div class="previa">
                <h3>{{ titulo() || nome() || 'Título do formulário' }}</h3>
                @if (descricao()) { <p class="desc">{{ descricao() }}</p> }
                <app-formulario-render [campos]="campos()" [(valores)]="valoresPrevia" [(arquivos)]="arquivosPrevia" />
                <p class="lgpd txt-denso">☐ O aviso de privacidade da empresa aparece aqui, com o texto das Configurações.</p>
                <button type="button" class="botao-previa" [style.background]="botao().fundo" [style.color]="botao().texto" tabindex="-1">
                  {{ textoBotao() || 'Enviar' }}
                </button>
              </div>
            </section>
          </div>
        } @else {
          <app-formulario-respostas [formularioId]="idAtual()!" [slug]="slugSalvo()" [campos]="campos()" />
        }
      }
    }

    <ui-modal [aberto]="incorporando()" titulo="Incorporar formulário" largura="m" (fechar)="incorporando.set(false)">
      <div class="inc">
        <ui-campo rotulo="Link público" [valor]="linkDoForm()" [desabilitado]="true" dica="Funciona sozinho: sem login.">
          <button acao type="button" class="btn btn--secundario" (click)="copiar(linkDoForm())">Copiar</button>
        </ui-campo>
        <label class="opcoes">
          <span class="txt-denso">Para colocar no seu site (iframe)</span>
          <textarea rows="4" readonly [value]="snippet()"></textarea>
        </label>
        <button type="button" class="btn btn--secundario" (click)="copiar(snippet())">Copiar código</button>
        <p class="dica txt-denso">O servidor de páginas controla quem pode incorporar (cabeçalho <code>frame-ancestors</code>, configurável na hospedagem do console).</p>
        <!-- ⚠️ O token de integração fica FORA da tela até existir uma integração que o use: um segredo
             gerado sem consumidor só aumenta a superfície (a rota POST /v1/formularios/:id/token continua). -->
      </div>
      <div rodape>
        <button type="button" class="btn btn--primario" (click)="incorporando.set(false)">Fechar</button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); container-type: inline-size; }
    .esqueleto { display: grid; gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
    .tres { display: grid; grid-template-columns: 1fr; gap: var(--espacamento-5); margin-top: var(--espacamento-4); align-items: start; min-width: 0; }
    @container (min-width: 1100px) {
      .tres { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr); }
      .coluna:last-child { position: sticky; top: var(--espacamento-4); }
    }
    .coluna { background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      padding: var(--espacamento-4); min-width: 0; display: flex; flex-direction: column; gap: var(--espacamento-3); }
    .coluna h2 { margin: 0; color: var(--texto); }
    .coluna h2 small { color: var(--texto-suave); font-weight: 400; }
    .paleta { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .chip-tipo { display: inline-flex; align-items: center; gap: var(--espacamento-1); padding: var(--espacamento-1) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada);
      color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    .chip-tipo:hover { background: var(--superficie-hover); }
    .chip-tipo:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .lista-campos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--espacamento-3); }
    .card { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-3);
      display: flex; flex-direction: column; gap: var(--espacamento-3); background: var(--fundo); min-width: 0; }
    .card--erro { border-color: var(--erro); }
    .card-topo { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .ferramentas { margin-left: auto; display: inline-flex; gap: var(--espacamento-1); }
    .ico { min-width: var(--densidade-alvo-clique-console); min-height: var(--densidade-alvo-clique-console); display: inline-grid; place-items: center;
      border: 1px solid transparent; border-radius: var(--raio-controle); background: transparent; color: var(--texto-secundario);
      font: inherit; cursor: pointer; }
    .ico:hover:not(:disabled) { background: var(--superficie-hover); color: var(--texto); }
    .ico:disabled { opacity: .4; cursor: default; }
    .ico:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .ico--ativo { color: var(--atencao); border-color: var(--atencao); }
    .ico--perigo:hover:not(:disabled) { color: var(--erro); }
    .marca { display: flex; align-items: center; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    .marca small { color: var(--texto-suave); }
    .opcoes { display: flex; flex-direction: column; gap: var(--espacamento-1); }
    textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto); font: inherit; font-size: 13px; resize: vertical; width: 100%; box-sizing: border-box; }
    .condicoes { display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .condicao { display: flex; flex-direction: column; gap: var(--espacamento-1); }
    .quando { font-size: 12px; color: var(--texto-secundario); }
    .alvos { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .alvo { padding: 2px var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo);
      background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 12px; cursor: pointer; }
    .alvo--ligado { background: var(--acao-suave); border-color: var(--acao); color: var(--texto); }
    .alvo:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .vazio, .dica { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .previa { border: 1px dashed var(--borda-forte); border-radius: var(--raio-controle); padding: var(--espacamento-4);
      display: flex; flex-direction: column; gap: var(--espacamento-4); background: var(--superficie-elevada); min-width: 0; }
    .previa h3 { margin: 0; font-size: 18px; color: var(--texto); }
    .desc { margin: 0; color: var(--texto-secundario); font-size: 13px; white-space: pre-line; }
    .lgpd { margin: 0; color: var(--texto-suave); }
    .botao-previa { padding: var(--espacamento-3); border: 0; border-radius: var(--raio-controle); font: inherit; font-weight: 600; cursor: default; }
    .inc { display: flex; flex-direction: column; gap: var(--espacamento-3); }
    .inc hr { width: 100%; border: 0; border-top: 1px solid var(--borda); margin: var(--espacamento-1) 0; }
  `,
})
export class FormularioBuilderPagina implements OnInit {
  /** Ligado ao `:id` da rota; ausente em `formularios/novo`. */
  readonly id = input<string | undefined>(undefined)

  private readonly api = inject(FormulariosServico)
  private readonly toast = inject(ToastServico)
  private readonly router = inject(Router)
  private readonly filiaisApi = inject(FiliaisServico)
  private readonly usuariosApi = inject(UsuariosServico)
  private readonly catalogos = inject(EtiquetasServico)

  protected readonly paleta = PALETA_CAMPOS
  protected readonly opcoesTipo = OPCOES_TIPO
  protected readonly opcoesCor = OPCOES_COR
  protected readonly opcoesSituacao = OPCOES_SITUACAO
  protected readonly opcoesMarketing = OPCOES_MARKETING

  protected readonly estado = signal<Estado>('carregando')
  protected readonly erroCarga = signal('')
  protected readonly idAtual = signal<string | null>(null)
  protected readonly slugSalvo = signal('')
  protected readonly chavePublica = signal('')
  protected readonly aba = signal('construtor')
  protected readonly abas = computed<Aba[]>(() => [{ id: 'construtor', rotulo: 'Construtor' }, { id: 'respostas', rotulo: 'Respostas' }])
  protected readonly trilha = computed(() => [{ rotulo: 'Formulários', rota: '/formularios' }, { rotulo: this.nome() || 'Novo formulário' }])

  // Configurações
  protected readonly nome = signal('')
  protected readonly titulo = signal('')
  protected readonly descricao = signal('')
  protected readonly tipo = signal('cadastro')
  protected readonly cor = signal('acao')
  protected readonly textoBotao = signal('Enviar')
  protected readonly mensagemSucesso = signal('Recebemos suas informações. Obrigado!')
  protected readonly slug = signal('')
  /** Nasce INATIVO: a API recusa publicar sem o campo telefone. */
  protected readonly ativo = signal('false')
  protected readonly marketing = signal('false')
  protected readonly origemId = signal('')
  protected readonly filialId = signal('')
  protected readonly etapaDestinoId = signal('')
  protected readonly responsavelCtl = new FormControl<string | null>(null)
  protected readonly responsavelInjetado = signal<OpcaoPaginada | null>(null)
  protected readonly opcoesOrigem = signal<OpcaoSelect[]>([])
  protected readonly opcoesFilial = signal<OpcaoSelect[]>([])
  protected readonly opcoesEtapa = signal<OpcaoSelect[]>([])

  // Campos
  protected readonly campos = signal<CampoFormulario[]>([])
  protected readonly rascunhoOpcoes = signal<Record<string, string>>({})
  protected readonly errosCfg = signal<Record<string, string>>({})
  protected readonly errosCampos = signal<Record<string, string>>({})
  protected readonly errosPorId = computed(() => errosPorIdDeCampo(this.errosCampos(), this.campos()))
  protected readonly idIdentidade = computed(() => this.campos().find((c) => c.tipo === 'telefone')?.id ?? null)
  protected readonly temReferencia = computed(() => this.campos().some((c) => c.referencia))
  protected readonly botao = computed(() => estiloDoBotao(this.cor()))
  protected readonly salvando = signal(false)

  // Pré-visualização
  protected readonly valoresPrevia = signal<Record<string, unknown>>({})
  protected readonly arquivosPrevia = signal<ReadonlyMap<string, File>>(new Map())

  // Incorporar
  protected readonly incorporando = signal(false)
  protected readonly linkDoForm = computed(() => linkPublico(window.location.origin, this.chavePublica()))
  protected readonly snippet = computed(() => snippetIframe(linkIncorporado(window.location.origin, this.chavePublica()), this.titulo() || this.nome()))

  protected readonly rotuloTipo = (t: TipoCampo): string => ROTULO_TIPO_CAMPO[t]
  protected readonly temOpcoes = temOpcoes
  protected comPlaceholder(t: TipoCampo): boolean { return COM_PLACEHOLDER.includes(t) }
  protected alvos(c: CampoFormulario): CampoFormulario[] { return alvosPossiveis(this.campos(), c) }
  protected liga(c: CampoFormulario, opcao: string, alvo: string): boolean { return (c.condicoes[opcao] ?? []).includes(alvo) }

  /** Usuários: só admin lista (403 para gestor) — nesse caso o seletor fica vazio e o responsável é opcional. */
  protected readonly carregarUsuarios: CarregarOpcoes = async (cursor, termo) => {
    try {
      const r = await this.usuariosApi.listar({ cursor, busca: termo, ativo: 'true' })
      return { itens: r.itens.map((u) => ({ valor: u.id, rotulo: u.nome, dica: u.email })), proximoCursor: r.proximoCursor }
    } catch (e) {
      if (ehStatus(e, 403)) return { itens: [], proximoCursor: null }
      throw e
    }
  }

  ngOnInit(): void { void this.carregar() }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [origens, filiais, etapas] = await Promise.all([
        this.todasAsPaginas((c) => this.catalogos.origens(c, true).then((r) => ({ itens: r.itens.map((o) => ({ valor: o.id, rotulo: o.nome })), proximoCursor: r.proximoCursor }))),
        this.todasAsPaginas((c) => this.filiaisApi.listar(c).then((r) => ({ itens: r.itens.filter((f) => f.ativa).map((f) => ({ valor: f.id, rotulo: f.nome })), proximoCursor: r.proximoCursor }))),
        this.api.etapasDoFunil().then((r) => r.itens.filter((e) => e.tipo === 'aberto' && e.ativo).map((e) => ({ valor: e.id, rotulo: e.nome }))),
      ])
      this.opcoesOrigem.set(origens); this.opcoesFilial.set(filiais); this.opcoesEtapa.set(etapas)

      const id = this.id()
      if (id) {
        const f = await this.api.obter(id)
        this.aplicar(f)
        if (f.responsavelPadraoId) void this.injetarResponsavel(f.responsavelPadraoId)
      }
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else if (ehStatus(e, 404)) { this.erroCarga.set('Este formulário não existe mais.'); this.estado.set('erro') }
      else { this.erroCarga.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  /** Catálogos pequenos (origens, filiais): lê por cursor até um teto — nunca um "traga tudo". */
  private async todasAsPaginas(
    pagina: (cursor: string | null) => Promise<{ itens: OpcaoSelect[]; proximoCursor: string | null }>,
  ): Promise<OpcaoSelect[]> {
    const todas: OpcaoSelect[] = []
    let cursor: string | null = null
    for (let n = 0; n < MAX_PAGINAS_CATALOGO; n++) {
      const r = await pagina(cursor)
      todas.push(...r.itens)
      if (!r.proximoCursor) break
      cursor = r.proximoCursor
    }
    return todas
  }

  /** Rótulo do responsável salvo, achado nas primeiras páginas (a lista é paginada e o valor pode estar além). */
  private async injetarResponsavel(id: string): Promise<void> {
    this.responsavelInjetado.set({ valor: id, rotulo: 'Responsável selecionado' })
    let cursor: string | null = null
    for (let n = 0; n < MAX_PAGINAS_CATALOGO; n++) {
      const r: PaginaOpcoes | null = await this.carregarUsuarios(cursor, '').catch(() => null)
      if (!r) return
      const achou = r.itens.find((o) => o.valor === id)
      if (achou) { this.responsavelInjetado.set(achou); return }
      if (!r.proximoCursor) return
      cursor = r.proximoCursor
    }
  }

  private aplicar(f: FormularioDetalhe): void {
    this.idAtual.set(f.id); this.slugSalvo.set(f.slug); this.chavePublica.set(f.chavePublica)
    this.nome.set(f.nome); this.titulo.set(f.titulo === f.nome ? '' : f.titulo); this.descricao.set(f.descricao ?? '')
    this.tipo.set(f.tipo); this.cor.set(f.cor); this.textoBotao.set(f.textoBotao); this.mensagemSucesso.set(f.mensagemSucesso)
    this.slug.set(f.slug); this.ativo.set(String(f.ativo)); this.marketing.set(String(f.consentimentoMarketing))
    this.origemId.set(f.origemId ?? ''); this.filialId.set(f.filialId ?? ''); this.etapaDestinoId.set(f.etapaDestinoId ?? '')
    this.responsavelCtl.setValue(f.responsavelPadraoId)
    this.campos.set(f.campos.map((c) => ({ ...c })))
    this.rascunhoOpcoes.set({})
  }

  // ── edição dos campos (regras puras em formulario.regras.ts) ──
  protected adicionar(t: TipoCampo): void { this.campos.update((l) => adicionarCampo(l, novoCampo(t))) }
  protected remover(id: string): void { this.campos.update((l) => removerCampo(l, id)) }
  protected mover(id: string, delta: -1 | 1): void { this.campos.update((l) => moverPorId(l, id, delta)) }
  protected referencia(id: string): void { this.campos.update((l) => alternarReferencia(l, id)) }
  protected atualizar(id: string, m: Partial<CampoFormulario>): void { this.campos.update((l) => atualizarCampo(l, id, m)) }
  protected alternar(c: CampoFormulario, opcao: string, alvo: string): void {
    this.atualizar(c.id, { condicoes: alternarCondicao(c, opcao, alvo) })
  }
  protected digitarOpcoes(id: string, texto: string): void {
    this.rascunhoOpcoes.update((r) => ({ ...r, [id]: texto }))
    this.atualizar(id, { opcoes: opcoesDeTexto(texto) })
  }

  // ── salvar ──
  protected async salvar(): Promise<void> {
    if (this.salvando()) return
    const cfg: Record<string, string> = {}
    if (!this.nome().trim()) cfg['nome'] = 'Informe o nome do formulário.'
    const estrutura = validarEstruturaCampos(this.campos())
    this.errosCfg.set(cfg); this.errosCampos.set(estrutura)
    if (Object.keys(cfg).length > 0 || Object.keys(estrutura).length > 0) {
      this.toast.erro('Corrija os pontos destacados antes de salvar.')
      return
    }

    this.salvando.set(true)
    const corpo = {
      nome: this.nome().trim(), titulo: this.titulo().trim() || this.nome().trim(), descricao: this.descricao().trim() || null,
      tipo: this.tipo(), cor: this.cor(), textoBotao: this.textoBotao().trim() || 'Enviar',
      mensagemSucesso: this.mensagemSucesso().trim() || 'Recebemos suas informações. Obrigado!',
      consentimentoMarketing: this.marketing() === 'true', origemId: this.origemId() || null, filialId: this.filialId() || null,
      etapaDestinoId: this.etapaDestinoId() || null, responsavelPadraoId: this.responsavelCtl.value || null,
    }
    const ativo = this.ativo() === 'true'
    const slug = this.slug().trim() ? { slug: this.slug().trim() } : {}
    try {
      // ⚠️ Ordem: campos ANTES de publicar. A API só aceita `ativo: true` com o campo telefone já gravado
      //    (o formulário nasce inativo e sem campos).
      let id = this.idAtual()
      if (!id) {
        const novo = await this.api.criar({ ...corpo, ...slug })
        id = novo.id
        this.idAtual.set(id); this.slugSalvo.set(novo.slug); this.slug.set(novo.slug); this.chavePublica.set(novo.chavePublica)
      }
      const r = await this.api.salvarCampos(id, this.campos())
      this.campos.set(r.campos.map((c) => ({ ...c })))
      await this.api.editar(id, { ...corpo, ...slug, ativo })
      this.rascunhoOpcoes.set({})
      this.slugSalvo.set(this.slug().trim() || this.slugSalvo())
      this.toast.sucesso('Formulário salvo.')
      if (!this.id()) void this.router.navigate(['/formularios', id], { replaceUrl: true })
    } catch (e) {
      this.mostrarErro(e)
    } finally { this.salvando.set(false) }
  }

  private mostrarErro(e: unknown): void {
    const corpo = (e as { error?: { campos?: Record<string, string> } })?.error
    if (corpo?.campos) {
      const cfg: Record<string, string> = {}
      const cps: Record<string, string> = {}
      for (const [k, v] of Object.entries(corpo.campos)) (k.startsWith('campos') ? cps : cfg)[k] = v
      this.errosCfg.set(cfg); this.errosCampos.set(cps)
      this.toast.erro('Corrija os pontos destacados.')
      return
    }
    if (codigoDoErro(e) === 'formulario.slug_duplicado') {
      this.errosCfg.set({ slug: 'Já existe um formulário com este endereço.' })
      return
    }
    this.toast.erro(mensagemDeErro(e, 'Não foi possível salvar.'))
  }

  // ── incorporar ──
  protected abrirIncorporar(): void { this.incorporando.set(true) }

  protected async copiar(texto: string): Promise<void> {
    try { await navigator.clipboard.writeText(texto); this.toast.sucesso('Copiado.') }
    catch { this.toast.erro('Não foi possível copiar. Selecione o texto e copie à mão.') }
  }
}
