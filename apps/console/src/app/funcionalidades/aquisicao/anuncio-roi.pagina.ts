import { Component, ChangeDetectionStrategy, inject, input, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, EsqueletoComponente, EstadoComponente,
  FiltroPeriodoComponente, SelectComponente, StatCardComponente, type ItemTrilha, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'

type Modelo = 'primeiro_toque' | 'ultimo_toque'

interface Roi {
  readonly anuncio: { readonly id: string; readonly nome: string; readonly estado: string; readonly campanha: string }
  readonly periodo: { readonly de: string; readonly ate: string }
  readonly custoCentavos: number
  readonly impressoes: number
  readonly cliques: number
  readonly leads: number
  readonly custoPorLeadCentavos: number | null
  readonly atribuicao: {
    readonly modelo: Modelo
    readonly janelaDias: number
    readonly vendas: number
    readonly receitaCentavos: number
    readonly roas: number | null
  }
  readonly semAmbiguidade: {
    readonly vendas: number
    readonly receitaCentavos: number
    readonly roas: number | null
  }
}

type Estado = 'carregando' | 'pronto' | 'nao_encontrado' | 'sem_permissao' | 'erro'

const OPCOES_MODELO: OpcaoSelect[] = [
  { valor: 'ultimo_toque', rotulo: 'Último toque' },
  { valor: 'primeiro_toque', rotulo: 'Primeiro toque' },
]

/**
 * ROI da veiculação (AQ-16) — quanto o anúncio custou e quanto fez faturar.
 *
 * ⚠️ **A tela existe para separar FATO de MODELO, e a separação é visual, não uma
 * nota de rodapé.** Custo, cliques e leads são fatos: vieram da plataforma e da
 * origem registrada na entrada. Receita atribuída é modelo — ligar uma venda de
 * semanas depois a um anúncio é sempre uma escolha. Misturar os dois no mesmo
 * bloco emprestaria ao segundo a credibilidade do primeiro.
 *
 * ⚠️ **E o número que mais importa não é o ROAS: é a DISTÂNCIA entre o ROAS
 * atribuído e o sem ambiguidade.** Perto, o número se sustenta. Longe, ele é
 * artefato da modelagem — e o cliente merece saber disso antes de assinar
 * performance em cima.
 *
 * Padrão Detalhe: trilha, cabeçalho do anúncio, filtro de período com modelo e
 * janela, e três blocos (fato, modelo, sem ambiguidade).
 */
@Component({
  selector: 'app-anuncio-roi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, EsqueletoComponente, EstadoComponente,
    FiltroPeriodoComponente, RouterLink, SelectComponente, StatCardComponente,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="dados()?.anuncio?.nome ?? 'Anúncio'" [subtitulo]="dados()?.anuncio?.campanha ?? ''">
      <ui-breadcrumb trilha [itens]="trilha()" />
      @if (dados(); as d) {
        @if (d.anuncio.estado !== 'ativa') { <ui-badge tom="neutro">{{ d.anuncio.estado }}</ui-badge> }
      }
    </ui-cabecalho-tela>

    <div class="corpo">
      <ui-filtro-periodo [(inicio)]="de" [(fim)]="ate" (aplicar)="carregar()">
        <ui-select rotulo="Modelo de atribuição" [opcoes]="opcoesModelo" [valor]="modelo()"
          (valorChange)="modelo.set($event === 'primeiro_toque' ? 'primeiro_toque' : 'ultimo_toque')" />
        <ui-campo rotulo="Janela (dias)" tipo="number" [valor]="janelaTexto()" (valorChange)="janelaTexto.set($event)"
          dica="De 1 a 90 dias." />
      </ui-filtro-periodo>

      @switch (estado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true">
            <ui-esqueleto altura="120px" />
            <ui-esqueleto altura="120px" />
          </div>
        }
        @case ('nao_encontrado') {
          <ui-estado titulo="Este anúncio não existe mais" descricao="Ele pode ter sido removido na plataforma ou o link está velho.">
            <a class="btn btn--secundario" routerLink="/aquisicao/midia">Voltar para a lista</a>
          </ui-estado>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à mídia paga" descricao="Sua conta não tem permissão para ver a mídia." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o ROI deste anúncio" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (dados(); as d) {
            <!-- FATOS — o que veio medido, sem interpretação nossa. -->
            <section class="painel">
              <h2 class="titulo-secao">O que aconteceu <ui-badge tom="sucesso">medido</ui-badge></h2>
              <div class="grade">
                <ui-stat-card rotulo="Investido" [valor]="dinheiro(d.custoCentavos)" />
                <ui-stat-card rotulo="Impressões" [valor]="d.impressoes" />
                <ui-stat-card rotulo="Cliques" [valor]="d.cliques" />
                <ui-stat-card rotulo="Leads no CRM" [valor]="d.leads" />
                <!-- ⚠️ Traço, não R$ 0,00: zero lead não é custo-por-lead zero, é
                     indefinido — e R$ 0,00 faria o pior anúncio parecer o melhor. -->
                <ui-stat-card rotulo="Custo por lead" tom="acao"
                  [valor]="d.custoPorLeadCentavos === null ? '—' : dinheiro(d.custoPorLeadCentavos)" />
              </div>
            </section>

            <!-- MODELO — separado de propósito, com o rótulo colado no número. -->
            <section class="painel">
              <h2 class="titulo-secao">O que atribuímos a ele
                <ui-badge tom="atencao">{{ rotuloModelo(d.atribuicao.modelo) }} · {{ d.atribuicao.janelaDias }} dias</ui-badge>
              </h2>
              <div class="grade">
                <ui-stat-card rotulo="Vendas" [valor]="d.atribuicao.vendas" />
                <ui-stat-card rotulo="Receita atribuída" [valor]="dinheiro(d.atribuicao.receitaCentavos)" />
                <ui-stat-card tom="acao" [rotulo]="'ROAS (' + rotuloModelo(d.atribuicao.modelo) + ', ' + d.atribuicao.janelaDias + 'd)'"
                  [valor]="d.atribuicao.roas === null ? '—' : (d.atribuicao.roas.toFixed(1) + '×')" />
              </div>
              <p class="nota">Uma venda de semanas depois é ligada ao anúncio por um <strong>modelo</strong>,
                nunca por um vínculo registrado. Por isso o modelo e a janela andam colados ao número.</p>
            </section>

            <!-- A distância entre os dois é o que diz se o ROAS se sustenta. -->
            <section class="painel">
              <h2 class="titulo-secao">Sem depender do modelo <ui-badge tom="sucesso">contatos de um toque só</ui-badge></h2>
              <div class="grade">
                <ui-stat-card rotulo="Vendas" [valor]="d.semAmbiguidade.vendas" />
                <ui-stat-card rotulo="Receita" [valor]="dinheiro(d.semAmbiguidade.receitaCentavos)" />
                <ui-stat-card rotulo="ROAS" tom="acao"
                  [valor]="d.semAmbiguidade.roas === null ? '—' : (d.semAmbiguidade.roas.toFixed(1) + '×')" />
              </div>
              @if (leitura(); as l) {
                <p class="nota" [class.alerta]="l.longe">{{ l.texto }}</p>
              }
            </section>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .esqueletos { display: grid; gap: var(--espacamento-3); }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .titulo-secao { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap;
      margin: 0 0 var(--espacamento-4); font-size: 15px; color: var(--texto); }
    /* auto-fit: de 320px a wide sem media query e sem coluna espremida. */
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--espacamento-3); }
    .nota { margin: var(--espacamento-4) 0 0; font-size: 12px; color: var(--texto-suave); line-height: 1.5; }
    .nota.alerta { color: var(--atencao); }
  `,
})
export class AnuncioRoiPagina implements OnInit {
  /** Vem da rota (`withComponentInputBinding`). */
  readonly id = input.required<string>()

  readonly #http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly dados = signal<Roi | null>(null)
  protected readonly opcoesModelo = OPCOES_MODELO

  readonly de = signal(this.#diasAtras(30))
  readonly ate = signal(this.#diasAtras(0))
  readonly modelo = signal<Modelo>('ultimo_toque')
  /** Texto do campo; a janela efetiva é `janela()`, limitada a 1–90 dias. */
  readonly janelaTexto = signal('14')
  readonly janela = computed(() => Math.min(90, Math.max(1, Math.trunc(Number(this.janelaTexto())) || 14)))

  protected readonly trilha = computed<ItemTrilha[]>(() => [
    { rotulo: 'Mídia paga', rota: '/aquisicao/midia' },
    { rotulo: this.dados()?.anuncio?.nome ?? 'Anúncio' },
  ])

  /**
   * ⚠️ A leitura que a tela existe para dar. O ROAS sozinho não diz se dá para
   * confiar nele; a distância para o número sem ambiguidade diz.
   */
  readonly leitura = computed(() => {
    const d = this.dados()
    if (!d) return null
    const a = d.atribuicao.roas
    const s = d.semAmbiguidade.roas
    if (a === null) {
      return { longe: false, texto: 'Ainda não há venda atribuída neste período — sem receita, não há ROAS a comparar.' }
    }
    if (s === null || d.semAmbiguidade.vendas === 0) {
      return {
        longe: true,
        texto: 'Todas as vendas vieram de contatos com mais de um toque de mídia: este ROAS depende inteiramente '
          + 'da escolha de modelo. Trate-o como estimativa, não como medida.',
      }
    }
    // 30% de diferença: acima disso o modelo está fazendo o trabalho pesado.
    const longe = Math.abs(a - s) / Math.max(a, s) > 0.3
    return {
      longe,
      texto: longe
        ? `Distância grande entre ${a.toFixed(1)}× (modelo) e ${s.toFixed(1)}× (sem ambiguidade): boa parte deste `
          + 'ROAS é artefato da modelagem. Vale olhar os dois antes de decidir orçamento.'
        : `Os dois números andam juntos (${a.toFixed(1)}× e ${s.toFixed(1)}×): o ROAS se sustenta sem depender do modelo.`,
    }
  })

  ngOnInit(): void { void this.carregar() }

  rotuloModelo(m: Modelo): string {
    return m === 'primeiro_toque' ? 'Primeiro toque' : 'Último toque'
  }

  dinheiro(centavos: number): string {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    const q = new URLSearchParams({
      de: this.de(), ate: this.ate(), modelo: this.modelo(), janelaDias: String(this.janela()),
    })
    try {
      const r = await firstValueFrom(
        this.#http.get<Roi>(`/v1/aquisicao/anuncios/${this.id()}/roi?${q.toString()}`))
      this.dados.set(r)
      this.estado.set('pronto')
    } catch (e) {
      const st = e instanceof HttpErrorResponse ? e.status : 0
      // ⚠️ 404 é estado PRÓPRIO, não "erro": não adianta oferecer "tentar de
      //    novo" para um anúncio que não existe mais.
      this.estado.set(st === 404 ? 'nao_encontrado' : st === 403 ? 'sem_permissao' : 'erro')
    }
  }

  #diasAtras(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  }
}
