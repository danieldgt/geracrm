import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, FiltroPeriodoComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'

interface Conta {
  readonly id: string
  readonly plataforma: string
  readonly idExterno: string
  readonly nome: string
  readonly moeda: string
  readonly ativo: boolean
  /** ⚠️ Sem ela, a venda NÃO volta para a plataforma (AQ-15). */
  readonly conversaoActionId: string | null
}
interface Anuncio {
  readonly id: string
  readonly nome: string
  readonly estado: string
  readonly campanha: string
  readonly custoCentavos: string
  readonly cliques: number
  readonly impressoes: number
  readonly leads: number
}
interface Campanha {
  readonly id: string
  readonly nome: string
  readonly estado: string
  readonly plataforma: string
  readonly modoEntrada: 'inbound_wa' | 'outbound_formulario'
  readonly leads: number
}
interface Lp {
  readonly id: string
  readonly nome: string
  readonly modo: 'inbound_wa' | 'outbound_formulario'
  readonly url: string
  readonly ativo: boolean
  readonly sessoes: number
  readonly consumidas: number
  /** ⚠️ `null` = ninguém clicou ainda. Diferente de 0% (todo clique preservou o código). */
  readonly taxaPerdida: number | null
}
interface EtapaFunil {
  readonly etapa: string
  readonly rotulo: string
  readonly quantidade: number
  readonly custoUnitarioCentavos: number | null
  readonly taxaDaAnterior: number | null
  /** ⚠️ `true` = medido; `false` = depende do modelo de atribuição declarado. */
  readonly fato: boolean
}
interface Funil {
  readonly custoCentavos: number
  readonly modelo: string
  readonly janelaDias: number
  readonly etapas: readonly EtapaFunil[]
  readonly maiorPerda: { readonly de: string; readonly para: string; readonly taxa: number } | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
type ModoEntrada = 'inbound_wa' | 'outbound_formulario'

const OPCOES_PLATAFORMA: OpcaoSelect[] = [
  { valor: 'google', rotulo: 'Google Ads' }, { valor: 'meta', rotulo: 'Meta' }, { valor: 'tiktok', rotulo: 'TikTok' },
]
const OPCOES_MODO: OpcaoSelect[] = [
  { valor: 'inbound_wa', rotulo: 'Lead escreve (WhatsApp)' }, { valor: 'outbound_formulario', rotulo: 'Nós ligamos (formulário)' },
]
const OPCOES_MODO_LP: OpcaoSelect[] = [
  { valor: 'inbound_wa', rotulo: 'Botão de WhatsApp (o lead escreve)' }, { valor: 'outbound_formulario', rotulo: 'Formulário (nós ligamos)' },
]

/**
 * Mídia paga (AQ-06) — custo e leads por anúncio. Padrão Lista (L): anúncios, contas,
 * campanhas e landing pages em ui-tabela; conectar conta e criar landing page em ui-modal;
 * o período em ui-filtro-periodo.
 *
 * ⚠️ **Custo por lead é o número que a tela existe para mostrar**, e não CPL da
 * plataforma: é o nosso custo dividido pelos leads que ENTRARAM no CRM.
 *
 * ⚠️ ROAS **não aparece aqui de propósito.** Ele exige declarar o modelo de
 * atribuição e a janela (AMK-009), e um número desses solto numa lista viraria
 * promessa que o produto não sustenta. Vive na tela do anúncio, com o rótulo ao lado.
 */
@Component({
  selector: 'app-midia',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente,
    FiltroPeriodoComponente, IconeComponente, ModalComponente, PaginacaoComponente, RouterLink, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Mídia paga" subtitulo="O que cada anúncio custou e quantos leads trouxe, no período.">
      <button type="button" class="btn btn--secundario" (click)="abrirConta()"><ui-icone nome="plus" />Conectar conta</button>
      <button type="button" class="btn btn--secundario" (click)="abrirLp()"><ui-icone nome="plus" />Landing page</button>
    </ui-cabecalho-tela>

    <div class="corpo">
      <ui-filtro-periodo [(inicio)]="de" [(fim)]="ate" (aplicar)="carregar()" />

      <!-- ⚠️ O funil vem ANTES da lista de anúncios de propósito: a lista diz
           quanto cada peça custou; o funil diz em qual ETAPA o dinheiro está parando. -->
      @if (funil(); as f) {
        <section class="painel funil" aria-labelledby="titulo-funil">
          <h2 id="titulo-funil" class="titulo-funil">Onde o dinheiro está parando
            <span class="etiqueta">{{ f.modelo === 'primeiro_toque' ? 'Primeiro toque' : 'Último toque' }} · {{ f.janelaDias }}d</span>
          </h2>
          <div class="degraus">
            @for (e of f.etapas; track e.etapa) {
              <div class="degrau" [class.modelado]="!e.fato">
                <span class="rot">{{ e.rotulo }}</span>
                <span class="qtd">{{ e.quantidade }}</span>
                <span class="sub">
                  @if (e.taxaDaAnterior !== null) { {{ pct(e.taxaDaAnterior) }} do anterior · }
                  <!-- ⚠️ Traço, não R$ 0,00: etapa sem ninguém tem custo indefinido. -->
                  {{ e.custoUnitarioCentavos === null ? '—' : dinheiro(e.custoUnitarioCentavos) }}
                </span>
              </div>
            }
          </div>
          @if (f.maiorPerda; as p) {
            <p class="perda"><ui-icone nome="alert-triangle" />A maior perda está entre <strong>{{ p.de }}</strong> e
              <strong>{{ p.para }}</strong> ({{ pct(p.taxa) }} passam).</p>
          }
          <p class="nota-funil">Os três primeiros degraus são <strong>medidos</strong>. Dali para baixo,
            o vínculo com a mídia é <strong>modelo de atribuição</strong> — por isso o rótulo anda colado.</p>
        </section>
      }

      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à mídia paga" descricao="Sua conta não tem permissão para ver a mídia." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a mídia paga" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <section class="bloco-secao" aria-labelledby="titulo-anuncios">
            <h2 id="titulo-anuncios" class="txt-secao">Anúncios</h2>
            @if (itens().length === 0) {
              <!-- ⚠️ Vazio aqui quase nunca é "não há dado": é conta não conectada
                   ou sincronização que ainda não rodou. -->
              <ui-estado titulo="Nenhum anúncio no período"
                descricao="Se a conta acabou de ser conectada, a primeira sincronização pode levar algumas horas." />
            } @else {
              <p class="total txt-denso">
                Total: <strong>{{ dinheiro(totalCusto()) }}</strong> de custo · <strong>{{ totalLeads() }}</strong> leads ·
                custo por lead <strong>{{ custoPorLeadTotal() }}</strong>
              </p>
              <ui-tabela [colunas]="colunas" [linhas]="linhas()">
                <!-- ⚠️ O nome vira link para o ROI (AQ-16): é onde o "gastei X" encontra o "faturei Y". -->
                <ng-template uiCelula="nome" let-a>
                  <a class="link-anuncio" [routerLink]="['/midia/anuncio', a.id]">{{ a.nome }}</a>
                  @if (a.estado !== 'ativa') { <ui-badge>{{ a.estado }}</ui-badge> }
                </ng-template>
                <ng-template uiCelula="custo" let-a><span class="txt-dados">{{ dinheiro(a.custoCentavos) }}</span></ng-template>
                <!-- ⚠️ Traço, não "R$ 0,00", quando não há lead: zero lead com custo não é custo-por-lead zero. -->
                <ng-template uiCelula="cpl" let-a><span class="txt-dados forte">{{ custoPorLead(a) }}</span></ng-template>
              </ui-tabela>
              <ui-paginacao [mostrados]="itens().length" [temMais]="temMais()" [carregando]="carregandoMais()" (mais)="carregarMais()" />
            }
          </section>

          <section class="bloco-secao" aria-labelledby="titulo-contas">
            <h2 id="titulo-contas" class="txt-secao">Contas de anúncio</h2>
            <ui-tabela [colunas]="colunasContas" [linhas]="contasLinhas()">
              <ng-template uiCelula="plataforma" let-c>
                <span class="txt-dados">{{ c.plataforma }} · {{ c.idExterno }} · {{ c.moeda }}</span>
              </ng-template>
              <ng-template uiCelula="conversao" let-c>
                <!-- ⚠️ O loop de dados só fecha com a ação de conversão. Sem ela o produto LÊ o gasto e nunca devolve a venda. -->
                @if (c.conversaoActionId) {
                  <ui-badge tom="sucesso"><ui-icone nome="link" [tamanho]="14" />devolve conversão · ação {{ c.conversaoActionId }}</ui-badge>
                  <button type="button" class="btn btn--fantasma btn--pequeno" (click)="editarAcao(c)">Alterar</button>
                } @else if (editandoAcao() === c.id) {
                  <span class="acao-edicao">
                    <ui-campo rotulo="Id da ação de conversão" placeholder="987654321" [valor]="acaoTexto()" (valorChange)="acaoTexto.set($event)" />
                    <span class="acoes">
                      <button type="button" class="btn btn--primario btn--pequeno" (click)="salvarAcao(c)">Salvar</button>
                      <button type="button" class="btn btn--fantasma btn--pequeno" (click)="editandoAcao.set(null)">Cancelar</button>
                    </span>
                  </span>
                } @else {
                  <ui-badge tom="atencao"><ui-icone nome="alert-triangle" [tamanho]="14" />sem ação de conversão — a venda não volta</ui-badge>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="editarAcao(c)">Configurar</button>
                }
              </ng-template>
              <ng-template uiCelula="situacao" let-c>
                @if (!c.ativo) { <ui-badge>inativa</ui-badge> } @else { <ui-badge tom="sucesso">ativa</ui-badge> }
              </ng-template>
              <div uiVazio><ui-estado titulo="Nenhuma conta conectada" descricao="Conecte a conta de anúncio para trazer o custo e os leads." /></div>
            </ui-tabela>
            <!-- ⚠️ A moeda não muda depois: vira propriedade da conta. Errar aqui contamina todo o custo. -->
            <p class="dica txt-denso">A moeda <strong>não pode ser alterada</strong> depois de conectar. Ela precisa bater com a configurada na plataforma.</p>
          </section>

          @if (campanhas().length > 0) {
            <section class="bloco-secao" aria-labelledby="titulo-campanhas">
              <h2 id="titulo-campanhas" class="txt-secao">Modo de entrada das campanhas</h2>
              <ui-tabela [colunas]="colunasCampanhas" [linhas]="campanhasLinhas()">
                <ng-template uiCelula="plataforma" let-c><span class="txt-dados">{{ c.plataforma }} · {{ c.leads }} leads</span></ng-template>
                <ng-template uiCelula="modo" let-c>
                  <ui-select [rotulo]="'Modo de entrada de ' + c.nome" [opcoes]="opcoesModo" [valor]="c.modoEntrada"
                    (valorChange)="trocarModo(c, $event)" />
                </ng-template>
              </ui-tabela>
              <!-- ⚠️ Vale daqui para a frente: o modo é copiado para cada lead na entrada. -->
              <p class="dica txt-denso">Vale <strong>daqui para a frente</strong>: o modo é copiado para cada lead
                na entrada, então o histórico continua dizendo o que valia quando ele chegou.</p>
              @if (erroCampanha(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
            </section>
          }

          <section class="bloco-secao" aria-labelledby="titulo-lps">
            <h2 id="titulo-lps" class="txt-secao">Landing pages do anúncio</h2>
            <!-- ⚠️ Sem destino não há campanha no Google: o anúncio precisa de uma URL, e é ela que carrega o clique até a conversa. -->
            @if (lps().length === 0) {
              <ui-estado titulo="Nenhuma landing page" descricao="Crie a página que o anúncio vai apontar.">
                <button type="button" class="btn btn--primario" (click)="abrirLp()">Criar landing page</button>
              </ui-estado>
            } @else {
              <ui-tabela [colunas]="colunasLp" [linhas]="lpsLinhas()">
                <ng-template uiCelula="pagina" let-l>
                  <strong>{{ l.nome }}</strong>
                  <ui-badge>{{ l.modo === 'inbound_wa' ? 'WhatsApp' : 'Formulário' }}</ui-badge>
                  @if (!l.ativo) { <ui-badge tom="atencao">desligada</ui-badge> }
                </ng-template>
                <ng-template uiCelula="link" let-l>
                  <span class="url txt-dados">{{ urlCompleta(l.url) }}</span>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="copiar(l.url)">
                    {{ copiado() === l.url ? 'Copiado' : 'Copiar link' }}
                  </button>
                </ng-template>
                <ng-template uiCelula="cliques" let-l>
                  <span class="txt-dados">{{ l.sessoes }} cliques</span>
                  <!-- ⚠️ "—" quando ninguém clicou: 0% de código perdido sem sessão nenhuma seria uma saúde que ninguém observou. -->
                  <span class="suave">
                    código perdido:
                    @if (l.taxaPerdida === null) { — } @else { <span [class.ruim]="l.taxaPerdida > 0.5">{{ pct(l.taxaPerdida) }}</span> }
                  </span>
                </ng-template>
              </ui-tabela>
            }
            @if (erroLp(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
          </section>
        }
      }
    </div>

    <!-- Conectar conta de anúncio: modal de cadastro (M). -->
    <ui-modal [aberto]="contaAberta()" titulo="Conectar conta de anúncio" largura="m" (fechar)="fecharConta()">
      <form id="form-conta" class="campos" (submit)="conectar($event)">
        <ui-select rotulo="Plataforma" [opcoes]="opcoesPlataforma" [valor]="novaPlataforma()" (valorChange)="novaPlataforma.set($event)" />
        <ui-campo rotulo="ID da conta" placeholder="997-075-4431" [obrigatorio]="true" [valor]="novoIdExterno()"
          (valorChange)="novoIdExterno.set($event)" />
        <ui-campo rotulo="Nome" placeholder="Drezz — aquisição" [obrigatorio]="true" [valor]="novoNome()"
          (valorChange)="novoNome.set($event)" />
        <ui-campo rotulo="Moeda" placeholder="BRL" dica="Três letras. Não muda depois de conectar." [valor]="novaMoeda()"
          (valorChange)="novaMoeda.set($event.toUpperCase())" />
        @if (erroConectar(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharConta()" [disabled]="conectando()">Cancelar</button>
        <button type="submit" form="form-conta" class="btn btn--primario" [disabled]="conectando() || !novoIdExterno().trim() || !novoNome().trim()">
          {{ conectando() ? 'Conectando…' : 'Conectar' }}
        </button>
      </div>
    </ui-modal>

    <!-- Nova landing page: modal de cadastro (M). O modo decide quem começa a conversa. -->
    <ui-modal [aberto]="lpAberta()" titulo="Nova landing page" largura="m" (fechar)="fecharLp()">
      <form id="form-lp" class="campos" (submit)="criarLp($event)">
        <ui-select rotulo="Modo" [opcoes]="opcoesModoLp" [valor]="lpModo()" (valorChange)="setLpModo($event)"
          [dica]="lpModo() === 'inbound_wa' ? 'O lead escreve primeiro: a janela de 24h nasce aberta e dá para responder sem template.' : 'Nós iniciamos a conversa: fora da janela de 24h só um template aprovado abre o contato.'" />
        <ui-campo rotulo="Nome interno" placeholder="Uniformes — PE" [obrigatorio]="true" [valor]="lpNome()" (valorChange)="lpNome.set($event)" />
        <ui-campo rotulo="Título da página" placeholder="Uniformes para a sua equipe" [obrigatorio]="true" [valor]="lpTitulo()"
          (valorChange)="lpTitulo.set($event)" />
        @if (lpModo() === 'inbound_wa') {
          <ui-campo rotulo="WhatsApp de destino" placeholder="55 81 99999-8888" dica="Com DDI e DDD." [valor]="lpTelefone()"
            (valorChange)="lpTelefone.set($event)" />
        }
        @if (erroLp(); as e) { <p class="erro-texto" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharLp()" [disabled]="criandoLp()">Cancelar</button>
        <button type="submit" form="form-lp" class="btn btn--primario" [disabled]="criandoLp() || !lpNome().trim() || !lpTitulo().trim()">
          {{ criandoLp() ? 'Criando…' : 'Criar landing page' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-filtro-periodo { display: block; }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-5); min-width: 0; }
    .bloco-secao { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .campos { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .total { margin: 0; color: var(--texto-secundario); }
    .dica { margin: 0; color: var(--texto-suave); }
    .suave { color: var(--texto-suave); font-size: 12px; }
    .forte { color: var(--texto); font-weight: 600; }
    .erro-texto { margin: 0; color: var(--erro); font-size: 13px; }
    .link-anuncio { color: var(--acao); text-decoration: none; }
    .link-anuncio:hover { text-decoration: underline; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .acao-edicao { display: grid; gap: var(--espacamento-2); min-width: 220px; }
    .url { display: block; min-width: 0; word-break: break-all; color: var(--texto-secundario); font-size: 12px; }
    .ruim { color: var(--erro); }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .titulo-funil { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; margin: 0 0 var(--espacamento-4); font-size: 15px; color: var(--texto); }
    .etiqueta { font-size: 11px; font-weight: 400; padding: 1px 8px; border-radius: var(--raio-completo); border: 1px solid var(--atencao); color: var(--atencao); }
    /* auto-fit: de 320px a wide sem media query e sem degrau espremido. */
    .degraus { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--espacamento-3); }
    .degrau { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: var(--espacamento-2);
      border-left: 3px solid var(--sucesso); background: var(--superficie); border-radius: var(--raio-controle); }
    /* Modelado × medido: a diferença é visual, não uma nota de rodapé. */
    .degrau.modelado { border-left-color: var(--atencao); border-left-style: dashed; }
    .degrau .rot { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    .degrau .qtd { font-size: 20px; color: var(--texto); font-variant-numeric: tabular-nums; }
    .degrau .sub { font-size: 11px; color: var(--texto-secundario); }
    .perda { display: flex; align-items: center; gap: var(--espacamento-2); margin: var(--espacamento-4) 0 0; padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .nota-funil { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); line-height: 1.5; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class MidiaPagina implements OnInit {
  readonly #http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly contas = signal<readonly Conta[]>([])
  readonly itens = signal<readonly Anuncio[]>([])
  readonly temMais = signal(false)
  readonly carregandoMais = signal(false)
  readonly #cursor = signal<string | null>(null)

  readonly opcoesPlataforma = OPCOES_PLATAFORMA
  readonly opcoesModo = OPCOES_MODO
  readonly opcoesModoLp = OPCOES_MODO_LP
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Anúncio' },
    { chave: 'campanha', rotulo: 'Campanha' },
    { chave: 'impressoes', rotulo: 'Impressões', alinhamento: 'dir', mono: true, largura: '120px' },
    { chave: 'cliques', rotulo: 'Cliques', alinhamento: 'dir', mono: true, largura: '100px' },
    { chave: 'custo', rotulo: 'Custo', alinhamento: 'dir', largura: '130px' },
    { chave: 'leads', rotulo: 'Leads', alinhamento: 'dir', mono: true, largura: '90px' },
    { chave: 'cpl', rotulo: 'Custo/lead', alinhamento: 'dir', largura: '130px' },
  ]
  protected readonly colunasContas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Conta' },
    { chave: 'plataforma', rotulo: 'Plataforma' },
    { chave: 'situacao', rotulo: 'Situação', largura: '100px' },
    { chave: 'conversao', rotulo: 'Conversão (devolve a venda)' },
  ]
  protected readonly colunasCampanhas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Campanha' },
    { chave: 'plataforma', rotulo: 'Plataforma' },
    { chave: 'modo', rotulo: 'Modo de entrada', largura: '280px' },
  ]
  protected readonly colunasLp: ColunaTabela[] = [
    { chave: 'pagina', rotulo: 'Página' },
    { chave: 'link', rotulo: 'Link para o anúncio' },
    { chave: 'cliques', rotulo: 'Cliques', largura: '220px' },
  ]
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly contasLinhas = computed(() => this.contas() as unknown as readonly LinhaTabela[])
  protected readonly campanhasLinhas = computed(() => this.campanhas() as unknown as readonly LinhaTabela[])
  protected readonly lpsLinhas = computed(() => this.lps() as unknown as readonly LinhaTabela[])

  readonly novaPlataforma = signal('google')
  readonly novoIdExterno = signal('')
  readonly novoNome = signal('')
  readonly novaMoeda = signal('BRL')
  readonly conectando = signal(false)
  readonly erroConectar = signal<string | null>(null)
  readonly contaAberta = signal(false)

  readonly de = signal(this.#diasAtras(30))
  readonly ate = signal(this.#diasAtras(0))

  readonly funil = signal<Funil | null>(null)
  readonly lps = signal<readonly Lp[]>([])
  readonly campanhas = signal<readonly Campanha[]>([])
  readonly lpAberta = signal(false)
  readonly lpModo = signal<ModoEntrada>('inbound_wa')
  readonly lpNome = signal('')
  readonly lpTitulo = signal('')
  readonly lpTelefone = signal('')
  readonly criandoLp = signal(false)
  readonly erroCampanha = signal<string | null>(null)
  readonly editandoAcao = signal<string | null>(null)
  readonly acaoTexto = signal('')
  readonly erroLp = signal<string | null>(null)
  readonly copiado = signal<string | null>(null)

  readonly totalCusto = computed(() =>
    // ⚠️ String → Number aqui, e não somando strings: `custoCentavos` vem como
    //    texto porque é bigint no banco (INV-46). "2" + "3" seria "23".
    String(this.itens().reduce((s, a) => s + Number(a.custoCentavos), 0)))
  readonly totalLeads = computed(() => this.itens().reduce((s, a) => s + a.leads, 0))

  ngOnInit(): void { void this.carregar() }

  setLpModo(valor: string): void { this.lpModo.set(valor as ModoEntrada) }

  abrirConta(): void { this.erroConectar.set(null); this.contaAberta.set(true) }
  fecharConta(): void { if (!this.conectando()) this.contaAberta.set(false) }
  abrirLp(): void { this.erroLp.set(null); this.lpAberta.set(true) }
  fecharLp(): void { if (!this.criandoLp()) this.lpAberta.set(false) }

  #diasAtras(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  }

  dinheiro(centavos: string | number): string {
    return (Number(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  /** ⚠️ Traço quando não há lead: zero lead não é custo-por-lead zero, é indefinido. */
  custoPorLead(a: Anuncio): string {
    return a.leads > 0 ? this.dinheiro(Number(a.custoCentavos) / a.leads) : '—'
  }
  custoPorLeadTotal(): string {
    const l = this.totalLeads()
    return l > 0 ? this.dinheiro(Number(this.totalCusto()) / l) : '—'
  }

  async conectar(ev: Event): Promise<void> {
    ev.preventDefault()
    this.conectando.set(true)
    this.erroConectar.set(null)
    try {
      await firstValueFrom(this.#http.post('/v1/aquisicao/contas', {
        plataforma: this.novaPlataforma(),
        idExterno: this.novoIdExterno().trim(),
        nome: this.novoNome().trim(),
        moeda: this.novaMoeda().trim() || 'BRL',
      }))
      this.novoIdExterno.set(''); this.novoNome.set('')
      this.contaAberta.set(false)
      await this.carregar()
    } catch (e) {
      // ⚠️ Conflito é resultado ESPERADO, com mensagem própria — a API devolve 409 nomeado.
      const st = e instanceof HttpErrorResponse ? e.status : 0
      this.erroConectar.set(
        st === 409 ? 'Esta conta já está conectada.'
        : st === 422 ? 'Confira a plataforma e o ID da conta.'
        : 'Não foi possível conectar. Tente de novo.')
    } finally {
      this.conectando.set(false)
    }
  }

  /**
   * ⚠️ A URL que vai no anúncio é ABSOLUTA e sai da origem atual: a API devolve o
   * caminho, e o link é servido na mesma origem do console (proxy do nginx). Um
   * caminho relativo colado no Google Ads não é um destino.
   */
  urlCompleta(caminho: string): string {
    return `${location.origin}${caminho}`
  }

  pct(taxa: number): string { return `${Math.round(taxa * 100)}%` }

  editarAcao(c: Conta): void {
    this.editandoAcao.set(c.id)
    this.acaoTexto.set(c.conversaoActionId ?? '')
  }

  async salvarAcao(c: Conta): Promise<void> {
    try {
      await firstValueFrom(this.#http.patch(`/v1/aquisicao/contas/${c.id}`, {
        conversaoActionId: this.acaoTexto().trim() || null,
      }))
      this.editandoAcao.set(null)
      await this.carregar()
    } catch {
      this.erroConectar.set('Não foi possível salvar a ação de conversão.')
    }
  }

  async copiar(caminho: string): Promise<void> {
    const url = this.urlCompleta(caminho)
    try {
      await navigator.clipboard.writeText(url)
      this.copiado.set(caminho)
      setTimeout(() => this.copiado.set(null), 2000)
    } catch {
      // Clipboard bloqueado (http, permissão): a URL está na tela e dá para selecionar à mão.
      this.erroLp.set('Não consegui copiar. Selecione o link na tela.')
    }
  }

  async criarLp(ev: Event): Promise<void> {
    ev.preventDefault()
    this.criandoLp.set(true)
    this.erroLp.set(null)
    try {
      await firstValueFrom(this.#http.post('/v1/aquisicao/lps', {
        nome: this.lpNome().trim(),
        titulo: this.lpTitulo().trim(),
        telefone: this.lpTelefone().trim(),
        modo: this.lpModo(),
      }))
      this.lpNome.set(''); this.lpTitulo.set(''); this.lpTelefone.set('')
      this.lpAberta.set(false)
      await this.#carregarLps()
    } catch (e) {
      const st = e instanceof HttpErrorResponse ? e.status : 0
      const campo = e instanceof HttpErrorResponse ? String(e.error?.campo ?? '') : ''
      this.erroLp.set(
        st === 422 && campo === 'telefone' ? 'Informe o WhatsApp com DDD e DDI (ex.: 55 81 99999-8888).'
        : st === 422 ? 'Confira o nome e o título da página.'
        : 'Não foi possível criar a landing page. Tente de novo.')
    } finally {
      this.criandoLp.set(false)
    }
  }

  /** Escolha do <ui-select> de modo: o valor vem como texto e é restrito aos dois modos. */
  trocarModo(c: Campanha, valor: string): void {
    this.mudarModo(c, valor as ModoEntrada)
  }

  /**
   * ⚠️ Troca otimista: a linha muda na hora e volta atrás se o servidor recusar.
   * Um `<select>` que só se move depois do ida-e-volta parece quebrado.
   */
  async mudarModo(c: Campanha, modo: ModoEntrada): Promise<void> {
    if (modo === c.modoEntrada) return
    const anterior = this.campanhas()
    this.campanhas.update((l) => l.map((x) => (x.id === c.id ? { ...x, modoEntrada: modo } : x)))
    this.erroCampanha.set(null)
    try {
      await firstValueFrom(this.#http.patch(`/v1/aquisicao/campanhas/${c.id}`, { modoEntrada: modo }))
    } catch {
      this.campanhas.set(anterior)
      this.erroCampanha.set('Não foi possível mudar o modo desta campanha. Tente de novo.')
    }
  }

  /** ⚠️ PARCIAL: se as LPs falharem, a tela de mídia continua de pé. */
  async #carregarLps(): Promise<void> {
    try {
      const r = await firstValueFrom(this.#http.get<{ itens: Lp[] }>('/v1/aquisicao/lps'))
      this.lps.set(r.itens)
    } catch { this.lps.set([]) }
  }

  /** ⚠️ PARCIAL: o funil é leitura de apoio — se falhar, a lista continua. */
  async #carregarFunil(): Promise<void> {
    const q = new URLSearchParams({
      de: this.de(), ate: this.ate(), modelo: 'ultimo_toque', janelaDias: '14',
    })
    try {
      this.funil.set(await firstValueFrom(this.#http.get<Funil>(`/v1/aquisicao/funil?${q.toString()}`)))
    } catch { this.funil.set(null) }
  }

  /** ⚠️ PARCIAL pelo mesmo motivo: campanha é contexto, não o dado principal. */
  async #carregarCampanhas(): Promise<void> {
    try {
      const r = await firstValueFrom(this.#http.get<{ itens: Campanha[] }>('/v1/aquisicao/campanhas'))
      this.campanhas.set(r.itens)
    } catch { this.campanhas.set([]) }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.#cursor.set(null)
    try {
      const c = await firstValueFrom(
        this.#http.get<{ contas: Conta[] }>('/v1/aquisicao/contas'))
      this.contas.set(c.contas)
      await this.#carregarLps()
      await this.#carregarCampanhas()
      await this.#carregarFunil()
      const r = await this.#buscarPagina(null)
      this.itens.set(r.itens)
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    if (this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.#buscarPagina(this.#cursor())
      this.itens.update((atual) => [...atual, ...r.itens])
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
    } catch { this.estado.set('erro') } finally { this.carregandoMais.set(false) }
  }

  #buscarPagina(cursor: string | null): Promise<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }> {
    const q = new URLSearchParams({ de: this.de(), ate: this.ate() })
    if (cursor) q.set('cursor', cursor)
    return firstValueFrom(
      this.#http.get<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }>(
        `/v1/aquisicao/anuncios?${q.toString()}`))
  }
}
