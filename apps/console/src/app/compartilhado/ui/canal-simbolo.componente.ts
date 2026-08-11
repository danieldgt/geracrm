import { Component, ChangeDetectionStrategy, input, computed } from '@angular/core'
import { familiaCanal, rotuloCanal, riscoBanimentoCanal, type TipoCanal } from '@geracrm/shared'

/**
 * Símbolo da marca do canal (WhatsApp / Instagram / TikTok) por conversa ou contato.
 * Fonte única do "que canal é este" vem de @geracrm/shared (familiaCanal/rotuloCanal);
 * aqui mora só o desenho — três selos quadrados-arredondados, um conjunto coerente.
 *
 * ⚠️ Cores de MARCA (verde do WhatsApp, gradiente do Instagram, preto do TikTok) NÃO
 *    são cor de tema — não saem de token. São exceção consciente e cada linha é
 *    marcada com `cor-literal-ok` para a R-12 (cor-literal.spec) permitir.
 *
 * ⚠️ svg com width/height EXPLÍCITOS + selo com padding:0 e box-sizing:content-box:
 *    sem isso o global svg{max-width:100%} zera a largura do ícone (bug do /contatos).
 *
 * ADR-021: o não-oficial carrega risco de banimento; o selo ganha um ponto âmbar
 *    visível quando é esse o caso.
 */
@Component({
  selector: 'app-canal-simbolo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="canal" [attr.data-familia]="familia()" [attr.title]="rotulo()"
          [attr.aria-label]="rotulo()" role="img"
          [style.width.px]="tam()" [style.height.px]="tam()">
      @switch (familia()) {
        @case ('whatsapp') {
          <svg viewBox="0 0 24 24" width="14" height="14" fill="#ffffff" aria-hidden="true"><!-- cor-literal-ok: branco do glifo sobre a marca -->
            <path fill="#ffffff" d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m5.8 14.03c-.24.68-1.42 1.3-1.95 1.34-.5.05-1.13.24-3.68-.77-3.09-1.22-5.07-4.36-5.22-4.56-.15-.2-1.25-1.66-1.25-3.17s.79-2.25 1.07-2.56c.28-.31.61-.38.81-.38.2 0 .41.01.58.01.19.01.44-.07.69.53.24.6.83 2.07.9 2.22.07.15.12.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.31-.13.6.17.29.76 1.24 1.63 2.01 1.12 1 2.07 1.31 2.36 1.46.29.15.46.12.63-.07.17-.2.73-.85.92-1.14.19-.29.39-.24.65-.15.27.1 1.71.81 2 .96.29.15.49.22.56.34.07.12.07.72-.17 1.4"/><!-- cor-literal-ok -->
          </svg>
        }
        @case ('instagram') {
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ffffff" stroke-width="2" aria-hidden="true"><!-- cor-literal-ok: traço branco sobre o gradiente -->
            <rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="#ffffff" stroke-width="2"/><!-- cor-literal-ok -->
            <circle cx="12" cy="12" r="4" fill="none" stroke="#ffffff" stroke-width="2"/><!-- cor-literal-ok -->
            <circle cx="17" cy="7" r="1.3" fill="#ffffff" stroke="none"/><!-- cor-literal-ok -->
          </svg>
        }
        @case ('tiktok') {
          <svg viewBox="0 0 24 24" width="14" height="14" fill="#ffffff" aria-hidden="true"><!-- cor-literal-ok: nota branca sobre o preto -->
            <path fill="#ffffff" d="M16.7 3c.28 2.02 1.62 3.53 3.55 3.78v2.42c-1.28 0-2.5-.4-3.55-1.1v5.64c0 3.12-2.5 5.31-5.32 5.31-2.75 0-5.02-2.16-5.02-5.16 0-2.66 1.98-4.85 4.6-5.2v2.53c-1.16.3-2 1.3-2 2.5 0 1.42 1.13 2.6 2.62 2.6 1.5 0 2.62-1.2 2.62-2.72V3h2.92z"/><!-- cor-literal-ok -->
          </svg>
        }
      }
      @if (risco()) { <span class="risco" title="Canal não-oficial — risco de banimento"></span> }
    </span>
  `,
  styles: [`
    .canal { display: inline-grid; place-items: center; padding: 0; box-sizing: content-box;
             border-radius: 5px; position: relative; flex: none; line-height: 0; }
    .canal svg { display: block; width: 14px; height: 14px; }
    .canal[data-familia="whatsapp"]  { background: #25d366; }                                   /* cor-literal-ok: marca WhatsApp */
    .canal[data-familia="instagram"] { background: radial-gradient(circle at 30% 107%,
        #fdf497 0%, #fd5949 45%, #d6249f 60%, #285aeb 90%); }                                   /* cor-literal-ok: gradiente Instagram */
    .canal[data-familia="tiktok"]    { background: #010101; }                                    /* cor-literal-ok: marca TikTok */
    /* Ponto de risco (ADR-021): não-oficial fica visível. */
    .risco { position: absolute; top: -3px; right: -3px; width: 7px; height: 7px;
             border-radius: 50%; background: var(--atencao); box-shadow: 0 0 0 1.5px var(--superficie); }
  `],
})
export class CanalSimboloComponente {
  /** Tipo do canal da conversa/contato. */
  readonly tipo = input.required<TipoCanal>()
  /** Lado do selo em px (o glifo fica em 14px fixo, centralizado). */
  readonly tam = input(22)

  readonly familia = computed(() => familiaCanal(this.tipo()))
  readonly rotulo = computed(() => rotuloCanal(this.tipo()))
  readonly risco = computed(() => riscoBanimentoCanal(this.tipo()))
}
