import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { NotificacoesServico, type Notificacao } from './notificacoes.servico.js'
import { EventosServico } from './eventos.servico.js'
import { InboxServico } from './inbox.servico.js'

/**
 * Sino de notificações (PLT-07). Fica no shell, sempre montado.
 *
 * ⚠️ Reage ao evento `notificacao.nova` do SSE — sem polling. A lista só carrega
 * quando o sino abre. Clicar numa notificação de conversa abre a conversa e
 * marca aquela como lida.
 */
@Component({
  selector: 'app-sino',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="sino-wrap">
      <button class="sino" (click)="alternar()" [attr.aria-label]="rotuloAria()" [class.tem]="servico.naoLidas() > 0">
        🔔
        @if (servico.naoLidas() > 0) {
          <span class="bolinha">{{ servico.naoLidas() > 9 ? '9+' : servico.naoLidas() }}</span>
        }
      </button>

      @if (aberto()) {
        <!-- Camada para fechar ao clicar fora. -->
        <div class="fora" (click)="fechar()"></div>
        <div class="painel" role="dialog" aria-label="Notificações">
          <header class="painel-topo">
            <strong>Notificações</strong>
            @if (servico.naoLidas() > 0) {
              <button class="limpar" (click)="servico.marcarTodasLidas()">Marcar todas como lidas</button>
            }
          </header>

          @if (servico.carregando()) {
            <p class="vazio">Carregando…</p>
          } @else if (servico.itens().length === 0) {
            <p class="vazio">Nada por aqui. Quando chegar mensagem num atendimento seu, aparece.</p>
          } @else {
            <ul class="lista">
              @for (n of servico.itens(); track n.id) {
                <li class="item" [class.nao-lida]="!n.lida" (click)="abrir(n)">
                  <span class="ponto" [class.on]="!n.lida"></span>
                  <span class="corpo">
                    <span class="titulo">{{ rotulo(n) }}</span>
                    <span class="quando">{{ n.criadoEm | date: 'dd/MM HH:mm' }}</span>
                  </span>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .sino-wrap { position: relative; }
    .sino { position: relative; border: none; background: transparent; font-size: 16px; cursor: pointer; padding: 4px 6px; line-height: 1; }
    .sino:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .bolinha { position: absolute; top: -2px; right: -2px; min-width: 15px; height: 15px; padding: 0 3px;
      background: var(--erro); color: var(--texto-invertido); font-size: 9px; font-weight: 700; border-radius: var(--raio-completo);
      display: flex; align-items: center; justify-content: center; }
    .fora { position: fixed; inset: 0; z-index: 40; }
    .painel { position: absolute; top: 30px; right: 0; width: 300px; z-index: 41;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      box-shadow: var(--elevacao-modal); overflow: hidden; }
    .painel-topo { display: flex; align-items: center; justify-content: space-between;
      padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .painel-topo strong { font-size: 13px; color: var(--texto); }
    .limpar { border: none; background: transparent; color: var(--acao); font-size: 12px; cursor: pointer; padding: 0; }
    .vazio { margin: 0; padding: var(--espacamento-6) var(--espacamento-4); color: var(--texto-suave); font-size: 13px; text-align: center; }
    .lista { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; }
    .item { display: flex; align-items: flex-start; gap: var(--espacamento-2);
      padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .item:last-child { border-bottom: none; }
    .item:hover { background: var(--superficie-hover); }
    .item.nao-lida { background: var(--superficie-selecionada); }
    .ponto { width: 7px; height: 7px; margin-top: 5px; border-radius: var(--raio-completo); background: transparent; flex: none; }
    .ponto.on { background: var(--acao); }
    .corpo { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .titulo { font-size: 13px; color: var(--texto); }
    .quando { font-size: 11px; color: var(--texto-suave); font-family: var(--tipografia-familia-dados); }
  `,
})
export class SinoNotificacoesComponente implements OnInit, OnDestroy {
  readonly servico = inject(NotificacoesServico)
  private readonly eventos = inject(EventosServico)
  private readonly inbox = inject(InboxServico)
  readonly aberto = signal(false)
  private cancelar?: () => void

  ngOnInit(): void {
    void this.servico.carregarContador()
    // ⚠️ Reage ao canal do usuário: a cada aviso, refaz o contador (e a lista se aberta).
    this.cancelar = this.eventos.escutar('notificacao.nova', () => {
      void this.servico.carregarContador()
      if (this.aberto()) void this.servico.carregarLista()
    })
  }

  ngOnDestroy(): void {
    this.cancelar?.()
  }

  alternar(): void {
    const novo = !this.aberto()
    this.aberto.set(novo)
    if (novo) void this.servico.carregarLista()
  }

  fechar(): void { this.aberto.set(false) }

  rotulo(n: Notificacao): string {
    return n.tipo === 'mensagem.nova' ? `Nova mensagem de ${n.titulo}` : n.titulo
  }

  rotuloAria(): string {
    const n = this.servico.naoLidas()
    return n > 0 ? `Notificações: ${n} não lidas` : 'Notificações'
  }

  abrir(n: Notificacao): void {
    if (!n.lida) void this.servico.marcarLida(n.id)
    this.fechar()
    // Abre a conversa no rail lateral (não navega — o chat vive na casca).
    if (n.conversaId) void this.inbox.abrir(n.conversaId)
  }
}
