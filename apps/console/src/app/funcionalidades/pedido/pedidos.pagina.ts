import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface PedidoItem {
  readonly id: string
  readonly estado: string
  readonly nome: string | null
  readonly totalCentavos: number
  readonly totalPecas: number
  readonly numeroExterno: string | null
  readonly criadoEm: string
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const FILTROS = [
  { chave: '', rotulo: 'Todos' },
  { chave: 'rascunho', rotulo: 'Rascunhos' },
  { chave: 'efetivado', rotulo: 'Efetivados' },
  { chave: 'falhou', rotulo: 'Falharam' },
  { chave: 'cancelado', rotulo: 'Cancelados' },
]

/**
 * Lista de pedidos (expansão CRUD). Filtro por estado + cursor. Segue a skill
 * geracrm-layout-ui: tokens, 5 estados, sem sobreposição.
 */
@Component({
  selector: 'app-pedidos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Pedidos</h1>
      <p class="sub">Todos os pedidos por estado. O rascunho nasce na conversa; o ERP efetiva.</p>
    </header>

    <div class="filtros">
      @for (f of filtros; track f.chave) {
        <button [class.on]="filtro() === f.chave" (click)="trocar(f.chave)">{{ f.rotulo }}</button>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso aos pedidos</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhum pedido aqui</h2>
            <p>Monte um pedido pela conversa ou pelo <a routerLink="/pedido">Pedido Assistido</a>.</p></div>
        } @else {
          <ul class="lista">
            @for (p of itens(); track p.id) {
              <li class="ped">
                <span class="badge" [class]="'badge--' + p.estado">{{ rotuloEstado(p.estado) }}</span>
                <span class="nome encolhe">{{ p.nome || 'Sem cliente' }}</span>
                <span class="pecas txt-dados">{{ p.totalPecas }} pç</span>
                <span class="total txt-dados">{{ reais(p.totalCentavos) }}</span>
                @if (p.numeroExterno) { <span class="nf txt-dados">NF {{ p.numeroExterno }}</span> }
                <span class="data txt-dados">{{ p.criadoEm | date: 'dd/MM/yy' }}</span>
              </li>
            }
          </ul>
          @if (proximoCursor()) {
            <button class="mais" (click)="carregarMais()" [disabled]="carregandoMais()">
              {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 900px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .filtros { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); }
    .filtros button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .filtros button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco a { color: var(--acao); }
    .esq { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .ped { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); font-size: 13px; }
    .ped:last-child { border-bottom: none; }
    .nome { color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .total { color: var(--texto); font-weight: 600; }
    .pecas, .data, .nf { color: var(--texto-suave); }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); white-space: nowrap; }
    .badge--rascunho { background: var(--acao-suave); color: var(--texto); }
    .badge--efetivado { background: var(--sucesso-suave); color: var(--texto); }
    .badge--falhou { background: var(--erro-suave); color: var(--texto); }
    .badge--cancelado { background: var(--superficie); color: var(--texto-suave); }
    .badge--aguardando_conferencia { background: var(--atencao-suave); color: var(--texto); }
    .mais { margin-top: var(--espacamento-4); padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    @media (max-width: 560px) { .pecas, .nf { display: none; } }
  `,
})
export class PedidosPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly filtros = FILTROS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly PedidoItem[]>([])
  readonly filtro = signal('')
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)

  ngOnInit(): void { void this.carregar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  rotuloEstado(e: string): string {
    return { rascunho: 'Rascunho', efetivado: 'Efetivado', falhou: 'Falhou', cancelado: 'Cancelado', aguardando_conferencia: 'Conferência', enviando: 'Enviando', validando: 'Validando' }[e] ?? e
  }
  trocar(f: string): void { this.filtro.set(f); void this.carregar() }

  private url(cursor: string | null): string {
    const p = new URLSearchParams()
    if (this.filtro()) p.set('estado', this.filtro())
    if (cursor) p.set('cursor', cursor)
    const q = p.toString()
    return `/v1/pedidos${q ? '?' + q : ''}`
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(null)))
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: PedidoItem[]; proximoCursor: string | null }>(this.url(cursor)))
      this.itens.update((a) => [...a, ...r.itens])
      this.proximoCursor.set(r.proximoCursor)
    } catch { /* mantém */ } finally { this.carregandoMais.set(false) }
  }
}
