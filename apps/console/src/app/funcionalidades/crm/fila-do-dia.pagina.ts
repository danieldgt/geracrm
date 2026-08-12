import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { FilaDoDiaServico } from './fila-do-dia.servico.js'
import type { ClienteRfv } from './clientes.servico.js'

/**
 * Fila do Dia — o coração do produto: "com quem falo AGORA e por quê".
 *
 * Cada linha é uma AÇÃO, não um registro: o nome, o segmento (cor da rampa +
 * rótulo), a frase explicável do porquê (RFV-10) e a ação sugerida. Ordenada por
 * urgência — quem está saindo do ritmo no topo.
 *
 * Princípios (mesmos de todas as telas): 5 estados, densidade, rampa RFV com
 * rótulo, números monoespaçados, cor só de tokens, regra de RFV vinda de shared.
 */
@Component({
  selector: 'app-fila-do-dia',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <h1>Fila do Dia</h1>
        <p class="sub">Quem está saindo do próprio ritmo de compra — os mais urgentes primeiro.</p>
      </div>
    </header>

    @switch (servico.estado()) {
      @case ('carregando') {
        <ul class="lista" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) { <li class="cartao esqueleto"></li> }
        </ul>
      }
      @case ('sem_permissao') {
        <div class="bloco"><h2>Você não tem acesso à fila</h2>
          <p>Peça a um administrador da sua empresa para liberar este acesso.</p></div>
      }
      @case ('erro') {
        <div class="bloco"><h2>Não foi possível montar a fila</h2>
          <p>{{ servico.erro() }}</p>
          <button class="primario" (click)="servico.carregar()">Tentar de novo</button></div>
      }
      @case ('pronto') {
        @if (servico.vazio()) {
          <div class="bloco">
            <h2>Ninguém saindo do ritmo hoje 🎉</h2>
            <p>Nenhum cliente passou do próprio ritmo de compra. Quando alguém passar, aparece aqui —
               com o porquê e a ação sugerida.</p>
          </div>
        } @else {
          <ul class="lista">
            @for (c of servico.itens(); track c.id) {
              <li class="cartao" [style.--acento]="cor(c.segmento.codigo)">
                <div class="topo">
                  <span class="segmento">
                    <i class="ponto" [style.background]="cor(c.segmento.codigo)"></i>
                    {{ c.segmento.rotulo }}
                  </span>
                  @if (!c.confiavel) {
                    <em class="estimado" title="Histórico anterior à carga — ritmo estimado">estimado</em>
                  }
                </div>

                <a class="nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>

                <!-- ⚠️ O porquê explicável: comparado ao ritmo DELE, não a uma média geral. -->
                <p class="porque">{{ frase(c) }}</p>

                <div class="rodape">
                  <span class="acao">➜ {{ c.segmento.acao }}</span>
                  <span class="num">{{ c.qtdVendas }} compras · {{ reais(c.totalCentavos) }}</span>
                </div>
              </li>
            }
          </ul>

          @if (servico.temMais()) {
            <div class="mais">
              <button (click)="servico.carregarMais()" [disabled]="servico.buscandoMais()">
                {{ servico.buscandoMais() ? 'Carregando…' : 'Ver mais da fila' }}
              </button>
            </div>
          }
          @if (servico.erro() && !servico.buscandoMais()) {
            <p class="parcial">Não foi possível carregar mais agora. {{ servico.erro() }}</p>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0 auto var(--espacamento-4); color: var(--texto-secundario); max-width: 46ch; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    /* Cartão: acento lateral da cor do segmento — a urgência salta antes da leitura. */
    .cartao { padding: var(--espacamento-3) var(--espacamento-4);
      border: 1px solid var(--borda); border-left: 4px solid var(--acento, var(--borda-forte));
      border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .esqueleto { height: 92px; background: var(--superficie); border-left-color: transparent; }
    .topo { display: flex; justify-content: space-between; align-items: center; }
    .segmento { display: inline-flex; align-items: center; gap: var(--espacamento-2); font-size: 12px; font-weight: 600; color: var(--texto); }
    .ponto { width: 10px; height: 10px; border-radius: var(--raio-completo); display: inline-block; }
    .estimado { font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--texto-suave); border: 1px solid var(--borda-forte); border-radius: var(--raio-controle); padding: 0 4px; }
    .nome { display: inline-block; margin: var(--espacamento-2) 0 var(--espacamento-1); font-size: 15px; color: var(--texto); text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    .porque { margin: 0; font-size: 13px; color: var(--texto-secundario); }
    .rodape { display: flex; justify-content: space-between; align-items: center; margin-top: var(--espacamento-3); gap: var(--espacamento-3); }
    .acao { font-size: 13px; font-weight: 500; color: var(--acao); }
    .num { font-family: var(--tipografia-familia-dados); font-size: 12px; color: var(--texto-suave); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .mais { text-align: center; padding: var(--espacamento-4); }
    button { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    .primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .parcial { text-align: center; color: var(--atencao); font-size: 13px; }
  `,
})
export class FilaDoDiaPagina implements OnInit {
  readonly servico = inject(FilaDoDiaServico)

  ngOnInit(): void { void this.servico.carregar() }

  cor(codigo: string): string { return `var(--rfv-${codigo})` }

  reais(centavos: number): string {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  frase(c: ClienteRfv): string {
    if (c.diasSemComprar === null) return 'sem data de compra'
    const desde = c.diasSemComprar === 0 ? 'hoje' : `há ${c.diasSemComprar} dias`
    if (c.mediaEntreVendasDias === null || c.qtdVendas < 2) return `comprou ${desde} · 1 compra`
    const ritmo = Math.round(c.mediaEntreVendasDias)
    if (c.atrasoRelativo !== null && c.atrasoRelativo > 1.3) {
      const alem = Math.round((c.atrasoRelativo - 1) * 100)
      return `comprou ${desde} · costuma a cada ~${ritmo} dias · ${alem}% além do ritmo`
    }
    return `comprou ${desde} · costuma a cada ~${ritmo} dias`
  }
}
