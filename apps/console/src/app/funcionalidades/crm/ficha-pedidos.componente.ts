import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import {
  BadgeComponente, BotaoComponente, EstadoComponente, PaginacaoComponente, TabelaComponente, CelulaDiretiva,
  formatarReais, mensagemDeErro, mesclarPagina, type ColunaTabela,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico, type PedidoDoContato } from './ficha-blocos.servico.js'
import { rotuloDoEstado, tomDoEstado } from '../pedido/pedidos.regras.js'

/** Aba Pedidos: os pedidos DESTE contato (cursor). Estado próprio. */
@Component({
  selector: 'app-ficha-pedidos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, BadgeComponente, BotaoComponente, EstadoComponente, PaginacaoComponente, TabelaComponente, CelulaDiretiva],
  template: `
    <div class="topo">
      <a class="btn btn--primario btn--pequeno" routerLink="/pedido" [queryParams]="{ contato: contatoId() }">Novo pedido</a>
    </div>
    @if (estado() === 'erro') {
      <ui-estado tipo="erro" titulo="Não foi possível carregar os pedidos" [descricao]="erro()">
        <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
      </ui-estado>
    } @else {
      <ui-tabela [colunas]="colunas" [linhas]="itens()" [carregando]="estado() === 'carregando'">
        <ng-template uiCelula="criadoEm" let-p>{{ p.criadoEm | date: 'dd/MM/yyyy' }}</ng-template>
        <ng-template uiCelula="rotulo" let-p>{{ p.rotulo || 'Pedido' }}@if (p.numeroExterno) { <span class="suave"> · nº {{ p.numeroExterno }}</span> }</ng-template>
        <ng-template uiCelula="estado" let-p><ui-badge [tom]="tom(p.estado)">{{ rotulo(p.estado) }}</ui-badge></ng-template>
        <ng-template uiCelula="totalCentavos" let-p>{{ reais(p.totalCentavos) }}</ng-template>
        <div uiVazio>
          <ui-estado titulo="Nenhum pedido ainda" descricao="Os pedidos montados para este contato aparecem aqui." icone="shopping-cart" />
        </div>
      </ui-tabela>
      @if (estado() === 'pronto') {
        <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximo()" [carregando]="carregandoMais()" (mais)="mais()" />
      }
    }
  `,
  styles: `
    :host { display: block; }
    .topo { display: flex; justify-content: flex-end; margin-bottom: var(--espacamento-3); }
    .topo a { text-decoration: none; }
    .suave { color: var(--texto-suave); }
  `,
})
export class FichaPedidosComponente {
  private readonly blocos = inject(FichaBlocosServico)
  readonly contatoId = input.required<string>()
  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  readonly itens = signal<readonly PedidoDoContato[]>([])
  readonly proximo = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly colunas: readonly ColunaTabela[] = [
    { chave: 'criadoEm', rotulo: 'Data', mono: true },
    { chave: 'rotulo', rotulo: 'Pedido' },
    { chave: 'itens', rotulo: 'Itens', alinhamento: 'dir', mono: true },
    { chave: 'estado', rotulo: 'Situação' },
    { chave: 'totalCentavos', rotulo: 'Total', alinhamento: 'dir', mono: true },
  ]
  readonly rotulo = rotuloDoEstado
  readonly tom = tomDoEstado
  readonly reais = formatarReais

  constructor() {
    effect(() => { this.contatoId(); untracked(() => { void this.carregar() }) })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const p = await this.blocos.pedidos(this.contatoId(), null)
      this.itens.set(p.itens); this.proximo.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }

  async mais(): Promise<void> {
    const cursor = this.proximo()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const p = await this.blocos.pedidos(this.contatoId(), cursor)
      this.itens.update((a) => mesclarPagina(a, p.itens, (x) => x.id))
      this.proximo.set(p.proximoCursor)
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar mais pedidos.'))
      this.estado.set('erro')
    } finally {
      this.carregandoMais.set(false)
    }
  }
}
