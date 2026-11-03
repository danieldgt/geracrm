import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core'
import { AbasComponente } from '../../compartilhado/ui/abas.componente.js'
import type { Aba } from '../../compartilhado/ui/abas.regras.js'
import { CabecalhoTelaComponente } from '../../compartilhado/ui/cabecalho-tela.componente.js'
import { RelatorioDimensaoComponente } from './relatorio-dimensao.componente.js'
import { DIMENSOES_RELATORIO, type DimensaoRelatorio } from './relatorio-dimensao.config.js'

/** Relatórios — contatos por origem, etapa, vendedor, dia da semana, qualificação e UF (uma aba por dimensão). */
@Component({
  selector: 'app-relatorios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbasComponente, CabecalhoTelaComponente, RelatorioDimensaoComponente],
  template: `
    <ui-cabecalho-tela titulo="Relatórios" subtitulo="Contatos novos por origem, etapa, vendedor e dia da semana." />
    <ui-abas [abas]="abas" [ativa]="aba()" (ativaChange)="trocar($event)" />
    <div class="corpo"><app-relatorio-dimensao [dimensao]="dimensao()" /></div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); }
  `,
})
export class RelatoriosPagina {
  protected readonly abas: readonly Aba[] = DIMENSOES_RELATORIO.map((d) => ({ id: d.chave, rotulo: d.aba }))
  protected readonly aba = signal<string>(DIMENSOES_RELATORIO[0]!.chave)
  protected readonly dimensao = computed(() => this.aba() as DimensaoRelatorio)

  protected trocar(id: string): void { this.aba.set(id) }
}
