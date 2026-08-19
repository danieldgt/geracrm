import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Lista { readonly id: string; readonly nome: string; readonly descricao: string | null; readonly membros: number }
interface Membro { readonly id: string; readonly nome: string }
interface AchadoContato { readonly id: string; readonly nome: string; readonly telefone: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Listas (públicos salvos) — CRUD de público curado + gestão de membros, em
 * coluna dupla (listas | membros). Adicionar membro por busca de contato.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-listas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Listas</h1>
      <p class="sub">Públicos que você monta à mão e reusa — separados dos segmentos automáticos.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="col"><div class="esq"></div><div class="esq"></div></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="grade">
          <section class="col">
            <form class="nova" (submit)="criar($event)">
              <input [value]="novoNome()" (input)="novoNome.set($any($event.target).value)" placeholder="Nova lista (ex.: Feira 2026)" aria-label="Nome da lista" />
              <button class="btn btn--primario" type="submit" [disabled]="criando() || !novoNome().trim()">+</button>
              @if (erroNova()) { <p class="erro">{{ erroNova() }}</p> }
            </form>
            <ul class="listas">
              @for (l of listas(); track l.id) {
                <li class="lista" [class.on]="selecionada()?.id === l.id" (click)="abrir(l)">
                  <span class="l-nome encolhe">{{ l.nome }}</span>
                  <span class="l-qtd txt-dados">{{ l.membros }}</span>
                  <button class="x" (click)="excluir(l.id, $event)" title="Excluir lista">×</button>
                </li>
              }
              @if (listas().length === 0) { <li class="vazio">Nenhuma lista ainda.</li> }
            </ul>
          </section>

          <section class="col detalhe">
            @if (selecionada() === null) {
              <div class="bloco"><h2 class="txt-secao">Escolha uma lista</h2><p>Selecione à esquerda para ver e adicionar contatos.</p></div>
            } @else {
              <div class="det-topo">
                <h2 class="txt-secao encolhe">{{ selecionada()!.nome }}</h2>
                <span class="det-qtd txt-dados">{{ membros().length }}{{ temMais() ? '+' : '' }}</span>
              </div>

              <div class="busca">
                <input [value]="termo()" (input)="buscar($any($event.target).value)" placeholder="Buscar contato para adicionar…" aria-label="Buscar contato" />
                @if (achados().length > 0) {
                  <ul class="achados">
                    @for (a of achados(); track a.id) {
                      <li (click)="adicionar(a)"><span class="encolhe">{{ a.nome }}</span>@if (a.telefone) { <span class="tel">{{ a.telefone }}</span> }</li>
                    }
                  </ul>
                }
              </div>

              @if (membros().length === 0) {
                <div class="bloco"><p>Lista vazia. Busque um contato acima para adicionar.</p></div>
              } @else {
                <ul class="membros">
                  @for (m of membros(); track m.id) {
                    <li><span class="m-nome encolhe">{{ m.nome }}</span>
                      <button class="x" (click)="remover(m.id)" title="Remover da lista">×</button></li>
                  }
                </ul>
                @if (temMais()) { <button class="btn btn--secundario btn--bloco" (click)="carregarMembros(true)">Carregar mais</button> }
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
    .grade { display: grid; grid-template-columns: 300px 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: 1fr; } }
    .col { min-width: 0; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .nova { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-3); flex-wrap: wrap; }
    .nova input { flex: 1; min-width: 140px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .listas { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .lista { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .lista:last-child { border-bottom: none; }
    .lista:hover { background: var(--superficie); }
    .lista.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    .l-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .l-qtd { color: var(--texto-secundario); font-weight: 600; }
    .vazio { padding: var(--espacamento-6); text-align: center; color: var(--texto-suave); font-size: 13px; }
    .det-topo { display: flex; align-items: baseline; justify-content: space-between; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .det-topo h2 { margin: 0; }
    .det-qtd { color: var(--texto-suave); }
    .busca { position: relative; margin-bottom: var(--espacamento-3); }
    .busca input { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .achados { position: absolute; z-index: 5; left: 0; right: 0; margin: var(--espacamento-1) 0 0; padding: 0; list-style: none; border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada); box-shadow: var(--elevacao-dropdown); max-height: 240px; overflow: auto; }
    .achados li { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); padding: var(--espacamento-2) var(--espacamento-3); cursor: pointer; }
    .achados li:hover { background: var(--acao-suave); }
    .tel { font-size: 12px; color: var(--texto-suave); }
    .membros { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .membros li { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .membros li:last-child { border-bottom: none; }
    .m-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .x { border: 0; background: transparent; color: var(--texto-suave); font-size: 16px; padding: 0 4px; cursor: pointer; flex: none; }
    .x:hover { color: var(--erro); }
    .btn--bloco { margin-top: var(--espacamento-2); }
  `,
})
export class ListasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly listas = signal<readonly Lista[]>([])
  readonly selecionada = signal<Lista | null>(null)
  readonly membros = signal<readonly Membro[]>([])
  readonly temMais = signal(false)
  readonly novoNome = signal(''); readonly criando = signal(false); readonly erroNova = signal<string | null>(null)
  readonly termo = signal(''); readonly achados = signal<readonly AchadoContato[]>([])
  private cursor: string | null = null
  private buscaSeq = 0

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Lista[] }>('/v1/listas'))
      this.listas.set(r.itens)
      this.estado.set('pronto')
      const sel = this.selecionada()
      if (sel) {
        const atual = r.itens.find((l) => l.id === sel.id) ?? null
        this.selecionada.set(atual)
        if (atual) await this.carregarMembros()
      }
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrir(l: Lista): void { this.selecionada.set(l); this.termo.set(''); this.achados.set([]); void this.carregarMembros() }

  async carregarMembros(anexar = false): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    if (!anexar) { this.cursor = null; this.membros.set([]) }
    const url = `/v1/listas/${l.id}/membros${this.cursor ? `?cursor=${this.cursor}` : ''}`
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[]; proximoCursor: string | null }>(url))
      this.membros.set(anexar ? [...this.membros(), ...r.itens] : r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
    } catch { /* mantém o que tinha */ }
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nome = this.novoNome().trim()
    if (this.criando() || !nome) return
    this.criando.set(true); this.erroNova.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/listas', { nome }))
      this.novoNome.set('')
      await this.carregar()
    } catch (e) {
      this.erroNova.set(e instanceof HttpErrorResponse && e.status === 409 ? 'Já existe uma lista com esse nome.' : 'Não foi possível criar.')
    } finally { this.criando.set(false) }
  }

  async excluir(id: string, ev: Event): Promise<void> {
    ev.stopPropagation()
    try {
      await firstValueFrom(this.http.delete(`/v1/listas/${id}`))
      if (this.selecionada()?.id === id) this.selecionada.set(null)
      await this.carregar()
    } catch { /* ignore */ }
  }

  async buscar(q: string): Promise<void> {
    this.termo.set(q)
    const seq = ++this.buscaSeq
    if (q.trim().length < 2) { this.achados.set([]); return }
    try {
      const r = await firstValueFrom(this.http.get<{ itens: AchadoContato[] }>(`/v1/contatos/busca?q=${encodeURIComponent(q.trim())}`))
      if (seq === this.buscaSeq) this.achados.set(r.itens)
    } catch { /* silencioso */ }
  }

  async adicionar(a: AchadoContato): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    try {
      await firstValueFrom(this.http.post(`/v1/listas/${l.id}/membros`, { contatoId: a.id }))
      this.termo.set(''); this.achados.set([])
      await this.carregar()
    } catch { /* ignore */ }
  }

  async remover(contatoId: string): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    try {
      await firstValueFrom(this.http.delete(`/v1/listas/${l.id}/membros/${contatoId}`))
      await this.carregar()
    } catch { /* ignore */ }
  }
}
