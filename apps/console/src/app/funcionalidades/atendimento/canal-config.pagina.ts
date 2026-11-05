import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ActivatedRoute } from '@angular/router'
import {
  AbasComponente, type Aba, CabecalhoTelaComponente, CampoComponente, EstadoComponente, EsqueletoComponente,
  GradeFormComponente, IconeComponente, ModalComponente, PainelComponente, SecaoFormComponente, SelectComponente, ToastServico,
  mensagemDeErro, HorarioAtendimentoComponente, somenteDiasAbertos, type Faixa, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { SlaConfigComponente } from './sla-config.componente.js'
import { RoteamentoComponente } from './roteamento.componente.js'

interface Canal { readonly id: string; readonly nomeAmigavel: string; readonly tipo: string; readonly estado: string; readonly riscoBanimento: boolean }
interface Config {
  readonly canal: string
  readonly horarioAtendimento: Record<string, Faixa | null>
  readonly mensagemAusencia: string | null
  readonly assinatura: string | null
  readonly disparoPausado: boolean
  readonly pausadoMotivo: string | null
  readonly pausadoEm: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Configurações → Atendimento: horário, mensagem de ausência, assinatura, SLA e a
 * pausa de disparo — por número — e o roteamento (aba própria).
 *
 * Padrão C (revisão de 2026-11-05): seletor de número no topo e seções em painel,
 * cada uma com o seu "Salvar". Antes era lista de canais à esquerda com o
 * formulário à direita, que espremia o formulário e repetia a tela de Números.
 * `?canal=<id>` abre já no número (vem da tela de Números). Pausa é modal de ação (A).
 */
@Component({
  selector: 'app-canal-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, DatePipe, EstadoComponente, EsqueletoComponente,
    GradeFormComponente, HorarioAtendimentoComponente, IconeComponente, ModalComponente, PainelComponente,
    SecaoFormComponente, SelectComponente, SlaConfigComponente, AbasComponente, RoteamentoComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Atendimento"
      subtitulo="Horário, ausência, assinatura, SLA e pausa de disparo — por número. Roteamento por filial e rodízio." />
    <ui-abas [abas]="abas" [(ativa)]="aba" idPainel="painel-canal-config" />

    <div class="painel-aba" role="tabpanel" id="painel-canal-config" [attr.aria-labelledby]="'painel-canal-config-aba-' + aba()">
    @if (aba() === 'roteamento') {
      <app-roteamento />
    } @else {
    @switch (estado()) {
      @case ('carregando') {
        <div class="col"><ui-esqueleto altura="44px" /><ui-esqueleto altura="320px" /></div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à configuração dos números"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os números" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (canais().length === 0) {
          <ui-estado titulo="Nenhum número conectado"
            descricao="Conecte um número em Configurações → Números para configurar o atendimento." />
        } @else {
          <div class="col">
            <div class="seletor">
              <ui-select rotulo="Número" [opcoes]="opcoesCanais()" [valor]="sel()?.id ?? ''"
                (valorChange)="escolher($event)" placeholder="Escolha o número" />
              @if (sel()?.riscoBanimento) {
                <span class="risco txt-denso"><ui-icone nome="alert-triangle" [tamanho]="14" /> Não-oficial: risco de banimento</span>
              }
            </div>

            @if (sel() === null) {
              <ui-estado titulo="Escolha um número" descricao="O horário, a ausência e o SLA são de cada número." />
            } @else if (cfg(); as cf) {
              @if (cf.disparoPausado) {
                <div class="pausa-aviso" role="status">
                  <ui-icone nome="alert-triangle" />
                  <div>
                    <strong>Disparo pausado</strong> — {{ cf.pausadoMotivo }}
                    @if (cf.pausadoEm) { <span class="desde">desde {{ cf.pausadoEm | date: 'dd/MM HH:mm' }}</span> }
                  </div>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="retomar()" [disabled]="salvandoPausa()">
                    {{ salvandoPausa() ? 'Retomando…' : 'Retomar disparo' }}
                  </button>
                </div>
              }

              <ui-painel>
                <form id="form-config-canal" (submit)="salvar($event)">
                  <ui-secao-form titulo="Mensagens">
                    <ui-grade-form>
                      <ui-campo class="largo" rotulo="Assinatura" placeholder="Ex.: Equipe Loja Centro"
                        autocomplete="off" [valor]="assinatura()" (valorChange)="assinatura.set($event)" />
                      <!-- ⚠️ A mensagem sai quando NÃO HÁ QUEM ATENDER este número: loja
                           fechada, ninguém logado ou todos marcados como ausentes. Por isso o
                           texto não pode prometer horário — "voltamos amanhã às 9h" vira mentira. -->
                      <ui-campo class="largo" tipo="textarea" rotulo="Mensagem de ausência"
                        placeholder="Ex.: Recebemos sua mensagem! No momento não há ninguém disponível — retornamos assim que possível."
                        dica="Enviada quando ninguém pode atender este número: fora do horário, sem ninguém logado ou com todos marcados como ausentes. Uma vez a cada 6 h por conversa."
                        [valor]="ausencia()" (valorChange)="ausencia.set($event)" />
                    </ui-grade-form>
                  </ui-secao-form>

                  <!-- A legenda do próprio fieldset já diz "Horário de atendimento": sem seção por cima. -->
                  <ui-horario-atendimento class="bloco-horario" [(horario)]="horario" />

                  <div class="rodape">
                    @if (erro()) { <span class="erro-texto" role="alert">{{ erro() }}</span> }
                    <button type="submit" class="btn btn--primario" [disabled]="salvando()">
                      {{ salvando() ? 'Salvando…' : 'Salvar atendimento' }}
                    </button>
                  </div>
                </form>
              </ui-painel>

              <!-- P18: SLA do handoff, salva à parte (admin, auditado) -->
              <app-sla-config [canalId]="sel()!.id" />

              @if (!cf.disparoPausado) {
                <ui-painel>
                  <h2 class="txt-secao">Pausar disparo</h2>
                  <p class="explica">Para campanhas e mensagens ativas deste número. As respostas em conversas abertas continuam.</p>
                  <div class="rodape">
                    <button type="button" class="btn btn--perigo" (click)="abrirPausa()" [disabled]="salvandoPausa()">Pausar disparo…</button>
                  </div>
                </ui-painel>
              }
            } @else if (erro()) {
              <ui-estado tipo="erro" titulo="Não foi possível carregar a configuração deste número" [descricao]="erro()!">
                <button type="button" class="btn btn--secundario" (click)="escolher(sel()!.id)">Tentar de novo</button>
              </ui-estado>
            } @else {
              <ui-esqueleto altura="320px" />
            }
          </div>
        }
      }
    }
    }
    </div>

    <!-- Pausa é ação com motivo obrigatório: modal de ação (A), não prompt() do navegador. -->
    <ui-modal [aberto]="pausaAberta()" titulo="Pausar disparo deste canal" largura="p" (fechar)="fecharPausa()">
      <p class="explica">
        Campanhas e mensagens ativas deste número param. Respostas em conversas abertas continuam saindo normalmente.
        Para voltar, use Retomar disparo.
      </p>
      <ui-campo rotulo="Motivo da pausa" placeholder="Ex.: número em revisão pela Meta"
        dica="Fica registrado e aparece na lista de canais." [obrigatorio]="true"
        [valor]="motivoPausa()" (valorChange)="motivoPausa.set($event)" [erro]="erroPausa()" />
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharPausa()" [disabled]="salvandoPausa()">Cancelar</button>
        <button type="button" class="btn btn--perigo" (click)="confirmarPausa()" [disabled]="salvandoPausa()">
          {{ salvandoPausa() ? 'Pausando…' : 'Pausar disparo' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .bloco-horario { display: block; margin-top: var(--espacamento-5); }
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    .painel-aba { margin-top: var(--espacamento-4); min-width: 0; }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
    /* Formulário de ajustes: largura de leitura, alinhado com as abas. */
    .col { min-width: 0; max-width: var(--largura-forma); display: grid; gap: var(--espacamento-4); align-content: start; }
    .seletor { display: flex; align-items: end; gap: var(--espacamento-3); flex-wrap: wrap; }
    .seletor ui-select { flex: 0 1 360px; min-width: 0; }
    .risco { display: inline-flex; align-items: center; gap: var(--espacamento-1); color: var(--atencao); padding-bottom: var(--espacamento-2); }
    .rodape { display: flex; justify-content: flex-end; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; margin-top: var(--espacamento-4); }
    ui-painel h2 { margin: 0 0 var(--espacamento-1); }
    .pausa-aviso { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap;
      padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .pausa-aviso > div { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .desde { color: var(--texto-suave); }
    .explica { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); line-height: 1.5; }
    .erro-texto { color: var(--erro); font-size: 13px; }
  `,
})
export class CanalConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  /** Aba ROTEAMENTO (G4): regras DDD/origem -> filial valem para varios numeros; `?aba=roteamento` abre nela. */
  readonly abas: readonly Aba[] = [{ id: 'numero', rotulo: 'Por número' }, { id: 'roteamento', rotulo: 'Roteamento' }]
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap
  readonly aba = signal(this.query.get('aba') === 'roteamento' ? 'roteamento' : 'numero')
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly Canal[]>([])
  readonly sel = signal<Canal | null>(null)
  /** Opções do seletor: o nome e o estado do número ("Loja Centro · conectado"). */
  readonly opcoesCanais = computed<OpcaoSelect[]>(() =>
    this.canais().map((c) => ({ valor: c.id, rotulo: `${c.nomeAmigavel} · ${c.estado}` })))
  readonly cfg = signal<Config | null>(null)
  readonly assinatura = signal(''); readonly ausencia = signal('')
  readonly horario = signal<Record<string, Faixa | null>>({})
  readonly salvando = signal(false); readonly salvandoPausa = signal(false)
  readonly erro = signal<string | null>(null)
  readonly pausaAberta = signal(false)
  readonly motivoPausa = signal('')
  readonly erroPausa = signal<string | null>(null)

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Canal[] }>('/v1/canais'))
      this.canais.set(r.itens)
      this.estado.set('pronto')
      // Número já escolhido, o de `?canal=`, ou o primeiro: nunca abre vazio quando há número.
      const alvo = r.itens.find((c) => c.id === (this.sel()?.id ?? this.query.get('canal'))) ?? r.itens[0] ?? null
      this.sel.set(alvo)
      if (alvo) await this.abrirConfig(alvo.id)
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  escolher(id: string): void {
    const c = this.canais().find((x) => x.id === id) ?? null
    this.sel.set(c); this.cfg.set(null); this.erro.set(null)
    if (c) void this.abrirConfig(c.id)
  }

  private async abrirConfig(id: string): Promise<void> {
    try {
      const cf = await firstValueFrom(this.http.get<Config>(`/v1/canais/${id}/config`))
      this.cfg.set(cf)
      this.assinatura.set(cf.assinatura ?? '')
      this.ausencia.set(cf.mensagemAusencia ?? '')
      this.horario.set({ ...cf.horarioAtendimento })
    } catch (e) {
      // Parcial: a lista de canais segue; a configuração deste não veio.
      this.cfg.set(null)
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar a configuração deste canal.'))
    }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const s = this.sel(); if (!s || this.salvando()) return
    this.salvando.set(true); this.erro.set(null)
    const horario = somenteDiasAbertos(this.horario())
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${s.id}/config`, {
        horarioAtendimento: horario, mensagemAusencia: this.ausencia(), assinatura: this.assinatura(),
      }))
      this.toast.sucesso('Atendimento salvo')
    } catch (e) { this.erro.set(mensagemDeErro(e, 'Não foi possível salvar a configuração.')) }
    finally { this.salvando.set(false) }
  }

  abrirPausa(): void {
    this.motivoPausa.set(''); this.erroPausa.set(null); this.pausaAberta.set(true)
  }
  fecharPausa(): void { if (!this.salvandoPausa()) this.pausaAberta.set(false) }

  async confirmarPausa(): Promise<void> {
    const s = this.sel(); if (!s || this.salvandoPausa()) return
    const motivo = this.motivoPausa().trim()
    if (!motivo) { this.erroPausa.set('Informe o motivo para pausar o disparo.'); return }
    this.salvandoPausa.set(true); this.erro.set(null); this.erroPausa.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${s.id}/config/pausar`, { motivo }))
      this.pausaAberta.set(false)
      this.toast.sucesso('Disparo pausado')
      await this.abrirConfig(s.id)
    } catch (e) { this.erroPausa.set(mensagemDeErro(e, 'Não foi possível pausar o disparo.')) }
    finally { this.salvandoPausa.set(false) }
  }

  async retomar(): Promise<void> {
    const s = this.sel(); if (!s) return
    this.salvandoPausa.set(true); this.erro.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${s.id}/config/retomar`, {}))
      this.toast.sucesso('Disparo retomado')
      await this.abrirConfig(s.id)
    } catch (e) { this.erro.set(mensagemDeErro(e, 'Não foi possível retomar o disparo.')) }
    finally { this.salvandoPausa.set(false) }
  }
}
