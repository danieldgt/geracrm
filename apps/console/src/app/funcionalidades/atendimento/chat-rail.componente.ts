import {
  Component, ChangeDetectionStrategy, ElementRef, inject, input, OnInit, OnDestroy, computed, effect, untracked, viewChild,
} from '@angular/core'
import { SlicePipe } from '@angular/common'
import { IconeComponente } from '../../compartilhado/ui/icone.componente.js'
import { devolverFoco, prenderTab } from '../../compartilhado/ui/foco.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { EventosServico } from '../../nucleo/eventos.servico.js'
import { InboxPagina } from './inbox.pagina.js'
import { rotuloBotaoConversas, rotuloContador, type ModoTrilho } from '../../nucleo/casca.regras.js'

/** Como a casca pediu o trilho: as duas formas do desktop (`modoTrilho`) ou a tela cheia do celular. */
export type ModoTrilhoCasca = ModoTrilho | 'tela-cheia'

/**
 * Rail do CHAT — a funcionalidade principal, sempre à mão, ancorado À DIREITA.
 *
 * Montado uma vez pela casca (shell). Recolhido: faixa fina de avatares na borda
 * direita. Expandido: o inbox completo. A pessoa ajusta a LARGURA arrastando a
 * borda esquerda (puxador); o serviço persiste.
 *
 * ⚠️ Empurrar × gaveta NÃO é escolha da pessoa (o antigo botão ⧉/⇥ saiu): a casca
 * decide pela largura (`modoTrilho`). Empurra quando a tela ao lado continua com
 * >= 960 px; senão abre como GAVETA abaixo da barra do topo, com véu, Esc que
 * fecha e devolve o foco, e foco preso — nunca esmaga a tela nem cobre o topo.
 *
 * ⚠️ Um título só: o trilho não tem cabeçalho próprio. "Conversas" e o botão que
 * recolhe moram no cabeçalho da lista do inbox (`fecharNoCabecalhoDaLista`).
 *
 * ⚠️ Dono do ciclo persistente (antes no InboxPagina): carrega a lista uma vez,
 * conecta o SSE (idempotente) e ESCUTA mensagens a sessão inteira — avisa de
 * mensagem nova em qualquer tela, sem re-registrar ouvinte por navegação.
 */
@Component({
  selector: 'app-chat-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InboxPagina, SlicePipe, IconeComponente],
  template: `
    @if (gaveta()) {
      <!-- Véu da gaveta: clique fecha (a pessoa desistiu), como no modal. -->
      <div class="veu-trilho" aria-hidden="true" (click)="fecharComFoco()"></div>
    }
    <div #painel class="rail" [class.aberto]="servico.railAberto()" [class.gaveta]="gaveta()"
         [style.--rail-w]="largura() + 'px'" tabindex="-1"
         [attr.role]="modal() ? 'dialog' : null" [attr.aria-modal]="modal() ? 'true' : null"
         [attr.aria-label]="modal() ? 'Conversas' : null"
         (keydown)="aoTeclar($event)">
      @if (servico.railAberto() && modo() !== 'tela-cheia') {
        <!-- Puxador de redimensionamento na BORDA ESQUERDA do painel. -->
        <div class="puxador" (pointerdown)="iniciarResize($event)"
             title="Arraste para redimensionar" role="separator" aria-label="Redimensionar chat"></div>
      }

      @if (!servico.railAberto()) {
        <!-- RECOLHIDO: faixa de avatares -->
        <!-- No celular (< 720px) este botão é o trilho inteiro: flutua no canto,
             com o contador de não lidas; a faixa de avatares some. -->
        <button class="topo-btn" (click)="servico.abrirRail()" title="Abrir chat" [attr.aria-label]="rotuloBotao()">
          <span class="ico" aria-hidden="true"><ui-icone nome="message-circle" /></span>
          @if (contador()) { <span class="badge" aria-hidden="true">{{ contador() }}</span> }
        </button>
        <div class="avs">
          @for (c of servico.conversas() | slice:0:16; track c.id) {
            <button class="av" (click)="servico.abrir(c.id)" [title]="c.nome" [attr.aria-label]="'Abrir conversa com ' + c.nome"
                    [class.nao-lida]="c.naoLida">
              {{ iniciais(c.nome) }}
              @if (c.naoLida) { <span class="pino" aria-hidden="true"></span> }
            </button>
          }
        </div>
        <span class="conex" [attr.data-estado]="eventos.estado()" [title]="'Conexão: ' + eventos.estado()"></span>
      } @else {
        <!-- EXPANDIDO: o inbox completo. Sem cabeçalho próprio (seria um
             segundo "Conversas"): fechar mora no cabeçalho da lista. -->
        <app-inbox class="corpo" [noTrilho]="true" />
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .rail { position: relative; height: 100%; display: flex; flex-direction: column; align-items: stretch;
            background: var(--superficie); border-left: 1px solid var(--borda); width: 66px; }
    .rail:focus { outline: none; }
    .rail.aberto { width: var(--rail-w); }
    /* GAVETA (desktop sem espaço para empurrar): flutua sobre o conteúdo, ABAIXO
       da barra do topo — sino, conta e tempo real continuam à vista. */
    .rail.aberto.gaveta { position: fixed; top: var(--altura-barra-topo); right: 0; bottom: 0; height: auto; z-index: 60;
                          box-shadow: var(--elevacao-modal); }
    .veu-trilho { position: fixed; top: var(--altura-barra-topo); right: 0; bottom: 0; left: 0; z-index: 59;
                  background: var(--fundo-sobreposicao, rgb(0 0 0 / .4)); }

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
             border-radius: var(--raio-completo); background: var(--acao); color: var(--acao-texto);
             font-size: 10px; font-weight: 700; line-height: 16px; }
    .avs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center;
           gap: 8px; padding: 10px 0; }
    /* Avatar neutro: palco neutro, a cor fica para o estado (não lida = anel de ação). */
    .av { position: relative; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--borda); cursor: pointer;
          background: var(--superficie-selecionada); color: var(--texto); font-size: 14px; font-weight: 600;
          display: grid; place-items: center; flex: none; }
    .av:hover { background: var(--superficie-hover); }
    .av:focus-visible, .topo-btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .av.nao-lida { box-shadow: 0 0 0 2px var(--acao); }
    .pino { position: absolute; top: -1px; right: -1px; width: 11px; height: 11px; border-radius: 50%;
            background: var(--acao); box-shadow: 0 0 0 2px var(--superficie); }
    .conex { align-self: center; width: 8px; height: 8px; border-radius: 50%; margin: 8px 0;
             background: var(--texto-suave); }
    .conex[data-estado="conectado"] { background: var(--sucesso); }
    .conex[data-estado="reconectando"], .conex[data-estado="conectando"] { background: var(--atencao); }
    .conex[data-estado="offline"] { background: var(--erro); }

    /* Expandido */
    .corpo { flex: 1; min-height: 0; display: block; }

    /* Celular (< 720px; corte em casca.regras.ts): recolhido = botão flutuante
       redondo no canto com o contador; aberto = tela inteira. Sem puxador (não
       há o que empurrar). */
    @media (max-width: 719.98px) {
      .rail:not(.aberto) { position: fixed; right: var(--espacamento-4); bottom: var(--espacamento-4); z-index: 60;
                           width: 56px; height: 56px; border: 1px solid var(--borda); border-radius: var(--raio-completo);
                           background: var(--superficie-elevada); box-shadow: var(--elevacao-modal); }
      .rail:not(.aberto) .avs, .rail:not(.aberto) .conex { display: none; }
      .topo-btn { height: 100%; border-bottom: 0; border-radius: var(--raio-completo); }
      .badge { top: -4px; right: -4px; min-width: 20px; height: 20px; line-height: 20px; font-size: 11px; }
      .rail.aberto, .rail.aberto.gaveta { position: fixed; inset: 0; width: 100vw; height: 100dvh; z-index: 60;
                                          border-left: 0; }
      .veu-trilho, .puxador { display: none; }
    }
  `],
})
export class ChatRailComponente implements OnInit, OnDestroy {
  readonly servico = inject(InboxServico)
  readonly eventos = inject(EventosServico)
  /** Decidido pela casca (`modoTrilho` no desktop; 'tela-cheia' no celular). */
  readonly modo = input<ModoTrilhoCasca>('empurrar')
  /** Largura do trilho aberto, já limitada pela janela (`limitarLarguraTrilho`). */
  readonly largura = input<number>(420)

  readonly contador = computed(() => rotuloContador(this.servico.naoLidasTotal()))
  readonly rotuloBotao = computed(() => rotuloBotaoConversas(this.servico.naoLidasTotal()))
  /** Aberto por cima do conteúdo no desktop (véu, Esc, foco preso). */
  readonly gaveta = computed(() => this.servico.railAberto() && this.modo() === 'gaveta')
  /** Aberto como diálogo: gaveta no desktop ou tela cheia no celular (o resto fica inert na casca). */
  readonly modal = computed(() => this.servico.railAberto() && this.modo() !== 'empurrar')

  private readonly painel = viewChild.required<ElementRef<HTMLElement>>('painel')
  /** Quem tinha o foco quando o trilho abriu como diálogo — recebe o foco de volta ao fechar. */
  #origem: Element | null = null
  private cancelarEscuta?: () => void

  constructor() {
    // Abriu como diálogo → o foco entra no painel; fechou → volta a quem abriu.
    effect(() => {
      const modal = this.modal()
      untracked(() => {
        if (modal) {
          this.#origem = document.activeElement
          requestAnimationFrame(() => {
            const p = this.painel().nativeElement
            if (!p.contains(document.activeElement)) p.focus()
          })
        } else if (this.#origem) {
          const o = this.#origem
          this.#origem = null
          devolverFoco(o)
        }
      })
    })
  }

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

  fecharComFoco(): void { this.servico.fecharRail() }

  /**
   * Como diálogo: Esc fecha (o effect devolve o foco) e o Tab fica preso no painel.
   * ⚠️ Esc dentro de um modal ou menu do próprio inbox é DELE (fecha só aquilo).
   */
  aoTeclar(ev: KeyboardEvent): void {
    if (!this.modal()) return
    const alvo = ev.target as Element | null
    if (ev.key === 'Escape') {
      if (ev.defaultPrevented || alvo?.closest('[role="dialog"]:not(.rail), [role="menu"], .emoji-panel')) return
      ev.preventDefault()
      this.servico.fecharRail()
      return
    }
    if (alvo?.closest('[role="dialog"]:not(.rail)')) return
    if (prenderTab(this.painel().nativeElement, ev, document.activeElement)) ev.preventDefault()
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

  iniciais(nome: string): string {
    const p = (nome || '?').trim().split(/\s+/)
    const a = p[0]?.[0] ?? ''
    const b = p.length > 1 ? (p[p.length - 1]?.[0] ?? '') : ''
    return (a + b).toUpperCase() || '?'
  }
}
