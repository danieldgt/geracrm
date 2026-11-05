import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { AbasComponente } from '../../compartilhado/ui/abas.componente.js'
import type { Aba } from '../../compartilhado/ui/abas.regras.js'
import { CabecalhoTelaComponente } from '../../compartilhado/ui/cabecalho-tela.componente.js'
import { RelatorioAtendimentoComponente } from './relatorio-atendimento.componente.js'
import { RelatorioCidadesComponente } from './relatorio-cidades.componente.js'
import { RelatorioComparativoComponente } from './relatorio-comparativo.componente.js'
import { RelatorioContatosCompletoComponente } from './relatorio-contatos-completo.componente.js'
import { RelatorioDesempenhoComponente } from './relatorio-desempenho.componente.js'
import { RelatorioEnviadasComponente } from './relatorio-enviadas.componente.js'
import { RelatorioImprimiveisComponente } from './relatorio-imprimiveis.componente.js'
import { RelatorioRaioXComponente } from './relatorio-raio-x.componente.js'
import { RelatorioVisaoGeralComponente } from './relatorio-visao-geral.componente.js'
import { RelatorioConversaoComponente } from './relatorio-conversao.componente.js'
import { RelatorioDimensaoComponente } from './relatorio-dimensao.componente.js'
import { RelatorioOperacionalComponente } from './relatorio-operacional.componente.js'
import { RelatorioVendasComponente } from './relatorio-vendas.componente.js'
import { RelatorioVendedoresComponente } from './relatorio-vendedores.componente.js'
import { RelatorioWhatsappComponente } from './relatorio-whatsapp.componente.js'
import {
  GRUPOS_RELATORIO, grupoDaFolha, paramsDaSelecao, selecaoDaSubAba, selecaoDaUrl, selecaoDoGrupo, subAbaAtiva, subAbas,
  type Selecao,
} from './relatorios.regras.js'

/**
 * Relatórios — 8 grupos (relatorios.regras.ts): Visão geral, Vendas, Vendedores, Contatos, Raio-X, Atendimento,
 * WhatsApp e Imprimíveis. Absorveu as telas Painéis (BI → Vendas), Mapa (→ Contatos → UF + top cidades),
 * Performance e NPS (→ Atendimento) e Mensagens Enviadas (→ WhatsApp).
 *
 * ⚠️ A seleção mora na URL (`?relatorio=&dim=`): favorito, "voltar" e o redirect das rotas antigas abrem o
 * relatório certo. Trocar de aba troca a URL com `replaceUrl` (não enche o histórico de abas).
 */
@Component({
  selector: 'app-relatorios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, CabecalhoTelaComponente, RelatorioAtendimentoComponente, RelatorioCidadesComponente,
    RelatorioConversaoComponente, RelatorioDimensaoComponente, RelatorioEnviadasComponente,
    RelatorioOperacionalComponente, RelatorioVendasComponente, RelatorioVendedoresComponente, RelatorioWhatsappComponente,
    RelatorioComparativoComponente, RelatorioContatosCompletoComponente, RelatorioDesempenhoComponente,
    RelatorioImprimiveisComponente, RelatorioRaioXComponente, RelatorioVisaoGeralComponente,
  ],
  template: `
    <ui-cabecalho-tela class="nao-imprimir" titulo="Relatórios"
      subtitulo="Vendas, contatos, atendimento e WhatsApp — com período livre e CSV." />
    <ui-abas class="nao-imprimir" [abas]="grupos" [ativa]="grupo().id" (ativaChange)="irGrupo($event)" />
    @if (sub().length) {
      <ui-abas class="nao-imprimir sub-abas" [abas]="sub()" [ativa]="subAtiva()" (ativaChange)="irSub($event)" />
    }
    <div class="corpo">
      @switch (sel().folha) {
        @case ('contatos') {
          <app-relatorio-dimensao [dimensao]="sel().dim" />
          @if (sel().dim === 'uf') { <app-relatorio-cidades class="cidades" /> }
        }
        @case ('vendas') { <app-relatorio-vendas /> }
        @case ('conversao') { <app-relatorio-conversao /> }
        @case ('vendedores') { <app-relatorio-vendedores /> }
        @case ('operacional') { <app-relatorio-operacional /> }
        @case ('whatsapp') { <app-relatorio-whatsapp /> }
        @case ('enviadas') { <app-relatorio-enviadas /> }
        @case ('atendimento') { <app-relatorio-atendimento /> }
        @case ('comparativo') { <app-relatorio-comparativo /> }
        @case ('visao-geral') { <app-relatorio-visao-geral /> }
        @case ('lista') { <app-relatorio-contatos-completo /> }
        @case ('raio-x') { <app-relatorio-raio-x /> }
        @case ('desempenho') { <app-relatorio-desempenho /> }
        @case ('imprimiveis') { <app-relatorio-imprimiveis /> }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .sub-abas { margin-top: var(--espacamento-3); }
    .corpo { margin-top: var(--espacamento-4); }
    .cidades { display: block; margin-top: var(--espacamento-6); }
    @media print { :host { padding: 0; } .corpo { margin-top: 0; } }
  `,
})
export class RelatoriosPagina {
  private readonly router = inject(Router)
  private readonly rota = inject(ActivatedRoute)
  private readonly qp = toSignal(this.rota.queryParamMap, { initialValue: this.rota.snapshot.queryParamMap })

  protected readonly grupos: readonly Aba[] = GRUPOS_RELATORIO.map((g) => ({ id: g.id, rotulo: g.rotulo }))
  protected readonly sel = computed<Selecao>(() => selecaoDaUrl(this.qp().get('relatorio'), this.qp().get('dim')))
  protected readonly grupo = computed(() => grupoDaFolha(this.sel().folha))
  protected readonly sub = computed<readonly Aba[]>(() => subAbas(this.grupo()))
  protected readonly subAtiva = computed(() => subAbaAtiva(this.sel()))

  protected irGrupo(id: string): void { this.ir(selecaoDoGrupo(id, this.sel())) }
  protected irSub(id: string): void { this.ir(selecaoDaSubAba(id, this.sel())) }

  private ir(s: Selecao): void {
    void this.router.navigate([], {
      relativeTo: this.rota, queryParams: paramsDaSelecao(s), queryParamsHandling: 'merge', replaceUrl: true,
    })
  }
}
