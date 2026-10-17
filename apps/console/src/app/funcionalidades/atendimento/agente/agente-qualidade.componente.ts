import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import type { AvaliacaoQualidadeDto, ResumoQualidadeDto } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
  centavosParaReais, formatarReais, mesclarPagina, reaisParaCentavos,
} from '../../../compartilhado/ui/index.js'
import { InboxServico } from '../../../nucleo/inbox.servico.js'
import { ehSemPermissao } from './agente.servico.js'
import { QualidadeServico, type ConfigQualidade } from './qualidade.servico.js'
import {
  amostraParaSalvar, badgeAcao, badgeGravidade, criteriosDaAvaliacao, formatarAmostra, formatarNota, linhaDaViolacao,
  mediasDoResumo, mensagemDaFalha, rotuloGatilho, rotuloOrigem, situacaoDoJuiz, textoDaAmostra, tomDaNota,
  type FiltroQualidade,
} from './qualidade.regras.js'

/**
 * QUALIDADE EM PRODUÇÃO (ADR-031, raia P12) — aba "Qualidade" do agente.
 *
 *   1. Resumo dos últimos 7 dias do número: turnos avaliados pelas regras
 *      (100%), violações por gravidade, pausas, nota média do juiz por critério,
 *      e o estado do juiz (ativo / indisponível / no teto) — degradação visível.
 *   2. Avaliações, por cursor ("carregar mais"), com filtro: o que escapou em
 *      cada turno, as notas e justificativas do juiz, "abrir conversa" e
 *      "avaliar com o juiz" sob demanda.
 *   3. Amostra e teto do juiz no número (admin) e exportação da amostra
 *      semanal em CSV (mascarado; gestor/admin).
 *
 * Cinco estados como ramos explícitos: carregando (esqueleto), erro (tentar de
 * novo), sem permissão, vazio (convite: ligar em sombra) e pronto; o resumo que
 * falha sozinho vira aviso localizado (parcial), a lista segue.
 */
export const ABA_QUALIDADE_PRONTA: boolean = true

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

const FILTROS: ReadonlyArray<{ id: FiltroQualidade; rotulo: string }> = [
  { id: 'achados', rotulo: 'Com achado' },
  { id: 'criticas', rotulo: 'Críticas' },
  { id: 'juiz', rotulo: 'Notas do juiz' },
  { id: 'todas', rotulo: 'Todas' },
]

@Component({
  selector: 'app-agente-qualidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq">
          <ui-esqueleto altura="20px" largura="40%" />
          <div class="kpis"><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /></div>
        </div></ui-painel>
        <ui-painel><div class="esq"><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /></div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Você não tem acesso à qualidade do agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar a qualidade do agente"
          descricao="O servidor do GeraCRM não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        <!-- 1. Resumo -->
        <ui-painel>
          <div class="cab">
            <h3 class="txt-secao titulo">Últimos 7 dias <span class="escopo">· este número</span></h3>
            <ui-botao variante="secundario" (click)="exportar()" [carregando]="exportando()">
              {{ exportando() ? 'Exportando…' : 'Exportar amostra da semana (CSV)' }}</ui-botao>
          </div>
          <p class="dica">Regras automáticas conferem 100% das respostas e sugestões. Uma violação crítica antes do envio
            não sai: em autônomo a conversa vai para a equipe; em assistido a sugestão chega marcada "não envie".</p>

          @if (resumo(); as r) {
            <div class="kpis">
              <div class="kpi"><span class="txt-rotulo">Turnos avaliados</span><span class="txt-kpi txt-dados">{{ r.turnosAvaliados }}</span></div>
              <div class="kpi" [class.alerta]="r.porGravidade.CRITICA > 0">
                <span class="txt-rotulo">Críticas</span><span class="txt-kpi txt-dados">{{ r.porGravidade.CRITICA }}</span>
                <span class="suave">{{ r.pausas }} pausa(s) · {{ r.naoEnvie }} "não envie"</span>
              </div>
              <div class="kpi"><span class="txt-rotulo">Altas · médias</span>
                <span class="txt-kpi txt-dados">{{ r.porGravidade.ALTA }} · {{ r.porGravidade.MEDIA }}</span></div>
              <div class="kpi"><span class="txt-rotulo">Nota do juiz</span>
                <span class="txt-kpi txt-dados">{{ nota(r.notaMedia) }}<span class="de">/5</span></span>
                <span class="suave">{{ r.julgadas }} conversa(s) julgada(s)</span></div>
            </div>

            <div class="juiz">
              <ui-badge [tom]="situacao().tom">{{ situacao().rotulo }}</ui-badge>
              <span class="suave">Amostra {{ amostraTexto() }} das conversas · gasto do mês {{ reais(r.juiz.gastoMesCentavos) }}
                @if (r.juiz.tetoMesCentavos !== null) { de {{ reais(r.juiz.tetoMesCentavos) }} }</span>
              @if (situacao().detalhe; as d) { <span class="degradado">{{ d }}</span> }
            </div>

            @if (r.julgadas > 0) {
              <ul class="criterios" aria-label="Média por critério">
                @for (c of medias(); track c.criterio) {
                  <li>
                    <span class="crit-nome">{{ c.rotulo }}</span>
                    <span class="barra" role="meter" [attr.aria-label]="c.rotulo" aria-valuemin="0" aria-valuemax="5" [attr.aria-valuenow]="c.media ?? 0">
                      <span class="barra-cheia" [style.width.%]="c.largura"></span></span>
                    <span class="txt-dados">{{ nota(c.media) }}</span>
                  </li>
                }
              </ul>
            }
            @if (r.porRegra.length > 0) {
              <p class="regras">@for (x of r.porRegra; track x.regra) {
                <span class="chip">{{ regra(x.regra) }} <span class="txt-dados">{{ x.quantidade }}</span></span> }</p>
            }
          } @else {
            <p class="parcial" role="status">O resumo não carregou agora; a lista abaixo continua valendo.
              <button type="button" class="link" (click)="carregarResumo()">Tentar de novo</button></p>
          }
        </ui-painel>

        <!-- 2. Avaliações -->
        <ui-painel>
          <div class="cab">
            <h3 class="txt-secao titulo">Avaliações</h3>
            <div class="filtros" role="group" aria-label="Filtrar avaliações">
              @for (f of filtros; track f.id) {
                <button type="button" class="filtro" [class.sel]="filtro() === f.id" [attr.aria-pressed]="filtro() === f.id"
                        (click)="trocarFiltro(f.id)">{{ f.rotulo }}</button>
              }
            </div>
          </div>
          @switch (estadoLista()) {
            @case ('carregando') { <div class="esq"><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /></div> }
            @case ('erro') {
              <ui-estado tipo="erro" titulo="Não foi possível carregar as avaliações" descricao="Dá para tentar de novo.">
                <ui-botao variante="secundario" (click)="carregarLista()">Tentar de novo</ui-botao></ui-estado>
            }
            @case ('pronto') {
              @if (itens().length === 0) {
                <ui-estado titulo="Nenhuma avaliação neste filtro" icone="✅"
                  [descricao]="filtro() === 'todas'
                    ? 'Cada resposta ou sugestão do agente é avaliada em até um minuto. Ligue o agente em modo sombra para começar a medir sem falar com o cliente.'
                    : 'Bom sinal. Veja Todas para conferir o que já foi avaliado.'" />
              } @else {
                <ul class="lista">
                  @for (a of itens(); track a.id) {
                    <li class="item">
                      <div class="linha">
                        <span class="txt-dados quando">{{ a.criadoEm | date: 'dd/MM HH:mm' }}</span>
                        <span class="gatilho encolhe">{{ gatilho(a) }}</span>
                        @if (a.cego) {
                          <!-- Revisão cega (P16): o servidor omitiu notas e gravidade desta conversa. -->
                          <ui-badge tom="neutro">Oculto até você revisar</ui-badge>
                        } @else if (a.tipo === 'juiz') {
                          @if (a.erro) { <ui-badge tom="atencao">Juiz não avaliou</ui-badge> }
                          @else { <ui-badge [tom]="tomNota(a.notaMedia)">Nota {{ nota(a.notaMedia) }}</ui-badge> }
                        } @else {
                          <ui-badge [tom]="gravidade(a).tom">{{ gravidade(a).rotulo }}</ui-badge>
                        }
                        @if (acao(a); as ac) { <ui-badge [tom]="ac.tom">{{ ac.rotulo }}</ui-badge> }
                        <ui-badge tom="neutro">{{ origem(a) }}</ui-badge>
                      </div>
                      @if (a.cego) {
                        <p class="suave">Esta conversa está na amostra de revisão da semana. Revise-a na aba Revisão para ver o que o juiz e as regras acharam.</p>
                      }
                      @if (escapou(a).length > 0) {
                        <ul class="violacoes">
                          @for (v of escapou(a); track $index) {
                            <li><ui-badge [tom]="badgeV(v.gravidade).tom">{{ badgeV(v.gravidade).rotulo }}</ui-badge>
                              <span class="v-nome">{{ violacao(v) }}</span>
                              @if (v.trecho) { <q class="trecho">{{ v.trecho }}</q> }</li>
                          }
                        </ul>
                      }
                      @if (corrigidas(a) > 0) {
                        <p class="suave">{{ corrigidas(a) }} desvio(s) corrigido(s) pelo pipeline antes de sair.</p>
                      }
                      @if (a.erro) { <p class="suave">{{ a.erro }}</p> }
                      @if (criterios(a).length > 0) {
                        <dl class="notas">
                          @for (c of criterios(a); track c.criterio) {
                            <dt>{{ c.rotulo }} <span class="txt-dados">{{ c.nota }}/5</span></dt><dd>{{ c.justificativa }}</dd>
                          }
                        </dl>
                      }
                      <div class="acoes">
                        <ui-botao variante="fantasma" (click)="abrirConversa(a.conversaId)">Abrir conversa</ui-botao>
                        @if (a.tipo === 'regras') {
                          <ui-botao variante="fantasma" (click)="avaliar(a)" [carregando]="avaliando() === a.conversaId">
                            {{ avaliando() === a.conversaId ? 'Avaliando…' : 'Avaliar com o juiz' }}</ui-botao>
                        }
                      </div>
                    </li>
                  }
                </ul>
                @if (erroMais(); as e) { <p class="erro-mais" role="alert">{{ e }}</p> }
                @if (proximoCursor()) {
                  <div class="mais"><ui-botao variante="secundario" (click)="carregarMais()" [carregando]="carregandoMais()">
                    {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</ui-botao></div>
                }
              }
            }
          }
        </ui-painel>

        <!-- 3. Amostra e teto do juiz -->
        @if (config(); as c) {
          <ui-painel>
            <h3 class="txt-secao titulo">Juiz de qualidade <span class="escopo">· este número</span></h3>
            <p class="dica">O juiz (um modelo de IA com rubrica de 5 critérios) lê só uma amostra estável das conversas — a mesma
              conversa sempre entra, ou nunca entra — no fim da conversa e a cada 10 turnos, fora do caminho da resposta.</p>
            <form class="form" (submit)="$event.preventDefault(); salvarConfig()">
              <label class="campo">
                <span>Amostra (% das conversas)</span>
                <input type="text" inputmode="decimal" [placeholder]="'Padrão do modo: ' + padrao(c)" [value]="amostraCampo()"
                       (input)="amostraCampo.set($any($event.target).value); erroAmostra.set(null)"
                       [attr.aria-invalid]="erroAmostra() ? 'true' : null" />
                @if (erroAmostra(); as e) { <span class="msg-erro">{{ e }}</span> }
                <small>Em branco: {{ padrao(c) }} (sombra 100%, assistido 20%, autônomo 5%).</small>
              </label>
              <label class="campo">
                <span>Teto do juiz por mês (R$)</span>
                <input type="text" inputmode="decimal" [placeholder]="'Padrão: ' + reais(c.tetoMesPadraoCentavos)" [value]="tetoCampo()"
                       (input)="tetoCampo.set($any($event.target).value); erroTeto.set(null)"
                       [attr.aria-invalid]="erroTeto() ? 'true' : null" />
                @if (erroTeto(); as e) { <span class="msg-erro">{{ e }}</span> }
                <small>Em branco: {{ reais(c.tetoMesPadraoCentavos) }}. Zero desliga o juiz; as regras continuam.</small>
              </label>
              <div class="acoes"><ui-botao tipo="submit" [carregando]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</ui-botao></div>
            </form>
          </ui-painel>
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .cab { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .titulo { margin: 0; color: var(--texto); }
    .escopo { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-suave); font-size: 13px; }
    .suave { color: var(--texto-suave); font-size: 12px; }
    .kpis { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .kpi { display: grid; gap: 2px; padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      background: var(--superficie); min-width: 0; }
    .kpi.alerta { border-color: var(--erro); }
    .kpi.alerta .txt-kpi { color: var(--erro); }
    .de { color: var(--texto-suave); font-size: 13px; margin-left: 2px; }
    .juiz { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; margin-top: var(--espacamento-3); min-width: 0; }
    .degradado { flex: 1 1 100%; color: var(--atencao); font-size: 13px; overflow-wrap: anywhere; }
    .criterios { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .criterios li { display: grid; grid-template-columns: minmax(120px, 180px) 1fr 40px; gap: var(--espacamento-2); align-items: center; }
    .crit-nome { font-size: 13px; color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .barra { height: 8px; border-radius: 999px; background: var(--superficie-hover); overflow: hidden; }
    .barra-cheia { display: block; height: 100%; background: var(--acao); }
    .regras { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; margin: var(--espacamento-3) 0 0; }
    .chip { font-size: 12px; padding: 2px var(--espacamento-2); border: 1px solid var(--borda); border-radius: 999px; color: var(--texto-secundario); }
    .parcial { margin: 0; color: var(--atencao); font-size: 13px; }
    .filtros { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; }
    .filtro { font: inherit; font-size: 13px; padding: 4px var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: 999px; background: var(--superficie); color: var(--texto-secundario); cursor: pointer; }
    .filtro:hover { background: var(--superficie-hover); }
    .filtro.sel { border-color: var(--acao); color: var(--acao); background: var(--superficie-selecionada); }
    .filtro:focus-visible, .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .lista { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel);
      overflow: hidden; }
    .item { padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .item:last-child { border-bottom: none; }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .quando { color: var(--texto-suave); }
    .gatilho { flex: 1 1 140px; font-size: 14px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .violacoes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); }
    .violacoes li { display: flex; gap: var(--espacamento-2); align-items: baseline; flex-wrap: wrap; font-size: 13px; min-width: 0; }
    .v-nome { color: var(--texto); }
    .trecho { color: var(--texto-secundario); overflow-wrap: anywhere; min-width: 0; flex: 1 1 200px; }
    .notas { display: grid; grid-template-columns: max-content 1fr; gap: var(--espacamento-1) var(--espacamento-3); margin: 0;
      padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); font-size: 13px; }
    .notas dt { color: var(--texto-suave); }
    .notas dd { margin: 0; color: var(--texto); overflow-wrap: anywhere; min-width: 0; }
    .acoes { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; align-items: center; }
    .erro-mais { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .mais { margin-top: var(--espacamento-4); }
    .link { border: 0; background: transparent; padding: 0; font: inherit; color: var(--acao); cursor: pointer; text-decoration: underline; }
    .form { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: start; }
    .form .acoes { grid-column: 1 / -1; }
    .campo { display: grid; gap: var(--espacamento-1); min-width: 0; }
    .campo small { color: var(--texto-suave); font-size: 12px; }
    .msg-erro { color: var(--erro); font-size: 12px; }
    @media (max-width: 640px) {
      .notas { grid-template-columns: 1fr; }
      .item { padding: var(--espacamento-3); }
      .criterios li { grid-template-columns: 1fr 40px; }
      .criterios .barra { grid-column: 1 / -1; grid-row: 2; }
    }
  `,
})
export class AgenteQualidadeComponente {
  /** Número selecionado na página. */
  readonly canalId = input.required<string>()

  readonly #api = inject(QualidadeServico)
  readonly #toast = inject(ToastServico)
  readonly #inbox = inject(InboxServico)

  readonly filtros = FILTROS
  readonly estado = signal<Estado>('carregando')
  readonly resumo = signal<ResumoQualidadeDto | null>(null)
  readonly config = signal<ConfigQualidade | null>(null)

  readonly filtro = signal<FiltroQualidade>('achados')
  readonly estadoLista = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly itens = signal<readonly AvaliacaoQualidadeDto[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erroMais = signal<string | null>(null)
  readonly avaliando = signal<string | null>(null)
  readonly exportando = signal(false)

  readonly amostraCampo = signal('')
  readonly tetoCampo = signal('')
  readonly erroAmostra = signal<string | null>(null)
  readonly erroTeto = signal<string | null>(null)
  readonly salvando = signal(false)

  readonly situacao = computed(() => {
    const r = this.resumo()
    return r ? situacaoDoJuiz(r.juiz) : { rotulo: '', tom: 'neutro' as const, detalhe: null }
  })
  readonly medias = computed(() => { const r = this.resumo(); return r ? mediasDoResumo(r) : [] })
  readonly amostraTexto = computed(() => {
    const r = this.resumo()
    return r ? formatarAmostra(r.amostra ?? r.amostraPadrao) : ''
  })

  constructor() {
    effect(() => { this.canalId(); untracked(() => void this.carregar()) })
  }

  nota(n: number | null): string { return formatarNota(n) }
  tomNota(n: number | null) { return tomDaNota(n) }
  reais(c: number): string { return formatarReais(c) }
  gravidade(a: AvaliacaoQualidadeDto) { return badgeGravidade(a.piorGravidade) }
  badgeV(g: AvaliacaoQualidadeDto['violacoes'][number]['gravidade']) { return badgeGravidade(g) }
  acao(a: AvaliacaoQualidadeDto) { return badgeAcao(a.acao) }
  origem(a: AvaliacaoQualidadeDto): string { return rotuloOrigem(a.origem) }
  gatilho(a: AvaliacaoQualidadeDto): string { return rotuloGatilho(a.gatilho) }
  regra(r: string): string { return linhaDaViolacao({ regra: r as never, gravidade: 'MEDIA', trecho: '' }) }
  violacao(v: AvaliacaoQualidadeDto['violacoes'][number]): string { return linhaDaViolacao(v) }
  escapou(a: AvaliacaoQualidadeDto) { return a.violacoes.filter((v) => !v.corrigida) }
  corrigidas(a: AvaliacaoQualidadeDto): number { return a.violacoes.filter((v) => v.corrigida).length }
  criterios(a: AvaliacaoQualidadeDto) { return criteriosDaAvaliacao(a) }
  padrao(c: ConfigQualidade): string { return formatarAmostra(c.amostraPadrao) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    const canal = this.canalId()
    try {
      // A lista é o principal: se ela falha, a aba inteira mostra o erro.
      const [pagina, config] = await Promise.all([
        this.#api.listar(canal, this.filtro(), null),
        this.#api.config(canal),
      ])
      this.itens.set(pagina.itens); this.proximoCursor.set(pagina.proximoCursor); this.estadoLista.set('pronto')
      this.config.set(config)
      this.amostraCampo.set(textoDaAmostra(config.amostra))
      this.tetoCampo.set(config.tetoMesCentavos === null ? '' : centavosParaReais(config.tetoMesCentavos))
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
      return
    }
    await this.carregarResumo()
  }

  /** Secundário: falha vira aviso localizado (parcial), a lista segue na tela. */
  async carregarResumo(): Promise<void> {
    try { this.resumo.set(await this.#api.resumo(this.canalId())) } catch { this.resumo.set(null) }
  }

  trocarFiltro(f: FiltroQualidade): void {
    if (f === this.filtro()) return
    this.filtro.set(f)
    void this.carregarLista()
  }

  async carregarLista(): Promise<void> {
    this.estadoLista.set('carregando'); this.erroMais.set(null)
    try {
      const p = await this.#api.listar(this.canalId(), this.filtro(), null)
      this.itens.set(p.itens); this.proximoCursor.set(p.proximoCursor); this.estadoLista.set('pronto')
    } catch { this.estadoLista.set('erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true); this.erroMais.set(null)
    try {
      const p = await this.#api.listar(this.canalId(), this.filtro(), cursor)
      this.itens.update((a) => mesclarPagina(a, p.itens, (x) => x.id))
      this.proximoCursor.set(p.proximoCursor)
    } catch {
      this.erroMais.set('Não foi possível carregar mais avaliações. Tente de novo.')
    } finally { this.carregandoMais.set(false) }
  }

  abrirConversa(conversaId: string): void { void this.#inbox.abrir(conversaId) }

  async avaliar(a: AvaliacaoQualidadeDto): Promise<void> {
    if (this.avaliando()) return
    this.avaliando.set(a.conversaId)
    // Julga a sessão DESTE item (a da decisão), não a mais recente da conversa.
    const r = await this.#api.avaliar(a.conversaId, a.decisaoId)
    this.avaliando.set(null)
    if (!r.ok) {
      this.#toast.erro(mensagemDaFalha(r.erro.erro, r.erro.mensagem ?? 'Não foi possível avaliar agora.'))
      return
    }
    this.#toast.sucesso(r.desfecho === 'ja_avaliada' ? 'Esta conversa já tinha nota do juiz.' : `Avaliada: nota ${formatarNota(r.avaliacao?.notaMedia ?? null)}.`)
    if (this.filtro() !== 'criticas') void this.carregarLista()
    void this.carregarResumo()
  }

  async exportar(): Promise<void> {
    if (this.exportando()) return
    this.exportando.set(true)
    const r = await this.#api.amostraSemanal(this.canalId())
    this.exportando.set(false)
    if (!r.ok) {
      this.#toast.erro(mensagemDaFalha(r.erro.erro, 'Não foi possível exportar a amostra agora.'))
      return
    }
    const url = URL.createObjectURL(r.blob)
    const link = document.createElement('a')
    link.href = url; link.download = r.nome
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    this.#toast.sucesso('Amostra da semana exportada.')
  }

  async salvarConfig(): Promise<void> {
    const amostra = amostraParaSalvar(this.amostraCampo())
    if (!amostra.ok) { this.erroAmostra.set(amostra.erro); return }
    const textoTeto = this.tetoCampo().trim()
    let teto: number | null = null
    if (textoTeto) {
      const c = reaisParaCentavos(textoTeto)
      if (c === null || c < 0) { this.erroTeto.set('Use um valor em reais, ex.: 20,00.'); return }
      teto = c
    }
    this.salvando.set(true)
    const r = await this.#api.salvarConfig(this.canalId(), amostra.valor, teto)
    this.salvando.set(false)
    if (!r.ok) {
      this.#toast.erro(mensagemDaFalha(r.erro.erro, r.erro.mensagem ?? 'Não foi possível salvar.'))
      return
    }
    this.#toast.sucesso('Juiz de qualidade salvo.')
    try { this.config.set(await this.#api.config(this.canalId())) } catch { /* fica o que estava */ }
    void this.carregarResumo()
  }
}
