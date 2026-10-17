import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import type { GoLiveDto, MetricasAgenteDto } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { MetricasServico } from './metricas.servico.js'
import {
  JANELAS_METRICAS, ROTULO_SITUACAO, TOM_SITUACAO, corpoDasDouradas, criteriosEmOrdem, indicadores, rotuloCurtoDoModo, rotuloDoMotivo,
  semAtividade, situacaoDoCriterio, tempoNaFase, trilhaDeFases, vereditoDaFase, type JanelaMetricas,
} from './metricas.regras.js'

/**
 * MÉTRICAS E FASE DO AGENTE (raia P19, ADR-031).
 *
 *   1. FASE: em que fase o número está (do modo, P14), há quanto tempo, e cada
 *      critério para avançar — verde/vermelho/sem medida, com valor, alvo e FONTE.
 *   2. MÉTRICAS: os agregados de /v1/agente/metricas na janela escolhida.
 *
 * ⚠️ O painel SÓ INFORMA. Mudar o modo é na aba Configuração (P14), com
 *    confirmação digitada e auditoria — aqui não há botão que mude o modo.
 * ⚠️ Os alvos são PROPOSTA (ADR-031): a tela diz isso.
 * ⚠️ Kill switch: o teto da conta PAUSA o número ("pausado pelo teto"), sem
 *    mudar a fase.
 * Na homologação, o admin registra a última rodada das douradas e do smoke
 * (POST /v1/agente/go-live/conferencia); o playground conta sozinho.
 * Cinco estados: carregando (esqueleto), erro (tentar de novo), sem permissão
 * (só gestor/admin), vazio (número sem atividade nesta fase; sem decisões na
 * janela das métricas) e parcial (as métricas falham e a fase continua na
 * tela, ou o contrário, com aviso localizado).
 */
export const ABA_METRICAS_PRONTA: boolean = true

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

@Component({
  selector: 'app-agente-metricas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente],
  template: `
    @switch (estadoFase()) {
      @case ('carregando') {
        <ui-painel><div class="esq" aria-busy="true" aria-label="Carregando a fase do agente">
          <ui-esqueleto altura="20px" largura="45%" /><ui-esqueleto altura="28px" />
          <ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="O painel de fase é para gestores e administradores"
          descricao="Peça acesso a um administrador da conta." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar a fase do agente"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregarFase()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (fase(); as g) {
          <ui-painel>
            <div class="topo">
              <div class="encolhe">
                <h3 class="titulo">Fase do agente <span class="escopo">· este número</span></h3>
                <p class="dica">{{ g.rotuloFase }} {{ tempo() }}. Modo do número: <strong>{{ modo(g.modoNumero) }}</strong>.
                  @if (!g.pausadoPeloTeto && g.modoAgora.modo !== g.modoNumero) {
                    Agora está em <strong>{{ modo(g.modoAgora.modo) }}</strong> (fora do recorte).
                  }
                </p>
              </div>
              <div class="selos">
                @if (g.pausadoPeloTeto) { <ui-badge tom="atencao">Pausado pelo teto da conta: {{ modo(g.modoAgora.modo) }}</ui-badge> }
                @if (g.alvosProposta) { <ui-badge tom="info">Alvos em proposta (ADR-031)</ui-badge> }
              </div>
            </div>

            <ol class="trilha" aria-label="Fases do agente">
              @for (p of trilha(); track p.fase) {
                <li [attr.data-estado]="p.estado" [attr.aria-current]="p.estado === 'atual' ? 'step' : null">{{ p.rotulo }}</li>
              }
            </ol>

            <div class="veredito" role="status" [attr.data-tom]="veredito()!.tom">
              <strong>{{ veredito()!.titulo }}</strong>
              <span>{{ veredito()!.texto }}</span>
            </div>

            @if (vazio()) {
              <ui-estado [titulo]="'Ainda sem atividade em ' + g.rotuloFase"
                descricao="O agente ainda não decidiu nada neste número desde que entrou nesta fase. Os critérios aparecem com as primeiras conversas." icone="📊" />
            } @else {
            <ul class="criterios" aria-label="Critérios para avançar">
              @for (c of criterios(); track c.id) {
                <li class="criterio" [attr.data-situacao]="situacao(c)">
                  <div class="linha">
                    <span class="nome encolhe">{{ c.rotulo }}</span>
                    <ui-badge [tom]="tom(c)">{{ rotuloSituacao(c) }}</ui-badge>
                  </div>
                  <div class="medida">
                    <span class="txt-dados valor">{{ c.valor ?? '—' }}</span>
                    <span class="alvo">alvo {{ c.alvo }}</span>
                  </div>
                  @if (c.alerta) { <p class="alerta" role="note">{{ c.alerta }}</p> }
                  @if (c.motivo) { <p class="motivo">{{ c.motivo }}</p> }
                  <p class="fonte">Fonte: {{ c.fonte }}</p>
                </li>
              }
            </ul>
            }

            @if (g.fase === 'homologacao' && g.podeConferir) {
              <section class="conferencia" aria-labelledby="conf-titulo">
                <h4 id="conf-titulo" class="sub">Registrar conferência <span class="escopo">· administrador</span></h4>
                <p class="dica">Os evals e o smoke rodam por script. Registre aqui a última rodada; vale 30 dias. O playground conta sozinho a cada "Reiniciar".</p>
                <form class="form-linha" (submit)="$event.preventDefault(); registrarDouradas()">
                  <label class="campo"><span>Cenários das douradas</span>
                    <input type="text" inputmode="numeric" [value]="cenarios()" (input)="cenarios.set($any($event.target).value); erroDouradas.set(null)"
                           [attr.aria-invalid]="erroDouradas() ? 'true' : null" /></label>
                  <label class="campo"><span>CRÍTICAs</span>
                    <input type="text" inputmode="numeric" [value]="criticas()" (input)="criticas.set($any($event.target).value); erroDouradas.set(null)"
                           [attr.aria-invalid]="erroDouradas() ? 'true' : null" /></label>
                  <ui-botao tipo="submit" variante="secundario" [carregando]="salvando() === 'douradas'">Registrar douradas</ui-botao>
                </form>
                @if (erroDouradas(); as e) { <p class="msg-erro" role="alert">{{ e }}</p> }
                <div class="form-linha" role="group" aria-label="Resultado do smoke">
                  <ui-botao variante="secundario" [carregando]="salvando() === 'smoke_ok'" (click)="registrarSmoke(true)">Smoke passou</ui-botao>
                  <ui-botao variante="secundario" [carregando]="salvando() === 'smoke_falhou'" (click)="registrarSmoke(false)">Smoke falhou</ui-botao>
                </div>
              </section>
            }
          </ui-painel>
        }
      }
    }

    @if (estadoFase() !== 'sem_permissao') {
      <ui-painel>
        <div class="topo">
          <h3 class="titulo">Métricas <span class="escopo">· este número</span></h3>
          <div class="janelas" role="group" aria-label="Janela das métricas">
            @for (d of janelas; track d) {
              <button type="button" class="janela" [class.sel]="dias() === d" [attr.aria-pressed]="dias() === d" (click)="trocarJanela(d)">{{ d }} dias</button>
            }
          </div>
        </div>
        @switch (estadoMetricas()) {
          @case ('carregando') {
            <div class="kpis" aria-busy="true">@for (i of [1,2,3,4,5,6]; track i) { <ui-esqueleto altura="56px" /> }</div>
          }
          @case ('sem_permissao') {
            <p class="parcial" role="status">Você não tem acesso às métricas do agente.</p>
          }
          @case ('erro') {
            <div class="parcial" role="status">
              <span>As métricas não carregaram agora — a fase acima continua valendo.</span>
              <ui-botao variante="secundario" (click)="carregarMetricas()">Tentar de novo</ui-botao>
            </div>
          }
          @case ('pronto') {
            @if (metricas(); as m) {
              @if (m.turnos === 0) {
                <ui-estado titulo="Sem decisões do agente nesta janela" icone="📊"
                  [descricao]="'Nenhum turno nos últimos ' + m.dias + ' dias. Ligue o agente em sombra na aba Configuração, ou escolha uma janela maior.'" />
              } @else {
                <dl class="kpis">
                  @for (i of kpis(); track i.rotulo) {
                    <div class="kpi"><dt>{{ i.rotulo }}</dt><dd class="txt-dados">{{ i.valor }}</dd>
                      @if (i.detalhe) { <dd class="detalhe">{{ i.detalhe }}</dd> }</div>
                  }
                </dl>
                @if (m.handoffPorMotivo.length > 0) {
                  <h4 class="sub">Por que passou para humano</h4>
                  <ul class="motivos">
                    @for (h of m.handoffPorMotivo; track h.motivo) {
                      <li><span class="encolhe">{{ motivo(h.motivo) }}</span><span class="txt-dados">{{ h.n }}</span></li>
                    }
                  </ul>
                }
              }
            }
          }
        }
      </ui-painel>
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .topo { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .encolhe { min-width: 0; }
    .titulo { margin: 0; font-size: 15px; font-weight: 600; color: var(--texto); }
    .escopo { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: var(--espacamento-1) 0 0; color: var(--texto-suave); font-size: 13px; overflow-wrap: anywhere; }
    .trilha { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); list-style: none; margin: var(--espacamento-3) 0; padding: 0; }
    .trilha li { font-size: 12px; padding: 2px var(--espacamento-2); border-radius: var(--raio-completo);
      border: 1px solid var(--borda); color: var(--texto-suave); }
    .trilha li[data-estado='feita'] { color: var(--texto-secundario); }
    .trilha li[data-estado='atual'] { color: var(--acao); border-color: var(--acao); background: var(--acao-suave); font-weight: 600; }
    .veredito { display: grid; gap: 2px; padding: var(--espacamento-3); border-radius: var(--raio-controle);
      border: 1px solid var(--borda); background: var(--superficie); font-size: 13px; color: var(--texto-secundario);
      margin-bottom: var(--espacamento-3); overflow-wrap: anywhere; }
    .veredito strong { color: var(--texto); font-size: 14px; }
    .veredito[data-tom='sucesso'] { border-color: var(--sucesso); background: var(--sucesso-suave); }
    .veredito[data-tom='erro'] { border-color: var(--erro); background: var(--erro-suave); }
    .criterios { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2);
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
    .criterio { display: grid; gap: var(--espacamento-1); padding: var(--espacamento-3); min-width: 0;
      border: 1px solid var(--borda); border-left-width: 3px; border-radius: var(--raio-controle); background: var(--superficie); }
    .criterio[data-situacao='cumpre'] { border-left-color: var(--sucesso); }
    .criterio[data-situacao='nao_cumpre'] { border-left-color: var(--erro); }
    .criterio[data-situacao='indisponivel'] { border-left-color: var(--atencao); }
    .linha { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); }
    .nome { font-size: 13px; font-weight: 600; color: var(--texto); overflow-wrap: anywhere; }
    .medida { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--espacamento-1) var(--espacamento-2); min-width: 0; }
    .valor { font-size: 15px; color: var(--texto); overflow-wrap: anywhere; }
    .alvo { font-size: 12px; color: var(--texto-suave); overflow-wrap: anywhere; }
    .motivo { margin: 0; font-size: 12px; color: var(--texto-secundario); overflow-wrap: anywhere; }
    .alerta { margin: 0; font-size: 12px; color: var(--atencao); font-weight: 600; overflow-wrap: anywhere; }
    .criterio[data-situacao='revisar'] { border-left-color: var(--atencao); }
    .selos { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; justify-content: flex-end; }
    .conferencia { margin-top: var(--espacamento-4); padding-top: var(--espacamento-3); border-top: 1px solid var(--borda); display: grid; gap: var(--espacamento-2); }
    .form-linha { display: flex; gap: var(--espacamento-2); align-items: end; flex-wrap: wrap; }
    .campo { display: grid; gap: 2px; font-size: 12px; color: var(--texto-secundario); min-width: 0; }
    .campo input { width: 120px; max-width: 100%; }
    .msg-erro { margin: 0; font-size: 12px; color: var(--erro); }
    .fonte { margin: 0; font-size: 11px; color: var(--texto-suave); overflow-wrap: anywhere; }
    .janelas { display: inline-flex; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); overflow: hidden; }
    .janela { border: 0; background: var(--superficie); color: var(--texto-secundario); font: inherit; font-size: 12px;
      padding: var(--espacamento-1) var(--espacamento-3); cursor: pointer; }
    .janela + .janela { border-left: 1px solid var(--borda-controle); }
    .janela:hover { background: var(--superficie-hover); }
    .janela.sel { background: var(--superficie-selecionada); color: var(--acao); font-weight: 600; }
    .janela:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .kpis { display: grid; gap: var(--espacamento-2); grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      margin: var(--espacamento-3) 0 0; }
    .kpi { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); min-width: 0; }
    .kpi dt { font-size: 12px; color: var(--texto-suave); }
    .kpi dd { margin: 2px 0 0; font-size: 16px; color: var(--texto); overflow-wrap: anywhere; }
    .kpi dd.detalhe { font-size: 11px; color: var(--texto-suave); font-family: inherit; }
    .sub { margin: var(--espacamento-4) 0 var(--espacamento-2); font-size: 13px; font-weight: 600; color: var(--texto); }
    .motivos { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); }
    .motivos li { display: flex; justify-content: space-between; gap: var(--espacamento-2); font-size: 13px;
      color: var(--texto-secundario); padding: var(--espacamento-1) 0; border-bottom: 1px solid var(--borda); }
    .parcial { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; margin: var(--espacamento-3) 0 0;
      font-size: 13px; color: var(--atencao); }
    @media (max-width: 640px) { .criterios, .kpis { grid-template-columns: 1fr; } }
  `,
})
export class AgenteMetricasComponente {
  /** Número selecionado na página. */
  readonly canalId = input.required<string>()

  readonly #api = inject(MetricasServico)
  readonly #toast = inject(ToastServico)

  readonly estadoFase = signal<Estado>('carregando')
  readonly fase = signal<GoLiveDto | null>(null)
  readonly estadoMetricas = signal<Estado>('carregando')
  readonly metricas = signal<MetricasAgenteDto | null>(null)
  readonly dias = signal<JanelaMetricas>(7)
  readonly janelas = JANELAS_METRICAS

  readonly trilha = computed(() => { const g = this.fase(); return g ? trilhaDeFases(g.fase) : [] })
  readonly veredito = computed(() => { const g = this.fase(); return g ? vereditoDaFase(g) : null })
  readonly criterios = computed(() => criteriosEmOrdem(this.fase()?.criterios ?? []))
  readonly tempo = computed(() => { const g = this.fase(); return g ? tempoNaFase(g) : '' })
  readonly kpis = computed(() => { const m = this.metricas(); return m ? indicadores(m) : [] })
  readonly vazio = computed(() => { const g = this.fase(); return g ? semAtividade(g) : false })
  readonly modo = rotuloCurtoDoModo

  // Conferência de homologação (douradas e smoke).
  readonly cenarios = signal('')
  readonly criticas = signal('0')
  readonly erroDouradas = signal<string | null>(null)
  readonly salvando = signal<'douradas' | 'smoke_ok' | 'smoke_falhou' | null>(null)

  readonly situacao = situacaoDoCriterio
  readonly tom = (c: Parameters<typeof situacaoDoCriterio>[0]) => TOM_SITUACAO[situacaoDoCriterio(c)]
  readonly rotuloSituacao = (c: Parameters<typeof situacaoDoCriterio>[0]) => ROTULO_SITUACAO[situacaoDoCriterio(c)]
  readonly motivo = rotuloDoMotivo

  constructor() {
    effect(() => {
      this.canalId()
      untracked(() => { void this.carregarFase(); void this.carregarMetricas() })
    })
  }

  async carregarFase(): Promise<void> {
    const canal = this.canalId()
    this.estadoFase.set('carregando')
    try {
      const g = await this.#api.goLive(canal)
      if (canal !== this.canalId()) return // resposta de um número que já saiu da tela
      this.fase.set(g)
      this.estadoFase.set('pronto')
    } catch (e) {
      if (canal !== this.canalId()) return
      this.estadoFase.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMetricas(): Promise<void> {
    const canal = this.canalId(), dias = this.dias()
    this.estadoMetricas.set('carregando')
    try {
      const m = await this.#api.metricas(canal, dias)
      if (canal !== this.canalId() || dias !== this.dias()) return
      this.metricas.set(m)
      this.estadoMetricas.set('pronto')
    } catch (e) {
      if (canal !== this.canalId() || dias !== this.dias()) return
      this.estadoMetricas.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async registrarDouradas(): Promise<void> {
    const v = corpoDasDouradas(this.canalId(), this.cenarios(), this.criticas())
    if (!v.ok) { this.erroDouradas.set(v.erro); return }
    this.salvando.set('douradas')
    const r = await this.#api.conferir(v.corpo)
    this.salvando.set(null)
    if (!r.ok) { this.#falhaConferencia(r.status, r.erro.mensagem, (m) => this.erroDouradas.set(m)); return }
    this.#toast.sucesso('Douradas registradas.')
    await this.carregarFase()
  }

  async registrarSmoke(ok: boolean): Promise<void> {
    this.salvando.set(ok ? 'smoke_ok' : 'smoke_falhou')
    const r = await this.#api.conferir({ item: 'smoke', canalId: this.canalId(), ok })
    this.salvando.set(null)
    if (!r.ok) { this.#falhaConferencia(r.status, r.erro.mensagem, (m) => this.#toast.erro(m)); return }
    this.#toast.sucesso(ok ? 'Smoke registrado: passou.' : 'Smoke registrado: falhou.')
    await this.carregarFase()
  }

  #falhaConferencia(status: number, mensagem: string | undefined, campo: (m: string) => void): void {
    if (status === 403) this.#toast.erro('Só administradores registram conferência.')
    else if (status === 422) campo(mensagem ?? 'Valor inválido.')
    else this.#toast.erro(mensagem ?? 'Não foi possível registrar a conferência. Tente de novo.')
  }

  trocarJanela(d: JanelaMetricas): void {
    if (d === this.dias()) return
    this.dias.set(d)
    void this.carregarMetricas()
  }
}
