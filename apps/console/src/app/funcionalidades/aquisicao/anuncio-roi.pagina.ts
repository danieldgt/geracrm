import { Component, ChangeDetectionStrategy, inject, input, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'

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
 */
@Component({
  selector: 'app-anuncio-roi',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <a class="voltar" routerLink="/midia">← Mídia paga</a>
        <h1>{{ dados()?.anuncio?.nome ?? 'Anúncio' }}</h1>
        @if (dados(); as d) {
          <p class="sub">{{ d.anuncio.campanha }}
            @if (d.anuncio.estado !== 'ativa') { <span class="badge">{{ d.anuncio.estado }}</span> }
          </p>
        }
      </div>
    </header>

    <form class="filtros" (submit)="$event.preventDefault(); carregar()">
      <label>De <input type="date" [value]="de()" (change)="de.set($any($event.target).value)" /></label>
      <label>Até <input type="date" [value]="ate()" (change)="ate.set($any($event.target).value)" /></label>
      <label>Modelo de atribuição
        <select [value]="modelo()" (change)="modelo.set($any($event.target).value)">
          <option value="ultimo_toque">Último toque</option>
          <option value="primeiro_toque">Primeiro toque</option>
        </select>
      </label>
      <label>Janela (dias)
        <input type="number" min="1" max="90" [value]="janela()"
               (change)="janela.set(+$any($event.target).value)" />
      </label>
      <button class="btn btn--secundario" type="submit">Aplicar</button>
    </form>

    @switch (estado()) {
      @case ('carregando') {
        <div class="bloco" aria-busy="true"><div class="esqueleto"></div><div class="esqueleto"></div></div>
      }
      @case ('nao_encontrado') {
        <div class="bloco aviso">
          <h2>Este anúncio não existe mais</h2>
          <p>Ele pode ter sido removido na plataforma ou o link está velho.</p>
          <a class="btn btn--secundario" routerLink="/midia">Voltar para a lista</a>
        </div>
      }
      @case ('sem_permissao') {
        <div class="bloco aviso"><h2>Sem acesso</h2>
          <p>Sua conta não tem permissão para ver a mídia.</p></div>
      }
      @case ('erro') {
        <div class="bloco aviso"><h2>Não foi possível carregar</h2>
          <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div>
      }
      @case ('pronto') {
        @if (dados(); as d) {
          <!-- FATOS — o que veio medido, sem interpretação nossa. -->
          <section class="painel">
            <h2 class="titulo-secao">O que aconteceu <span class="etiqueta fato">medido</span></h2>
            <div class="grade">
              <div class="kpi"><span class="rot">Investido</span><span class="val">{{ dinheiro(d.custoCentavos) }}</span></div>
              <div class="kpi"><span class="rot">Impressões</span><span class="val">{{ d.impressoes }}</span></div>
              <div class="kpi"><span class="rot">Cliques</span><span class="val">{{ d.cliques }}</span></div>
              <div class="kpi"><span class="rot">Leads no CRM</span><span class="val">{{ d.leads }}</span></div>
              <!-- ⚠️ Traço, não R$ 0,00: zero lead não é custo-por-lead zero, é
                   indefinido — e R$ 0,00 faria o pior anúncio parecer o melhor. -->
              <div class="kpi"><span class="rot">Custo por lead</span>
                <span class="val forte">{{ d.custoPorLeadCentavos === null ? '—' : dinheiro(d.custoPorLeadCentavos) }}</span>
              </div>
            </div>
          </section>

          <!-- MODELO — separado de propósito, com o rótulo colado no número. -->
          <section class="painel">
            <h2 class="titulo-secao">O que atribuímos a ele
              <span class="etiqueta modelo">{{ rotuloModelo(d.atribuicao.modelo) }} · {{ d.atribuicao.janelaDias }} dias</span>
            </h2>
            <div class="grade">
              <div class="kpi"><span class="rot">Vendas</span><span class="val">{{ d.atribuicao.vendas }}</span></div>
              <div class="kpi"><span class="rot">Receita atribuída</span><span class="val">{{ dinheiro(d.atribuicao.receitaCentavos) }}</span></div>
              <div class="kpi"><span class="rot">ROAS ({{ rotuloModelo(d.atribuicao.modelo) }}, {{ d.atribuicao.janelaDias }}d)</span>
                <span class="val forte">{{ d.atribuicao.roas === null ? '—' : (d.atribuicao.roas.toFixed(1) + '×') }}</span>
              </div>
            </div>
            <p class="nota">Uma venda de semanas depois é ligada ao anúncio por um <strong>modelo</strong>,
              nunca por um vínculo registrado. Por isso o modelo e a janela andam colados ao número.</p>
          </section>

          <!-- A distância entre os dois é o que diz se o ROAS se sustenta. -->
          <section class="painel">
            <h2 class="titulo-secao">Sem depender do modelo <span class="etiqueta fato">contatos de um toque só</span></h2>
            <div class="grade">
              <div class="kpi"><span class="rot">Vendas</span><span class="val">{{ d.semAmbiguidade.vendas }}</span></div>
              <div class="kpi"><span class="rot">Receita</span><span class="val">{{ dinheiro(d.semAmbiguidade.receitaCentavos) }}</span></div>
              <div class="kpi"><span class="rot">ROAS</span>
                <span class="val forte">{{ d.semAmbiguidade.roas === null ? '—' : (d.semAmbiguidade.roas.toFixed(1) + '×') }}</span>
              </div>
            </div>
            @if (leitura(); as l) {
              <p class="nota" [class.alerta]="l.longe">{{ l.texto }}</p>
            }
          </section>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    .voltar { display: inline-block; margin-bottom: var(--espacamento-2); font-size: 13px; color: var(--acao); text-decoration: none; }
    .voltar:hover { text-decoration: underline; }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .badge { margin-left: var(--espacamento-2); font-size: 11px; padding: 1px 6px; border-radius: var(--raio-controle);
      border: 1px solid var(--borda); color: var(--texto-suave); }
    .filtros { display: flex; gap: var(--espacamento-3); align-items: end; margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .filtros label { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .filtros input, .filtros select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .bloco.aviso { text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { color: var(--texto-secundario); margin: 0 auto var(--espacamento-4); max-width: 44ch; }
    .esqueleto { height: 56px; margin-bottom: var(--espacamento-3); background: var(--superficie); border-radius: var(--raio-controle); }
    .painel { padding: var(--espacamento-4); margin-bottom: var(--espacamento-4); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .titulo-secao { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap;
      margin: 0 0 var(--espacamento-4); font-size: 15px; color: var(--texto); }
    .etiqueta { font-size: 11px; font-weight: 400; padding: 1px 8px; border-radius: var(--raio-completo); border: 1px solid var(--borda); }
    .etiqueta.fato { color: var(--sucesso); border-color: var(--sucesso); }
    .etiqueta.modelo { color: var(--atencao); border-color: var(--atencao); }
    /* auto-fit: de 320px a wide sem media query e sem coluna espremida. */
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--espacamento-4); }
    .kpi { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .rot { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); }
    .val { font-size: 20px; color: var(--texto); font-variant-numeric: tabular-nums;
      overflow: hidden; text-overflow: ellipsis; }
    .val.forte { font-weight: 600; }
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

  readonly de = signal(this.#diasAtras(30))
  readonly ate = signal(this.#diasAtras(0))
  readonly modelo = signal<Modelo>('ultimo_toque')
  readonly janela = signal(14)

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
