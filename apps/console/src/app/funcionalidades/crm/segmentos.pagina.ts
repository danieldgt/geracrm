import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Segmento {
  readonly codigo: string
  readonly rotulo: string
  readonly acao: string
  readonly urgencia: number
  readonly contatos: number
  readonly receitaCentavos: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Segmentos RFV — a base inteira distribuída por segmento, ordenada por urgência
 * (quem precisa de ação primeiro). A cor sai do token rfv.*; a régua é a mesma
 * `classificarRfv` do resto. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-segmentos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Segmentos RFV</h1>
      <p class="sub">Sua base por comportamento de compra. Comece por quem está mais no topo.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (total() === 0) {
          <div class="bloco"><h2 class="txt-secao">Sem base segmentável ainda</h2>
            <p>Os segmentos aparecem quando houver vendas importadas do ERP.</p></div>
        } @else {
          <p class="total">{{ total() }} clientes com histórico</p>
          <ul class="lista">
            @for (s of itens(); track s.codigo) {
              <li class="seg" [style.--c]="cor(s.codigo)">
                <div class="seg-topo">
                  <span class="ponto"></span>
                  <strong class="seg-nome">{{ s.rotulo }}</strong>
                  <span class="seg-qtd txt-dados">{{ s.contatos }}</span>
                </div>
                <div class="barra"><span class="preenche" [style.width.%]="pct(s.contatos)"></span></div>
                <div class="seg-rodape">
                  <span class="acao">➜ {{ s.acao }}</span>
                  <span class="receita txt-dados">{{ reais(s.receitaCentavos) }}</span>
                </div>
              </li>
            }
          </ul>
          <p class="dica">Quer falar com um segmento? Crie uma <a routerLink="/campanhas">campanha</a> mirando ele.</p>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 720px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .total { font-size: 13px; color: var(--texto-suave); margin: 0 0 var(--espacamento-3); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .esq { height: 64px; border-radius: var(--raio-painel); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .seg { padding: var(--espacamento-4); border: 1px solid var(--borda); border-left: 3px solid var(--c); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .seg-topo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); background: var(--c); flex: none; }
    .seg-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .seg-qtd { color: var(--texto); font-weight: 600; }
    .barra { height: 6px; border-radius: var(--raio-completo); background: var(--superficie); margin: var(--espacamento-2) 0; overflow: hidden; }
    .preenche { display: block; height: 100%; background: var(--c); }
    .seg-rodape { display: flex; justify-content: space-between; gap: var(--espacamento-3); align-items: baseline; }
    .acao { font-size: 12px; color: var(--texto-secundario); }
    .receita { color: var(--texto-suave); font-size: 12px; }
    .dica { margin-top: var(--espacamento-4); font-size: 13px; color: var(--texto-suave); }
    .dica a { color: var(--acao); }
  `,
})
export class SegmentosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Segmento[]>([])
  readonly total = computed(() => this.itens().reduce((s, i) => s + i.contatos, 0))
  private readonly maxContatos = computed(() => Math.max(1, ...this.itens().map((i) => i.contatos)))

  ngOnInit(): void { void this.carregar() }
  cor(codigo: string): string { return `var(--rfv-${codigo})` }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  pct(n: number): number { return Math.round((n / this.maxContatos()) * 100) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Segmento[] }>('/v1/segmentos'))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
