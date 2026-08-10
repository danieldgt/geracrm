import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/**
 * Estado de tela do bloco 1 (R-12): vazio / erro / sem-permissão.
 * ⚠️ Vazio EXPLICA o porquê e oferece a ação seguinte (slot). Erro NOMEIA o que
 * falhou (integração nomeia o sistema). Nunca uma tela em branco.
 */
@Component({
  selector: 'ui-estado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="estado" [attr.data-tipo]="tipo()">
      <span class="icone" aria-hidden="true">{{ icone() || padraoIcone() }}</span>
      <h2>{{ titulo() }}</h2>
      @if (descricao()) { <p>{{ descricao() }}</p> }
      <div class="acao"><ng-content /></div>
    </div>
  `,
  styles: `
    .estado { display: grid; justify-items: center; text-align: center; gap: var(--espacamento-2);
      padding: var(--espacamento-8); color: var(--texto-secundario); }
    .icone { font-size: 40px; }
    h2 { margin: 0; font-size: 16px; color: var(--texto); }
    p { margin: 0; max-width: 46ch; }
    .acao { margin-top: var(--espacamento-3); }
  `,
})
export class EstadoComponente {
  readonly tipo = input<'vazio' | 'erro' | 'sem-permissao'>('vazio')
  readonly titulo = input('')
  readonly descricao = input('')
  readonly icone = input('')
  padraoIcone(): string {
    return this.tipo() === 'erro' ? '⚠️' : this.tipo() === 'sem-permissao' ? '🔒' : '📭'
  }
}
