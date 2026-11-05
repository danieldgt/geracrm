import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { CabecalhoTelaComponente, EstadoComponente, IconeComponente, PaginacaoComponente } from '../../compartilhado/ui/index.js'
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
  imports: [RouterLink, CabecalhoTelaComponente, EstadoComponente, IconeComponente, PaginacaoComponente],
  template: `
    <ui-cabecalho-tela titulo="Fila do Dia"
      subtitulo="Quem está saindo do próprio ritmo de compra — os mais urgentes primeiro." />

    @switch (servico.estado()) {
      @case ('carregando') {
        <ul class="lista" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) { <li class="cartao esqueleto"></li> }
        </ul>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à fila"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível montar a fila" [descricao]="servico.erro() ?? ''">
          <button class="btn btn--primario" type="button" (click)="servico.carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (servico.vazio()) {
          <ui-estado titulo="Ninguém saindo do ritmo hoje"
            descricao="Nenhum cliente passou do próprio ritmo de compra. Quando alguém passar, aparece aqui — com o porquê e a ação sugerida." />
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
                  <span class="acao"><ui-icone nome="chevron-right" [tamanho]="14" /> {{ c.segmento.acao }}</span>
                  <span class="num">{{ c.qtdVendas }} compras · {{ reais(c.totalCentavos) }}</span>
                </div>
              </li>
            }
          </ul>

          <ui-paginacao [mostrados]="servico.itens().length" [temMais]="servico.temMais()"
            [carregando]="servico.buscandoMais()" (mais)="servico.carregarMais()" />
          @if (servico.erro() && !servico.buscandoMais()) {
            <p class="parcial">Não foi possível carregar mais agora. {{ servico.erro() }}</p>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
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
    .acao { display: inline-flex; align-items: center; gap: var(--espacamento-1); font-size: 13px; font-weight: 500; color: var(--acao); }
    .num { font-family: var(--tipografia-familia-dados); font-size: 12px; color: var(--texto-suave); font-variant-numeric: tabular-nums; white-space: nowrap; }
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
