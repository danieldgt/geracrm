import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { BotaoCsvComponente } from '../../compartilhado/ui/botao-csv.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  ROTULO_AUTOR, barrasDeMensagens, csvWhatsapp, formatarDuracaoSeg, formatarPercentual, type RespostaWhatsapp,
} from './relatorios-gestao.regras.js'

/**
 * WhatsApp (E2): mensagens recebidas e enviadas por dia, conversas iniciadas, 1ª resposta (p50/p95) por autor
 * e o % respondido por gente em até X minutos (X configurável). Só canais WhatsApp. A resposta automática
 * NÃO é contada como humana — as duas aparecem em linhas separadas.
 */
@Component({
  selector: 'app-relatorio-whatsapp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BarrasHorizontaisComponente, BotaoCsvComponente, CelulaDiretiva, PainelComponente, RelatorioMolduraComponente,
    StatCardComponente, TabelaComponente,
  ],
  template: `
    <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
      [vazio]="semMovimento()" tituloVazio="Nenhuma mensagem no período"
      descricaoVazio="Conta só canais WhatsApp. Confira o período ou se há um número conectado."
      (aplicar)="carregar()" (tentar)="carregar()">
      <label filtro class="campo-limite">
        <span class="txt-rotulo">Responder em até (min)</span>
        <input type="number" min="1" max="1440" step="1" [value]="limiteMin()" (change)="limiteMin.set(lerLimite($event))" />
      </label>

      @if (c.dados(); as d) {
        <div class="cartoes">
          <ui-stat-card [valor]="d.cartoes.recebidas" rotulo="Mensagens recebidas" />
          <ui-stat-card [valor]="d.cartoes.enviadas" rotulo="Mensagens enviadas" tom="acao" />
          <ui-stat-card [valor]="d.cartoes.enviadasHumanas + ' / ' + d.cartoes.enviadasAutomaticas" rotulo="Enviadas: humanas / automáticas" />
          <ui-stat-card [valor]="d.cartoes.conversasIniciadas" rotulo="Conversas iniciadas" />
          <ui-stat-card [valor]="pct(d.cartoes.pctNoLimite)" [rotulo]="'Respondidas por gente em até ' + d.limiteMin + ' min'" tom="sucesso" />
        </div>

        <div class="duas">
          <ui-painel>
            <h2 class="txt-secao">Recebidas por dia</h2>
            <app-barras-horizontais [itens]="recebidas()" descricao="Mensagens recebidas por dia" alturaMax="360px" />
          </ui-painel>
          <ui-painel>
            <h2 class="txt-secao">Enviadas por dia</h2>
            <app-barras-horizontais [itens]="enviadas()" descricao="Mensagens enviadas por dia" alturaMax="360px" />
          </ui-painel>
        </div>

        <div class="barra-tabela">
          <span class="txt-denso nota">
            Período {{ c.inicio() }} a {{ c.fim() }}. Tempo da chegada da 1ª mensagem do cliente até a 1ª resposta;
            p50 = metade respondeu até esse tempo, p95 = 95% respondeu até esse tempo.
          </span>
          <ui-botao-csv [colunas]="csv().colunas" [linhas]="csv().linhas" [arquivo]="arquivoCsv()" />
        </div>
        <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chave">
          <ng-template uiCelula="p50" let-l>{{ dur(l['p50Seg']) }}</ng-template>
          <ng-template uiCelula="p95" let-l>{{ dur(l['p95Seg']) }}</ng-template>
        </ui-tabela>
      }
    </app-relatorio-moldura>
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); }
    .duas { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--espacamento-4); }
    h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .campo-limite { display: grid; gap: var(--espacamento-1); }
    .campo-limite input { width: 9ch; }
    .barra-tabela { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); }
  `,
})
export class RelatorioWhatsappComponente implements OnInit {
  protected readonly limiteMin = signal(5)
  protected readonly c = new CarregadorRelatorio<RespostaWhatsapp>(
    inject(HttpClient), () => '/v1/relatorios/whatsapp', () => `limiteMin=${this.limiteMin()}`,
  )

  protected readonly semMovimento = computed(() => {
    const k = this.c.dados()?.cartoes
    return !k || (k.recebidas === 0 && k.enviadas === 0 && k.conversasIniciadas === 0)
  })
  protected readonly recebidas = computed(() => barrasDeMensagens(this.c.dados()?.porDia ?? [], 'recebidas'))
  protected readonly enviadas = computed(() => barrasDeMensagens(this.c.dados()?.porDia ?? [], 'enviadas'))
  protected readonly linhas = computed<LinhaTabela[]>(() =>
    (this.c.dados()?.primeiraResposta ?? []).map((r) => ({ ...r, rotulo: ROTULO_AUTOR[r.autor] })))
  protected readonly csv = computed(() => csvWhatsapp(this.c.dados()?.porDia ?? []))
  protected readonly arquivoCsv = computed(() => `whatsapp-${this.c.inicio()}-a-${this.c.fim()}`)
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'rotulo', rotulo: 'Quem respondeu primeiro' },
    { chave: 'atendimentos', rotulo: 'Atendimentos', alinhamento: 'dir' },
    { chave: 'p50', rotulo: '1ª resposta p50', alinhamento: 'dir' },
    { chave: 'p95', rotulo: '1ª resposta p95', alinhamento: 'dir' },
  ]
  protected readonly chave = (l: LinhaTabela): string => String(l['autor'])

  ngOnInit(): void { void this.carregar() }

  protected lerLimite(e: Event): number {
    const n = Math.trunc(Number((e.target as HTMLInputElement).value))
    return Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : 5
  }
  protected pct(v: number | null): string { return formatarPercentual(v) }
  protected dur(v: unknown): string { return formatarDuracaoSeg(v === null || v === undefined ? null : Number(v)) }
  protected carregar(): Promise<void> { return this.c.carregar() }
}
