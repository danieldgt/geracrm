import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core'
import { SlicePipe } from '@angular/common'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { EventosServico } from '../../nucleo/eventos.servico.js'
import { InboxPagina } from './inbox.pagina.js'

/**
 * Rail lateral do CHAT — a funcionalidade principal, sempre à mão.
 *
 * Montado uma vez pela casca (shell), ao lado do menu. Recolhido: faixa fina com
 * os avatares das conversas + não-lidas + estado da conexão. Expandido: o inbox
 * completo (lista + diálogo) empurrando o conteúdo; recolhe quando terminar.
 *
 * ⚠️ Dono do ciclo persistente que antes vivia no InboxPagina: carrega a lista uma
 * vez, conecta o SSE (idempotente — a casca também conecta) e ESCUTA mensagens a
 * sessão inteira. Assim o rail avisa de mensagem nova em qualquer tela, sem
 * re-registrar ouvinte a cada navegação.
 */
@Component({
  selector: 'app-chat-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InboxPagina, SlicePipe],
  template: `
    <div class="rail" [class.aberto]="servico.railAberto()">
      @if (!servico.railAberto()) {
        <!-- RECOLHIDO: faixa de avatares -->
        <button class="topo-btn" (click)="servico.abrirRail()" title="Abrir chat" aria-label="Abrir chat">
          <span class="ico">💬</span>
          @if (servico.naoLidasTotal() > 0) { <span class="badge">{{ servico.naoLidasTotal() }}</span> }
        </button>
        <div class="avs">
          @for (c of servico.conversas() | slice:0:16; track c.id) {
            <button class="av" [style.background]="corAvatar(c.id)"
                    (click)="servico.abrir(c.id)" [title]="c.nome"
                    [class.nao-lida]="c.naoLida">
              {{ iniciais(c.nome) }}
              @if (c.naoLida) { <span class="pino" aria-hidden="true"></span> }
            </button>
          }
        </div>
        <span class="conex" [attr.data-estado]="eventos.estado()" [title]="'Conexão: ' + eventos.estado()"></span>
      } @else {
        <!-- EXPANDIDO: barra de recolher + inbox completo -->
        <div class="cab">
          <span class="cab-tit">Conversas</span>
          <button class="recolher" (click)="servico.fecharRail()" title="Recolher chat" aria-label="Recolher chat">‹</button>
        </div>
        <app-inbox class="corpo" />
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .rail { height: 100%; display: flex; flex-direction: column; align-items: stretch;
            background: var(--superficie); border-right: 1px solid var(--borda);
            width: 66px; box-shadow: 4px 0 24px rgb(31 26 22 / .04); }
    .rail.aberto { width: min(760px, 62vw); }

    /* Recolhido */
    .topo-btn { position: relative; height: 52px; border: 0; border-bottom: 1px solid var(--borda);
                background: transparent; cursor: pointer; font-size: 20px; color: var(--texto-secundario); }
    .topo-btn:hover { background: var(--superficie-hover); }
    .badge { position: absolute; top: 6px; right: 10px; min-width: 16px; height: 16px; padding: 0 4px;
             border-radius: 999px; background: var(--acao); color: var(--acao-texto);
             font-size: 10px; font-weight: 700; line-height: 16px; }
    .avs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center;
           gap: 8px; padding: 10px 0; }
    .av { position: relative; width: 42px; height: 42px; border-radius: 50%; border: 0; cursor: pointer;
          color: #fff; font-size: 14px; font-weight: 600; display: grid; place-items: center; flex: none; }
    .av.nao-lida { box-shadow: 0 0 0 2px var(--acao); }
    .pino { position: absolute; top: -1px; right: -1px; width: 11px; height: 11px; border-radius: 50%;
            background: var(--acao); box-shadow: 0 0 0 2px var(--superficie); }
    .conex { align-self: center; width: 8px; height: 8px; border-radius: 50%; margin: 8px 0;
             background: var(--texto-suave); }
    .conex[data-estado="conectado"] { background: #25d366; }
    .conex[data-estado="reconectando"], .conex[data-estado="conectando"] { background: var(--atencao); }
    .conex[data-estado="offline"] { background: var(--erro); }

    /* Expandido */
    .cab { height: 40px; display: flex; align-items: center; justify-content: space-between;
           padding: 0 8px 0 14px; border-bottom: 1px solid var(--borda); background: var(--superficie); }
    .cab-tit { font-size: 13px; font-weight: 600; color: var(--texto-secundario); text-transform: uppercase; letter-spacing: .05em; }
    .recolher { border: 0; background: transparent; color: var(--texto-secundario); font-size: 22px; cursor: pointer; line-height: 1; padding: 4px 8px; border-radius: var(--raio-controle); }
    .recolher:hover { background: var(--superficie-hover); color: var(--texto); }
    .corpo { flex: 1; min-height: 0; display: block; }

    /* Em telas estreitas, expandido vira overlay (não espreme o conteúdo). */
    @media (max-width: 900px) {
      .rail.aberto { position: fixed; inset: 0 0 0 0; width: 100vw; z-index: 60; box-shadow: none; }
    }
  `],
})
export class ChatRailComponente implements OnInit, OnDestroy {
  readonly servico = inject(InboxServico)
  readonly eventos = inject(EventosServico)
  private cancelarEscuta?: () => void

  ngOnInit(): void {
    void this.servico.carregar()
    // Idempotente: a casca também conecta; garante o stream se o rail montar antes.
    this.eventos.conectar()
    // Ouvinte que vive a sessão inteira: mensagem/atendimento → atualiza lista e thread.
    this.cancelarEscuta = this.eventos.escutar('*', (ev) => {
      if (!ev.tipo.startsWith('mensagem') && ev.tipo !== 'atendimento.mudou') return
      void this.servico.atualizar()
      if (ev.conversaId) void this.servico.atualizarThread(ev.conversaId)
    })
  }

  ngOnDestroy(): void {
    // Cancela o ouvinte; NÃO desconecta o SSE (a casca é dona da conexão global).
    this.cancelarEscuta?.()
  }

  // Avatar: iniciais + cor estável por id (mesmo esquema do inbox).
  private readonly CORES = ['#6a4bb6', '#00786b', '#2a6fc9', '#b0417a', '#4e37a8', '#00747f', '#3a8f45', '#c0552b', '#5d6d7e', '#9c5b23']
  corAvatar(id: string): string {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    return this.CORES[h % this.CORES.length]!
  }
  iniciais(nome: string): string {
    const p = (nome || '?').trim().split(/\s+/)
    const a = p[0]?.[0] ?? ''
    const b = p.length > 1 ? (p[p.length - 1]?.[0] ?? '') : ''
    return (a + b).toUpperCase() || '?'
  }
}
