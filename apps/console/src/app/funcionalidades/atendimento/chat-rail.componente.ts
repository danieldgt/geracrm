import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core'
import { SlicePipe } from '@angular/common'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { EventosServico } from '../../nucleo/eventos.servico.js'
import { InboxPagina } from './inbox.pagina.js'

/**
 * Rail do CHAT — a funcionalidade principal, sempre à mão, ancorado À DIREITA.
 *
 * Montado uma vez pela casca (shell). Recolhido: faixa fina de avatares na borda
 * direita. Expandido: o inbox completo. O usuário controla, e o serviço persiste:
 *  · LARGURA — arrasta a borda esquerda do painel (puxador);
 *  · MODO — botão alterna EMPURRAR o conteúdo (padrão) × SOBREPOR (overlay).
 *
 * ⚠️ Dono do ciclo persistente (antes no InboxPagina): carrega a lista uma vez,
 * conecta o SSE (idempotente) e ESCUTA mensagens a sessão inteira — avisa de
 * mensagem nova em qualquer tela, sem re-registrar ouvinte por navegação.
 */
@Component({
  selector: 'app-chat-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InboxPagina, SlicePipe],
  template: `
    <div class="rail" [class.aberto]="servico.railAberto()"
         [class.sobrepor]="servico.railAberto() && servico.railSobrepor()"
         [style.--rail-w]="servico.railLargura() + 'px'">
      @if (servico.railAberto()) {
        <!-- Puxador de redimensionamento na BORDA ESQUERDA do painel. -->
        <div class="puxador" (pointerdown)="iniciarResize($event)"
             title="Arraste para redimensionar" role="separator" aria-label="Redimensionar chat"></div>
      }

      @if (!servico.railAberto()) {
        <!-- RECOLHIDO: faixa de avatares -->
        <button class="topo-btn" (click)="servico.abrirRail()" title="Abrir chat" aria-label="Abrir chat">
          <span class="ico">💬</span>
          @if (servico.naoLidasTotal() > 0) { <span class="badge">{{ servico.naoLidasTotal() }}</span> }
        </button>
        <div class="avs">
          @for (c of servico.conversas() | slice:0:16; track c.id) {
            <button class="av" [style.background]="corAvatar(c.id)"
                    (click)="servico.abrir(c.id)" [title]="c.nome" [class.nao-lida]="c.naoLida">
              {{ iniciais(c.nome) }}
              @if (c.naoLida) { <span class="pino" aria-hidden="true"></span> }
            </button>
          }
        </div>
        <span class="conex" [attr.data-estado]="eventos.estado()" [title]="'Conexão: ' + eventos.estado()"></span>
      } @else {
        <!-- EXPANDIDO: cabeçalho (modo + recolher) + inbox completo -->
        <div class="cab">
          <span class="cab-tit">Conversas</span>
          <span class="cab-acoes">
            <button class="modo" (click)="servico.alternarSobrepor()"
                    [attr.aria-pressed]="servico.railSobrepor()"
                    [title]="servico.railSobrepor()
                      ? 'Sobrepondo o conteúdo — clique para empurrar'
                      : 'Empurrando o conteúdo — clique para sobrepor'">
              {{ servico.railSobrepor() ? '⧉' : '⇥' }}
            </button>
            <button class="recolher" (click)="servico.fecharRail()" title="Recolher chat" aria-label="Recolher chat">›</button>
          </span>
        </div>
        <app-inbox class="corpo" />
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .rail { position: relative; height: 100%; display: flex; flex-direction: column; align-items: stretch;
            background: var(--superficie); border-left: 1px solid var(--borda);
            width: 66px; box-shadow: -4px 0 24px rgb(31 26 22 / .04); }
    .rail.aberto { width: var(--rail-w); }
    /* Overlay: painel flutua sobre o conteúdo (o host colapsa, o conteúdo ocupa tudo). */
    .rail.aberto.sobrepor { position: fixed; top: 0; right: 0; height: 100vh; z-index: 60;
                            box-shadow: -10px 0 34px rgb(31 26 22 / .16); }

    /* Puxador de redimensionamento. */
    .puxador { position: absolute; left: -3px; top: 0; bottom: 0; width: 8px; cursor: ew-resize;
               z-index: 3; touch-action: none; }
    .puxador::after { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px; background: transparent; }
    .puxador:hover::after, .puxador:active::after { background: var(--acao); }

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
           padding: 0 6px 0 14px; border-bottom: 1px solid var(--borda); background: var(--superficie); }
    .cab-tit { font-size: 13px; font-weight: 600; color: var(--texto-secundario); text-transform: uppercase; letter-spacing: .05em; }
    .cab-acoes { display: flex; align-items: center; gap: 2px; }
    .modo, .recolher { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer;
                       line-height: 1; padding: 5px 8px; border-radius: var(--raio-controle); }
    .modo { font-size: 15px; }
    .modo[aria-pressed="true"] { color: var(--marca); background: var(--acao-suave); }
    .recolher { font-size: 22px; }
    .modo:hover, .recolher:hover { background: var(--superficie-hover); color: var(--texto); }
    .corpo { flex: 1; min-height: 0; display: block; }

    /* Em tela estreita, expandido SEMPRE sobrepõe (não esmaga o conteúdo). */
    @media (max-width: 900px) {
      .rail.aberto { position: fixed; top: 0; right: 0; height: 100vh; z-index: 60;
                     width: min(var(--rail-w), 100vw); box-shadow: -10px 0 34px rgb(31 26 22 / .16); }
    }
  `],
})
export class ChatRailComponente implements OnInit, OnDestroy {
  readonly servico = inject(InboxServico)
  readonly eventos = inject(EventosServico)
  private cancelarEscuta?: () => void

  ngOnInit(): void {
    void this.servico.carregar()
    this.eventos.conectar()
    this.cancelarEscuta = this.eventos.escutar('*', (ev) => {
      if (!ev.tipo.startsWith('mensagem') && ev.tipo !== 'atendimento.mudou') return
      void this.servico.atualizar()
      if (ev.conversaId) void this.servico.atualizarThread(ev.conversaId)
    })
  }

  ngOnDestroy(): void {
    this.cancelarEscuta?.()
  }

  /** Arrasta a borda esquerda: largura = borda direita da viewport − ponteiro. */
  iniciarResize(ev: PointerEvent): void {
    ev.preventDefault()
    const alvo = ev.target as HTMLElement
    alvo.setPointerCapture(ev.pointerId)
    const mover = (e: PointerEvent) => this.servico.definirLargura(window.innerWidth - e.clientX)
    const soltar = (e: PointerEvent) => {
      try { alvo.releasePointerCapture(e.pointerId) } catch { /* já solto */ }
      alvo.removeEventListener('pointermove', mover)
      alvo.removeEventListener('pointerup', soltar)
    }
    alvo.addEventListener('pointermove', mover)
    alvo.addEventListener('pointerup', soltar)
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
