import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { BarrasHorizontaisComponente } from './barras-horizontais.componente.js'
import { CarregadorRelatorio } from './carregador-relatorio.js'
import { RelatorioMolduraComponente } from './relatorio-moldura.componente.js'
import {
  alternarSecao, resumoWhatsappImprimivel, ROTULO_SECAO, SECOES_IMPRIMIVEIS, type RespostaImprimiveis, type SecaoImprimivel,
} from './relatorios-analise.regras.js'
import { formatarDuracaoSeg, formatarPercentual, ROTULO_AUTOR, rotuloDoDia } from './relatorios-gestao.regras.js'

/**
 * Imprimíveis (E3): funil, origens, motivos de perda e WhatsApp numa página só, prontos para o papel/PDF do
 * navegador. Na impressão (`@media print`, em estilos.css) somem o menu, a barra do topo, o trilho de conversas
 * e tudo o que é `.nao-imprimir` (período, botões e abas) — sobra o título, o período e os quadros escolhidos.
 */
@Component({
  selector: 'app-relatorio-imprimiveis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarrasHorizontaisComponente, PainelComponente, RelatorioMolduraComponente, StatCardComponente],
  template: `
    <div class="nao-imprimir">
      <app-relatorio-moldura [(inicio)]="c.inicio" [(fim)]="c.fim" [estado]="c.estado()" [erroTexto]="c.erroTexto()"
        (aplicar)="carregar()" (tentar)="carregar()" />
    </div>

    @if (c.estado() === 'pronto' && c.dados(); as d) {
      <div class="nao-imprimir barra">
        <div class="secoes" role="group" aria-label="Quadros do relatório impresso">
          @for (s of secoesTodas; track s) {
            <button type="button" class="btn btn--pequeno" [class.btn--primario]="ativas().includes(s)" [class.btn--secundario]="!ativas().includes(s)"
                    [attr.aria-pressed]="ativas().includes(s)" (click)="alternar(s)">{{ rotulo(s) }}</button>
          }
        </div>
        <button type="button" class="btn btn--primario btn--pequeno" (click)="imprimir()">Imprimir ou salvar em PDF</button>
      </div>

      <section class="folha imprimivel" aria-label="Relatório para impressão">
        <header class="cabecalho">
          <h1 class="txt-titulo">Relatório de acompanhamento</h1>
          <p class="txt-denso nota">Período {{ c.inicio() }} a {{ c.fim() }} (fuso {{ d.periodo.fuso }}).</p>
        </header>

        @if (ativas().includes('funil')) {
          <ui-painel class="quadro">
            <h2 class="txt-secao">Funil: oportunidades abertas por etapa (hoje)</h2>
            @if (funil().length === 0) { <p class="txt-denso nota">Nenhuma etapa de funil configurada.</p> }
            @else { <app-barras-horizontais [itens]="funil()" descricao="Oportunidades abertas por etapa" /> }
          </ui-painel>
        }
        @if (ativas().includes('origens')) {
          <ui-painel class="quadro">
            <h2 class="txt-secao">Origens dos contatos novos</h2>
            @if (origens().length === 0) { <p class="txt-denso nota">Nenhum contato novo no período.</p> }
            @else { <app-barras-horizontais [itens]="origens()" descricao="Contatos novos por origem" /> }
            @if (d.origens.truncado) { <p class="txt-denso nota">Mostrando as 100 maiores origens.</p> }
          </ui-painel>
        }
        @if (ativas().includes('motivos')) {
          <ui-painel class="quadro">
            <h2 class="txt-secao">Motivos de perda ({{ d.motivosPerda.total }} {{ d.motivosPerda.total === 1 ? 'oportunidade perdida' : 'oportunidades perdidas' }})</h2>
            @if (motivos().length === 0) { <p class="txt-denso nota">Nenhuma oportunidade perdida no período.</p> }
            @else { <app-barras-horizontais [itens]="motivos()" descricao="Oportunidades perdidas por motivo" /> }
          </ui-painel>
        }
        @if (ativas().includes('whatsapp')) {
          <ui-painel class="quadro">
            <h2 class="txt-secao">WhatsApp</h2>
            <div class="cartoes">
              @for (k of whatsapp().cartoes; track k.rotulo) { <ui-stat-card [valor]="k.valor" [rotulo]="k.rotulo" /> }
            </div>
            @for (p of whatsapp().primeiraResposta; track p.autor) {
              <p class="txt-denso nota">{{ autor(p.autor) }}: {{ p.atendimentos }} atendimentos; 1ª resposta mediana {{ duracao(p.p50Seg) }}, p95 {{ duracao(p.p95Seg) }}.</p>
            }
            <app-barras-horizontais [itens]="mensagensPorDia()" alturaMax="260px" descricao="Mensagens recebidas por dia" />
          </ui-painel>
        }
      </section>
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); min-width: 0; }
    h1, h2 { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .barra { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .secoes { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .folha { display: grid; gap: var(--espacamento-4); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .nota { color: var(--texto-secundario); margin: 0 0 var(--espacamento-2); }
    @media print {
      .quadro { break-inside: avoid; }
    }
  `,
})
export class RelatorioImprimiveisComponente implements OnInit {
  protected readonly c = new CarregadorRelatorio<RespostaImprimiveis>(inject(HttpClient), () => '/v1/relatorios/imprimiveis')
  protected readonly secoesTodas = SECOES_IMPRIMIVEIS
  protected readonly ativas = signal<readonly SecaoImprimivel[]>([...SECOES_IMPRIMIVEIS])

  protected readonly funil = computed(() => (this.c.dados()?.funil ?? []).map((e) => ({ chave: e.chave, rotulo: e.rotulo, valor: e.oportunidades })))
  protected readonly origens = computed(() =>
    (this.c.dados()?.origens.itens ?? []).map((o) => ({ chave: o.chave, rotulo: o.rotulo, valor: o.contatos, texto: `${o.contatos} (${formatarPercentual(o.taxa)} conv.)` })))
  protected readonly motivos = computed(() =>
    (this.c.dados()?.motivosPerda.itens ?? []).map((m) => ({ chave: m.chave, rotulo: m.rotulo, valor: m.total, texto: `${m.total} (${formatarPercentual(m.percentual)})` })))
  protected readonly whatsapp = computed(() => resumoWhatsappImprimivel(this.c.dados()?.whatsapp ?? { cartoes: ZERO_ZAP, primeiraResposta: [], porDia: [] }))
  protected readonly mensagensPorDia = computed(() =>
    this.whatsapp().dias.map((d) => ({ chave: d.dia, rotulo: rotuloDoDia(d.dia), valor: d.recebidas })))

  ngOnInit(): void { void this.c.carregar() }

  protected carregar(): Promise<void> { return this.c.carregar() }
  protected alternar(s: SecaoImprimivel): void { this.ativas.set(alternarSecao(this.ativas(), s)) }
  protected rotulo(s: SecaoImprimivel): string { return ROTULO_SECAO[s] }
  protected autor(a: 'humano' | 'automatico'): string { return ROTULO_AUTOR[a] }
  protected duracao(s: number | null): string { return formatarDuracaoSeg(s) }
  protected imprimir(): void { window.print() }
}

const ZERO_ZAP = {
  recebidas: 0, enviadas: 0, enviadasHumanas: 0, enviadasAutomaticas: 0, falhas: 0, conversasIniciadas: 0, atendimentos: 0,
  respondidasNoLimite: 0, pctNoLimite: null,
}
