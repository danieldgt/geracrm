import { Component, ChangeDetectionStrategy, computed, inject, signal, viewChild, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import {
  AbasComponente, BotaoComponente, CabecalhoTelaComponente, ConfirmacaoServico, PainelComponente, EsqueletoComponente, EstadoComponente,
  type Aba,
} from '../../../compartilhado/ui/index.js'
import { AgenteServico, ehSemPermissao, type CanalResumo } from './agente.servico.js'
import { AgenteConfigComponente } from './agente-config.componente.js'
import { AgenteAgendaComponente } from './agente-agenda.componente.js'
import { AgentePlaygroundComponente } from './agente-playground.componente.js'
import { AgenteDecisoesComponente } from './agente-decisoes.componente.js'
import { AgenteSessoesComponente } from './agente-sessoes.componente.js'
import { AgenteConhecimentoComponente } from './agente-conhecimento.componente.js'
import { AgenteProtecoesComponente, ABA_PROTECOES_PRONTA } from './agente-protecoes.componente.js'
import { AgenteQualidadeComponente, ABA_QUALIDADE_PRONTA } from './agente-qualidade.componente.js'
import { AgenteRevisaoComponente, ABA_REVISAO_PRONTA } from './agente-revisao.componente.js'
import { AgenteMetricasComponente, ABA_METRICAS_PRONTA } from './agente-metricas.componente.js'
import { AgentePlaybookComponente, ABA_PLAYBOOK_PRONTA } from './agente-playbook.componente.js'
import {
  enderecoDaSecao, gruposVisiveis, precisaConfirmarTroca, secaoDoEndereco, secaoDoGrupo, type Secao, type SubAgente,
} from './agente-abas.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/** Os 5 grupos, só com as sub-seções prontas (as das raias entram pela constante do componente). */
const GRUPOS = gruposVisiveis({
  protecoes: ABA_PROTECOES_PRONTA,
  playbook: ABA_PLAYBOOK_PRONTA,
  qualidade: ABA_QUALIDADE_PRONTA,
  revisao: ABA_REVISAO_PRONTA,
  metricas: ABA_METRICAS_PRONTA,
})

/**
 * O agente vendedor como PRODUTO, em 5 grupos pela tarefa: Configurar
 * (configuração e proteções), Ensinar (conhecimento e playbook), Testar
 * (playground), Acompanhar (sessões e decisões) e Qualidade (qualidade,
 * revisão e métricas). O número escolhido fica no cabeçalho, ao lado do título.
 *
 * ⚠️ A seção vem do ENDEREÇO (`?aba=<grupo>&sub=<sub>`): favorito, deep link e
 * o "voltar" do navegador funcionam; o formato antigo (`?aba=playbook`) segue
 * valendo (agente-abas.regras.ts).
 *
 * A página só cuida do número selecionado e da navegação; cada seção carrega o
 * seu dado e tem os seus cinco estados. Trocar de número recarrega as seções por
 * número (config, conhecimento, playground, decisões); sessões são do tenant inteiro.
 */
@Component({
  selector: 'app-agente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, AbasComponente, BotaoComponente, CabecalhoTelaComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
    AgenteConfigComponente, AgenteAgendaComponente, AgenteConhecimentoComponente, AgentePlaygroundComponente, AgenteDecisoesComponente,
    AgenteSessoesComponente, AgenteProtecoesComponente, AgenteQualidadeComponente, AgenteRevisaoComponente,
    AgenteMetricasComponente, AgentePlaybookComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Agente vendedor"
      subtitulo="Atende no WhatsApp com o catálogo e as políticas da loja — em sombra, assistido ou sozinho, por número.">
      @if (estado() === 'pronto' && canais().length > 0) {
        <label class="numero">
          <span class="txt-rotulo">Número</span>
          <select [value]="canalId()" (change)="trocarNumero($any($event.target))">
            @for (c of canais(); track c.id) { <option [value]="c.id" [selected]="c.id === canalId()">{{ c.nomeAmigavel }}</option> }
          </select>
        </label>
      }
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq-lista">
          <ui-esqueleto altura="40px" largura="50%" /><ui-esqueleto altura="36px" /><ui-esqueleto altura="160px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Você não tem acesso ao agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar os números"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (canais().length === 0) {
          <ui-painel><ui-estado titulo="Nenhum número conectado" icone="smartphone"
            descricao="O agente atende por número. Conecte um número e volte aqui.">
            <a class="btn btn--primario" routerLink="/config/numeros">Conectar um número</a>
          </ui-estado></ui-painel>
        } @else {
          <ui-abas class="grupos" [abas]="abasGrupo" [ativa]="secao().grupo" (ativaChange)="irParaGrupo($event)" />

          @if (grupoAtual(); as g) {
            @if (g.subs.length > 1) {
              <div class="subs" role="tablist" [attr.aria-label]="'Seções de ' + g.rotulo" (keydown)="teclaSub($event, g.subs)">
                @for (s of g.subs; track s.id) {
                  <button type="button" role="tab" class="sub" [id]="'sub-' + s.id" [attr.data-sub]="s.id"
                          [attr.aria-selected]="secao().sub === s.id" [attr.aria-controls]="'painel-agente'"
                          [attr.tabindex]="secao().sub === s.id ? 0 : -1" (click)="irPara(s.id)">{{ s.rotulo }}</button>
                }
              </div>
            }
          }

          <div role="tabpanel" id="painel-agente" [attr.aria-label]="rotuloSecao()" class="painel-aba">
            @switch (secao().sub) {
              @case ('configuracao') {
                <app-agente-config [canalId]="canalId()" (abrirConhecimento)="irPara('conhecimento')" (abrirPlaybook)="irPara('playbook')" />
                <app-agente-agenda [canalId]="canalId()" /><!-- C3: só com o módulo Agenda ligado -->
              }
              @case ('protecoes') { <app-agente-protecoes [canalId]="canalId()" /> }
              @case ('conhecimento') { <app-agente-conhecimento [canalId]="canalId()" /> }
              @case ('playbook') { <app-agente-playbook [canalId]="canalId()" /> }
              @case ('playground') { <app-agente-playground [canalId]="canalId()" /> }
              @case ('sessoes') { <app-agente-sessoes /> }
              @case ('decisoes') { <app-agente-decisoes [canalId]="canalId()" /> }
              @case ('qualidade') { <app-agente-qualidade [canalId]="canalId()" /> }
              @case ('revisao') { <app-agente-revisao [canalId]="canalId()" /> }
              @case ('metricas') { <app-agente-metricas [canalId]="canalId()" /> }
            }
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; padding: var(--espacamento-6); }
    .esq-lista { display: grid; gap: var(--espacamento-3); }
    .numero { display: grid; gap: var(--espacamento-1); min-width: 0; width: min(280px, 100%); }
    .numero select { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console);
      padding: 0 var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto); }
    .numero select:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .grupos { margin-bottom: var(--espacamento-3); }
    /* Sub-seções: segmentado discreto, abaixo das abas — nunca uma segunda barra de abas igual. */
    .subs { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); margin-bottom: var(--espacamento-4); }
    .sub { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-1) var(--espacamento-3);
      border: 1px solid transparent; border-radius: var(--raio-controle); background: transparent;
      color: var(--texto-secundario); font: inherit; font-size: 14px; cursor: pointer;
      transition: background var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    .sub:hover { color: var(--texto); background: var(--superficie-hover); }
    .sub[aria-selected='true'] { color: var(--texto); background: var(--superficie-selecionada); border-color: var(--borda); font-weight: 600; }
    .sub:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .painel-aba { min-width: 0; }
    @media (max-width: 719.98px) { :host { padding: var(--espacamento-4); } .numero { width: 100%; } }
  `,
})
export class AgentePagina implements OnInit {
  private readonly api = inject(AgenteServico)
  private readonly rota = inject(ActivatedRoute)
  private readonly router = inject(Router)

  readonly grupos = GRUPOS
  readonly abasGrupo: readonly Aba[] = GRUPOS.map((g) => ({ id: g.id, rotulo: g.rotulo }))
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly CanalResumo[]>([])
  readonly canalId = signal('')
  private readonly confirmacao = inject(ConfirmacaoServico)
  /** O Configurar do número atual (só existe na sub-seção Configuração) — para saber se há edição pendente. */
  private readonly config = viewChild(AgenteConfigComponente)

  /** A seção vem do endereço — a única fonte (voltar do navegador incluído). */
  private readonly query = toSignal(this.rota.queryParamMap, { initialValue: this.rota.snapshot.queryParamMap })
  readonly secao = computed<Secao>(() => secaoDoEndereco(this.query().get('aba'), this.query().get('sub'), GRUPOS))
  readonly grupoAtual = computed(() => GRUPOS.find((g) => g.id === this.secao().grupo) ?? null)
  readonly rotuloSecao = computed(() => this.grupoAtual()?.subs.find((s) => s.id === this.secao().sub)?.rotulo ?? '')

  ngOnInit(): void {
    void this.carregar()
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const canais = await this.api.listarCanais()
      this.canais.set(canais)
      // Mantém o número escolhido se ele ainda existe; senão, o primeiro.
      const atual = this.canalId()
      if (!canais.some((c) => c.id === atual)) this.canalId.set(canais[0]?.id ?? '')
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  /**
   * Troca o número do cabeçalho. Com alterações não salvas no Configurar, pergunta
   * antes: o formulário recarrega do número novo e a edição se perderia. Se a
   * pessoa continuar editando, o seletor volta ao número de antes.
   */
  async trocarNumero(seletor: HTMLSelectElement): Promise<void> {
    const atual = this.canalId()
    const novo = seletor.value
    if (precisaConfirmarTroca(atual, novo, this.config()?.alterado() ?? false)) {
      const ok = await this.confirmacao.confirmar({
        titulo: 'Descartar as alterações deste número?',
        mensagem: 'Há alterações não salvas na configuração do agente. Trocar de número descarta o que foi editado.',
        acao: 'Descartar', cancelar: 'Continuar editando', perigo: true,
      })
      if (!ok) { seletor.value = atual; return }
    }
    this.canalId.set(novo)
  }

  irParaGrupo(grupo: string): void {
    const s = secaoDoGrupo(grupo, GRUPOS)
    if (s) this.navegar(s)
  }

  /** Vai para uma sub-seção (usado também pelos atalhos de dentro da Configuração). */
  irPara(sub: SubAgente): void {
    const g = GRUPOS.find((x) => x.subs.some((s) => s.id === sub))
    if (g) this.navegar({ grupo: g.id, sub })
  }

  private navegar(s: Secao): void {
    const e = enderecoDaSecao(s, GRUPOS)
    void this.router.navigate([], {
      relativeTo: this.rota, queryParams: { aba: e.aba, sub: e.sub }, queryParamsHandling: 'merge',
    })
  }

  /** Setas movem entre as sub-seções (WAI-ARIA tablist); Home/End vão às pontas. */
  teclaSub(ev: KeyboardEvent, subs: readonly { readonly id: SubAgente }[]): void {
    const i = subs.findIndex((s) => s.id === this.secao().sub)
    let alvo: number | null = null
    if (ev.key === 'ArrowRight') alvo = (i + 1) % subs.length
    else if (ev.key === 'ArrowLeft') alvo = (i - 1 + subs.length) % subs.length
    else if (ev.key === 'Home') alvo = 0
    else if (ev.key === 'End') alvo = subs.length - 1
    if (alvo === null) return
    ev.preventDefault()
    const id = subs[alvo]!.id
    this.irPara(id)
    ;(ev.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(`[data-sub="${id}"]`)?.focus()
  }
}
