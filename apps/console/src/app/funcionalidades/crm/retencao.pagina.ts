import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Bucket { readonly estado: string; readonly contatos: number; readonly receitaCentavos: number }
interface Retencao { readonly config: { diasAtivo: number; diasInativo: number }; readonly buckets: Bucket[]; readonly totalContatos: number }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const ROTULOS: Record<string, { nome: string; acao: string; token: string }> = {
  ativo:      { nome: 'Ativos',    acao: 'Comprando no ritmo — mantenha o relacionamento.', token: 'var(--rfv-campeao)' },
  inativo:    { nome: 'Inativos',  acao: 'Passaram do ritmo — hora de reativar antes de perder.', token: 'var(--rfv-em-risco)' },
  perdido:    { nome: 'Perdidos',  acao: 'Sumidos há tempo — campanha de resgate ou aceitar a perda.', token: 'var(--rfv-perdido)' },
  sem_compra: { nome: 'Sem compra', acao: 'Cadastrados que nunca compraram — primeira venda.', token: 'var(--texto-suave)' },
}
const ORDEM = ['ativo', 'inativo', 'perdido', 'sem_compra']

/**
 * Retenção — o funil de recompra (ciclo de vida). A base distribuída em
 * Ativo/Inativo/Perdido/Sem compra, com a fronteira em dias CONFIGURÁVEL pelo
 * dono do negócio. Segue geracrm-layout-ui (5 estados, tokens, responsivo).
 */
@Component({
  selector: 'app-retencao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Retenção</h1>
        <p class="sub">Onde sua base está no ciclo de recompra — e quem está indo embora.</p>
      </div>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="funil"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as r) {
          <form class="config" (submit)="salvar($event)">
            <span class="cfg-txt">Ativo até</span>
            <input type="number" min="1" [value]="ativo()" (input)="ativo.set(+$any($event.target).value)" aria-label="Dias para ativo" />
            <span class="cfg-txt">dias · Inativo até</span>
            <input type="number" min="2" [value]="inativo()" (input)="inativo.set(+$any($event.target).value)" aria-label="Dias para inativo" />
            <span class="cfg-txt">dias · acima = Perdido</span>
            @if (mudou()) { <button class="primario" type="submit" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Aplicar' }}</button> }
            @if (erroCfg()) { <span class="erro">{{ erroCfg() }}</span> }
          </form>

          @if (r.totalContatos === 0) {
            <div class="bloco"><h2 class="txt-secao">Sem base ainda</h2><p>O funil aparece quando houver contatos.</p></div>
          } @else {
            <div class="funil">
              @for (b of ordenados(); track b.estado) {
                <section class="etapa" [style.--c]="rotulo(b.estado).token">
                  <div class="etapa-topo">
                    <span class="ponto"></span>
                    <strong class="etapa-nome">{{ rotulo(b.estado).nome }}</strong>
                  </div>
                  <span class="etapa-qtd txt-kpi">{{ b.contatos }}</span>
                  <span class="etapa-pct txt-dados">{{ pct(b.contatos, r.totalContatos) }}% · {{ reais(b.receitaCentavos) }}</span>
                  <div class="barra"><span class="fill" [style.width.%]="pct(b.contatos, maxBucket())"></span></div>
                  <p class="etapa-acao">{{ rotulo(b.estado).acao }}</p>
                </section>
              }
            </div>
            <p class="dica">Quer agir sobre um grupo? Veja os <a routerLink="/segmentos">segmentos RFV</a> ou monte uma <a routerLink="/campanhas">campanha</a>.</p>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 960px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .config { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; margin-bottom: var(--espacamento-4); padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .cfg-txt { font-size: 13px; color: var(--texto-secundario); }
    .config input { width: 64px; padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; text-align: center; }
    .primario { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; cursor: pointer; }
    .primario:disabled { opacity: .6; cursor: default; }
    .erro { color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .funil { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); }
    .esq { height: 160px; border-radius: var(--raio-painel); background: var(--superficie); }
    .etapa { display: flex; flex-direction: column; gap: var(--espacamento-1); padding: var(--espacamento-4); border: 1px solid var(--borda); border-top: 3px solid var(--c); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .etapa-topo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); background: var(--c); flex: none; }
    .etapa-nome { color: var(--texto); font-size: 14px; }
    .etapa-qtd { color: var(--texto); }
    .etapa-pct { color: var(--texto-suave); font-size: 12px; }
    .barra { height: 5px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; margin: var(--espacamento-1) 0; }
    .fill { display: block; height: 100%; background: var(--c); }
    .etapa-acao { margin: var(--espacamento-1) 0 0; font-size: 12px; color: var(--texto-secundario); line-height: 1.4; }
    .dica { margin-top: var(--espacamento-4); font-size: 13px; color: var(--texto-suave); }
    .dica a { color: var(--acao); }
  `,
})
export class RetencaoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Retencao | null>(null)
  readonly ativo = signal(30); readonly inativo = signal(90)
  readonly salvando = signal(false); readonly erroCfg = signal<string | null>(null)

  readonly mudou = computed(() => {
    const cfg = this.d()?.config
    return !!cfg && (cfg.diasAtivo !== this.ativo() || cfg.diasInativo !== this.inativo())
  })
  readonly ordenados = computed(() => {
    const b = this.d()?.buckets ?? []
    return [...b].sort((x, y) => ORDEM.indexOf(x.estado) - ORDEM.indexOf(y.estado))
  })

  ngOnInit(): void { void this.carregar() }
  rotulo(estado: string) { return ROTULOS[estado] ?? { nome: estado, acao: '', token: 'var(--texto-suave)' } }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  pct(n: number, total: number): number { return total > 0 ? Math.round((n / total) * 100) : 0 }
  maxBucket(): number { return Math.max(1, ...(this.d()?.buckets.map((b) => b.contatos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Retencao>('/v1/retencao'))
      this.d.set(r)
      this.ativo.set(r.config.diasAtivo); this.inativo.set(r.config.diasInativo)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    if (this.inativo() <= this.ativo() || this.ativo() < 1) { this.erroCfg.set('Inativo tem de ser maior que Ativo.'); return }
    this.salvando.set(true); this.erroCfg.set(null)
    try {
      await firstValueFrom(this.http.put('/v1/retencao/config', { diasAtivo: this.ativo(), diasInativo: this.inativo() }))
      await this.carregar()
    } catch { this.erroCfg.set('Não foi possível salvar.') } finally { this.salvando.set(false) }
  }
}
