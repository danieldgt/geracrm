import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Conta {
  readonly id: string
  readonly plataforma: string
  readonly idExterno: string
  readonly nome: string
  readonly moeda: string
  readonly ativo: boolean
}
interface Anuncio {
  readonly id: string
  readonly nome: string
  readonly estado: string
  readonly campanha: string
  readonly custoCentavos: string
  readonly cliques: number
  readonly impressoes: number
  readonly leads: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Mídia paga (AQ-06) — custo e leads por anúncio.
 *
 * ⚠️ **Custo por lead é o número que a tela existe para mostrar**, e não CPL da
 * plataforma: é o nosso custo dividido pelos leads que ENTRARAM no CRM. A
 * diferença entre os dois é justamente o que a operação enxerga e o painel do
 * Google não.
 *
 * ⚠️ ROAS **não aparece aqui de propósito.** Ele exige declarar o modelo de
 * atribuição e a janela (AMK-009), e um número desses solto numa lista viraria
 * promessa que o produto não sustenta. Vive na tela do anúncio, com o rótulo ao
 * lado.
 */
@Component({
  selector: 'app-midia',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <h1>Mídia paga</h1>
      <p class="sub">O que cada anúncio custou e quantos leads trouxe, no período.</p>
    </header>

    <form class="filtros" (submit)="$event.preventDefault(); carregar()">
      <label>De <input type="date" [value]="de()" (change)="de.set($any($event.target).value)" /></label>
      <label>Até <input type="date" [value]="ate()" (change)="ate.set($any($event.target).value)" /></label>
      <button class="btn btn--secundario" type="submit">Aplicar</button>
    </form>

    @if (contas().length > 0) {
      <ul class="contas">
        @for (c of contas(); track c.id) {
          <li class="conta">
            <span class="nome">{{ c.nome }}</span>
            <span class="dado">{{ c.plataforma }} · {{ c.idExterno }} · {{ c.moeda }}</span>
            @if (!c.ativo) { <span class="badge">inativa</span> }
          </li>
        }
      </ul>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="bloco"><div class="esqueleto"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2>Sem acesso</h2>
        <p>Sua conta não tem permissão para ver a mídia.</p></div> }
      @case ('erro') { <div class="bloco aviso"><h2>Não foi possível carregar</h2>
        <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco vazio">
            <h2>Nenhum anúncio no período</h2>
            <!-- ⚠️ Vazio aqui quase nunca é "não há dado": é conta não conectada
                 ou sincronização que ainda não rodou. Dizer isso evita a leitura
                 errada de que a campanha não gastou nada. -->
            <p>Se a conta acabou de ser conectada, a primeira sincronização pode levar algumas horas.</p>
          </div>
        } @else {
          <table class="tabela">
            <thead>
              <tr>
                <th>Anúncio</th><th>Campanha</th>
                <th class="num">Impressões</th><th class="num">Cliques</th>
                <th class="num">Custo</th><th class="num">Leads</th>
                <th class="num">Custo/lead</th>
              </tr>
            </thead>
            <tbody>
              @for (a of itens(); track a.id) {
                <tr>
                  <td>{{ a.nome }} @if (a.estado !== 'ativa') { <span class="badge">{{ a.estado }}</span> }</td>
                  <td class="suave">{{ a.campanha }}</td>
                  <td class="num">{{ a.impressoes }}</td>
                  <td class="num">{{ a.cliques }}</td>
                  <td class="num">{{ dinheiro(a.custoCentavos) }}</td>
                  <td class="num">{{ a.leads }}</td>
                  <!-- ⚠️ Traço, não "R$ 0,00", quando não há lead: zero lead com
                       custo não é custo-por-lead zero — é indefinido. -->
                  <td class="num forte">{{ custoPorLead(a) }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4">Total</td>
                <td class="num">{{ dinheiro(totalCusto()) }}</td>
                <td class="num">{{ totalLeads() }}</td>
                <td class="num forte">{{ custoPorLeadTotal() }}</td>
              </tr>
            </tfoot>
          </table>
          @if (temMais()) { <button class="btn btn--secundario mais" (click)="carregarMais()">Carregar mais</button> }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .filtros { display: flex; gap: var(--espacamento-3); align-items: end; margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .filtros label { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .filtros input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .contas { list-style: none; display: flex; gap: var(--espacamento-3); flex-wrap: wrap; margin: 0 0 var(--espacamento-4); padding: 0; }
    .conta { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .conta .nome { font-size: 13px; color: var(--texto); }
    .conta .dado { font-size: 11px; color: var(--texto-suave); font-family: var(--tipografia-familia-dados, monospace); }
    .badge { font-size: 11px; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: 0 var(--espacamento-1); margin-left: var(--espacamento-1); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .esqueleto { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); }
    .tabela { width: 100%; border-collapse: collapse; border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    th, td { padding: var(--espacamento-2) var(--espacamento-3); text-align: left; font-size: 13px; border-bottom: 1px solid var(--borda); }
    th { color: var(--texto-secundario); font-weight: 500; font-size: 12px; }
    td { color: var(--texto); }
    td.suave { color: var(--texto-suave); }
    /* ⚠️ tabular-nums: sem isso, coluna de dinheiro não alinha e o olho não compara. */
    .num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--tipografia-familia-dados, monospace); }
    .forte { color: var(--texto); font-weight: 600; }
    tfoot td { border-bottom: none; border-top: 1px solid var(--borda-forte); color: var(--texto-secundario); }
    .mais { margin-top: var(--espacamento-3); }
  `,
})
export class MidiaPagina implements OnInit {
  readonly #http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly contas = signal<readonly Conta[]>([])
  readonly itens = signal<readonly Anuncio[]>([])
  readonly temMais = signal(false)
  readonly #cursor = signal<string | null>(null)

  readonly de = signal(this.#diasAtras(30))
  readonly ate = signal(this.#diasAtras(0))

  readonly totalCusto = computed(() =>
    // ⚠️ String → Number aqui, e não somando strings: `custoCentavos` vem como
    //    texto porque é bigint no banco (INV-46). "2" + "3" seria "23".
    String(this.itens().reduce((s, a) => s + Number(a.custoCentavos), 0)))
  readonly totalLeads = computed(() => this.itens().reduce((s, a) => s + a.leads, 0))

  ngOnInit(): void { void this.carregar() }

  #diasAtras(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  }

  dinheiro(centavos: string | number): string {
    return (Number(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  /** ⚠️ Traço quando não há lead: zero lead não é custo-por-lead zero, é indefinido. */
  custoPorLead(a: Anuncio): string {
    return a.leads > 0 ? this.dinheiro(Number(a.custoCentavos) / a.leads) : '—'
  }
  custoPorLeadTotal(): string {
    const l = this.totalLeads()
    return l > 0 ? this.dinheiro(Number(this.totalCusto()) / l) : '—'
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.#cursor.set(null)
    try {
      const c = await firstValueFrom(
        this.#http.get<{ contas: Conta[] }>('/v1/aquisicao/contas'))
      this.contas.set(c.contas)
      const r = await this.#buscarPagina(null)
      this.itens.set(r.itens)
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    try {
      const r = await this.#buscarPagina(this.#cursor())
      this.itens.update((atual) => [...atual, ...r.itens])
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
    } catch { this.estado.set('erro') }
  }

  #buscarPagina(cursor: string | null): Promise<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }> {
    const q = new URLSearchParams({ de: this.de(), ate: this.ate() })
    if (cursor) q.set('cursor', cursor)
    return firstValueFrom(
      this.#http.get<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }>(
        `/v1/aquisicao/anuncios?${q.toString()}`))
  }
}
