import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Canal { readonly id: string; readonly nomeAmigavel: string; readonly tipo: string; readonly estado: string; readonly riscoBanimento: boolean }
import { HorarioAtendimentoComponente, somenteDiasAbertos, type Faixa } from '../../compartilhado/ui/index.js'
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
 * pausa de disparo, por canal. Master-detail (canais | config).
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-canal-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, HorarioAtendimentoComponente],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Configuração do Canal</h1>
      <p class="sub">Horário, ausência, assinatura e a pausa de disparo — por número.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="col"><div class="esq"></div><div class="esq"></div></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (canais().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhum canal conectado</h2><p>Conecte um número em Meus Números primeiro.</p></div>
        } @else {
          <div class="grade">
            <section class="col">
              <ul class="canais">
                @for (c of canais(); track c.id) {
                  <li class="cn" [class.on]="sel()?.id === c.id" (click)="abrir(c)">
                    <span class="cn-nome encolhe">{{ c.nomeAmigavel }}</span>
                    @if (c.riscoBanimento) { <span class="risco" title="Canal não-oficial: risco de banimento">⚠</span> }
                    <span class="cn-estado" [attr.data-e]="c.estado">{{ c.estado }}</span>
                  </li>
                }
              </ul>
            </section>

            <section class="col detalhe">
              @if (sel() === null) {
                <div class="bloco"><h2 class="txt-secao">Escolha um canal</h2><p>Selecione à esquerda para configurar.</p></div>
              } @else if (cfg(); as cf) {
                @if (cf.disparoPausado) {
                  <div class="pausa-aviso">
                    <div><strong>Disparo pausado</strong> — {{ cf.pausadoMotivo }}
                      @if (cf.pausadoEm) { <span class="desde">desde {{ cf.pausadoEm | date: 'dd/MM HH:mm' }}</span> }
                    </div>
                    <button class="btn btn--primario btn--pequeno" (click)="retomar()" [disabled]="salvandoPausa()">Retomar disparo</button>
                  </div>
                }

                <form class="form" (submit)="salvar($event)">
                  <label class="campo">Assinatura
                    <input [value]="assinatura()" (input)="assinatura.set($any($event.target).value)" placeholder="Ex.: Equipe Loja Centro" />
                  </label>

                  <!-- ⚠️ A mensagem sai quando NÃO HÁ QUEM ATENDER este número: loja
                       fechada, ninguém logado ou todos marcados como ausentes. Ela
                       deixou de ser só "fora do expediente" em 2026-09-01, e por isso
                       o texto não pode prometer horário — em horário comercial com a
                       equipe offline, "voltamos amanhã às 9h" vira mentira. -->
                  <label class="campo">Mensagem de ausência
                    <textarea rows="2" [value]="ausencia()" (input)="ausencia.set($any($event.target).value)" placeholder="Ex.: Recebemos sua mensagem! No momento não há ninguém disponível — retornamos assim que possível."></textarea>
                    <span class="dica">Enviada quando ninguém pode atender este número: fora do horário, sem ninguém logado ou com todos marcados como ausentes. Uma vez a cada 6 h por conversa.</span>
                  </label>

<ui-horario-atendimento [(horario)]="horario" />

                  <div class="acoes">
                    <button class="btn btn--primario" type="submit" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar configuração' }}</button>
                    @if (!cf.disparoPausado) { <button class="btn btn--secundario" type="button" (click)="pausar()" [disabled]="salvandoPausa()">Pausar disparo…</button> }
                    @if (msg()) { <span class="ok">{{ msg() }}</span> }
                  </div>
                </form>
              }
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .grade { display: grid; grid-template-columns: 260px 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: 1fr; } }
    .col { min-width: 0; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 48px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .canais { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .cn { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .cn:last-child { border-bottom: none; }
    .cn:hover { background: var(--superficie); }
    .cn.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    .cn-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .risco { color: var(--atencao); flex: none; }
    .cn-estado { font-size: 11px; color: var(--texto-suave); flex: none; }
    .cn-estado[data-e="conectado"] { color: var(--sucesso); }
    .cn-estado[data-e="suspenso"], .cn-estado[data-e="desconectado"] { color: var(--erro); }
    .pausa-aviso { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--atencao-suave); color: var(--texto); margin-bottom: var(--espacamento-4); font-size: 13px; }
    .desde { color: var(--texto-suave); margin-left: var(--espacamento-1); }
    .form { display: grid; gap: var(--espacamento-4); }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); font-size: 13px; }
    .dica { color: var(--texto-suave); font-size: 12px; }
    .campo input, .campo textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; resize: vertical; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .pausar:hover { color: var(--erro); border-color: var(--erro); }
    .ok { color: var(--sucesso); font-size: 13px; }
  `,
})
export class CanalConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly Canal[]>([])
  readonly sel = signal<Canal | null>(null)
  readonly cfg = signal<Config | null>(null)
  readonly assinatura = signal(''); readonly ausencia = signal('')
  readonly horario = signal<Record<string, Faixa | null>>({})
  readonly salvando = signal(false); readonly salvandoPausa = signal(false); readonly msg = signal<string | null>(null)

  ngOnInit(): void { void this.carregar() }

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

  abrir(c: Canal): void { this.sel.set(c); this.msg.set(null); void this.abrirConfig(c.id) }

  private async abrirConfig(id: string): Promise<void> {
    try {
      const cf = await firstValueFrom(this.http.get<Config>(`/v1/canais/${id}/config`))
      this.cfg.set(cf)
      this.assinatura.set(cf.assinatura ?? '')
      this.ausencia.set(cf.mensagemAusencia ?? '')
      this.horario.set({ ...cf.horarioAtendimento })
    } catch { /* mantém */ }
  }


  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const s = this.sel(); if (!s || this.salvando()) return
    this.salvando.set(true); this.msg.set(null)
    const horario = somenteDiasAbertos(this.horario())
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${s.id}/config`, {
        horarioAtendimento: horario, mensagemAusencia: this.ausencia(), assinatura: this.assinatura(),
      }))
      this.msg.set('Configuração salva.')
    } catch { this.msg.set('Não foi possível salvar.') } finally { this.salvando.set(false) }
  }

  async pausar(): Promise<void> {
    const s = this.sel(); if (!s) return
    const motivo = prompt('Por que pausar o disparo deste canal?')?.trim()
    if (!motivo) return
    this.salvandoPausa.set(true)
    try { await firstValueFrom(this.http.post(`/v1/canais/${s.id}/config/pausar`, { motivo })); await this.abrirConfig(s.id) }
    catch { /* ignore */ } finally { this.salvandoPausa.set(false) }
  }

  async retomar(): Promise<void> {
    const s = this.sel(); if (!s) return
    this.salvandoPausa.set(true)
    try { await firstValueFrom(this.http.post(`/v1/canais/${s.id}/config/retomar`, {})); await this.abrirConfig(s.id) }
    catch { /* ignore */ } finally { this.salvandoPausa.set(false) }
  }
}
