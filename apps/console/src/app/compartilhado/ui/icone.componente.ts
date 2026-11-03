import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core'
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser'
import { atributosDeAcessibilidade, marcacaoDoIcone } from './icone.regras.js'

/**
 * Ícone Lucide do console. Substitui o emoji como ícone de menu e de estado.
 *
 * ⚠️ `[innerHTML]` com `bypassSecurityTrustHtml` é seguro AQUI porque o markup
 * vem só de `ICONES` (constantes do código-fonte, versionadas, sem entrada de
 * usuário). O `nome` escolhe uma chave do mapa; ele nunca entra como HTML. Um
 * nome desconhecido cai no círculo de reserva, nunca em texto cru. Se algum dia
 * o markup vier de fora (API, tenant), esta premissa cai e o bypass vira XSS:
 * nesse caso, sanitize antes.
 */
@Component({
  selector: 'ui-icone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
      class="icone"
      [attr.width]="tamanho()"
      [attr.height]="tamanho()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.aria-hidden]="acessibilidade()['aria-hidden']"
      [attr.role]="acessibilidade().role"
      [attr.aria-label]="acessibilidade()['aria-label']"
      [innerHTML]="marcacao()"
    ></svg>`,
  styles: `
    :host { display: inline-flex; line-height: 0; flex: none; }
    .icone { display: block; }
  `,
})
export class IconeComponente {
  private readonly sanitizador = inject(DomSanitizer)

  /** Nome Lucide (kebab-case), ex.: `house`, `bar-chart-3`. */
  readonly nome = input.required<string>()
  /** Tamanho em px da caixa do ícone. Só a escala da casca (14 e 18). */
  readonly tamanho = input<14 | 18>(18)
  /** Sem rótulo, o ícone é decorativo. Com rótulo, vira `role="img"` nomeado. */
  readonly rotulo = input<string>()

  protected readonly marcacao = computed<SafeHtml>(() =>
    this.sanitizador.bypassSecurityTrustHtml(marcacaoDoIcone(this.nome()).markup),
  )

  protected readonly acessibilidade = computed(() => atributosDeAcessibilidade(this.rotulo()))
}
