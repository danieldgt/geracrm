import { Component, ChangeDetectionStrategy, computed, inject, input, effect, signal, viewChild } from '@angular/core'
import { DatePipe } from '@angular/common'
import { Router, RouterLink } from '@angular/router'
import { rotuloSegmento } from '@geracrm/shared'
import { FichaServico, type FichaContato } from './ficha.servico.js'
import { FichaBlocosServico } from './ficha-blocos.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { AgendaContatoComponente } from '../agenda/agenda-contato.componente.js'
import { AgendaEventoModalComponente } from '../agenda/agenda-evento-modal.componente.js'
import { diaIso } from '../agenda/agenda.regras.js'
import {
  AbasComponente, BadgeComponente, BotaoComponente, BreadcrumbComponente, CabecalhoTelaComponente, ConfirmacaoServico,
  EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, PainelComponente, ToastServico, mensagemDeErro,
  type ItemTrilha, ModalComponente, GradeFormComponente, CampoComponente, SelectComponente
} from '../../compartilhado/ui/index.js'
import { AnonimizarContatoComponente } from './anonimizar-contato.componente.js'
import { AvisosPrivacidadeComponente } from './avisos-privacidade.componente.js'
import { EtiquetasContatoComponente } from './etiquetas-contato.componente.js'
import { TarefaModalComponente } from './tarefa-modal.componente.js'
import { FichaFeedComponente } from './ficha-feed.componente.js'
import { FichaPerfilCompraComponente } from './ficha-perfil-compra.componente.js'
import { FichaArquivosComponente } from './ficha-arquivos.componente.js'
import { FichaPedidosComponente } from './ficha-pedidos.componente.js'
import { FichaTarefasComponente } from './ficha-tarefas.componente.js'
import { MenuMaisComponente } from '../atendimento/menu-mais.componente.js'
import type { ItemMenuMais } from '../atendimento/menu-mais.regras.js'
import {
  ABAS_FICHA, acoesVisiveis, camposDeCadastro, camposDeInformacao, estadoDaAcao, selosDaFicha, separarAcoesFicha, type IdAcao,
} from './ficha.regras.js'

/**
 * Ficha do Contato — detalhe no padrão "2 + 1" (coluna larga + lateral de 320 px; 1 coluna em
 * contêiner < 900 px). O cabeçalho traz selos e ações; a coluna larga traz Perfil de compra e as
 * abas (Feed, Dados, Pedidos, Tarefas, Agenda — a conversa abre no chat, pelo "Conversar"); a lateral traz Informações, Etiquetas,
 * Arquivos, Contato e Avisos de privacidade.
 *
 * ⚠️ Cada bloco tem estado próprio (componente próprio): um bloco que falha mostra o erro dele e o
 * resto da ficha segue. O `id` vem da rota (component input binding); recarrega quando muda.
 */
@Component({
  selector: 'app-ficha-contato',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SelectComponente, CampoComponente, GradeFormComponente, ModalComponente, 
    RouterLink, DatePipe, AnonimizarContatoComponente, AbasComponente, BadgeComponente, BotaoComponente, BreadcrumbComponente, CabecalhoTelaComponente,
    EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, PainelComponente,
    AvisosPrivacidadeComponente, EtiquetasContatoComponente, TarefaModalComponente, FichaFeedComponente,
    FichaPerfilCompraComponente, FichaArquivosComponente, FichaPedidosComponente, FichaTarefasComponente, MenuMaisComponente,
    AgendaContatoComponente, AgendaEventoModalComponente,
  ],
  template: `
    @switch (servico.estado()) {
      @case ('carregando') {
        <ui-breadcrumb [itens]="trilhaCarregando" />
        <div class="esq" aria-busy="true" aria-label="Carregando a ficha">
          <ui-esqueleto altura="28px" largura="40%" />
          <ui-esqueleto altura="120px" />
          <ui-esqueleto altura="220px" />
        </div>
      }
      @case ('nao_encontrado') {
        <ui-breadcrumb [itens]="trilhaCarregando" />
        <ui-estado titulo="Contato não encontrado" descricao="Ele pode ter sido mesclado ou removido." icone="user">
          <a class="btn btn--secundario" routerLink="/contatos">Voltar para Contatos</a>
        </ui-estado>
      }
      @case ('sem_permissao') {
        <ui-breadcrumb [itens]="trilhaCarregando" />
        <ui-estado tipo="sem-permissao" titulo="Sem acesso a este contato" />
      }
      @case ('erro') {
        <ui-breadcrumb [itens]="trilhaCarregando" />
        <ui-estado tipo="erro" titulo="Não foi possível carregar a ficha" [descricao]="servico.erro() ?? ''">
          <ui-botao variante="secundario" (click)="recarregar()">Tentar de novo</ui-botao>
        </ui-estado>
      }
      @case ('pronto') {
        @if (servico.ficha(); as f) {
          <ui-cabecalho-tela [titulo]="f.nome" [subtitulo]="subtitulo(f)">
            <ui-breadcrumb trilha [itens]="trilha()" />
          </ui-cabecalho-tela>

          <div class="grade">
            <section class="col" aria-label="Contato">
              <!-- Cartão-cabeçalho: selos (ordem fixa) e ações. -->
              <ui-painel>
                <div class="selos" aria-label="Situação do contato">
                  @for (s of selos(); track s.id) {
                    @if (s.codigoRfv) {
                      <span class="selo-rfv" [style.--c]="'var(--rfv-' + s.codigoRfv + ')'">{{ s.rotulo }}</span>
                    } @else {
                      <ui-badge [tom]="s.tom">{{ s.rotulo }}</ui-badge>
                    }
                  }
                </div>
                <!-- Uma ação cheia (Conversar), duas à vista e o resto no "⋯"
                     (separarAcoesFicha). Antes: 9 botões, 3 cheios em cores diferentes. -->
                <div class="acoes">
                  @for (a of acoesSeparadas().aVista; track a.id) {
                    @switch (a.id) {
                      @case ('conversar') {
                        <ui-botao variante="primario" [carregando]="abrindoConversa()" [desabilitado]="a.desabilitada" (click)="agir(f, a.id)">{{ a.rotulo }}</ui-botao>
                      }
                      @case ('editar') { <a class="btn btn--secundario" [routerLink]="['/contato', f.id, 'editar']" [attr.title]="a.dica">{{ a.rotulo }}</a> }
                      @case ('novo-pedido') { <a class="btn btn--secundario" routerLink="/pedido" [queryParams]="{ contato: f.id }" [attr.title]="a.dica">{{ a.rotulo }}</a> }
                    }
                  }
                  <app-menu-mais [itens]="itensMenu()" rotulo="Mais ações do contato" (escolher)="aoMenu(f, $event)" />
                  @if (qualificando()) { <span class="txt-denso trabalhando" role="status">Atualizando a qualificação…</span> }
                </div>
                <!-- Só a lógica do "Anonimizar (LGPD)" (papel admin + confirmação digitada);
                     o gatilho é o item do "⋯", por último. -->
                <div hidden><app-anonimizar-contato [contatoId]="f.id" (anonimizou)="recarregar()" /></div>
                @if (dicaDesabilitada(); as d) { <p class="txt-denso dica">{{ d }}</p> }
                @if (erroAcao(); as e) { <p class="txt-denso erro" role="alert">{{ e }}</p> }
                @if (modulos.agendaAtiva()) {
                  <app-agenda-evento-modal [aberto]="modalAgenda()" [contatoId]="f.id" [contatoNome]="f.nome"
                    [dataInicial]="hoje" (fechar)="modalAgenda.set(false)" (criado)="aoCriarEvento()" />
                }
              </ui-painel>

              <app-ficha-perfil-compra [contatoId]="f.id" />

              <ui-painel>
                <ui-abas [abas]="abas" [(ativa)]="aba" />
                <div class="aba-corpo">
                  @switch (aba()) {
                    @case ('feed') { <app-ficha-feed [contatoId]="f.id" [versao]="feedVersao()" /> }
                    @case ('dados') {
                      <ui-lista-definicao [itens]="cadastro()" [colunas]="2" />
                      @if (f.endereco; as e) {
                        <h3 class="txt-rotulo sub">Endereço</h3>
                        <p class="txt-corpo texto">{{ enderecoTexto(e) }}</p>
                      }
                      @if (f.observacoes) {
                        <h3 class="txt-rotulo sub">Observações do cadastro</h3>
                        <p class="txt-corpo texto pre">{{ f.observacoes }}</p>
                      }
                      <h3 class="txt-rotulo sub">Comportamento de compra</h3>
                      @if (f.metricas; as m) {
                        <p class="txt-corpo texto"><strong>{{ m.segmento.rotulo }}</strong>@if (!m.confiavel) { <span class="suave"> · estimado (histórico anterior à carga)</span> }
                          · {{ m.qtdVendas }} compras @if (m.mediaEntreVendasDias !== null) { · ritmo de {{ arred(m.mediaEntreVendasDias) }} dias }</p>
                        <p class="txt-corpo acao-rfv">{{ m.segmento.acao }}</p>
                      } @else {
                        <p class="txt-corpo suave">Este contato ainda não tem vendas importadas, sem RFV por enquanto.</p>
                      }
                      @if (servico.segmentoHistorico().length > 1) {
                        <h3 class="txt-rotulo sub">Evolução do segmento</h3>
                        <ol class="trajetoria">
                          @for (h of servico.segmentoHistorico(); track $index) {
                            <li><span class="selo-rfv" [style.--c]="'var(--rfv-' + h.segmento + ')'">{{ rotuloSeg(h.segmento) }}</span>
                              <span class="txt-denso suave">{{ h.capturadoEm | date: 'dd/MM/yy' }}</span></li>
                          }
                        </ol>
                      }
                      <h3 class="txt-rotulo sub">Categorias mais compradas</h3>
                      @if (f.categorias.length) {
                        <ul class="barras">
                          @for (c of f.categorias; track c.categoria) {
                            <li>
                              <span class="rot txt-denso">{{ c.categoria }}</span>
                              <span class="barra"><i [style.width.%]="pct(c.totalCentavos, f.categorias[0]?.totalCentavos ?? 1)"></i></span>
                              <span class="txt-dados">{{ reais(c.totalCentavos) }}</span>
                            </li>
                          }
                        </ul>
                      } @else {
                        <p class="txt-corpo suave">Sem itens de venda importados. As categorias aparecem quando o detalhe das vendas for sincronizado.</p>
                      }
                      <h3 class="txt-rotulo sub">Últimas compras</h3>
                      @if (f.ultimasVendas.length) {
                        <ul class="linhas">
                          @for (v of f.ultimasVendas; track v.id) {
                            <li [class.cancelada]="v.cancelada">
                              <span class="txt-dados">{{ data(v.ocorridaEm) }}</span>
                              <span class="txt-dados val">{{ reais(v.valorCentavos) }}</span>
                              @if (v.cancelada) { <ui-badge tom="erro">cancelada</ui-badge> }
                            </li>
                          }
                        </ul>
                      } @else { <p class="txt-corpo suave">Sem compras registradas.</p> }
                    }
                    @case ('pedidos') { <app-ficha-pedidos [contatoId]="f.id" /> }
                    @case ('tarefas') { <app-ficha-tarefas [contatoId]="f.id" [versao]="tarefasVersao()" (nova)="novaTarefa.set(true)" /> }
                    @case ('agenda') {
                      @if (modulos.agendaAtiva()) {
                        <app-agenda-contato [contatoId]="f.id" [contatoNome]="f.nome" />
                      } @else {
                        <ui-estado titulo="Agenda ainda não está ligada" descricao="Os compromissos deste contato aparecem aqui quando o módulo Agenda estiver ativo no seu plano." icone="calendar" />
                      }
                    }
                  }
                </div>
              </ui-painel>
            </section>

            <aside class="lateral" aria-label="Informações do contato">
              <ui-painel>
                <h3 class="txt-rotulo tit">Informações</h3>
                <ui-lista-definicao [itens]="informacoes()" [colunas]="1" />
              </ui-painel>

              <ui-painel>
                <h3 class="txt-rotulo tit">Etiquetas</h3>
                <app-etiquetas-contato [contatoId]="f.id" (salvou)="avancarFeed()" />
              </ui-painel>

              <ui-painel>
                <app-ficha-arquivos [contatoId]="f.id" (alterou)="avancarFeed()" />
              </ui-painel>

              <ui-painel>
                <h3 class="txt-rotulo tit">Contato</h3>
                @if (f.telefones.length) {
                  <ul class="linhas">
                    @for (t of f.telefones; track t.seq) {
                      <li>
                        <span class="txt-dados encolhe">{{ t.e164 }}</span>
                        @if (t.principal) { <ui-badge>principal</ui-badge> }
                        @else { <button type="button" class="btn btn--secundario btn--pequeno" (click)="servico.principalTelefone(t.seq)">tornar principal</button> }
                        @if (t.whatsapp) { <ui-badge tom="sucesso">WhatsApp</ui-badge> }
                        <button type="button" class="x" (click)="removerTelefone(t)" title="Remover telefone" aria-label="Remover telefone">×</button>
                      </li>
                    }
                  </ul>
                } @else { <p class="txt-corpo suave">Sem telefone cadastrado.</p> }
                <!-- Cadastro curto abre modal (padrão A), com rótulo visível e máscara — não mais campo solto no painel. -->
                <button type="button" class="btn btn--secundario btn--pequeno add" (click)="abrirAdicionar('telefone')">+ Telefone</button>

                <h3 class="txt-rotulo sub">Documentos</h3>
                @if (f.documentos.length) {
                  <ul class="linhas">
                    @for (d of f.documentos; track d.seq) {
                      <li><span class="txt-dados encolhe">{{ d.numero }}</span> <ui-badge>{{ d.tipo }}</ui-badge>
                        <button type="button" class="x" (click)="removerDocumento(d)" title="Remover documento" aria-label="Remover documento">×</button></li>
                    }
                  </ul>
                  @if (f.totalDocumentos > f.documentos.length) {
                    <p class="txt-denso alerta">{{ f.totalDocumentos }} documentos neste contato, provável fusão de cadastros por telefone repetido.</p>
                  }
                } @else { <p class="txt-corpo suave">Sem documento.</p> }
                <button type="button" class="btn btn--secundario btn--pequeno add" (click)="abrirAdicionar('documento')">+ Documento</button>
                @if (!adicionando()) { @if (servico.erroEdicao(); as e) { <p class="txt-denso erro" role="alert">{{ e }}</p> } }
              </ui-painel>

              <!-- Prova LGPD (P4): quando e com que texto o aviso foi exibido. Estado próprio; sem permissão, some. -->
              <app-avisos-privacidade [contatoId]="f.id" />
            </aside>
          </div>

          <ui-modal [aberto]="adicionando() !== null" largura="p"
                    [titulo]="adicionando() === 'telefone' ? 'Adicionar telefone' : 'Adicionar documento'" (fechar)="fecharAdicionar()">
            <form id="form-add-contato" (submit)="salvarAdicionar($event)" novalidate>
              <ui-grade-form>
                @if (adicionando() === 'telefone') {
                  <ui-campo [largo]="true" rotulo="Telefone" mascara="telefone" placeholder="(81) 99999-0000" [obrigatorio]="true"
                            dica="Com DDD." [valor]="novoTel()" (valorChange)="novoTel.set($event)" />
                } @else {
                  <ui-select rotulo="Tipo" [opcoes]="opcoesDoc" [valor]="novoDocTipo()" [obrigatorio]="true"
                             (valorChange)="novoDocTipo.set($event === 'cpf' ? 'cpf' : 'cnpj')" />
                  <ui-campo rotulo="Número" [mascara]="novoDocTipo()" [obrigatorio]="true"
                            [valor]="novoDoc()" (valorChange)="novoDoc.set($event)" />
                }
              </ui-grade-form>
              @if (servico.erroEdicao(); as e) { <p class="txt-denso erro" role="alert">{{ e }}</p> }
            </form>
            <div rodape>
              <button type="button" class="btn btn--secundario" (click)="fecharAdicionar()">Cancelar</button>
              <button type="submit" form="form-add-contato" class="btn btn--primario"
                      [disabled]="adicionandoSalvando() || !(adicionando() === 'telefone' ? novoTel() : novoDoc()).trim()">
                {{ adicionandoSalvando() ? 'Adicionando…' : (adicionando() === 'telefone' ? 'Adicionar telefone' : 'Adicionar documento') }}
              </button>
            </div>
          </ui-modal>

          <app-tarefa-modal [aberto]="novaTarefa()" [contatoId]="f.id" [contatoNome]="f.nome"
            (fechar)="novaTarefa.set(false)" (criada)="aoCriarTarefa()" />
        }
      }
    }
  `,
  styles: `
    /* Contêiner de consulta: a ficha vira 1 coluna pela largura do CONTEÚDO (com menu e rail abertos
       a janela engana), não pela do viewport. */
    :host { display: block; width: 100%; padding: var(--espacamento-6); container-type: inline-size; }
    .grade { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--espacamento-4); align-items: start; }
    @container (max-width: 900px) { .grade { grid-template-columns: minmax(0, 1fr); } }
    .col, .lateral { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--espacamento-4); min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-4); margin-top: var(--espacamento-4); }
    .selos { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin-bottom: var(--espacamento-3); }
    .selo-rfv { font-size: 11px; font-weight: 600; line-height: 1; padding: 3px 8px; border-radius: var(--raio-completo);
      border: 1px solid var(--c); color: var(--c); white-space: nowrap; }
    .acoes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); }
    .trabalhando { color: var(--texto-secundario); }
    .acoes a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: var(--densidade-alvo-clique-console); }
    .dica { color: var(--texto-secundario); margin: var(--espacamento-2) 0 0; }
    .erro { color: var(--erro); margin: var(--espacamento-2) 0 0; }
    .alerta { color: var(--atencao); margin: var(--espacamento-2) 0 0; }
    .aba-corpo { padding-top: var(--espacamento-4); min-width: 0; }
    .sub { margin: var(--espacamento-5) 0 var(--espacamento-2); }
    .tit { margin: 0 0 var(--espacamento-3); }
    .texto { margin: 0; color: var(--texto); overflow-wrap: anywhere; }
    .pre { white-space: pre-wrap; }
    .suave { color: var(--texto-secundario); margin: 0; }
    .acao-rfv { margin: var(--espacamento-2) 0 0; font-weight: 500; color: var(--acao); }
    .x { border: 0; background: transparent; color: var(--texto-suave); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
    .x:hover { color: var(--erro); }
    .x:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .add { margin-top: var(--espacamento-2); }
    .linhas { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .linhas li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    .linhas li.cancelada { color: var(--texto-suave); text-decoration: line-through; }
    .encolhe { min-width: 0; overflow-wrap: anywhere; }
    .val { margin-left: auto; }
    .trajetoria { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .trajetoria li { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); }
    .barras { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .barras li { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr) auto; align-items: center; gap: var(--espacamento-2); }
    .rot { color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .barra { height: 8px; background: var(--superficie); border-radius: var(--raio-completo); overflow: hidden; }
    .barra i { display: block; height: 100%; background: var(--acao); }
  `,
})
export class FichaContatoPagina {
  readonly servico = inject(FichaServico)
  private readonly blocos = inject(FichaBlocosServico)
  private readonly inbox = inject(InboxServico)
  private readonly router = inject(Router)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)
  readonly id = input.required<string>()

  readonly abas = ABAS_FICHA
  readonly aba = signal<string>('feed')
  readonly trilhaCarregando: readonly ItemTrilha[] = [{ rotulo: 'Contatos', rota: '/contatos' }, { rotulo: 'Contato' }]

  readonly modulos = inject(ModulosServico)
  readonly modalAgenda = signal(false)
  readonly hoje = diaIso(new Date())

  readonly abrindoConversa = signal(false)
  readonly qualificando = signal<IdAcao | null>(null)
  readonly novaTarefa = signal(false)
  readonly erroAcao = signal<string | null>(null)
  /** Contadores que mandam o feed e a aba Tarefas recarregarem quando algo muda por fora deles. */
  readonly feedVersao = signal(0)
  readonly tarefasVersao = signal(0)

  readonly trilha = computed<readonly ItemTrilha[]>(() => [
    { rotulo: 'Contatos', rota: '/contatos' }, { rotulo: this.servico.ficha()?.nome ?? 'Contato' },
  ])
  readonly selos = computed(() => { const f = this.servico.ficha(); return f ? selosDaFicha(f) : [] })
  readonly acoes = computed(() => { const f = this.servico.ficha(); return f ? acoesVisiveis(f, this.modulos.agendaAtiva()) : [] })
  readonly acoesSeparadas = computed(() => separarAcoesFicha(this.acoes()))
  /** Dica só das ações À VISTA (ex.: Conversar sem telefone); a do "⋯" vai no title do item. */
  readonly dicaDesabilitada = computed(() => this.acoesSeparadas().aVista.find((a) => a.desabilitada)?.dica ?? null)
  private readonly anonimizar = viewChild(AnonimizarContatoComponente)
  /** O "⋯": Nova tarefa, Agendar, Qualificar, Descartar e (admin) Anonimizar — destrutivos por último. */
  readonly itensMenu = computed<readonly ItemMenuMais[]>(() => {
    const itens: ItemMenuMais[] = this.acoesSeparadas().noMenu.map((a) => ({
      id: a.id, rotulo: a.rotulo, dica: a.dica, desabilitado: a.desabilitada || this.qualificando() !== null,
      perigo: a.id === 'descartar',
    }))
    if (this.anonimizar()?.admin()) {
      itens.push({ id: 'anonimizar', rotulo: 'Anonimizar (LGPD)', perigo: true,
        dica: 'Apaga os dados pessoais deste contato (LGPD). Não tem volta.', desabilitado: this.anonimizar()?.trabalhando() === true })
    }
    return itens
  })

  aoMenu(f: FichaContato, id: string): void {
    if (id === 'anonimizar') { void this.anonimizar()?.anonimizar(); return }
    void this.agir(f, id as IdAcao)
  }
  readonly cadastro = computed(() => { const f = this.servico.ficha(); return f ? camposDeCadastro(f) : [] })
  readonly informacoes = computed(() => { const f = this.servico.ficha(); return f ? camposDeInformacao(f) : [] })

  // Edição de telefone e documento
  readonly novoTel = signal('')
  readonly novoDoc = signal('')
  readonly novoDocTipo = signal<'cnpj' | 'cpf'>('cnpj')
  /** Modal de adicionar telefone ou documento (cadastro curto, padrão A). */
  readonly adicionando = signal<'telefone' | 'documento' | null>(null)
  readonly adicionandoSalvando = signal(false)
  readonly opcoesDoc = [{ valor: 'cnpj', rotulo: 'CNPJ' }, { valor: 'cpf', rotulo: 'CPF' }]

  constructor() {
    // ⚠️ `id` vem da rota. effect recarrega ao mudar: navegar de um contato para outro troca o dado
    //    sem recriar o componente — e volta para a aba Feed.
    effect(() => {
      const id = this.id()
      if (id) { this.servico.vincular(id); this.aba.set('feed'); void this.servico.carregar(id) }
    })
  }

  recarregar(): void { void this.servico.carregar(this.id()) }
  avancarFeed(): void { this.feedVersao.update((v) => v + 1) }
  subtitulo(f: FichaContato): string {
    return [f.razaoSocial, f.nomeFantasia && f.nomeFantasia !== f.razaoSocial ? f.nomeFantasia : null].filter(Boolean).join(' · ')
  }

  /** Despacha as ações do cabeçalho que não são links. */
  async agir(f: FichaContato, acao: IdAcao): Promise<void> {
    this.erroAcao.set(null)
    switch (acao) {
      case 'conversar': await this.abrirConversa(f); return
      case 'nova-tarefa': this.novaTarefa.set(true); return
      case 'agendar': if (this.modulos.agendaAtiva()) this.modalAgenda.set(true); return
      case 'qualificar': case 'descartar': await this.qualificar(f, acao); return
      default: return
    }
  }

  /** Abre (ou cria) a conversa no rail. A API decide o número; a falha vem tipificada e vai para a tela. */
  async abrirConversa(f: FichaContato): Promise<void> {
    if (this.abrindoConversa()) return
    this.abrindoConversa.set(true)
    this.erroAcao.set(null)
    try {
      if (f.telefones.length === 0) { this.erroAcao.set('Este contato não tem telefone: cadastre um ao lado para conversar.'); return }
      const r = await this.servico.conversaDoContato(f.id)
      if (!r.ok) { this.erroAcao.set(r.mensagem); return }
      await this.inbox.abrir(r.conversaId)
    } finally {
      this.abrindoConversa.set(false)
    }
  }

  private async qualificar(f: FichaContato, acao: 'qualificar' | 'descartar'): Promise<void> {
    if (acao === 'descartar') {
      const ok = await this.confirmacao.confirmar({
        titulo: 'Descartar este contato?', mensagem: `${f.nome} sai da fila de qualificação. Dá para qualificar de novo depois.`,
        acao: 'Descartar', perigo: true,
      })
      if (!ok) return
    }
    this.qualificando.set(acao)
    try {
      await this.blocos.qualificar(f.id, estadoDaAcao(acao))
      this.toast.sucesso(acao === 'qualificar' ? 'Contato qualificado' : 'Contato descartado')
      await this.servico.carregar(f.id, true)
      this.avancarFeed()
    } catch (e) {
      this.erroAcao.set(mensagemDeErro(e, 'Não foi possível atualizar a qualificação.'))
    } finally {
      this.qualificando.set(null)
    }
  }

  /** The modal shows the toast; the ficha closes it (the modal never closes itself) and refreshes the feed. */
  aoCriarEvento(): void {
    this.modalAgenda.set(false)
    this.avancarFeed()
  }

  aoCriarTarefa(): void {
    this.novaTarefa.set(false)
    this.tarefasVersao.update((v) => v + 1)
    this.avancarFeed() // the modal already shows the "Tarefa criada" toast
  }

  async removerTelefone(t: { seq: number; e164: string }): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover telefone?', mensagem: `${t.e164} deixa de ser um contato deste cliente.`, acao: 'Remover',
    })
    if (!ok) return
    if (await this.servico.removerTelefone(t.seq)) this.toast.sucesso('Telefone removido')
  }

  async removerDocumento(d: { seq: number; numero: string; tipo: string }): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover documento?', mensagem: `${d.tipo.toUpperCase()} ${d.numero} sai da ficha deste cliente.`, acao: 'Remover',
    })
    if (!ok) return
    if (await this.servico.removerDocumento(d.seq)) this.toast.sucesso('Documento removido')
  }

  abrirAdicionar(tipo: 'telefone' | 'documento'): void {
    this.novoTel.set(''); this.novoDoc.set(''); this.novoDocTipo.set('cnpj')
    this.servico.erroEdicao.set(null)
    this.adicionando.set(tipo)
  }
  fecharAdicionar(): void { if (!this.adicionandoSalvando()) this.adicionando.set(null) }
  /** Erro fica NO modal (o número digitado continua); sucesso fecha e a ficha recarrega. */
  async salvarAdicionar(ev: Event): Promise<void> {
    ev.preventDefault()
    const tipo = this.adicionando()
    const valor = (tipo === 'telefone' ? this.novoTel() : this.novoDoc()).trim()
    if (!tipo || !valor || this.adicionandoSalvando()) return
    this.adicionandoSalvando.set(true)
    try {
      const ok = tipo === 'telefone'
        ? await this.servico.addTelefone(valor)
        : await this.servico.addDocumento(this.novoDocTipo(), valor)
      if (ok) this.adicionando.set(null)
    } finally { this.adicionandoSalvando.set(false) }
  }

  rotuloSeg(codigo: string): string { return rotuloSegmento(codigo) }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  arred(n: number): number { return Math.round(n) }
  pct(v: number, max: number): number { return max > 0 ? Math.round((v / max) * 100) : 0 }
  data(iso: string): string { return new Date(iso).toLocaleDateString('pt-BR') }
  enderecoTexto(e: NonNullable<FichaContato['endereco']>): string {
    return [
      [e.logradouro, e.numero].filter(Boolean).join(', '),
      e.complemento, e.bairro, [e.cidade, e.uf].filter(Boolean).join('/'), e.cep,
    ].filter(Boolean).join(' · ')
  }
}
