import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, StatCardComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela, type TomStat,
} from '../../compartilhado/ui/index.js'

interface Mercado {
  readonly total: number
  readonly cobertura: { comWhatsapp: number; comTelefone: number; comErp: number; optOut: number; jaCompraram: number }
  readonly porOrigem: { origem: string; contatos: number }[]
  /** `true` quando há mais origens que as 30 listadas. */
  readonly porOrigemTruncado: boolean
  readonly rfv: { codigo: string; rotulo: string; urgencia: number; contatos: number }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Visão de Mercado — a fotografia da base: tamanho, o quanto é acionável
 * (WhatsApp, telefone, ERP, opt-out) e onde está no RFV. Leitura pura.
 * Padrão Lista de leitura: indicadores em ui-stat-card e as distribuições em
 * ui-tabela com barra de proporção na célula.
 */
@Component({
  selector: 'app-mercado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, RouterLink, StatCardComponente, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Visão de Mercado" subtitulo="Sua base em números: tamanho, alcance e composição." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="kpis" aria-busy="true">
            <ui-esqueleto altura="96px" />
            <ui-esqueleto altura="96px" />
            <ui-esqueleto altura="96px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à visão de mercado" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a visão de mercado" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as m) {
            @if (m.total === 0) {
              <ui-estado titulo="Base vazia" descricao="Importe clientes do ERP ou cadastre para ver a composição." />
            } @else {
              <ui-stat-card rotulo="Base ativa · contatos" tom="acao" [valor]="m.total" />

              <h2 class="txt-secao secao">O quanto dá para agir</h2>
              <div class="cob">
                @for (c of cobertura(m); track c.chave) {
                  <ui-stat-card [rotulo]="c.rotulo + ' · ' + pct(c.n, m.total) + '% da base'" [valor]="c.n" [tom]="c.tom" />
                }
              </div>

              <div class="duas">
                <section class="painel" aria-labelledby="titulo-origem">
                  <h2 class="txt-secao" id="titulo-origem">De onde vieram</h2>
                  <ui-tabela [colunas]="colunasOrigem" [linhas]="linhasOrigem()" [chaveLinha]="chaveOrigem">
                    <ng-template uiCelula="contatos" let-o>
                      <span class="barra-val">
                        <span class="l-barra" aria-hidden="true"><span class="l-fill" [style.width.%]="pct(o.contatos, maxOrigem())"></span></span>
                        <span class="l-val txt-dados">{{ o.contatos }}</span>
                      </span>
                    </ng-template>
                  </ui-tabela>
                  @if (m.porOrigemTruncado) {
                    <p class="corte">Mostrando as 30 maiores origens; há mais origens fora desta lista.</p>
                  }
                </section>

                <section class="painel" aria-labelledby="titulo-rfv">
                  <h2 class="txt-secao" id="titulo-rfv">Onde estão no RFV</h2>
                  <ui-tabela [colunas]="colunasRfv" [linhas]="linhasRfv()" [chaveLinha]="chaveRfv">
                    <ng-template uiCelula="segmento" let-s>
                      <span class="segmento"><span class="ponto" aria-hidden="true" [style.background]="cor(s.codigo)"></span>{{ s.rotulo }}</span>
                    </ng-template>
                    <ng-template uiCelula="contatos" let-s>
                      <span class="barra-val">
                        <span class="l-barra" aria-hidden="true"><span class="l-fill" [style.width.%]="pct(s.contatos, maxRfv())" [style.background]="cor(s.codigo)"></span></span>
                        <span class="l-val txt-dados">{{ s.contatos }}</span>
                      </span>
                    </ng-template>
                  </ui-tabela>
                  <a class="mais-link" routerLink="/segmentos">Ver segmentos em detalhe →</a>
                </section>
              </div>
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .secao { margin: var(--espacamento-3) 0 0; }
    .cob { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--espacamento-3); }
    .duas { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: var(--espacamento-4); align-items: start; min-width: 0; }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .barra-val { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 120px; }
    .segmento { display: inline-flex; align-items: center; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); flex: none; }
    .l-barra { flex: 1; height: 4px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .l-fill { display: block; height: 100%; background: var(--acao); }
    .l-val { color: var(--texto-secundario); font-size: 12px; min-width: 32px; text-align: right; }
    .mais-link { display: inline-block; margin-top: var(--espacamento-3); font-size: 13px; color: var(--acao); text-decoration: none; }
    .mais-link:hover { text-decoration: underline; }
    .corte { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
  `,
})
export class MercadoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Mercado | null>(null)

  protected readonly colunasOrigem: readonly ColunaTabela[] = [
    { chave: 'origem', rotulo: 'Origem' },
    { chave: 'contatos', rotulo: 'Contatos' },
  ]
  protected readonly colunasRfv: readonly ColunaTabela[] = [
    { chave: 'segmento', rotulo: 'Segmento' },
    { chave: 'contatos', rotulo: 'Contatos' },
  ]
  protected readonly linhasOrigem = computed<LinhaTabela[]>(() => (this.d()?.porOrigem ?? []).map((o) => ({
    origem: this.rotuloOrigem(o.origem), chaveOrigem: o.origem, contatos: o.contatos,
  })))
  protected readonly linhasRfv = computed<LinhaTabela[]>(() => (this.d()?.rfv ?? []).map((s) => ({
    segmento: s.rotulo, codigo: s.codigo, contatos: s.contatos,
  })))
  protected readonly chaveOrigem = (l: LinhaTabela): string => String(l['chaveOrigem'])
  protected readonly chaveRfv = (l: LinhaTabela): string => String(l['codigo'])

  ngOnInit(): void { void this.carregar() }
  pct(n: number, total: number): number { return total > 0 ? Math.round((n / total) * 100) : 0 }
  cor(codigo: string): string { return `var(--rfv-${codigo})` }
  maxOrigem(): number { return Math.max(1, ...(this.d()?.porOrigem.map((o) => o.contatos) ?? [])) }
  maxRfv(): number { return Math.max(1, ...(this.d()?.rfv.map((s) => s.contatos) ?? [])) }

  cobertura(m: Mercado): { chave: string; rotulo: string; n: number; tom: TomStat }[] {
    return [
      { chave: 'zap', rotulo: 'Com WhatsApp', n: m.cobertura.comWhatsapp, tom: 'neutro' },
      { chave: 'tel', rotulo: 'Com telefone', n: m.cobertura.comTelefone, tom: 'neutro' },
      { chave: 'erp', rotulo: 'Vindos do ERP', n: m.cobertura.comErp, tom: 'neutro' },
      { chave: 'compra', rotulo: 'Já compraram', n: m.cobertura.jaCompraram, tom: 'neutro' },
      { chave: 'optout', rotulo: 'Opt-out', n: m.cobertura.optOut, tom: 'atencao' },
    ]
  }
  rotuloOrigem(o: string): string {
    const mapa: Record<string, string> = { erp: 'ERP (carga)', whatsapp: 'WhatsApp', instagram: 'Instagram', manual: 'Cadastro manual', importacao: 'Importação' }
    return mapa[o] ?? o
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Mercado>('/v1/mercado'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
