import { Component, ChangeDetectionStrategy, inject, input, signal, computed, effect, untracked } from '@angular/core'
import type { EstadoAtivas, TemplateAprovadoResumo } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, ConfirmacaoServico, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { AtivasServico } from './ativas.servico.js'
import {
  adicionarFeriado, badgeStatusTemplate, confirmacaoLiberar, erroDaApi, feriadoDeData, removerFeriado, rotuloFeriado, rotuloSuspensao,
  formatarNoFuso, validarAtivas, type ErrosAtivas, type FormAtivas,
} from './ativas.regras.js'

/**
 * MENSAGENS ATIVAS (raia P11) — o que o agente INICIA sozinho (o retorno):
 * suspensão pela qualidade do número, expediente e feriados, limites por dia e
 * semana e, no oficial, o template usado fora da janela de 24h.
 *
 * ⚠️ A tela só ACRESCENTA restrição (ADR-029): limite mínimo 1, e escolher um
 *    template não desliga a janela — sem template aprovado a ativa é recusada.
 * Cinco estados: carregando (esqueleto), erro, sem permissão, pronto, e
 * parcial (a lista de templates falhou; o resto da tela segue).
 */
export const ATIVAS_PRONTO: boolean = true

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

@Component({
  selector: 'app-agente-ativas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq">
          <ui-esqueleto altura="20px" largura="40%" /><ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso às mensagens ativas"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar as mensagens ativas"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (dados(); as d) {
          <ui-painel>
            <header class="cab">
              <h3 class="txt-secao">Mensagens ativas</h3>
              <p class="sub">O que o agente inicia sozinho — os retornos depois de uma proposta ou de um carrinho parado.
                Resposta a quem acabou de escrever não passa por aqui.</p>
            </header>

            @if (d.suspensao; as s) {
              <div class="aviso aviso--erro" role="status">
                <strong>Ativas suspensas desde {{ quando(s.desde, d.fuso) }}.</strong>
                {{ suspensao(s.motivo) }}
                <div class="acoes-aviso">
                  <ui-botao variante="secundario" (click)="liberar()" [carregando]="liberando()">Liberar agora</ui-botao>
                </div>
              </div>
            }

            <section class="bloco">
              <h4 class="txt-rotulo">Horário</h4>
              @if (!d.horarioConfigurado) {
                <p class="aviso">Este número não tem horário de atendimento: as ativas saem a qualquer hora, inclusive de madrugada.
                  Configure o horário nas configurações do número.</p>
              } @else if (d.expediente.aberto) {
                <p class="linha">Dentro do expediente agora — as ativas saem na hora marcada.</p>
              } @else {
                <p class="linha">Fora do expediente agora.
                  @if (d.expediente.proximaAbertura) { As ativas vencidas saem na próxima abertura: <span class="txt-dados">{{ quando(d.expediente.proximaAbertura, d.fuso) }}</span>. }
                  @else { Nenhum dia aberto nas próximas semanas — as ativas ficam esperando. }
                </p>
              }

              <div class="feriados">
                <span class="rot">Feriados (o expediente não abre)</span>
                @if (form().feriados.length === 0) {
                  <p class="obs">Nenhum feriado. Ativa que venceria num feriado espera o próximo dia útil.</p>
                } @else {
                  <ul class="chips">
                    @for (f of form().feriados; track f) {
                      <li class="chip"><span class="txt-dados">{{ rotulo(f) }}</span>
                        <button type="button" class="x" [attr.aria-label]="'Remover feriado ' + rotulo(f)" (click)="tirarFeriado(f)">×</button></li>
                    }
                  </ul>
                }
                <div class="add">
                  <label class="campo"><span>Data</span>
                    <input type="date" [value]="novaData()" (input)="novaData.set($any($event.target).value)" /></label>
                  <label class="chk"><input type="checkbox" [checked]="todoAno()" (change)="todoAno.set($any($event.target).checked)" />Repete todo ano</label>
                  <ui-botao variante="secundario" (click)="incluirFeriado()" [desabilitado]="!novaData()">Adicionar feriado</ui-botao>
                </div>
                @if (erros().feriados; as e) { <span class="msg-erro">{{ e }}</span> }
              </div>
            </section>

            <section class="bloco">
              <h4 class="txt-rotulo">Limites por conversa</h4>
              <p class="obs">Contados desde a última mensagem do cliente: quando ele responde, a conta zera. Acima do limite, a ativa é descartada — não acumula.</p>
              <div class="grade-2">
                <label class="campo"><span>Por dia (24 h)</span>
                  <input type="number" min="1" [max]="maxDia" step="1" [value]="form().limiteDia"
                         (input)="mudar('limiteDia', +$any($event.target).value)" [attr.aria-invalid]="erros().limiteDia ? 'true' : null" />
                  @if (erros().limiteDia; as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Padrão: {{ d.padroes.limiteDia }}.</small></label>
                <label class="campo"><span>Por semana (7 dias)</span>
                  <input type="number" min="1" [max]="maxSemana" step="1" [value]="form().limiteSemana"
                         (input)="mudar('limiteSemana', +$any($event.target).value)" [attr.aria-invalid]="erros().limiteSemana ? 'true' : null" />
                  @if (erros().limiteSemana; as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Padrão: {{ d.padroes.limiteSemana }}.</small></label>
              </div>
            </section>

            @if (d.exigeTemplateForaDaJanela) {
              <section class="bloco">
                <h4 class="txt-rotulo">Fora da janela de 24 h (WhatsApp oficial)</h4>
                <p class="obs">Passadas 24 h da última mensagem do cliente, a Meta só aceita template aprovado. Sem um escolhido aqui,
                  o retorno é recusado e fica registrado. Só serve template com no máximo a variável <span class="txt-dados" ngNonBindable>{{1}}</span> (primeiro nome).</p>
                @if (d.template; as t) {
                  <div class="tpl-atual">
                    <span class="txt-dados encolhe">{{ t.nome }} · {{ t.idioma }}</span>
                    <ui-badge [tom]="badge(t.status).tom">{{ badge(t.status).rotulo }}</ui-badge>
                  </div>
                  @if (t.status !== 'APPROVED') { <p class="aviso">Este template não está aprovado agora: os retornos fora de 24 h estão sendo recusados.</p> }
                }
                <label class="campo"><span>Template de retorno</span>
                  <select [value]="form().templateRetorno ?? ''" (change)="mudar('templateRetorno', $any($event.target).value || null)"
                          [attr.aria-invalid]="erros().templateRetorno ? 'true' : null">
                    <option value="">Nenhum — recusar fora de 24 h</option>
                    @if (d.template; as t) { @if (!temNaLista(t.id)) { <option [value]="t.id">{{ t.nome }} ({{ t.idioma }})</option> } }
                    @for (t of templates(); track t.id) {
                      <option [value]="t.id" [disabled]="!t.compativel">{{ t.nome }} ({{ t.idioma }}){{ t.compativel ? '' : ' — usa variável além do primeiro nome' }}</option>
                    }
                  </select>
                  @if (erros().templateRetorno; as e) { <span class="msg-erro">{{ e }}</span> }
                </label>
                @if (escolhido(); as t) { <p class="previa">“{{ t.corpo }}”</p> }
                @if (templatesFalhou()) {
                  <p class="aviso" role="status">Não foi possível carregar os templates aprovados.
                    <button type="button" class="link" (click)="carregarTemplates(null)">Tentar de novo</button></p>
                } @else if (templatesCursor()) {
                  <button type="button" class="link" (click)="carregarTemplates(templatesCursor())">Carregar mais templates</button>
                } @else if (templates().length === 0) {
                  <p class="obs">Nenhum template aprovado ainda. Crie um em Templates e aguarde a aprovação da Meta.</p>
                }
              </section>
            }

            @if (erros().geral; as e) { <p class="msg-erro" role="alert">{{ e }}</p> }
            <div class="acoes">
              <ui-botao (click)="salvar()" [carregando]="salvando()" [desabilitado]="!alterado()">Salvar</ui-botao>
              @if (alterado()) { <ui-botao variante="fantasma" (click)="descartar()">Descartar alterações</ui-botao> }
            </div>
          </ui-painel>
        }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .cab { margin-bottom: var(--espacamento-4); }
    .cab h3 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 13px; }
    .bloco { border-top: 1px solid var(--borda); padding-top: var(--espacamento-4); margin-top: var(--espacamento-4); min-width: 0; }
    .bloco h4 { margin: 0 0 var(--espacamento-2); }
    .linha { margin: 0; color: var(--texto); font-size: 14px; }
    .obs { margin: 0 0 var(--espacamento-2); color: var(--texto-suave); font-size: 12px; overflow-wrap: anywhere; }
    .aviso { padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; margin: 0 0 var(--espacamento-3); overflow-wrap: anywhere; }
    .aviso--erro { background: var(--erro-suave); }
    .acoes-aviso { margin-top: var(--espacamento-2); }
    .feriados { margin-top: var(--espacamento-3); display: grid; gap: var(--espacamento-2); grid-template-columns: minmax(0, 1fr); min-width: 0; }
    .rot { color: var(--texto); font-size: 13px; }
    .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); border: 1px solid var(--borda);
      border-radius: var(--raio-completo); padding: 2px var(--espacamento-1) 2px var(--espacamento-3); background: var(--superficie); }
    .x { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer; font: inherit;
      min-width: 24px; min-height: 24px; border-radius: var(--raio-completo); }
    .x:hover { background: var(--superficie-hover); color: var(--texto); }
    .x:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .add { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3); }
    .add .campo { flex: 0 1 200px; }
    .campo { display: grid; gap: var(--espacamento-1); grid-template-columns: minmax(0, 1fr); min-width: 0; color: var(--texto); font-size: 13px; }
    .campo small { color: var(--texto-suave); font-size: 12px; }
    .campo input, .campo select { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console);
      padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); }
    .campo input:focus-visible, .campo select:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .campo [aria-invalid='true'] { border-color: var(--borda-erro); }
    .chk { display: flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); font-size: 13px;
      min-height: var(--densidade-alvo-clique-console); }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .grade-2 { display: grid; gap: var(--espacamento-3); grid-template-columns: 1fr 1fr; min-width: 0; }
    .grade-2 > * { min-width: 0; }
    .tpl-atual { display: flex; align-items: center; gap: var(--espacamento-2); margin-bottom: var(--espacamento-2); min-width: 0; }
    .encolhe { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .previa { margin: var(--espacamento-2) 0; color: var(--texto-secundario); font-size: 13px; overflow-wrap: anywhere; }
    .link { border: 0; background: transparent; padding: 0; font: inherit; font-size: 13px; color: var(--acao); cursor: pointer; text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; margin-top: var(--espacamento-4); }
    @media (max-width: 640px) { .grade-2 { grid-template-columns: 1fr; } }
  `,
})
export class AgenteAtivasComponente {
  /** Número selecionado na página. */
  readonly canalId = input.required<string>()

  private readonly api = inject(AtivasServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly estado = signal<Estado>('carregando')
  readonly dados = signal<EstadoAtivas | null>(null)
  readonly form = signal<FormAtivas>({ limiteDia: 2, limiteSemana: 4, templateRetorno: null, feriados: [] })
  private readonly original = signal<FormAtivas | null>(null)
  readonly erros = signal<ErrosAtivas>({})
  readonly salvando = signal(false)
  readonly liberando = signal(false)
  readonly novaData = signal('')
  readonly todoAno = signal(false)
  readonly templates = signal<readonly TemplateAprovadoResumo[]>([])
  readonly templatesCursor = signal<string | null>(null)
  readonly templatesFalhou = signal(false)

  readonly maxDia = 10
  readonly maxSemana = 30

  readonly alterado = computed(() => JSON.stringify(this.form()) !== JSON.stringify(this.original()))
  readonly escolhido = computed(() => {
    const id = this.form().templateRetorno
    if (!id) return null
    return this.templates().find((t) => t.id === id) ?? (this.dados()?.template?.id === id ? this.dados()!.template : null)
  })

  constructor() {
    // Troca de número recarrega — o texto não salvo é do número anterior.
    effect(() => { const id = this.canalId(); untracked(() => void this.carregar(id)) })
  }

  rotulo(f: string): string { return rotuloFeriado(f) }
  /** Data no fuso do TENANT (a loja), não no do navegador. */
  quando(iso: string, fuso: string): string { return formatarNoFuso(iso, fuso) }
  suspensao(m: string): string { return rotuloSuspensao(m) }
  badge(s: string) { return badgeStatusTemplate(s) }
  temNaLista(id: string): boolean { return this.templates().some((t) => t.id === id) }

  async carregar(canalId: string = this.canalId()): Promise<void> {
    this.estado.set('carregando'); this.erros.set({})
    try {
      const d = await this.api.carregar(canalId)
      const f: FormAtivas = { ...d.config, feriados: [...d.feriados] }
      this.dados.set(d); this.form.set(f); this.original.set(f)
      this.estado.set('pronto')
      if (d.exigeTemplateForaDaJanela) void this.carregarTemplates(null)
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarTemplates(cursor: string | null): Promise<void> {
    this.templatesFalhou.set(false)
    try {
      const p = await this.api.listarTemplates(this.canalId(), cursor)
      this.templates.update((a) => (cursor ? [...a, ...p.itens] : p.itens))
      this.templatesCursor.set(p.proximoCursor)
    } catch {
      // Parcial: o resto da tela segue; o aviso é localizado no bloco.
      this.templatesFalhou.set(true)
    }
  }

  mudar<K extends keyof FormAtivas>(campo: K, valor: FormAtivas[K]): void {
    this.form.update((f) => ({ ...f, [campo]: valor }))
    this.erros.update((e) => {
      const { [campo]: _campo, geral: _geral, ...resto } = e
      return resto
    })
  }

  incluirFeriado(): void {
    const f = feriadoDeData(this.novaData(), this.todoAno())
    if (!f) { this.erros.update((e) => ({ ...e, feriados: 'Escolha uma data válida.' })); return }
    this.mudar('feriados', adicionarFeriado(this.form().feriados, f))
    this.novaData.set('')
  }

  tirarFeriado(f: string): void { this.mudar('feriados', removerFeriado(this.form().feriados, f)) }

  descartar(): void {
    const o = this.original()
    if (o) this.form.set(o)
    this.erros.set({})
  }

  async salvar(): Promise<void> {
    const f = this.form()
    const locais = validarAtivas(f)
    if (Object.keys(locais).length > 0) { this.erros.set(locais); this.toast.erro('Corrija os campos destacados antes de salvar.'); return }
    this.salvando.set(true)
    try {
      const r = await this.api.salvar(this.canalId(), { ...f, feriados: [...f.feriados] })
      if (r.ok) {
        this.toast.sucesso('Mensagens ativas salvas — valem no próximo retorno.')
        await this.carregar()
        return
      }
      this.erros.set(erroDaApi(r.erro.erro, r.erro.mensagem, r.erro.campos))
    } finally { this.salvando.set(false) }
  }

  async liberar(): Promise<void> {
    const motivo = this.dados()?.suspensao?.motivo
    if (motivo === undefined) return
    // ⚠️ Modal do console, nunca `confirm()` nativo — e com o número em vermelho, confirmação digitada.
    if (!(await this.confirmacao.confirmar(confirmacaoLiberar(motivo)))) return
    this.liberando.set(true)
    try {
      const r = await this.api.liberar(this.canalId())
      if (r.ok) { this.toast.sucesso('Ativas liberadas neste número.'); await this.carregar(); return }
      this.toast.erro(r.status === 403 ? 'Só um administrador pode liberar as ativas.' : r.erro.mensagem ?? 'Não foi possível liberar.')
    } finally { this.liberando.set(false) }
  }
}
