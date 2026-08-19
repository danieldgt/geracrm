import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Mercado {
  readonly total: number
  readonly cobertura: { comWhatsapp: number; comTelefone: number; comErp: number; optOut: number; jaCompraram: number }
  readonly porOrigem: { origem: string; contatos: number }[]
  readonly rfv: { codigo: string; rotulo: string; urgencia: number; contatos: number }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Visão de Mercado — a fotografia da base: tamanho, o quanto é acionável
 * (WhatsApp, telefone, ERP, opt-out) e onde está no RFV. Leitura pura.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-mercado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Visão de Mercado</h1>
      <p class="sub">Sua base em números: tamanho, alcance e composição.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="kpis"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as m) {
          @if (m.total === 0) {
            <div class="bloco"><h2 class="txt-secao">Base vazia</h2><p>Importe clientes do ERP ou cadastre para ver a composição.</p></div>
          } @else {
            <div class="destaque">
              <span class="txt-rotulo">Base ativa</span>
              <span class="txt-kpi">{{ m.total }}</span>
              <span class="d-sub">contatos</span>
            </div>

            <h2 class="txt-secao secao">O quanto dá para agir</h2>
            <div class="cob">
              @for (c of cobertura(m); track c.chave) {
                <div class="ccard">
                  <div class="c-topo"><span class="c-rot">{{ c.rotulo }}</span><span class="c-val txt-dados" [class.alerta]="c.alerta">{{ c.n }}</span></div>
                  <div class="barra"><span class="fill" [class.alerta]="c.alerta" [style.width.%]="pct(c.n, m.total)"></span></div>
                  <span class="c-pct">{{ pct(c.n, m.total) }}% da base</span>
                </div>
              }
            </div>

            <div class="duas">
              <section class="painel">
                <h2 class="txt-secao">De onde vieram</h2>
                <ul class="lista">
                  @for (o of m.porOrigem; track o.origem) {
                    <li>
                      <span class="l-rot encolhe">{{ rotuloOrigem(o.origem) }}</span>
                      <span class="l-barra"><span class="l-fill" [style.width.%]="pct(o.contatos, maxOrigem())"></span></span>
                      <span class="l-val txt-dados">{{ o.contatos }}</span>
                    </li>
                  }
                </ul>
              </section>

              <section class="painel">
                <h2 class="txt-secao">Onde estão no RFV</h2>
                <ul class="lista">
                  @for (s of m.rfv; track s.codigo) {
                    <li>
                      <span class="ponto" [style.background]="cor(s.codigo)"></span>
                      <span class="l-rot encolhe">{{ s.rotulo }}</span>
                      <span class="l-barra"><span class="l-fill" [style.width.%]="pct(s.contatos, maxRfv())" [style.background]="cor(s.codigo)"></span></span>
                      <span class="l-val txt-dados">{{ s.contatos }}</span>
                    </li>
                  }
                </ul>
                <a class="mais-link" routerLink="/segmentos">Ver segmentos em detalhe →</a>
              </section>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: var(--espacamento-3); }
    .esq { height: 96px; border-radius: var(--raio-painel); background: var(--superficie); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .destaque { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-4) var(--espacamento-6); border: 1px solid var(--borda); border-left: 3px solid var(--acao); border-radius: var(--raio-painel); background: var(--superficie-elevada); margin-bottom: var(--espacamento-4); }
    .d-sub { color: var(--texto-suave); font-size: 12px; }
    .secao { margin: var(--espacamento-4) 0 var(--espacamento-3); }
    .cob { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-6); }
    .ccard { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .c-topo { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-2); }
    .c-rot { font-size: 13px; color: var(--texto-secundario); }
    .c-val { color: var(--texto); font-weight: 600; }
    .c-val.alerta { color: var(--atencao); }
    .barra { height: 6px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; margin: var(--espacamento-2) 0 var(--espacamento-1); }
    .fill { display: block; height: 100%; background: var(--acao); }
    .fill.alerta { background: var(--atencao); }
    .c-pct { font-size: 11px; color: var(--texto-suave); }
    .duas { display: grid; grid-template-columns: 1fr 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 640px) { .duas { grid-template-columns: 1fr; } }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .lista li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--espacamento-2); }
    .painel:first-child .lista li { grid-template-columns: 1fr 2fr auto; }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); flex: none; }
    .l-rot { font-size: 13px; color: var(--texto); }
    .l-barra { height: 4px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .l-fill { display: block; height: 100%; background: var(--acao); }
    .l-val { color: var(--texto-secundario); font-size: 12px; }
    .mais-link { display: inline-block; margin-top: var(--espacamento-3); font-size: 13px; color: var(--acao); text-decoration: none; }
  `,
})
export class MercadoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Mercado | null>(null)

  ngOnInit(): void { void this.carregar() }
  pct(n: number, total: number): number { return total > 0 ? Math.round((n / total) * 100) : 0 }
  cor(codigo: string): string { return `var(--rfv-${codigo})` }
  maxOrigem(): number { return Math.max(1, ...(this.d()?.porOrigem.map((o) => o.contatos) ?? [])) }
  maxRfv(): number { return Math.max(1, ...(this.d()?.rfv.map((s) => s.contatos) ?? [])) }

  cobertura(m: Mercado) {
    return [
      { chave: 'zap', rotulo: 'Com WhatsApp', n: m.cobertura.comWhatsapp, alerta: false },
      { chave: 'tel', rotulo: 'Com telefone', n: m.cobertura.comTelefone, alerta: false },
      { chave: 'erp', rotulo: 'Vindos do ERP', n: m.cobertura.comErp, alerta: false },
      { chave: 'compra', rotulo: 'Já compraram', n: m.cobertura.jaCompraram, alerta: false },
      { chave: 'optout', rotulo: 'Opt-out', n: m.cobertura.optOut, alerta: true },
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
