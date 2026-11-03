import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, IconeComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

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
  imports: [CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, IconeComponente, RouterLink, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Segmentos RFV"
      subtitulo="Sua base por comportamento de compra. Comece por quem está mais no topo." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso aos segmentos" descricao="Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os segmentos" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (total() === 0) {
            <ui-estado titulo="Sem base segmentável ainda"
              descricao="Os segmentos aparecem quando houver vendas importadas do ERP." />
          } @else {
            <p class="total txt-denso">{{ total() }} clientes com histórico</p>
            <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chaveDoSegmento">
              <ng-template uiCelula="rotulo" let-s>
                <span class="seg-nome" [style.--c]="cor(s.codigo)">
                  <span class="ponto" aria-hidden="true"></span>{{ s.rotulo }}
                </span>
              </ng-template>
              <ng-template uiCelula="contatos" let-s>{{ s.contatos }}</ng-template>
              <ng-template uiCelula="proporcao" let-s>
                <span class="barra" aria-hidden="true" [style.--c]="cor(s.codigo)">
                  <span class="preenche" [style.width.%]="pct(s.contatos)"></span>
                </span>
              </ng-template>
              <ng-template uiCelula="acao" let-s>
                <span class="acao"><ui-icone nome="chevron-right" [tamanho]="14" />{{ s.acao }}</span>
              </ng-template>
              <ng-template uiCelula="receita" let-s>{{ reais(s.receitaCentavos) }}</ng-template>
            </ui-tabela>
            <p class="dica">Quer falar com um segmento? Crie uma <a routerLink="/campanhas">campanha</a> mirando ele.</p>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .total { margin: 0 0 var(--espacamento-2); color: var(--texto-suave); }
    .seg-nome { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); background: var(--c); flex: none; }
    .barra { display: block; width: 160px; max-width: 100%; height: 6px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .preenche { display: block; height: 100%; background: var(--c); }
    .acao { display: inline-flex; align-items: center; gap: var(--espacamento-1); color: var(--texto-secundario); font-size: 12px; }
    .dica { margin-top: var(--espacamento-4); font-size: 13px; color: var(--texto-suave); }
    .dica a { color: var(--acao); }
  `,
})
export class SegmentosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'rotulo', rotulo: 'Segmento' },
    { chave: 'contatos', rotulo: 'Clientes', alinhamento: 'dir', mono: true, largura: '110px' },
    { chave: 'proporcao', rotulo: 'Proporção', largura: '180px' },
    { chave: 'acao', rotulo: 'Ação sugerida' },
    { chave: 'receita', rotulo: 'Receita', alinhamento: 'dir', mono: true, largura: '140px' },
  ]
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Segmento[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly chaveDoSegmento = (l: LinhaTabela): string => String(l['codigo'])
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
