import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, EstadoComponente, EsqueletoComponente, FormPaginaComponente,
  GradeFormComponente, IconeComponente, ModalComponente, SecaoFormComponente, ToastServico, mensagemDeErro,
  HorarioAtendimentoComponente, somenteDiasAbertos, type Faixa,
} from '../../compartilhado/ui/index.js'
import { SlaConfigComponente } from './sla-config.componente.js'

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
 * Config do Canal — horário de atendimento, mensagem de ausência, assinatura e a
 * pausa de disparo, por canal. Master-detail (canais | config) no padrão de
 * formulário-página (F) e de ação em modal (A) para a pausa.
 */
@Component({
  selector: 'app-canal-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, DatePipe, EstadoComponente, EsqueletoComponente,
    FormPaginaComponente, GradeFormComponente, HorarioAtendimentoComponente, IconeComponente, ModalComponente,
    SecaoFormComponente, SlaConfigComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Configuração do canal"
      subtitulo="Horário, ausência, assinatura e a pausa de disparo — por número." />

    @switch (estado()) {
      @case ('carregando') {
        <div class="grade">
          <div class="col"><ui-esqueleto altura="48px" /><ui-esqueleto altura="48px" /></div>
          <div class="col"><ui-esqueleto altura="320px" /></div>
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à configuração dos canais"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar os canais" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (canais().length === 0) {
          <ui-estado titulo="Nenhum canal conectado"
            descricao="Conecte um número em Números de WhatsApp para configurar o atendimento." />
        } @else {
          <div class="grade">
            <section class="col" aria-label="Canais">
              <ul class="canais">
                @for (c of canais(); track c.id) {
                  <li>
                    <button type="button" class="cn" [class.on]="sel()?.id === c.id"
                      [attr.aria-current]="sel()?.id === c.id ? 'true' : null" (click)="abrir(c)">
                      <span class="cn-nome" [title]="c.nomeAmigavel">{{ c.nomeAmigavel }}</span>
                      @if (c.riscoBanimento) {
                        <span class="risco"><ui-icone nome="alert-triangle" [tamanho]="14" rotulo="Canal não-oficial: risco de banimento" /></span>
                      }
                      <ui-badge [tom]="tomEstado(c.estado)">{{ c.estado }}</ui-badge>
                    </button>
                  </li>
                }
              </ul>
            </section>

            <section class="col" aria-label="Configuração do canal selecionado">
              @if (sel() === null) {
                <ui-estado titulo="Escolha um canal" descricao="Selecione um número à esquerda para configurar." />
              } @else if (cfg(); as cf) {
                @if (cf.disparoPausado) {
                  <div class="pausa-aviso" role="status">
                    <ui-icone nome="alert-triangle" />
                    <div>
                      <strong>Disparo pausado</strong> — {{ cf.pausadoMotivo }}
                      @if (cf.pausadoEm) { <span class="desde">desde {{ cf.pausadoEm | date: 'dd/MM HH:mm' }}</span> }
                    </div>
                    <button type="button" class="btn btn--primario btn--pequeno" (click)="retomar()" [disabled]="salvandoPausa()">
                      {{ salvandoPausa() ? 'Retomando…' : 'Retomar disparo' }}
                    </button>
                  </div>
                }

                <ui-form-pagina titulo="Atendimento" [subtitulo]="sel()!.nomeAmigavel">
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

                    <ui-secao-form titulo="Horário de atendimento">
                      <ui-horario-atendimento [(horario)]="horario" />
                    </ui-secao-form>
                  </form>

                  <div rodape>
                    @if (msg()) { <span class="ok" role="status">{{ msg() }}</span> }
                    @if (erro()) { <span class="erro-texto" role="alert">{{ erro() }}</span> }
                    @if (!cf.disparoPausado) {
                      <button type="button" class="btn btn--secundario" (click)="abrirPausa()" [disabled]="salvandoPausa()">Pausar disparo…</button>
                    }
                    <button type="submit" form="form-config-canal" class="btn btn--primario" [disabled]="salvando()">
                      {{ salvando() ? 'Salvando…' : 'Salvar configuração' }}
                    </button>
                  </div>
                </ui-form-pagina>
                <!-- P18: SLA do handoff, salva à parte (admin, auditado) -->
                <app-sla-config [canalId]="sel()!.id" />
              }
            </section>
          </div>
        }
      }
    }

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
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    .grade { margin-top: var(--espacamento-4); display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
    .col { min-width: 0; display: grid; gap: var(--espacamento-4); align-content: start; }
    .canais { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .canais li + li { border-top: 1px solid var(--borda); }
    .cn { display: flex; width: 100%; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3) var(--espacamento-4);
      border: 0; background: transparent; color: var(--texto); font: inherit; text-align: left; cursor: pointer; }
    .cn:hover { background: var(--superficie); }
    .cn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .cn.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    /* Nome longo (sem espaço) trunca em vez de passar por cima do badge. */
    .cn-nome { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .risco { display: inline-flex; color: var(--atencao); flex: none; }
    .pausa-aviso { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap;
      padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .pausa-aviso > div { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .desde { color: var(--texto-suave); }
    .explica { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); line-height: 1.5; }
    .ok { color: var(--sucesso); font-size: 13px; }
    .erro-texto { color: var(--erro); font-size: 13px; }
  `,
})
export class CanalConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly Canal[]>([])
  readonly sel = signal<Canal | null>(null)
  readonly cfg = signal<Config | null>(null)
  readonly assinatura = signal(''); readonly ausencia = signal('')
  readonly horario = signal<Record<string, Faixa | null>>({})
  readonly salvando = signal(false); readonly salvandoPausa = signal(false)
  readonly msg = signal<string | null>(null)
  readonly erro = signal<string | null>(null)
  readonly pausaAberta = signal(false)
  readonly motivoPausa = signal('')
  readonly erroPausa = signal<string | null>(null)

  ngOnInit(): void { void this.carregar() }

  tomEstado(estado: string): 'sucesso' | 'erro' | 'neutro' {
    return estado === 'conectado' ? 'sucesso' : (estado === 'suspenso' || estado === 'desconectado') ? 'erro' : 'neutro'
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Canal[] }>('/v1/canais'))
      this.canais.set(r.itens)
      this.estado.set('pronto')
      const s = this.sel()
      if (s && r.itens.some((c) => c.id === s.id)) await this.abrirConfig(s.id)
      else this.sel.set(null)
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrir(c: Canal): void { this.sel.set(c); this.msg.set(null); this.erro.set(null); void this.abrirConfig(c.id) }

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
    this.salvando.set(true); this.msg.set(null); this.erro.set(null)
    const horario = somenteDiasAbertos(this.horario())
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${s.id}/config`, {
        horarioAtendimento: horario, mensagemAusencia: this.ausencia(), assinatura: this.assinatura(),
      }))
      this.msg.set('Configuração salva.')
      this.toast.sucesso('Configuração salva')
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
    this.salvandoPausa.set(true); this.msg.set(null); this.erro.set(null); this.erroPausa.set(null)
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
    this.salvandoPausa.set(true); this.msg.set(null); this.erro.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${s.id}/config/retomar`, {}))
      this.toast.sucesso('Disparo retomado')
      await this.abrirConfig(s.id)
    } catch (e) { this.erro.set(mensagemDeErro(e, 'Não foi possível retomar o disparo.')) }
    finally { this.salvandoPausa.set(false) }
  }
}
