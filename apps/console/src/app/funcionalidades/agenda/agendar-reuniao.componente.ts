import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { ModalidadeEvento, RespostaHorariosLivres, VendedorParaReuniao } from '@geracrm/shared'
import {
  CampoComponente, EsqueletoComponente, GradeFormComponente, ModalComponente, SelectComponente, ToastServico, codigoDoErro,
  type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { diaIso } from './agenda.regras.js'
import {
  DURACAO_INICIAL, OPCOES_DURACAO, OPCOES_MODALIDADE_REUNIAO, corpoReuniao, estadoDosHorarios, limitesDoDia, mensagemDaFalha,
  opcoesVendedores, recarregaHorarios, rotuloHorario, textoDeSucesso, vendedorInicial, type ErrosReuniao,
} from './agendar-reuniao.regras.js'

/**
 * "Agendar reunião" no cabeçalho da conversa (raia C3, padrão A).
 *
 * Escolhe a pessoa (o responsável do cliente vem primeiro e marcado; depois quem pede e a filial,
 * conforme o escopo — a API filtra), o dia e um HORÁRIO LIVRE da grade da API. Se outra pessoa
 * marcar o mesmo horário no meio, o 409 `agenda.horario_ocupado` é nomeado e a grade recarrega.
 *
 * ⚠️ Só com o módulo Agenda ligado (sem módulo, o botão nem aparece — a API daria 404). NÃO
 *    depende da chave do agente: a pessoa marca mesmo com o agente proibido de marcar.
 */
@Component({
  selector: 'app-agendar-reuniao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalComponente, GradeFormComponente, SelectComponente, CampoComponente, EsqueletoComponente],
  template: `
    @if (modulos.agendaAtiva()) {
      <button class="acao-btn" type="button" (click)="abrir()" title="Marcar uma reunião com este cliente">Agendar reunião</button>
    }
    <ui-modal [aberto]="aberto()" titulo="Agendar reunião" largura="m" (fechar)="fechar()">
      @if (erroVendedores()) {
        <p class="erro" role="alert">Não foi possível carregar quem pode receber a reunião.
          <button type="button" class="link" (click)="carregarVendedores()">Tentar de novo</button></p>
      } @else {
        <form id="form-reuniao" (submit)="salvar($event)" novalidate>
          <ui-grade-form>
            <ui-select rotulo="Com quem" [largo]="true" [obrigatorio]="true" [opcoes]="vendedores()" placeholder="Escolha a pessoa"
              [valor]="usuarioId()" (valorChange)="mudarPessoa($event)" [erro]="erros().usuarioId ?? null"
              dica="Marcar com outra pessoa passa o cliente para ela — só a gestão pode." />
            <ui-campo rotulo="Dia" tipo="date" [obrigatorio]="true" [valor]="dia()" (valorChange)="mudarDia($event)" />
            <ui-select rotulo="Duração" [opcoes]="duracoes" [valor]="duracao()" (valorChange)="mudarDuracao($event)" />
          </ui-grade-form>

          <fieldset class="horarios">
            <legend class="txt-rotulo">Horário livre</legend>
            @switch (estadoHorarios()) {
              @case ('ocioso') { <p class="obs">Escolha a pessoa e o dia para ver os horários livres.</p> }
              @case ('carregando') {
                <div class="grade" aria-busy="true">@for (i of [1, 2, 3, 4]; track i) { <ui-esqueleto altura="32px" largura="72px" /> }</div>
              }
              @case ('erro') {
                <p class="erro" role="alert">Não foi possível carregar os horários.
                  <button type="button" class="link" (click)="carregarHorarios()">Tentar de novo</button></p>
              }
              @case ('fechado') { <p class="obs">Dia sem expediente (fim de semana, feriado ou fora do horário do número). Escolha outro dia.</p> }
              @case ('vazio') { <p class="obs">Nenhum horário livre neste dia para esta pessoa. Tente outro dia ou outra pessoa.</p> }
              @case ('pronto') {
                <div class="grade" role="radiogroup" aria-label="Horários livres">
                  @for (h of horarios(); track h.inicio) {
                    <button type="button" class="horario" role="radio" [attr.aria-checked]="inicio() === h.inicio"
                            [class.escolhido]="inicio() === h.inicio" (click)="escolher(h.inicio)">{{ rotulo(h.inicio) }}</button>
                  }
                </div>
                @if (resposta()?.origemExpediente === 'padrao') {
                  <p class="obs">O número não tem expediente configurado: usando o horário comercial (seg a sex, 9h às 18h).</p>
                }
              }
            }
            @if (erros().inicio; as e) { <span class="msg-erro">{{ e }}</span> }
          </fieldset>

          <ui-grade-form>
            <ui-select rotulo="Modalidade" [opcoes]="modalidades" [valor]="modalidade()" (valorChange)="modalidade.set($any($event))" />
            <ui-campo rotulo="Link (opcional)" placeholder="https://" [valor]="link()" (valorChange)="link.set($event)" [erro]="erros().link ?? null" />
          </ui-grade-form>
          @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
        </form>
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="submit" form="form-reuniao" class="btn btn--primario" [disabled]="salvando() || erroVendedores()">
          {{ salvando() ? 'Marcando…' : 'Marcar reunião' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: inline-flex; }
    .acao-btn { font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; padding: 6px 12px; border-radius: 999px;
      border: 1px solid var(--borda-controle); background: var(--fundo); color: var(--texto); }
    .acao-btn:hover { background: var(--superficie-elevada); }
    .acao-btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .horarios { border: 0; margin: var(--espacamento-4) 0; padding: 0; display: grid; gap: var(--espacamento-2); min-width: 0; }
    .grade { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .horario { font: inherit; font-variant-numeric: tabular-nums; min-height: var(--densidade-alvo-clique-console); padding: 0 var(--espacamento-3);
      border-radius: var(--raio-controle); border: 1px solid var(--borda-controle); background: var(--fundo); color: var(--texto); cursor: pointer; }
    .horario:hover { background: var(--superficie-elevada); }
    .horario.escolhido { border-color: var(--acao); background: var(--acao); color: var(--acao-texto); }
    .horario:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .obs { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .erro, .msg-erro { margin: 0; color: var(--erro); font-size: 13px; }
    .link { font: inherit; background: none; border: 0; padding: 0; color: var(--acao); cursor: pointer; text-decoration: underline; }
  `,
})
export class AgendarReuniaoComponente {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  protected readonly modulos = inject(ModulosServico)

  readonly conversaId = input.required<string>()

  protected readonly duracoes = OPCOES_DURACAO as OpcaoSelect[]
  protected readonly modalidades = OPCOES_MODALIDADE_REUNIAO as OpcaoSelect[]

  readonly aberto = signal(false)
  readonly lista = signal<readonly VendedorParaReuniao[]>([])
  readonly vendedores = computed(() => opcoesVendedores(this.lista()) as OpcaoSelect[])
  readonly erroVendedores = signal(false)
  readonly usuarioId = signal('')
  readonly dia = signal(diaIso(new Date()))
  readonly duracao = signal(DURACAO_INICIAL)
  readonly modalidade = signal<ModalidadeEvento>('online')
  readonly link = signal('')
  readonly inicio = signal<string | null>(null)
  readonly resposta = signal<RespostaHorariosLivres | null>(null)
  readonly carregandoHorarios = signal(false)
  readonly erroHorarios = signal(false)
  readonly salvando = signal(false)
  readonly erros = signal<ErrosReuniao>({})
  readonly erroGeral = signal<string | null>(null)
  readonly horarios = computed(() => this.resposta()?.horarios ?? [])
  readonly estadoHorarios = computed(() => estadoDosHorarios({
    carregando: this.carregandoHorarios(), erro: this.erroHorarios(), resposta: this.resposta(),
  }))
  readonly rotulo = rotuloHorario
  #pedido = 0

  async abrir(): Promise<void> {
    this.dia.set(diaIso(new Date())); this.inicio.set(null); this.link.set('')
    this.erros.set({}); this.erroGeral.set(null); this.resposta.set(null)
    this.aberto.set(true)
    await this.carregarVendedores()
  }

  fechar(): void { if (!this.salvando()) this.aberto.set(false) }

  async carregarVendedores(): Promise<void> {
    this.erroVendedores.set(false)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: VendedorParaReuniao[] }>(
        `/v1/agenda/reuniao/vendedores?conversaId=${encodeURIComponent(this.conversaId())}`))
      this.lista.set(r.itens)
      this.usuarioId.set(vendedorInicial(r.itens))
      if (this.usuarioId()) await this.carregarHorarios()
    } catch { this.erroVendedores.set(true) }
  }

  mudarPessoa(v: string): void { this.usuarioId.set(v); void this.carregarHorarios() }
  mudarDia(v: string): void {
    const { min, max } = limitesDoDia(new Date())
    this.dia.set(v < min ? min : v > max ? max : v)
    void this.carregarHorarios()
  }
  mudarDuracao(v: string): void { this.duracao.set(v); void this.carregarHorarios() }
  escolher(iso: string): void { this.inicio.set(iso); this.erros.update(({ inicio: _i, ...r }) => r) }

  async carregarHorarios(): Promise<void> {
    this.inicio.set(null)
    if (!this.usuarioId() || !this.dia()) { this.resposta.set(null); return }
    const n = ++this.#pedido
    this.carregandoHorarios.set(true); this.erroHorarios.set(false)
    try {
      const q = `usuarioId=${encodeURIComponent(this.usuarioId())}&dia=${this.dia()}&duracao=${this.duracao()}&conversaId=${encodeURIComponent(this.conversaId())}`
      const r = await firstValueFrom(this.http.get<RespostaHorariosLivres>(`/v1/agenda/horarios-livres?${q}`))
      if (n === this.#pedido) this.resposta.set(r)
    } catch {
      if (n === this.#pedido) { this.resposta.set(null); this.erroHorarios.set(true) }
    } finally {
      if (n === this.#pedido) this.carregandoHorarios.set(false)
    }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const c = corpoReuniao(this.conversaId(), {
      usuarioId: this.usuarioId(), inicio: this.inicio(), duracao: this.duracao(), modalidade: this.modalidade(), link: this.link(),
    })
    if (!c.ok) { this.erros.set(c.erros); return }
    this.erros.set({}); this.erroGeral.set(null); this.salvando.set(true)
    try {
      const r = await firstValueFrom(this.http.post<{ eventoId: string; responsavelAlterado: boolean }>('/v1/agenda/reunioes', c.corpo))
      this.salvando.set(false)
      this.aberto.set(false)
      this.toast.sucesso(textoDeSucesso({
        inicio: this.inicio()!, vendedor: this.lista().find((v) => v.usuarioId === this.usuarioId()), responsavelAlterado: r.responsavelAlterado,
      }))
    } catch (e) {
      this.salvando.set(false)
      const status = e instanceof HttpErrorResponse ? e.status : -1
      const codigo = codigoDoErro(e)
      this.erroGeral.set(mensagemDaFalha(status, codigo))
      if (recarregaHorarios(status, codigo)) await this.carregarHorarios()
    }
  }
}
