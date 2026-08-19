import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Mapa {
  readonly total: number; readonly semEndereco: number
  readonly porEstado: { uf: string; contatos: number }[]
  readonly porCidade: { cidade: string; uf: string | null; contatos: number }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Mapa de Clientes — distribuição geográfica pelo ENDEREÇO DECLARADO (sem
 * geocoding). ⚠️ Honesto: não finge um mapa com pino; mostra a base por UF e
 * cidade e nomeia o "sem endereço". Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-mapa',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Mapa de Clientes</h1>
      <p class="sub">Onde sua base está, pelo endereço declarado.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="bloco esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as m) {
          @if (m.total === 0) {
            <div class="bloco"><h2 class="txt-secao">Base vazia</h2><p>Cadastre clientes com endereço para ver a distribuição.</p></div>
          } @else {
            <p class="nota">📍 Distribuição por <strong>endereço declarado</strong> — ainda sem mapa geográfico (geocoding). Quando o endereço virar coordenada, isto vira o mapa com pinos.</p>

            <div class="grade">
              <section class="painel">
                <h2 class="txt-secao">Por estado (UF)</h2>
                @if (m.porEstado.length === 0) { <p class="vazio">Nenhum contato com UF.</p> }
                @else {
                  <ul class="lista">
                    @for (e of m.porEstado; track e.uf) {
                      <li>
                        <span class="uf">{{ e.uf }}</span>
                        <span class="barra"><span class="fill" [style.width.%]="pct(e.contatos, maxEstado())"></span></span>
                        <span class="val txt-dados">{{ e.contatos }}</span>
                      </li>
                    }
                  </ul>
                }
              </section>

              <section class="painel">
                <h2 class="txt-secao">Top cidades</h2>
                @if (m.porCidade.length === 0) { <p class="vazio">Nenhum contato com cidade.</p> }
                @else {
                  <ul class="lista">
                    @for (c of m.porCidade; track c.cidade; let i = $index) {
                      <li>
                        <span class="pos">{{ i + 1 }}</span>
                        <span class="cid encolhe">{{ c.cidade }}@if (c.uf) { <span class="cuf">/{{ c.uf }}</span> }</span>
                        <span class="barra"><span class="fill" [style.width.%]="pct(c.contatos, maxCidade())"></span></span>
                        <span class="val txt-dados">{{ c.contatos }}</span>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>

            @if (m.semEndereco > 0) {
              <p class="sem">⚠️ {{ m.semEndereco }} de {{ m.total }} contatos estão <strong>sem endereço</strong> — não entram na distribuição. Complete o cadastro para o mapa ficar fiel.</p>
            }
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
    .nota { padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie); color: var(--texto-secundario); font-size: 13px; margin: 0 0 var(--espacamento-4); line-height: 1.5; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 200px; }
    .grade { display: grid; grid-template-columns: 1fr 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 640px) { .grade { grid-template-columns: 1fr; } }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .lista li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--espacamento-2); }
    .painel:last-child .lista li { grid-template-columns: 18px 1fr 2fr auto; }
    .uf { font-weight: 600; color: var(--texto); font-size: 13px; min-width: 28px; }
    .pos { color: var(--texto-suave); font-size: 12px; text-align: center; }
    .cid { color: var(--texto); font-size: 13px; }
    .cuf { color: var(--texto-suave); }
    .barra { height: 6px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--acao); }
    .val { color: var(--texto-secundario); font-size: 12px; }
    .vazio { color: var(--texto-suave); font-size: 13px; margin: 0; }
    .sem { margin-top: var(--espacamento-4); padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--atencao-suave); color: var(--texto); font-size: 13px; line-height: 1.5; }
  `,
})
export class MapaPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Mapa | null>(null)

  ngOnInit(): void { void this.carregar() }
  pct(n: number, max: number): number { return max > 0 ? Math.round((n / max) * 100) : 0 }
  maxEstado(): number { return Math.max(1, ...(this.d()?.porEstado.map((e) => e.contatos) ?? [])) }
  maxCidade(): number { return Math.max(1, ...(this.d()?.porCidade.map((c) => c.contatos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Mapa>('/v1/mapa'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
