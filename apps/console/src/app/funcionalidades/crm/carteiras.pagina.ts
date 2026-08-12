import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { SlicePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Vendedor { readonly usuarioId: string; readonly usuario: string; readonly clientes: number }
interface Membro { readonly id: string; readonly nome: string }
interface ContatoCarteira { readonly id: string; readonly nome: string; readonly qtdVendas: number; readonly ultimaVendaEm: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
// Alvo aberto no painel da direita: um vendedor específico, os órfãos, ou nada.
type Alvo = { tipo: 'vendedor'; id: string; nome: string } | { tipo: 'orfaos' } | null

/**
 * Vendedores e Carteiras — quem é o dono de cada cliente, com transferência
 * atômica (a API fecha o período e abre o novo na mesma transação) e órfãos
 * visíveis. ⚠️ Órfão não some: aparece como uma "carteira" própria a distribuir.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem sobreposição).
 */
@Component({
  selector: 'app-carteiras',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SlicePipe],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Vendedores e Carteiras</h1>
      <p class="sub">Quem é o dono de cada cliente. Toda transferência fica no histórico.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="col"><div class="esq"></div><div class="esq"></div></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="grade">
          <!-- Coluna 1: as carteiras (vendedores + órfãos) -->
          <section class="col">
            <ul class="lista">
              @if (orfaos() > 0) {
                <li class="cart" [class.on]="ehAlvo('orfaos')" (click)="abrirOrfaos()">
                  <span class="ava orfao">?</span>
                  <span class="cart-nome encolhe">Sem dono</span>
                  <span class="cart-qtd txt-dados alerta">{{ orfaos() }}</span>
                </li>
              }
              @for (v of vendedores(); track v.usuarioId) {
                <li class="cart" [class.on]="ehAlvo('vendedor', v.usuarioId)" (click)="abrirVendedor(v)">
                  <span class="ava">{{ inicial(v.usuario) }}</span>
                  <span class="cart-nome encolhe">{{ v.usuario }}</span>
                  <span class="cart-qtd txt-dados">{{ v.clientes }}</span>
                </li>
              }
              @if (vendedores().length === 0 && orfaos() === 0) {
                <li class="vazio">Nenhuma carteira atribuída ainda.</li>
              }
            </ul>
          </section>

          <!-- Coluna 2: clientes da carteira selecionada -->
          <section class="col detalhe">
            @if (alvo() === null) {
              <div class="bloco"><h2 class="txt-secao">Escolha uma carteira</h2>
                <p>Selecione um vendedor à esquerda para ver e transferir seus clientes.</p></div>
            } @else {
              <div class="det-topo">
                <h2 class="txt-secao encolhe">{{ tituloAlvo() }}</h2>
                <span class="det-qtd txt-dados">{{ contatos().length }}{{ temMais() ? '+' : '' }}</span>
              </div>
              @if (contatos().length === 0) {
                <div class="bloco"><p>Sem clientes nesta carteira.</p></div>
              } @else {
                <ul class="clientes">
                  @for (c of contatos(); track c.id) {
                    <li class="cli">
                      <div class="col encolhe">
                        <a class="cli-nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>
                        <span class="cli-meta">{{ c.qtdVendas }} compras@if (c.ultimaVendaEm) { · última em {{ c.ultimaVendaEm | slice: 0:10 }} }</span>
                      </div>
                      <div class="acoes">
                        <select class="sel" [disabled]="movendo() === c.id" (change)="transferir(c.id, $any($event.target).value); $any($event.target).value=''">
                          <option value="">Transferir…</option>
                          @for (m of equipe(); track m.id) {
                            @if (!ehDonoAtual(m.id)) { <option [value]="m.id">→ {{ m.nome }}</option> }
                          }
                        </select>
                        @if (alvo()?.tipo === 'vendedor') {
                          <button class="soltar" [disabled]="movendo() === c.id" (click)="soltar(c.id)" title="Deixar sem dono">Soltar</button>
                        }
                      </div>
                    </li>
                  }
                </ul>
                @if (temMais()) { <button class="mais" (click)="carregarContatos(true)">Carregar mais</button> }
              }
            }
          </section>
        </div>
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .grade { display: grid; grid-template-columns: 280px 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: 1fr; } }
    .col { min-width: 0; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 52px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .cart { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .cart:last-child { border-bottom: none; }
    .cart:hover { background: var(--superficie); }
    .cart.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    .ava { width: 28px; height: 28px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--acao); font-size: 12px; font-weight: 600; display: grid; place-items: center; flex: none; }
    .ava.orfao { background: var(--atencao-suave); color: var(--atencao); }
    .cart-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .cart-qtd { color: var(--texto-secundario); font-weight: 600; }
    .cart-qtd.alerta { color: var(--atencao); }
    .vazio { padding: var(--espacamento-6); text-align: center; color: var(--texto-suave); font-size: 13px; }
    .det-topo { display: flex; align-items: baseline; justify-content: space-between; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .det-topo h2 { margin: 0; }
    .det-qtd { color: var(--texto-suave); }
    .clientes { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .cli { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); flex-wrap: wrap; }
    .cli:last-child { border-bottom: none; }
    .cli .col { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 160px; }
    .cli-nome { color: var(--acao); text-decoration: none; font-size: 14px; }
    .cli-meta { font-size: 12px; color: var(--texto-suave); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-2); flex: none; }
    .sel { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; font-size: 12px; }
    .soltar { padding: 3px 10px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 12px; cursor: pointer; }
    .soltar:hover { color: var(--erro); border-color: var(--erro); }
    .mais { display: block; width: 100%; margin-top: var(--espacamento-2); padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; cursor: pointer; }
    button:disabled, select:disabled { opacity: .6; cursor: default; }
  `,
})
export class CarteirasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly vendedores = signal<readonly Vendedor[]>([])
  readonly orfaos = signal(0)
  readonly equipe = signal<readonly Membro[]>([])
  readonly alvo = signal<Alvo>(null)
  readonly contatos = signal<readonly ContatoCarteira[]>([])
  readonly temMais = signal(false)
  readonly movendo = signal<string | null>(null)
  private cursor: string | null = null

  readonly tituloAlvo = computed(() => {
    const a = this.alvo()
    return a === null ? '' : a.tipo === 'orfaos' ? 'Clientes sem dono' : `Carteira de ${a.nome}`
  })

  ngOnInit(): void { void this.carregar() }
  inicial(nome: string): string { return (nome.trim()[0] ?? '?').toUpperCase() }
  ehAlvo(tipo: 'vendedor' | 'orfaos', id?: string): boolean {
    const a = this.alvo()
    return a?.tipo === tipo && (tipo === 'orfaos' || a.tipo === 'vendedor' && a.id === id)
  }
  ehDonoAtual(usuarioId: string): boolean {
    const a = this.alvo()
    return a?.tipo === 'vendedor' && a.id === usuarioId
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [resumo, equipe] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Vendedor[]; orfaos: number }>('/v1/carteiras')),
        firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe')),
      ])
      this.vendedores.set(resumo.itens)
      this.orfaos.set(resumo.orfaos)
      this.equipe.set(equipe.itens)
      this.estado.set('pronto')
      // Reabrir o alvo atual, se ainda existir; senão limpar o painel.
      const a = this.alvo()
      if (a?.tipo === 'vendedor' && !resumo.itens.some((v) => v.usuarioId === a.id)) this.alvo.set(null)
      else if (a?.tipo === 'orfaos' && resumo.orfaos === 0) this.alvo.set(null)
      else if (a !== null) await this.carregarContatos()
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrirVendedor(v: Vendedor): void { this.alvo.set({ tipo: 'vendedor', id: v.usuarioId, nome: v.usuario }); void this.carregarContatos() }
  abrirOrfaos(): void { this.alvo.set({ tipo: 'orfaos' }); void this.carregarContatos() }

  async carregarContatos(anexar = false): Promise<void> {
    const a = this.alvo()
    if (a === null) return
    if (!anexar) { this.cursor = null; this.contatos.set([]) }
    const base = a.tipo === 'orfaos' ? 'orfaos=1' : `usuarioId=${a.id}`
    const url = `/v1/carteiras/contatos?${base}${this.cursor ? `&cursor=${this.cursor}` : ''}`
    try {
      const r = await firstValueFrom(this.http.get<{ itens: ContatoCarteira[]; proximoCursor: string | null }>(url))
      this.contatos.set(anexar ? [...this.contatos(), ...r.itens] : r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
    } catch { /* mantém o que já tinha; o estado geral segue 'pronto' */ }
  }

  async transferir(contatoId: string, usuarioId: string): Promise<void> {
    if (!usuarioId || this.movendo()) return
    this.movendo.set(contatoId)
    try {
      await firstValueFrom(this.http.post(`/v1/contatos/${contatoId}/carteira`, { usuarioId }))
      await this.carregar()
    } catch { /* falha silenciosa: recarrega no finally reflete o estado real */ }
    finally { this.movendo.set(null) }
  }

  async soltar(contatoId: string): Promise<void> {
    if (this.movendo()) return
    this.movendo.set(contatoId)
    try {
      await firstValueFrom(this.http.delete(`/v1/contatos/${contatoId}/carteira`))
      await this.carregar()
    } catch { /* idem */ }
    finally { this.movendo.set(null) }
  }
}
