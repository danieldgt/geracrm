import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { escalarBarras } from './relatorio-dimensao.regras.js'

/**
 * Barras horizontais em CSS (sem biblioteca de gráfico): rótulo SEMPRE ao lado da barra e valor no fim.
 * Cor só por token. A largura vem de `escalarBarras` (maior = 100%).
 */
@Component({
  selector: 'app-barras-horizontais',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="barras" [attr.aria-label]="descricao()" [style.max-height]="alturaMax() || null">
      @for (b of barras(); track b.chave) {
        <li class="linha">
          <span class="rotulo txt-denso" [title]="b.rotulo">{{ b.rotulo }}</span>
          <span class="trilho" aria-hidden="true"><span class="fill" [style.width.%]="b.largura"></span></span>
          <span class="valor txt-dados">{{ b.texto ?? b.valor }}</span>
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .barras { overflow-y: auto; list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .linha { display: grid; grid-template-columns: minmax(72px, 28%) 1fr auto; align-items: center; gap: var(--espacamento-3); min-width: 0; }
    .rotulo { color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .trilho { display: block; height: 12px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .fill { display: block; height: 100%; border-radius: var(--raio-completo); background: var(--acao); }
    .valor { min-width: 3ch; white-space: nowrap; text-align: right; color: var(--texto); }
  `,
})
export class BarrasHorizontaisComponente {
  readonly itens = input.required<readonly { chave: string; rotulo: string; valor: number; texto?: string }[]>()
  /** Altura máxima da lista (CSS, ex.: '360px'); acima disso rola. Vazio = sem limite. */
  readonly alturaMax = input('')
  /** Texto para leitor de tela ("Contatos por origem"). */
  readonly descricao = input('Gráfico de barras')
  protected readonly barras = computed(() => escalarBarras(this.itens()))
}
