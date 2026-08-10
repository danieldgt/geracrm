import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/**
 * Esqueleto do bloco 1 (R-12). ⚠️ O estado "carregando" usa a FORMA do conteúdo
 * (regra das telas), nunca um spinner solto no centro.
 */
@Component({
  selector: 'ui-esqueleto',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="esq" [style.width]="largura()" [style.height]="altura()"
                   [style.border-radius]="raio()"></span>`,
  styles: `
    .esq { display: block;
      background: linear-gradient(90deg, var(--superficie-elevada), var(--borda), var(--superficie-elevada));
      background-size: 200% 100%; animation: brilho 1.3s ease-in-out infinite; }
    @keyframes brilho { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
  `,
})
export class EsqueletoComponente {
  readonly largura = input('100%')
  readonly altura = input('16px')
  readonly raio = input('var(--raio-controle)')
}
