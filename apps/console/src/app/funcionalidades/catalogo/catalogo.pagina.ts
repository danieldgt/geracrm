import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Sku { readonly id: string; readonly atributos: Record<string, string>; readonly precoCentavos: number | null; readonly saldo: number | null }
interface Produto { readonly id: string; readonly referencia: string; readonly descricao: string; readonly skus: readonly Sku[] }
type Estado = 'pronto' | 'buscando' | 'sem_permissao' | 'erro'

/**
 * Catálogo (browse). Reusa GET /v1/catalogo (mesma verdade do pedido assistido):
 * produtos → SKUs com grade, preço e saldo do ERP. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-catalogo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Catálogo</h1>
      <p class="sub">Produtos e grade (cor × tamanho) com preço e saldo do ERP.</p>
    </header>

    <div class="barra">
      <input class="busca" [value]="busca()" (input)="onBusca($any($event.target).value)" placeholder="Buscar por referência ou descrição" />
      <div class="perfil">
        <button [class.on]="perfil() === 'atacado'" (click)="trocarPerfil('atacado')">Atacado</button>
        <button [class.on]="perfil() === 'varejo'" (click)="trocarPerfil('varejo')">Varejo</button>
      </div>
    </div>

    @switch (estado()) {
      @case ('buscando') { <p class="dica">Buscando…</p> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso ao catálogo</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nada encontrado</h2>
            <p>Refine a busca ou sincronize o catálogo do ERP.</p></div>
        } @else {
          @if (limitado()) { <p class="dica">Mostrando os primeiros resultados — refine a busca para ver o resto.</p> }
          <ul class="lista">
            @for (p of itens(); track p.id) {
              <li class="prod">
                <div class="prod-topo">
                  <strong class="ref txt-dados">{{ p.referencia }}</strong>
                  <span class="desc encolhe">{{ p.descricao }}</span>
                </div>
                <div class="skus">
                  @for (s of p.skus; track s.id) {
                    <span class="sku">
                      <span class="grade">{{ atributos(s.atributos) }}</span>
                      <span class="preco txt-dados">{{ s.precoCentavos !== null ? reais(s.precoCentavos) : '—' }}</span>
                      <span class="saldo" [class.zero]="(s.saldo ?? 0) <= 0">{{ s.saldo ?? '?' }} un</span>
                    </span>
                  }
                </div>
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 900px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .barra { display: flex; gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .busca { flex: 1; min-width: 200px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .perfil { display: flex; }
    .perfil button { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .perfil button:first-child { border-radius: var(--raio-controle) 0 0 var(--raio-controle); }
    .perfil button:last-child { border-radius: 0 var(--raio-controle) var(--raio-controle) 0; border-left: 0; }
    .perfil button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .dica { font-size: 13px; color: var(--texto-suave); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .prod { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .prod-topo { display: flex; gap: var(--espacamento-3); align-items: baseline; margin-bottom: var(--espacamento-2); }
    .ref { color: var(--acao); flex: none; }
    .desc { color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skus { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .sku { display: inline-flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--fundo); font-size: 12px; }
    .grade { color: var(--texto-secundario); }
    .preco { color: var(--texto); }
    .saldo { color: var(--sucesso); }
    .saldo.zero { color: var(--erro); }
  `,
})
export class CatalogoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('buscando')
  readonly itens = signal<readonly Produto[]>([])
  readonly limitado = signal(false)
  readonly busca = signal('')
  readonly perfil = signal<'atacado' | 'varejo'>('atacado')
  private timer?: ReturnType<typeof setTimeout>

  ngOnInit(): void { void this.buscar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  atributos(a: Record<string, string>): string { return Object.values(a).join(' · ') || '—' }

  onBusca(v: string): void {
    this.busca.set(v)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.buscar(), 300)
  }
  trocarPerfil(p: 'atacado' | 'varejo'): void { this.perfil.set(p); void this.buscar() }

  async buscar(): Promise<void> {
    this.estado.set('buscando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Produto[]; limitado: boolean }>(
        `/v1/catalogo?perfil=${this.perfil()}&busca=${encodeURIComponent(this.busca().trim())}`))
      this.itens.set(r.itens)
      this.limitado.set(r.limitado)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
