import { Component, ChangeDetectionStrategy, inject, input, signal, effect, computed, untracked } from '@angular/core'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
  centavosParaReais, formatarReais,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { CustoServico, type CustoDoNumero, type OrcamentoMensal } from './custo.servico.js'
import { escolhaDoTeto, orcamentoParaSalvar, percentualDoMes, tetoParaSalvar, type EscolhaTeto } from './custo.regras.js'

/**
 * CUSTO E TETOS (ADR-032, raia P6) — bloco da aba "Proteções".
 *
 *   1. Teto por CONVERSA do número: pega loop e conversa patológica. No teto, o
 *      agente para e passa para a equipe (em autônomo, avisando o cliente).
 *   2. Orçamento MENSAL da conta: só ALERTA a 80% e a 100% (uma vez por mês) —
 *      não corta. Quem corta é o teto do dia (Configuração) e o da conversa.
 *
 * ⚠️ Degradação visível: modelo sem preço no catálogo aparece aqui, porque o
 *    custo dele é estimado pelo MAIOR preço e os tetos disparam antes da hora.
 * Cinco estados: carregando, erro (tentar de novo), sem permissão, vazio (sem
 * orçamento definido — o bloco convida a definir) e pronto.
 */
export const CUSTO_PRONTO: boolean = true

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

@Component({
  selector: 'app-agente-custo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq">
          <ui-esqueleto altura="20px" largura="40%" /><ui-esqueleto altura="64px" /><ui-esqueleto altura="20px" largura="60%" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Você não tem acesso ao custo do agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar o custo"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (numero(); as n) {
          <ui-painel>
            <h3 class="titulo">Teto por conversa <span class="escopo">· este número</span></h3>
            <p class="dica">Quando uma conversa chega ao teto, o agente para e passa para a equipe — em autônomo, avisando o
              cliente. Protege contra conversa em loop; não afeta as demais.</p>

            <form class="form" (submit)="$event.preventDefault(); salvarTeto()">
              <fieldset class="opcoes">
                <legend class="sr">Teto por conversa</legend>
                <label class="opcao" [class.sel]="escolha() === 'padrao'">
                  <input type="radio" name="teto" [checked]="escolha() === 'padrao'" (change)="escolha.set('padrao')" />
                  <span>Padrão do sistema <strong>{{ reais(n.tetoSessaoPadraoCentavos) }}</strong></span>
                </label>
                <label class="opcao" [class.sel]="escolha() === 'personalizado'">
                  <input type="radio" name="teto" [checked]="escolha() === 'personalizado'" (change)="escolha.set('personalizado')" />
                  <span>Valor próprio</span>
                </label>
                <label class="opcao" [class.sel]="escolha() === 'sem_teto'">
                  <input type="radio" name="teto" [checked]="escolha() === 'sem_teto'" (change)="escolha.set('sem_teto')" />
                  <span>Sem teto por conversa</span>
                </label>
              </fieldset>

              @if (escolha() === 'personalizado') {
                <label class="campo valor">
                  <span>Teto por conversa (R$)</span>
                  <input type="text" inputmode="decimal" placeholder="Ex.: 2,50" [value]="tetoTexto()"
                         (input)="tetoTexto.set($any($event.target).value); erroTeto.set(null)"
                         [attr.aria-invalid]="erroTeto() ? 'true' : null" />
                  @if (erroTeto(); as e) { <span class="msg-erro">{{ e }}</span> }
                </label>
              }
              @if (escolha() === 'sem_teto') {
                <p class="aviso">Sem teto, uma conversa em loop só para no teto do dia do número.</p>
              }

              <dl class="numeros">
                <div><dt>Gasto hoje neste número</dt>
                  <dd>{{ reais(n.gastoHojeCentavos) }}
                    @if (n.orcamentoDiaCentavos !== null) { <span class="suave">de {{ reais(n.orcamentoDiaCentavos) }} (teto do dia)</span> }
                    @else { <span class="suave">sem teto do dia</span> }
                  </dd></div>
                <div><dt>Conversas nos últimos 30 dias</dt>
                  <dd>{{ n.sessoes30Dias.quantidade }}
                    @if (n.sessoes30Dias.mediaCentavos !== null) {
                      <span class="suave">· média {{ reais(n.sessoes30Dias.mediaCentavos) }} · maior {{ reais(n.sessoes30Dias.maiorCentavos ?? 0) }}</span>
                    }
                  </dd></div>
              </dl>

              <div class="acoes">
                <ui-botao tipo="submit" [carregando]="salvandoTeto()">{{ salvandoTeto() ? 'Salvando…' : 'Salvar teto' }}</ui-botao>
              </div>
            </form>
          </ui-painel>
        }

        @if (orcamento(); as o) {
          <ui-painel>
            <h3 class="titulo">Orçamento mensal de IA <span class="escopo">· toda a conta</span></h3>
            <p class="dica">Só avisa — a 80% e a 100% do valor, uma vez por mês cada, no sino e na faixa de alertas. Não
              desliga o agente.</p>

            @if (o.modelosSemPreco.length > 0) {
              <div class="degradado" role="status">
                <ui-badge tom="atencao">Custo estimado para cima</ui-badge>
                <span>Sem preço no catálogo: <strong>{{ o.modelosSemPreco.join(', ') }}</strong>. O custo desses modelos
                  é estimado pelo maior preço conhecido, e os tetos podem disparar antes da hora.</span>
              </div>
            }

            @if (percentual(); as p) {
              <div class="uso">
                <div class="uso-linha">
                  <span>{{ reais(o.gastoMesCentavos) }} de {{ reais(o.mensalCentavos ?? 0) }} em {{ mesLegivel() }}</span>
                  @if (o.limiarAtingido === 100) { <ui-badge tom="erro">{{ p.real }}% — orçamento atingido</ui-badge> }
                  @else if (o.limiarAtingido === 80) { <ui-badge tom="atencao">{{ p.real }}% — perto do limite</ui-badge> }
                  @else { <ui-badge tom="neutro">{{ p.real }}%</ui-badge> }
                </div>
                <div class="barra" role="progressbar" aria-label="Uso do orçamento mensal"
                     [attr.aria-valuenow]="p.barra" aria-valuemin="0" aria-valuemax="100">
                  <div class="barra-cheia" [class.atencao]="o.limiarAtingido === 80" [class.erro]="o.limiarAtingido === 100"
                       [style.width.%]="p.barra"></div>
                </div>
              </div>
            } @else {
              <ui-estado titulo="Sem orçamento mensal" icone="📊"
                [descricao]="'Gasto de IA em ' + mesLegivel() + ': ' + reais(o.gastoMesCentavos) + '. Defina um valor para ser avisado antes de passar dele.'" />
            }

            <form class="form" (submit)="$event.preventDefault(); salvarOrcamento()">
              <label class="campo valor">
                <span>Orçamento por mês (R$)</span>
                <input type="text" inputmode="decimal" placeholder="Em branco: sem orçamento" [value]="orcamentoTexto()"
                       (input)="orcamentoTexto.set($any($event.target).value); erroOrcamento.set(null)"
                       [attr.aria-invalid]="erroOrcamento() ? 'true' : null" />
                @if (erroOrcamento(); as e) { <span class="msg-erro">{{ e }}</span> }
                <small>Estimativa em reais pelo câmbio de {{ o.cambioBrl.toLocaleString('pt-BR') }} — a fatura é a do fornecedor.</small>
              </label>
              <div class="acoes">
                <ui-botao tipo="submit" [carregando]="salvandoOrcamento()">{{ salvandoOrcamento() ? 'Salvando…' : 'Salvar orçamento' }}</ui-botao>
              </div>
            </form>
          </ui-painel>
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .titulo { margin: 0; font-size: 15px; font-weight: 600; color: var(--texto); }
    .escopo { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-suave); font-size: 13px; }
    .form { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .opcoes { display: grid; gap: var(--espacamento-2); grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      border: 0; margin: 0; padding: 0; min-width: 0; }
    .opcao { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); cursor: pointer; min-width: 0;
      background: var(--superficie); }
    .opcao:hover { background: var(--superficie-hover); }
    .opcao.sel { border-color: var(--acao); background: var(--superficie-selecionada); }
    .opcao:has(input:focus-visible) { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .opcao span { overflow-wrap: anywhere; }
    .valor { max-width: 320px; }
    .aviso { margin: 0; color: var(--atencao); font-size: 13px; }
    .numeros { display: grid; gap: var(--espacamento-2); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 0; }
    .numeros dt { color: var(--texto-suave); font-size: 12px; }
    .numeros dd { margin: 2px 0 0; color: var(--texto); overflow-wrap: anywhere; }
    .suave { color: var(--texto-suave); font-size: 12px; }
    .acoes { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .degradado { display: flex; gap: var(--espacamento-2); align-items: flex-start; flex-wrap: wrap;
      margin-bottom: var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); min-width: 0; }
    .degradado span { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
    .uso { display: grid; gap: var(--espacamento-2); margin-bottom: var(--espacamento-3); }
    .uso-linha { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .barra { height: 8px; border-radius: 999px; background: var(--superficie-hover); overflow: hidden; }
    .barra-cheia { height: 100%; background: var(--acao); }
    .barra-cheia.atencao { background: var(--atencao); }
    .barra-cheia.erro { background: var(--erro); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `,
})
export class AgenteCustoComponente {
  /** Número selecionado na página (o orçamento mensal é da conta inteira). */
  readonly canalId = input.required<string>()

  readonly #api = inject(CustoServico)
  readonly #toast = inject(ToastServico)

  readonly estado = signal<Estado>('carregando')
  readonly numero = signal<CustoDoNumero | null>(null)
  readonly orcamento = signal<OrcamentoMensal | null>(null)

  readonly escolha = signal<EscolhaTeto>('padrao')
  readonly tetoTexto = signal('')
  readonly erroTeto = signal<string | null>(null)
  readonly salvandoTeto = signal(false)

  readonly orcamentoTexto = signal('')
  readonly erroOrcamento = signal<string | null>(null)
  readonly salvandoOrcamento = signal(false)

  readonly percentual = computed(() => {
    const o = this.orcamento()
    return o ? percentualDoMes(o.gastoMesCentavos, o.mensalCentavos) : null
  })
  readonly mesLegivel = computed(() => {
    const m = this.orcamento()?.mes
    if (!m) return ''
    const [a, mm] = m.split('-').map(Number)
    return new Date(a!, (mm ?? 1) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  })

  readonly reais = formatarReais

  constructor() {
    // Trocar de número recarrega (o orçamento vem junto — é barato e mantém um estado só).
    effect(() => {
      this.canalId()
      untracked(() => void this.carregar())
    })
  }

  async carregar(): Promise<void> {
    const canal = this.canalId()
    this.estado.set('carregando')
    try {
      const [n, o] = await Promise.all([this.#api.doNumero(canal), this.#api.orcamento()])
      if (canal !== this.canalId()) return // resposta de um número que já saiu da tela
      this.numero.set(n)
      this.orcamento.set(o)
      this.escolha.set(escolhaDoTeto(n.tetoSessaoCentavos))
      this.tetoTexto.set(n.tetoSessaoCentavos ? centavosParaReais(n.tetoSessaoCentavos) : '')
      this.orcamentoTexto.set(o.mensalCentavos === null ? '' : centavosParaReais(o.mensalCentavos))
      this.erroTeto.set(null); this.erroOrcamento.set(null)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async salvarTeto(): Promise<void> {
    const v = tetoParaSalvar(this.escolha(), this.tetoTexto())
    if (!v.ok) { this.erroTeto.set(v.erro); return }
    this.salvandoTeto.set(true)
    const r = await this.#api.salvarTeto(this.canalId(), v.tetoSessaoCentavos)
    this.salvandoTeto.set(false)
    if (!r.ok) {
      if (r.status === 422) this.erroTeto.set(r.erro.mensagem ?? 'Valor inválido.')
      else this.#toast.erro(r.status === 403 ? 'Só administradores mudam o teto por conversa.' : (r.erro.mensagem ?? 'Não foi possível salvar o teto.'))
      return
    }
    this.#toast.sucesso(r.tetoSessaoEfetivoCentavos === null ? 'Teto por conversa desligado.' : `Teto por conversa: ${formatarReais(r.tetoSessaoEfetivoCentavos)}.`)
    await this.carregar()
  }

  async salvarOrcamento(): Promise<void> {
    const v = orcamentoParaSalvar(this.orcamentoTexto())
    if (!v.ok) { this.erroOrcamento.set(v.erro); return }
    this.salvandoOrcamento.set(true)
    const r = await this.#api.salvarOrcamento(v.mensalCentavos)
    this.salvandoOrcamento.set(false)
    if (!r.ok) {
      if (r.status === 422) this.erroOrcamento.set(r.erro.mensagem ?? 'Valor inválido.')
      else this.#toast.erro(r.status === 403 ? 'Só administradores mudam o orçamento mensal.' : (r.erro.mensagem ?? 'Não foi possível salvar o orçamento.'))
      return
    }
    this.#toast.sucesso(r.mensalCentavos === null ? 'Orçamento mensal removido.' : `Orçamento mensal: ${formatarReais(r.mensalCentavos)}.`)
    await this.carregar()
  }
}
