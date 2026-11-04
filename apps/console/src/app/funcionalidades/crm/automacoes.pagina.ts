import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, IconeComponente,
  ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente, ToastServico, ehStatus, mensagemDeErro, mesclarPagina,
  queryDeLista, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { ACOES_AUTOMACAO, GATILHOS_AUTOMACAO, MAX_TEXTO_AUTOMACAO, ROTULO_ACAO_AUTOMACAO, ROTULO_GATILHO_AUTOMACAO, type RoteiroPosVenda } from '@geracrm/shared'
import {
  ACAO_POS_VENDA, DIAS_DEPOIS_MAX, ROTEIROS_POS_VENDA, ROTULO_ROTEIRO_POS_VENDA, acaoAoTrocarGatilho, avisoSoTemplate, descreverPosVenda,
  gatilhoAoTrocarAcao, paramsPosVenda,
} from './automacoes.regras.js'

interface Automacao {
  readonly id: string; readonly nome: string; readonly ativa: boolean
  readonly gatilho: string; readonly gatilhoParam: Record<string, unknown>
  readonly acao: string; readonly acaoParam: Record<string, unknown>
  readonly ultimaExecucaoEm: string | null; readonly execucoes: number
}
interface Ref { readonly id: string; readonly nome: string }
interface Pagina { readonly itens: Automacao[]; readonly proximoCursor: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const SEGMENTOS: Ref[] = [
  { id: 'campeao', nome: 'Campeão' }, { id: 'cliente-fiel', nome: 'Cliente Fiel' },
  { id: 'potencial-fiel', nome: 'Potencial Fiel' }, { id: 'cliente-promissor', nome: 'Cliente Promissor' },
  { id: 'cliente-recente', nome: 'Cliente Recente' }, { id: 'nao-perder', nome: 'Não Perder' },
  { id: 'em-risco', nome: 'Em Risco' }, { id: 'precisa-atencao', nome: 'Precisa de Atenção' },
  { id: 'semi-perdido', nome: 'Semi Perdido' }, { id: 'hibernando', nome: 'Hibernando' }, { id: 'perdido', nome: 'Perdido' },
]
const GAT_ROTULO: Readonly<Record<string, string>> = ROTULO_GATILHO_AUTOMACAO
const ACAO_ROTULO: Readonly<Record<string, string>> = ROTULO_ACAO_AUTOMACAO
/** Mesmo teto do servidor — mensagem longa no WhatsApp não é lida. */
const MAX_TEXTO = MAX_TEXTO_AUTOMACAO
interface TemplateRef { readonly id: string; readonly nome: string; readonly statusMeta: string }

/**
 * Automações — regras gatilho→ação (varredura agendada, ações internas; ver
 * docs/automacoes.md). Lista L com paginação por cursor; a criação é um modal de
 * cadastro (M) com gatilho e ação em pares; "Rodar agora" é a varredura manual.
 */
@Component({
  selector: 'app-automacoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, DatePipe, EstadoComponente, IconeComponente,
    ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Automações"
      subtitulo="Quando um cliente cruzar uma condição, o sistema cria a tarefa. Mensagem ao cliente só nas ações que dizem isso — e pelas mesmas regras de envio.">
      <button type="button" class="btn btn--secundario" (click)="rodar()" [disabled]="rodando()">
        <ui-icone nome="refresh-cw" />{{ rodando() ? 'Rodando…' : 'Rodar agora' }}
      </button>
      <button type="button" class="btn btn--primario" (click)="abrirNova()"><ui-icone nome="plus" />Nova regra</button>
    </ui-cabecalho-tela>

    <div class="corpo">
      @if (msg(); as m) {
        <p class="msg" [class.ok]="m.ok" [class.erro]="!m.ok" [attr.role]="m.ok ? 'status' : 'alert'">{{ m.texto }}</p>
      }
      <!-- Parcial: a lista carregou, mas os seletores de sequência/lista não — a
           tela avisa e deixa criar as outras ações. -->
      @if (erroRefs()) {
        <p class="aviso-parcial" role="alert"><ui-icone nome="alert-triangle" />{{ erroRefs() }} <button type="button" class="link" (click)="carregarRefs()">Tentar de novo</button></p>
      }

      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso às automações" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as automações" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()">
            <ng-template uiCelula="ativa" let-a>
              <label class="switch">
                <input type="checkbox" [checked]="a.ativa" [attr.aria-label]="'Regra ' + a.nome + (a.ativa ? ' ativa' : ' pausada')"
                  (change)="alternar(a, $any($event.target).checked)" /><span class="track"></span>
              </label>
            </ng-template>
            <ng-template uiCelula="regra" let-a>
              <span class="r-nome">{{ a.nome }}</span>
              @if (!a.ativa) { <span class="pausada">Pausada</span> }
              <span class="r-regra">{{ descreve(a) }}</span>
            </ng-template>
            <ng-template uiCelula="execucoes" let-a>
              <span class="txt-dados">{{ a.execucoes }} exec.</span>
              @if (a.ultimaExecucaoEm) { <span class="r-quando">último {{ a.ultimaExecucaoEm | date: 'dd/MM HH:mm' }}</span> }
            </ng-template>
            <ng-template uiCelula="acoes" let-a>
              <button type="button" class="btn btn--fantasma btn--pequeno" (click)="excluir(a)" [attr.aria-label]="'Excluir a regra ' + a.nome">
                <ui-icone nome="trash-2" [tamanho]="14" />
              </button>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhuma automação ainda" descricao="Crie a primeira regra: quando o cliente cruzar uma condição, o sistema faz a ação.">
                <button type="button" class="btn btn--primario" (click)="abrirNova()">Nova regra</button>
              </ui-estado>
            </div>
          </ui-tabela>
          <ui-paginacao [mostrados]="itens().length" [temMais]="proximoCursor() !== null"
            [carregando]="carregandoMais()" (mais)="carregarMais()" />
        }
      }
    </div>

    <!-- Criar regra: modal de cadastro. Gatilho e ação andam em par (ver trocarGatilho/trocarAcao). -->
    <ui-modal [aberto]="mostrarNova()" titulo="Nova regra" largura="g" (fechar)="fecharNova()">
      <form id="form-automacao" class="form" (submit)="criar($event)">
        <ui-campo rotulo="Nome" placeholder="Ex.: Reativar quem virou Em Risco" [obrigatorio]="true"
          [valor]="nome()" (valorChange)="nome.set($event)" />

        <div class="dupla">
          <ui-select rotulo="Gatilho (quando)" [opcoes]="opcoesGatilho" [valor]="gatilho()" (valorChange)="trocarGatilho($event)" />
          <div class="params">
            @switch (gatilho()) {
              @case ('rfv_segmento') {
                <ui-select rotulo="Segmento" [opcoes]="opcoesSegmento" [valor]="segmento()" (valorChange)="segmento.set($event)" />
              }
              @case ('dias_sem_comprar') {
                <ui-campo rotulo="Dias sem comprar (mais de)" tipo="number" [valor]="dias().toString()" (valorChange)="dias.set(+$event)" />
              }
              @case ('lead_frio') {
                <ui-campo rotulo="Sem 1ª compra há mais de (dias)" tipo="number" [valor]="dias().toString()" (valorChange)="dias.set(+$event)" />
              }
              @case ('nps_detrator') {
                <ui-campo rotulo="Nota até" tipo="number" [valor]="notaMax().toString()" (valorChange)="notaMax.set(+$event)" />
              }
              @case ('pedido_efetivado') {
                <ui-campo rotulo="Dias depois da efetivação" tipo="number" [valor]="diasDepois().toString()" (valorChange)="diasDepois.set(+$event)"
                  [dica]="'0 = no mesmo dia (até ' + DIAS_DEPOIS_MAX + '). Age por PEDIDO: cada compra efetivada recebe a sua mensagem, uma vez.'" />
              }
              @case ('reposicao_ritmo') {
                <ui-campo rotulo="Antecipação (× o ritmo do cliente)" tipo="number" [valor]="fator().toString()" (valorChange)="fator.set(+$event)"
                  dica="0,8 = age quando o cliente chega a 80% da média entre as compras DELE (antes de atrasar)." />
              }
            }
          </div>
        </div>

        <div class="dupla">
          <ui-select rotulo="Ação (faça)" [opcoes]="opcoesAcao" [valor]="acao()" (valorChange)="trocarAcao($event)" />
          <div class="params">
            @switch (acao()) {
              @case ('criar_tarefa') {
                <ui-campo rotulo="Título da tarefa" placeholder="Ex.: Ligar para reativar" [valor]="titulo()" (valorChange)="titulo.set($event)" />
                <label class="chk"><input type="checkbox" [checked]="paraDono()" (change)="paraDono.set($any($event.target).checked)" /> para o dono da carteira</label>
              }
              @case ('aplicar_sequencia') {
                <ui-select rotulo="Sequência" placeholder="Escolha…" [opcoes]="opcoesSequencias()" [valor]="sequenciaId()" (valorChange)="sequenciaId.set($event)" />
              }
              @case ('adicionar_lista') {
                <ui-select rotulo="Lista" placeholder="Escolha…" [opcoes]="opcoesListas()" [valor]="listaId()" (valorChange)="listaId.set($event)" />
              }
              @case ('agente_envia') {
                <ui-select rotulo="Roteiro" [opcoes]="opcoesRoteiro" [valor]="roteiro()" (valorChange)="setRoteiro($event)" />
                <ui-campo class="largo" tipo="textarea" rotulo="Mensagem (dentro de 24h e no não-oficial)" [valor]="textoPosVenda()"
                  (valorChange)="textoPosVenda.set($event)" [largo]="true"
                  [placeholder]="'Oi {nome}! De 0 a 10, que nota você dá para a sua compra?'"
                  [dica]="'Até ' + MAX_TEXTO + ' caracteres.'" />
                <ui-select rotulo="Template aprovado (oficial fora de 24h)" placeholder="Sem template" [opcoes]="opcoesTemplates()"
                  [valor]="templateId()" (valorChange)="templateId.set($event)" />
                @if (avisoTemplate(); as av) { <p class="aviso-envio">{{ av }}</p> }
                <!-- ⚠️ Fala com o cliente em nome do agente: a política das ativas vale inteira. -->
                <p class="aviso-envio">
                  O agente envia como <strong>mensagem ativa</strong>: só com o agente em <strong>autônomo</strong> no número,
                  dentro do <strong>expediente</strong> e dos <strong>limites</strong> do dia/semana; respeita opt-out e
                  “não receber automações”. No oficial, fora da janela de 24h, só o <strong>template aprovado</strong>; no
                  não-oficial, só texto e dentro da cota de <strong>aquecimento</strong>. Com atendimento humano aberto, não envia.
                  No roteiro NPS a resposta do cliente vira nota no painel de NPS; no de indicação, contatos com origem “Indicação”.
                </p>
              }
              @case ('enviar_mensagem') {
                <ui-campo class="largo" tipo="textarea" rotulo="Mensagem" [valor]="texto()" (valorChange)="texto.set($event)" [largo]="true"
                  [placeholder]="'Oi {nome}, faz um tempo que não conversamos…'" [dica]="'Até ' + MAX_TEXTO + ' caracteres.'" />
                <!-- ⚠️ A ÚNICA ação que fala com o cliente. O aviso não é enfeite:
                     é o que separa "organizar o trabalho" de "falar pelo humano". -->
                <p class="aviso-envio">
                  Vai pelo <strong>mesmo gateway</strong> das outras mensagens: respeita opt-out,
                  janela de 24h e pausa de disparo. Quem marcou <strong>“não receber automações”</strong>
                  fica de fora. <br />
                  Sem conversa aberta, <strong>vira tarefa</strong> em vez de abrir conversa —
                  mensagem fria exige template no oficial e arrisca o número no não-oficial.
                </p>
              }
            }
          </div>
        </div>
      </form>

      @if (erroForm(); as e) { <p class="erro" role="alert"><ui-icone nome="alert-triangle" />{{ e }}</p> }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharNova()" [disabled]="salvando()">Cancelar</button>
        <button type="submit" form="form-automacao" class="btn btn--primario" [disabled]="salvando() || !nome().trim()">
          {{ salvando() ? 'Criando…' : 'Criar regra' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-cabecalho-tela { display: block; }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .msg { margin: 0; font-size: 13px; color: var(--texto-secundario); }
    .msg.ok { color: var(--sucesso); }
    .msg.erro { color: var(--erro); }
    .aviso-parcial { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .link { border: 0; background: transparent; color: var(--acao); font: inherit; font-size: 13px; cursor: pointer; padding: 0; text-decoration: underline; }
    .form { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .dupla { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: var(--espacamento-3); align-items: start; min-width: 0; }
    @media (max-width: 560px) { .dupla { grid-template-columns: minmax(0, 1fr); } }
    .params { display: grid; gap: var(--espacamento-3); align-content: start; min-width: 0; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); font-size: 13px; }
    .erro { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .aviso-envio { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto-secundario); font-size: 12px; line-height: 1.5; }
    .r-nome { color: var(--texto); font-size: 14px; }
    .pausada { margin-left: var(--espacamento-2); font-size: 11px; color: var(--texto-suave); }
    .r-regra { display: block; color: var(--texto-suave); font-size: 12px; }
    .r-quando { display: block; color: var(--texto-suave); font-size: 11px; }
    /* Switch sem texto: o nome vai no aria-label da linha. */
    .switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
    .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .track { width: 34px; height: 20px; border-radius: var(--raio-completo); background: var(--borda-forte); position: relative; transition: background var(--movimento-estado-duracao); }
    .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: var(--raio-completo); background: var(--superficie-elevada); transition: transform var(--movimento-estado-duracao); }
    .switch input:checked + .track { background: var(--acao); }
    .switch input:checked + .track::after { transform: translateX(14px); }
    .switch input:focus-visible + .track { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `,
})
export class AutomacoesPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  readonly gatilhos: readonly string[] = GATILHOS_AUTOMACAO
  readonly acoes: readonly string[] = ACOES_AUTOMACAO
  readonly roteiros = ROTEIROS_POS_VENDA
  readonly rotuloRoteiro = ROTULO_ROTEIRO_POS_VENDA
  readonly DIAS_DEPOIS_MAX = DIAS_DEPOIS_MAX
  readonly segmentos = SEGMENTOS
  readonly MAX_TEXTO = MAX_TEXTO

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'ativa', rotulo: 'Ativa', largura: '72px' },
    { chave: 'regra', rotulo: 'Regra' },
    { chave: 'execucoes', rotulo: 'Execuções', alinhamento: 'dir', largura: '150px' },
    { chave: 'acoes', rotulo: '', alinhamento: 'dir', largura: '64px' },
  ]
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly opcoesGatilho: OpcaoSelect[] = this.gatilhos.map((g) => ({ valor: g, rotulo: GAT_ROTULO[g] ?? g }))
  protected readonly opcoesAcao: OpcaoSelect[] = this.acoes.map((a) => ({ valor: a, rotulo: ACAO_ROTULO[a] ?? a }))
  protected readonly opcoesSegmento: OpcaoSelect[] = SEGMENTOS.map((s) => ({ valor: s.id, rotulo: s.nome }))
  protected readonly opcoesRoteiro: OpcaoSelect[] = ROTEIROS_POS_VENDA.map((r) => ({ valor: r, rotulo: ROTULO_ROTEIRO_POS_VENDA[r] }))
  protected readonly opcoesSequencias = computed<OpcaoSelect[]>(() => this.sequencias().map((s) => ({ valor: s.id, rotulo: s.nome })))
  protected readonly opcoesListas = computed<OpcaoSelect[]>(() => this.listas().map((l) => ({ valor: l.id, rotulo: l.nome })))
  protected readonly opcoesTemplates = computed<OpcaoSelect[]>(() => this.templates().map((t) => ({ valor: t.id, rotulo: t.nome })))

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Automacao[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly sequencias = signal<readonly Ref[]>([]); readonly listas = signal<readonly Ref[]>([])
  readonly erroRefs = signal<string | null>(null)
  readonly mostrarNova = signal(false); readonly rodando = signal(false)
  readonly msg = signal<{ ok: boolean; texto: string } | null>(null)
  // form
  readonly nome = signal(''); readonly gatilho = signal('dias_sem_comprar'); readonly acao = signal('criar_tarefa')
  readonly segmento = signal('em-risco'); readonly dias = signal(60); readonly notaMax = signal(6)
  readonly fator = signal(0.8) // régua de recompra: × o ritmo do cliente
  readonly titulo = signal(''); readonly paraDono = signal(true); readonly sequenciaId = signal(''); readonly listaId = signal('')
  readonly texto = signal('')
  // Pós-venda (G3)
  readonly diasDepois = signal(0)
  readonly roteiro = signal<RoteiroPosVenda>('agradecimento')
  readonly textoPosVenda = signal('')
  readonly templateId = signal('')
  readonly templates = signal<readonly TemplateRef[]>([])
  avisoTemplate(): string | null { return avisoSoTemplate({ texto: this.textoPosVenda(), templateId: this.templateId() }) }
  /** O par gatilho/ação do pós-venda anda junto (a API recusa um sem o outro). */
  trocarGatilho(g: string): void { this.gatilho.set(g); this.acao.set(acaoAoTrocarGatilho(g, this.acao())) }
  trocarAcao(a: string): void { this.acao.set(a); this.gatilho.set(gatilhoAoTrocarAcao(a, this.gatilho())) }
  setRoteiro(r: string): void { this.roteiro.set(r as RoteiroPosVenda) }
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  ngOnInit(): void { void this.carregar(); void this.carregarRefs() }
  rotuloGat(g: string): string { return GAT_ROTULO[g] ?? g }
  rotuloAcao(a: string): string { return ACAO_ROTULO[a] ?? a }

  abrirNova(): void { this.erroForm.set(null); this.mostrarNova.set(true) }
  fecharNova(): void { if (this.salvando()) return; this.mostrarNova.set(false); this.erroForm.set(null) }

  descreve(a: Automacao): string {
    if (a.acao === ACAO_POS_VENDA) return descreverPosVenda(a.gatilhoParam, a.acaoParam)
    const g = a.gatilhoParam, ap = a.acaoParam
    const quando =
      a.gatilho === 'rfv_segmento' ? `virou ${this.segNome(String(g['segmento'] ?? ''))}`
      : a.gatilho === 'dias_sem_comprar' ? `passou de ${g['dias']} dias sem comprar`
      : a.gatilho === 'lead_frio' ? `lead sem compra há ${g['dias']} dias`
      : a.gatilho === 'reposicao_ritmo' ? `chegou a ${g['fator'] ?? 0.8}× o ritmo de compra dele`
      : `NPS ≤ ${g['notaMax'] ?? 6}`
    const faz =
      a.acao === 'criar_tarefa' ? `criar tarefa “${ap['titulo'] ?? a.nome}”`
      : a.acao === 'aplicar_sequencia' ? `aplicar uma sequência`
      : a.acao === 'enviar_mensagem' ? `enviar mensagem ao cliente`
      : `adicionar a uma lista`
    return `Quando ${quando} → ${faz}`
  }
  private segNome(c: string): string { return SEGMENTOS.find((s) => s.id === c)?.nome ?? c }

  /**
   * Seletores de sequência/lista. ⚠️ As duas listas são paginadas por cursor:
   * o seletor percorre as páginas até o fim (conjunto de configuração, pequeno)
   * — nada de `LIMIT 200` cru no servidor.
   */
  async carregarRefs(): Promise<void> {
    this.erroRefs.set(null)
    try {
      const [seq, lis] = await Promise.all([this.todasAsPaginas('/v1/sequencias'), this.todasAsPaginas('/v1/listas')])
      this.sequencias.set(seq); this.listas.set(lis)
    } catch (e) {
      this.erroRefs.set(mensagemDeErro(e, 'Não foi possível carregar as sequências e listas para o seletor.'))
    }
    // Templates à parte: sem eles o pós-venda ainda funciona por texto (parcial, não quebra o resto).
    try {
      const tpl = await this.todasAsPaginas('/v1/templates')
      // Só os aprovados pela Meta servem ao pós-venda (o envio confere de novo).
      this.templates.set((tpl as unknown as TemplateRef[]).filter((t) => t.statusMeta === 'APPROVED'))
    } catch {
      this.templates.set([])
    }
  }
  private async todasAsPaginas(base: string): Promise<Ref[]> {
    let acumulado: Ref[] = []
    let cursor: string | null = null
    do {
      const r: { itens: Ref[]; proximoCursor?: string | null } =
        await firstValueFrom(this.http.get<{ itens: Ref[]; proximoCursor?: string | null }>(`${base}${queryDeLista({ cursor })}`))
      acumulado = mesclarPagina(acumulado, r.itens, (x) => x.id)
      cursor = r.proximoCursor ?? null
    } while (cursor)
    return acumulado
  }

  private pagina(cursor: string | null): Promise<Pagina> {
    return firstValueFrom(this.http.get<Pagina>(`/v1/automacoes${queryDeLista({ cursor })}`))
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.pagina(null)
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(ehStatus(e, 403) ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.pagina(cursor)
      this.itens.update((a) => mesclarPagina(a, r.itens, (x) => x.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais automações.'))
    } finally { this.carregandoMais.set(false) }
  }

  private montarGatilhoParam(): object {
    switch (this.gatilho()) {
      case 'rfv_segmento': return { segmento: this.segmento() }
      case 'dias_sem_comprar': return { dias: this.dias() }
      case 'lead_frio': return { dias: this.dias() }
      case 'nps_detrator': return { notaMax: this.notaMax(), janelaDias: 30 }
      case 'reposicao_ritmo': return { fator: this.fator() }
      default: return {}
    }
  }
  private montarAcaoParam(): object {
    switch (this.acao()) {
      case 'criar_tarefa': return { titulo: this.titulo().trim() || this.nome().trim(), offsetDias: 0, paraDono: this.paraDono() }
      case 'aplicar_sequencia': return { sequenciaId: this.sequenciaId() }
      case 'adicionar_lista': return { listaId: this.listaId() }
      case 'enviar_mensagem': return { texto: this.texto().trim() }
      default: return {}
    }
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || !this.nome().trim()) return
    if (this.acao() === 'aplicar_sequencia' && !this.sequenciaId()) { this.erroForm.set('Escolha a sequência.'); return }
    if (this.acao() === 'enviar_mensagem' && !this.texto().trim()) { this.erroForm.set('Escreva a mensagem que vai ser enviada.'); return }
    if (this.acao() === 'adicionar_lista' && !this.listaId()) { this.erroForm.set('Escolha a lista.'); return }
    let gatilhoParam: object = this.montarGatilhoParam()
    let acaoParam: object = this.montarAcaoParam()
    if (this.acao() === ACAO_POS_VENDA) {
      const pv = paramsPosVenda({ diasDepois: this.diasDepois(), roteiro: this.roteiro(), texto: this.textoPosVenda(), templateId: this.templateId() })
      if (!pv.ok) { this.erroForm.set(pv.erro); return }
      gatilhoParam = pv.params.gatilhoParam; acaoParam = pv.params.acaoParam
    }
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/automacoes', {
        nome: this.nome().trim(), gatilho: this.gatilho(), gatilhoParam, acao: this.acao(), acaoParam,
      }))
      this.nome.set(''); this.titulo.set(''); this.texto.set(''); this.textoPosVenda.set(''); this.templateId.set(''); this.mostrarNova.set(false)
      this.toast.sucesso('Regra criada')
      await this.carregar()
    } catch (e) {
      // ⚠️ A API devolve a frase com a ação corretiva (ex.: "Escreva a mensagem…").
      this.erroForm.set(mensagemDeErro(e, ehStatus(e, 422) ? 'Confira a sequência/lista escolhida.' : 'Não foi possível criar a regra.'))
    } finally { this.salvando.set(false) }
  }

  async alternar(a: Automacao, ativa: boolean): Promise<void> {
    try {
      await firstValueFrom(this.http.patch(`/v1/automacoes/${a.id}`, { ativa }))
      this.itens.update((lista) => lista.map((x) => (x.id === a.id ? { ...x, ativa } : x)))
      this.toast.sucesso(ativa ? 'Regra ativada' : 'Regra pausada')
    } catch (e) {
      // Devolve o switch ao estado real: a tela não pode mentir.
      this.itens.update((lista) => lista.map((x) => (x.id === a.id ? { ...x, ativa: a.ativa } : x)))
      this.toast.erro(mensagemDeErro(e, ativa ? 'Não foi possível ativar a regra.' : 'Não foi possível pausar a regra.'))
    }
  }
  async excluir(a: Automacao): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: `Excluir “${a.nome}”?`,
      mensagem: a.execucoes > 0
        ? `A regra deixa de rodar. As ${a.execucoes} execuções já feitas (tarefas, listas, mensagens) continuam.`
        : 'A regra deixa de rodar. Não dá para desfazer.',
      acao: 'Excluir',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/automacoes/${a.id}`))
      this.itens.update((lista) => lista.filter((x) => x.id !== a.id))
      this.toast.sucesso('Regra excluída')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível excluir a regra.'))
    }
  }
  async rodar(): Promise<void> {
    this.rodando.set(true); this.msg.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ acoesExecutadas: number }>('/v1/automacoes/executar', {}))
      this.msg.set({ ok: true, texto: `Varredura concluída: ${r.acoesExecutadas} ação(ões) executada(s).` })
      await this.carregar()
    } catch (e) {
      this.msg.set({ ok: false, texto: mensagemDeErro(e, 'Não foi possível rodar a varredura agora.') })
    } finally { this.rodando.set(false) }
  }
}
