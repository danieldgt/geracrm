import {
  ChangeDetectionStrategy, Component, ElementRef, Injectable, afterRenderEffect, inject, signal, viewChild,
} from '@angular/core'
import {
  FECHADO, abrir, normalizarPedido, responder, type EstadoConfirmacao,
} from './confirmacao.estado.js'

/**
 * Confirmação de ação destrutiva — serviço por Promise + UM modal de verdade.
 *
 *   const ok = await confirmacao.confirmar({ titulo: 'Excluir meta?', mensagem: '…', acao: 'Excluir' })
 *   if (!ok) return
 *
 * ⚠️ Substitui o `confirm()` nativo e, principalmente, o botão que apaga sem
 * perguntar. A máquina de estados (confirmacao.estado.ts) é pura e testada; aqui
 * só mora a cola com o Angular: o signal, as promessas pendentes e o foco.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmacaoServico {
  readonly estado = signal<EstadoConfirmacao>(FECHADO)
  private serie = 0
  private readonly pendentes = new Map<number, (r: boolean) => void>()

  confirmar(p: { titulo: string; mensagem: string; acao?: string; cancelar?: string; perigo?: boolean }): Promise<boolean> {
    const serie = ++this.serie
    const t = abrir(this.estado(), normalizarPedido(p), serie)
    this.aplicar(t.respostas)
    this.estado.set(t.estado)
    return new Promise<boolean>((resolve) => this.pendentes.set(serie, resolve))
  }

  responder(resposta: boolean): void {
    const t = responder(this.estado(), resposta)
    this.aplicar(t.respostas)
    this.estado.set(t.estado)
  }

  private aplicar(respostas: readonly { serie: number; resposta: boolean }[]): void {
    for (const r of respostas) {
      this.pendentes.get(r.serie)?.(r.resposta)
      this.pendentes.delete(r.serie)
    }
  }
}

/** Montar UMA vez na casca (ao lado de `ui-toasts`). */
@Component({
  selector: 'ui-confirmar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servico.estado(); as e) {
      @if (e.aberto) {
        <div class="overlay" (click)="servico.responder(false)">
          <div #caixa class="modal" role="dialog" aria-modal="true" tabindex="-1"
               aria-labelledby="ui-confirmar-titulo" aria-describedby="ui-confirmar-msg"
               (click)="$event.stopPropagation()" (keydown.escape)="servico.responder(false)">
            <h2 id="ui-confirmar-titulo" class="txt-secao">{{ e.pedido.titulo }}</h2>
            <p id="ui-confirmar-msg" class="txt-corpo">{{ e.pedido.mensagem }}</p>
            <div class="acoes">
              <button type="button" class="btn btn--secundario" (click)="servico.responder(false)">{{ e.pedido.cancelar }}</button>
              <button #primario type="button" class="btn" [class.btn--perigo]="e.pedido.perigo" [class.btn--primario]="!e.pedido.perigo"
                      (click)="servico.responder(true)">{{ e.pedido.acao }}</button>
            </div>
          </div>
        </div>
      }
    }
  `,
  styles: `
    .overlay { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center;
      padding: var(--espacamento-4); background: var(--fundo-sobreposicao, rgb(0 0 0 / .4)); }
    .modal { width: 100%; max-width: 420px; padding: var(--espacamento-6);
      background: var(--superficie-elevada); color: var(--texto); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); outline: none; }
    .modal:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    h2 { margin: 0 0 var(--espacamento-2); }
    p { margin: 0 0 var(--espacamento-5); color: var(--texto-secundario); }
    .acoes { display: flex; justify-content: flex-end; gap: var(--espacamento-2); flex-wrap: wrap; }
    .btn { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-4);
      border-radius: var(--raio-controle); border: 1px solid transparent; font: inherit; font-weight: 600; cursor: pointer; }
    .btn--secundario { background: var(--fundo); color: var(--texto); border-color: var(--borda-controle); }
    .btn--primario { background: var(--acao); color: var(--acao-texto); }
    .btn--perigo { background: var(--erro); color: var(--acao-texto); }
    .btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `,
})
export class ConfirmarComponente {
  readonly servico = inject(ConfirmacaoServico)
  private readonly caixa = viewChild<ElementRef<HTMLElement>>('caixa')
  private readonly primario = viewChild<ElementRef<HTMLButtonElement>>('primario')

  constructor() {
    // ⚠️ Foco entra no diálogo ao abrir (o leitor de tela anuncia e o teclado
    //    não fica preso atrás). O botão da ação recebe o foco; se não existir
    //    ainda, o próprio modal (tabindex=-1).
    afterRenderEffect(() => {
      if (!this.servico.estado().aberto) return
      const alvo = this.primario()?.nativeElement ?? this.caixa()?.nativeElement
      if (alvo && document.activeElement !== alvo && !alvo.contains(document.activeElement)) alvo.focus()
    })
  }
}
