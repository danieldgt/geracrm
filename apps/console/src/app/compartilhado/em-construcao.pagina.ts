import { Component, ChangeDetectionStrategy, inject } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { toSignal } from '@angular/core/rxjs-interop'
import { map } from 'rxjs'

/**
 * Placeholder honesto para telas ainda não construídas.
 *
 * ⚠️ É um dos CINCO estados obrigatórios aplicado ao roteamento: em vez de a
 * tela sumir do menu (o que esconderia o plano) ou abrir em branco (o que
 * parece bug), ela existe, é navegável e DIZ o que vai ser e em qual onda. É o
 * que deixa "os menus prontos" sem fingir que tudo está feito.
 *
 * O título e a descrição vêm do `data` da rota — que sai do mesmo config de
 * menu. Zero duplicação: não há um componente por tela em construção.
 */
@Component({
  selector: 'app-em-construcao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="caixa">
      <span class="icone">{{ dados()?.icone }}</span>
      <h1>{{ dados()?.rotulo }}</h1>
      <p class="job">{{ dados()?.descricao }}</p>
      <span class="selo">Em construção · {{ dados()?.onda }}</span>
      <p class="nota">
        Esta tela já está mapeada e faz parte do sistema. O menu e a navegação estão prontos;
        o conteúdo entra na onda indicada, seguindo os cinco estados e os design tokens.
      </p>
    </div>
  `,
  styles: `
    :host { display: grid; place-items: center; min-height: 60vh; padding: var(--espacamento-6); }
    .caixa { max-width: 460px; text-align: center; padding: var(--espacamento-8);
      border: 1px dashed var(--borda-forte); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); }
    .icone { font-size: 40px; display: block; margin-bottom: var(--espacamento-3); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .job { margin: var(--espacamento-2) 0 var(--espacamento-4); color: var(--texto-secundario); }
    .selo { display: inline-block; font-size: 12px; font-weight: 500; color: var(--atencao);
      border: 1px solid var(--atencao); border-radius: var(--raio-completo);
      padding: 2px var(--espacamento-3); }
    .nota { margin-top: var(--espacamento-4); font-size: 12px; color: var(--texto-suave); line-height: 1.5; }
  `,
})
export class EmConstrucaoPagina {
  private readonly rota = inject(ActivatedRoute)
  readonly dados = toSignal(
    this.rota.data.pipe(map((d) => d as { rotulo: string; descricao: string; icone: string; onda: string })),
  )
}
