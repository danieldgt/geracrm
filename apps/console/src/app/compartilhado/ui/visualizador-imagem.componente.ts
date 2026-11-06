import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed, inject, input, model,
  signal, untracked, viewChild,
} from '@angular/core'
import { IconeComponente } from './icone.componente.js'
import { devolverFoco, prenderTab } from './foco.js'
import {
  andarImagem, cabeReduzida, contadorImagem, encaixar, indiceDaImagem, nomeParaBaixar,
  type ImagemVisualizavel, type Medida,
} from './visualizador-imagem.regras.js'

/**
 * Visualizador de imagem em tela cheia (lightbox): a foto ocupa o que a janela permite,
 * com legenda, "Baixar" e navegação entre as imagens da lista (setas ← →).
 *
 *   <ui-visualizador-imagem [imagens]="imagens()" [(abertaId)]="imagemAberta" />
 *
 * ⚠️ Abre e navega por ID, não por índice: na conversa, mensagem nova chega e "ver
 * anteriores" insere imagens no começo da lista com o visor aberto — o índice mudaria
 * de foto sob o dedo da vendedora; o id não. Se a imagem some da lista, o visor fecha.
 *
 * Fecha com Esc, × ou clique fora da foto; o foco volta a quem abriu. Clicar na foto
 * alterna entre "caber na tela" e "tamanho real" (só quando a foto é maior que a tela).
 */
@Component({
  selector: 'ui-visualizador-imagem',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconeComponente],
  template: `
    @if (atual(); as img) {
      <div class="overlay">
        <div #caixa class="visor" role="dialog" aria-modal="true" tabindex="-1"
             [attr.aria-label]="img.legenda || 'Imagem ampliada'" (keydown)="aoTeclar($event)">
          <header class="barra">
            <span class="contador" aria-live="polite">{{ contador() }}</span>
            <div class="acoes">
              @if (podeTamanhoReal()) {
                <button type="button" class="bt" [attr.aria-pressed]="tamanhoReal()" (click)="alternarTamanho()">
                  {{ tamanhoReal() ? 'Caber na tela' : 'Tamanho real' }}
                </button>
              }
              <a class="bt" [href]="img.src" [attr.download]="nomeArquivo()" target="_blank" rel="noopener">
                <ui-icone nome="download" [tamanho]="16" /> Baixar
              </a>
              <button #fecharBt type="button" class="bt so-icone" aria-label="Fechar (Esc)" title="Fechar (Esc)"
                      (click)="fechar()">
                <ui-icone nome="x" [tamanho]="18" />
              </button>
            </div>
          </header>

          <div #palco class="palco" [class.real]="tamanhoReal()" (click)="cliqueNoPalco($event)">
            <img [src]="img.src" [alt]="img.legenda || 'Imagem da conversa'" draggable="false"
                 [class.ampliavel]="podeTamanhoReal()"
                 [style.width.px]="tamanhoReal() ? null : encaixe()?.largura"
                 [style.height.px]="tamanhoReal() ? null : encaixe()?.altura"
                 (load)="aoCarregar($event)" (click)="cliqueNaFoto($event)" />
          </div>

          @if (total() > 1) {
            <button type="button" class="nav ant" aria-label="Imagem anterior (←)" title="Anterior (←)"
                    [disabled]="indice() === 0" (click)="andar(-1)">
              <ui-icone nome="chevron-left" [tamanho]="24" />
            </button>
            <button type="button" class="nav prox" aria-label="Próxima imagem (→)" title="Próxima (→)"
                    [disabled]="indice() === total() - 1" (click)="andar(1)">
              <ui-icone nome="chevron-right" [tamanho]="24" />
            </button>
          }

          @if (img.legenda) { <p class="legenda">{{ img.legenda }}</p> }
        </div>
      </div>
    }
  `,
  styles: `
    /* Fundo quase preto nos DOIS temas: foto se vê melhor contra o escuro, como em todo
       visualizador. As cores são luz/sombra sobre esse fundo, não cor de marca. */
    .overlay { position: fixed; inset: 0; z-index: 1100; background: rgb(0 0 0 / .96); }
    .visor { position: absolute; inset: 0; display: flex; flex-direction: column; outline: none;
      color: rgb(255 255 255 / .92); }
    .barra { flex: none; display: flex; align-items: center; justify-content: space-between;
      gap: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); }
    .contador { font-size: 13px; font-variant-numeric: tabular-nums; color: rgb(255 255 255 / .7); padding-left: var(--espacamento-2); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-2); }
    .bt { display: inline-flex; align-items: center; gap: var(--espacamento-1); min-height: var(--densidade-alvo-clique-console);
      padding: 0 var(--espacamento-3); border: 0; border-radius: var(--raio-controle); background: rgb(255 255 255 / .1);
      color: inherit; font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
    .bt.so-icone { padding: 0; min-width: var(--densidade-alvo-clique-console); justify-content: center; }
    .bt:hover { background: rgb(255 255 255 / .2); }
    .bt:focus-visible, .nav:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .palco { flex: 1 1 auto; min-height: 0; display: grid; place-items: center; overflow: hidden;
      padding: 0 var(--espacamento-4) var(--espacamento-4); overscroll-behavior: contain; }
    .palco.real { overflow: auto; align-items: start; justify-items: safe center; }
    .palco img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none;
      border-radius: var(--raio-controle); }
    .palco.real img { max-width: none; max-height: none; border-radius: 0; }
    .palco img.ampliavel { cursor: zoom-in; }
    .palco.real img.ampliavel { cursor: zoom-out; }
    .nav { position: absolute; top: 50%; transform: translateY(-50%); display: grid; place-items: center;
      width: 48px; height: 48px; border: 0; border-radius: 999px; background: rgb(0 0 0 / .5); color: inherit; cursor: pointer; }
    .nav:hover:not(:disabled) { background: rgb(0 0 0 / .75); }
    .nav:disabled { opacity: .25; cursor: default; }
    .ant { left: var(--espacamento-3); }
    .prox { right: var(--espacamento-3); }
    .legenda { flex: none; margin: 0; padding: var(--espacamento-3) var(--espacamento-6) var(--espacamento-4);
      max-height: 25vh; overflow-y: auto; text-align: center; white-space: pre-wrap; font-size: 14px; line-height: 1.45; }
    @media (max-width: 719px) {
      .palco { padding: 0 0 var(--espacamento-2); }
      .palco img { border-radius: 0; }
      .nav { width: 40px; height: 40px; }
      .ant { left: var(--espacamento-1); }
      .prox { right: var(--espacamento-1); }
    }
  `,
})
export class VisualizadorImagemComponente {
  readonly imagens = input<readonly ImagemVisualizavel[]>([])
  /** Id da imagem aberta; `null` = fechado. Fechar escreve `null`. */
  readonly abertaId = model<string | null>(null)

  protected readonly indice = computed(() => {
    const id = this.abertaId()
    return id === null ? -1 : indiceDaImagem(this.imagens(), id)
  })
  protected readonly atual = computed(() => this.imagens()[this.indice()] ?? null)
  protected readonly total = computed(() => this.imagens().length)
  protected readonly contador = computed(() => contadorImagem(this.indice(), this.total()))
  protected readonly nomeArquivo = computed(() => nomeParaBaixar(this.atual()?.src ?? ''))

  protected readonly tamanhoReal = signal(false)
  private readonly natural = signal<Medida>({ largura: 0, altura: 0 })
  private readonly area = signal<Medida>({ largura: 0, altura: 0 })
  protected readonly encaixe = computed(() => encaixar(this.natural(), this.area()))
  protected readonly podeTamanhoReal = computed(() => {
    const n = this.natural()
    return n.largura > 0 && cabeReduzida(n, this.area())
  })

  private readonly caixa = viewChild<ElementRef<HTMLElement>>('caixa')
  private readonly palco = viewChild<ElementRef<HTMLElement>>('palco')
  private readonly fecharBt = viewChild<ElementRef<HTMLElement>>('fecharBt')
  private anterior: Element | null = null
  private observador: ResizeObserver | null = null

  constructor() {
    afterRenderEffect(() => {
      const caixa = this.caixa()?.nativeElement
      const palco = this.palco()?.nativeElement
      const aberto = this.atual() !== null
      untracked(() => {
        if (aberto && caixa && palco) {
          if (!caixa.contains(document.activeElement)) {
            this.anterior ??= document.activeElement
            ;(this.fecharBt()?.nativeElement ?? caixa).focus()
          }
          this.observar(palco)
        } else if (!aberto) {
          this.pararDeObservar()
          if (this.anterior) { const volta = this.anterior; this.anterior = null; devolverFoco(volta) }
        }
      })
    })
    inject(DestroyRef).onDestroy(() => this.pararDeObservar())
  }

  protected fechar(): void {
    this.tamanhoReal.set(false)
    this.abertaId.set(null)
  }

  protected andar(passo: number): void {
    const i = andarImagem(this.indice(), this.total(), passo)
    const destino = this.imagens()[i]
    if (!destino || i === this.indice()) return
    this.tamanhoReal.set(false)
    this.abertaId.set(destino.id)
  }

  protected alternarTamanho(): void { this.tamanhoReal.update((v) => !v) }

  protected aoCarregar(e: Event): void {
    const img = e.target as HTMLImageElement
    this.natural.set({ largura: img.naturalWidth, altura: img.naturalHeight })
  }

  protected cliqueNaFoto(e: MouseEvent): void {
    e.stopPropagation()
    if (this.podeTamanhoReal()) this.alternarTamanho()
  }

  /** Clique no escuro em volta da foto fecha; na foto, não. */
  protected cliqueNoPalco(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.fechar()
  }

  protected aoTeclar(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); this.fechar(); return }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.andar(-1); return }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.andar(1); return }
    const el = this.caixa()?.nativeElement
    if (el && prenderTab(el, e, document.activeElement)) { e.preventDefault(); e.stopPropagation() }
  }

  /** Mede a área útil (sem o padding) para encaixar a foto; acompanha o redimensionar da janela. */
  private observar(palco: HTMLElement): void {
    if (this.observador || typeof ResizeObserver === 'undefined') return
    const medir = (): void => {
      const cs = getComputedStyle(palco)
      const px = (v: string): number => Number.parseFloat(v) || 0
      this.area.set({
        largura: palco.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
        altura: palco.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
      })
    }
    this.observador = new ResizeObserver(medir)
    this.observador.observe(palco)
    medir()
  }

  private pararDeObservar(): void {
    this.observador?.disconnect()
    this.observador = null
    this.natural.set({ largura: 0, altura: 0 })
  }
}
