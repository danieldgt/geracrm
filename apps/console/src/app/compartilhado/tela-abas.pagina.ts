import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, RouterOutlet } from '@angular/router'
import { map } from 'rxjs'
import { AbasComponente } from './ui/abas.componente.js'
import type { Aba } from './ui/abas.regras.js'
import { TELA_EMBUTIDA } from './ui/embutida.js'
import { abasVisiveis, type ItemMenu } from '../nucleo/menu.js'
import { ModulosServico } from '../nucleo/modulos.servico.js'
import { PresencaServico } from '../nucleo/presenca.servico.js'

/**
 * Tela com abas: UMA entrada do menu que reúne telas irmãs (Configurações, Base
 * de clientes, Públicos…). Cada aba é uma rota filha `/<item>/<aba>` que carrega
 * a tela de verdade, sem cópia.
 *
 * ⚠️ Provê `TELA_EMBUTIDA`: a tela filha esconde o próprio título (quem diz o
 * nome é esta) e mantém as ações. A aba ativa vem da URL — favorito e "voltar"
 * do navegador funcionam aba por aba.
 */
@Component({
  selector: 'app-tela-abas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbasComponente, RouterOutlet],
  providers: [{ provide: TELA_EMBUTIDA, useValue: true }],
  template: `
    <div class="topo">
      <h1 class="txt-titulo">{{ item()?.rotulo }}</h1>
      @if (item()?.descricao; as d) { <p class="txt-corpo sub">{{ d }}</p> }
      <!-- Uma aba só (ex.: Agenda e tarefas sem o módulo Agenda) não vira barra de abas. -->
      @if (abas().length > 1) {
        <ui-abas class="abas" [abas]="abas()" idPainel="painel-aba" />
      } @else {
        <div class="sem-abas"></div>
      }
    </div>
    <div id="painel-aba" role="tabpanel">
      <router-outlet />
    </div>
  `,
  styles: `
    :host { display: block; }
    .topo { padding: var(--espacamento-6) var(--espacamento-6) 0; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); }
    .abas { margin-top: var(--espacamento-4); }
    .sem-abas { margin-top: var(--espacamento-2); }
    @media (max-width: 719.98px) { .topo { padding: var(--espacamento-4) var(--espacamento-4) 0; } }
  `,
})
export class TelaAbasPagina {
  private readonly rota = inject(ActivatedRoute)
  private readonly modulos = inject(ModulosServico)
  private readonly presenca = inject(PresencaServico)

  protected readonly item = toSignal(this.rota.data.pipe(map((d) => d['item'] as ItemMenu | undefined)))
  protected readonly abas = computed<readonly Aba[]>(() => {
    const it = this.item()
    if (!it) return []
    return abasVisiveis(it, this.modulos.estado(), this.presenca.gestao())
      .map((a) => ({ id: a.rota, rotulo: a.rotulo, rota: `/${it.rota}/${a.rota}` }))
  })
}
