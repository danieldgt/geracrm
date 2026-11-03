import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core'

/**
 * Formulário-página: cartão com cabeçalho, corpo de seções e rodapé de ações.
 *
 *   <ui-form-pagina titulo="Novo contato" subtitulo="…">
 *     <ui-secao-form titulo="Dados">…</ui-secao-form>
 *     <div rodape>botões</div>
 *   </ui-form-pagina>
 */
@Component({
  selector: 'ui-form-pagina',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <section class="ui-form-pagina">
      <header class="ui-form-pagina__cab">
        <h2 class="txt-secao">{{ titulo() }}</h2>
        @if (subtitulo()) { <p class="txt-corpo">{{ subtitulo() }}</p> }
      </header>
      <div class="ui-form-pagina__corpo"><ng-content /></div>
      <footer class="ui-form-pagina__rodape"><ng-content select="[rodape]" /></footer>
    </section>
  `,
  styles: `
    ui-form-pagina { display: block; }
    .ui-form-pagina { background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); overflow: hidden; }
    .ui-form-pagina__cab { padding: var(--espacamento-4) var(--espacamento-6); border-bottom: 1px solid var(--borda); }
    .ui-form-pagina__cab h2 { margin: 0; color: var(--texto); }
    .ui-form-pagina__cab p { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); }
    .ui-form-pagina__corpo { display: flex; flex-direction: column; gap: var(--espacamento-8);
      padding: var(--espacamento-6); }
    .ui-form-pagina__rodape { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--espacamento-2);
      padding: var(--espacamento-4) var(--espacamento-6); border-top: 1px solid var(--borda); }
    .ui-form-pagina__rodape:empty { display: none; }
    @media (max-width: 639px) {
      .ui-form-pagina__cab, .ui-form-pagina__rodape { padding-inline: var(--espacamento-4); }
      .ui-form-pagina__corpo { padding: var(--espacamento-4); gap: var(--espacamento-6); }
      .ui-form-pagina__rodape > * { flex: 1 1 auto; }
    }
  `,
})
export class FormPaginaComponente {
  readonly titulo = input('')
  readonly subtitulo = input('')
}
