import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Campanha {
  readonly id: string
  readonly nome: string
  readonly segmentoAlvo: string
  readonly estado: string
  readonly janelaDias: number
  readonly disparadaEm: string | null
}
interface Roi {
  readonly janelaDias: number
  readonly exata: { pedidos: number; receitaCentavos: number }
  readonly estimada: { vendas: number; receitaCentavos: number }
  readonly enviados: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const SEGMENTOS = [
  { codigo: 'todos', rotulo: 'Todos os clientes' },
  { codigo: 'nao-perder', rotulo: 'Na hora da recompra' },
  { codigo: 'em-risco', rotulo: 'Em risco / atrasado' },
  { codigo: 'semi-perdido', rotulo: 'Sumindo' },
  { codigo: 'hibernando', rotulo: 'Hibernando' },
  { codigo: 'cliente-fiel', rotulo: 'Em dia (fiéis)' },
  { codigo: 'cliente-recente', rotulo: 'Clientes novos' },
]

/**
 * Campanhas com ROI (Onda 3). ⚠️ O ROI mostra a atribuição EXATA e a ESTIMADA
 * SEPARADAS — somar as duas infla o número (skill funil-de-vendas). Segue a
 * skill geracrm-layout-ui: tokens, 5 estados, sem sobreposição.
 */
@Component({
  selector: 'app-campanhas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Campanhas</h1>
        <p class="sub">Fale com um segmento e meça o retorno — atribuição exata e estimada, separadas.</p>
      </div>
      <button class="primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Nova campanha' }}</button>
    </header>

    @if (mostrarNova()) {
      <form class="nova" (submit)="criar($event)">
        <input [value]="nome()" (input)="nome.set($any($event.target).value)" placeholder="Nome da campanha" />
        <select [value]="segmento()" (change)="segmento.set($any($event.target).value)">
          @for (s of segmentos; track s.codigo) { <option [value]="s.codigo">{{ s.rotulo }}</option> }
        </select>
        <input class="msg" [value]="mensagem()" (input)="mensagem.set($any($event.target).value)" placeholder="Mensagem" />
        <label class="janela">Janela ROI (dias)
          <input type="number" min="1" max="90" [value]="janela()" (input)="janela.set(+$any($event.target).value)" />
        </label>
        <button class="primario" type="submit" [disabled]="salvando() || !nome().trim() || !mensagem().trim()">
          {{ salvando() ? 'Criando…' : 'Criar' }}
        </button>
      </form>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="bloco"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2 class="txt-secao">Sem acesso a campanhas</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
        <button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco vazio"><h2 class="txt-secao">Nenhuma campanha ainda</h2>
            <p>Crie a primeira para reativar um segmento de clientes.</p></div>
        } @else {
          <ul class="lista">
            @for (c of itens(); track c.id) {
              <li class="camp">
                <div class="camp-topo">
                  <div class="encolhe">
                    <strong class="camp-nome">{{ c.nome }}</strong>
                    <span class="camp-meta">{{ rotuloSegmento(c.segmentoAlvo) }} · {{ rotuloEstado(c.estado) }}</span>
                  </div>
                  <div class="camp-acoes">
                    @if (c.estado === 'rascunho') {
                      <button (click)="verAudiencia(c.id)">Audiência</button>
                      <button class="primario" (click)="disparar(c.id)" [disabled]="ocupada().has(c.id)">
                        {{ ocupada().has(c.id) ? '…' : 'Disparar' }}
                      </button>
                    } @else {
                      <button (click)="verRoi(c.id)">Ver ROI</button>
                    }
                  </div>
                </div>
                @if (audiencia()[c.id] !== undefined) {
                  <p class="camp-info">Audiência: <b>{{ audiencia()[c.id] }}</b> contatos.</p>
                }
                @if (roi()[c.id]; as r) {
                  <div class="roi">
                    <div class="roi-box exata">
                      <span class="txt-rotulo">Receita atribuída (exata)</span>
                      <span class="txt-kpi">{{ reais(r.exata.receitaCentavos) }}</span>
                      <span class="roi-sub">{{ r.exata.pedidos }} pedidos nascidos da campanha</span>
                    </div>
                    <div class="roi-box estimada">
                      <span class="txt-rotulo">Receita estimada ({{ r.janelaDias }}d)</span>
                      <span class="txt-kpi">{{ reais(r.estimada.receitaCentavos) }}</span>
                      <span class="roi-sub">{{ r.estimada.vendas }} compras na janela · correlação, não causa</span>
                    </div>
                  </div>
                }
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 820px; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-5);
      padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .nova input, .nova select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .nova .msg { flex: 1; min-width: 180px; }
    .janela { font-size: 12px; color: var(--texto-suave); display: flex; align-items: center; gap: var(--espacamento-2); }
    .janela input { width: 60px; }
    button { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    .primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .esq { height: 60px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .camp { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .camp-topo { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-3); }
    .camp-nome { display: block; color: var(--texto); font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .camp-meta { font-size: 12px; color: var(--texto-suave); }
    .camp-acoes { display: flex; gap: var(--espacamento-2); flex: none; }
    .camp-info { margin: var(--espacamento-3) 0 0; font-size: 13px; color: var(--texto-secundario); }
    .roi { display: grid; grid-template-columns: 1fr 1fr; gap: var(--espacamento-3); margin-top: var(--espacamento-4); }
    @media (max-width: 560px) { .roi { grid-template-columns: 1fr; } }
    .roi-box { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-3); border-radius: var(--raio-controle); }
    .roi-box.exata { background: var(--sucesso-suave); }
    .roi-box.estimada { background: var(--acao-suave); }
    .roi-box .txt-kpi { color: var(--texto); }
    .roi-sub { font-size: 11px; color: var(--texto-suave); }
  `,
})
export class CampanhasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly segmentos = SEGMENTOS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Campanha[]>([])
  readonly mostrarNova = signal(false)
  readonly nome = signal(''); readonly segmento = signal('todos'); readonly mensagem = signal(''); readonly janela = signal(7)
  readonly salvando = signal(false)
  readonly audiencia = signal<Record<string, number>>({})
  readonly roi = signal<Record<string, Roi>>({})
  readonly ocupada = signal<ReadonlySet<string>>(new Set())

  ngOnInit(): void { void this.carregar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  rotuloSegmento(cod: string): string { return this.segmentos.find((s) => s.codigo === cod)?.rotulo ?? cod }
  rotuloEstado(e: string): string {
    return { rascunho: 'Rascunho', disparando: 'Disparada', concluida: 'Concluída', cancelada: 'Cancelada' }[e] ?? e
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Campanha[] }>('/v1/campanhas'))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.salvando.set(true)
    try {
      await firstValueFrom(this.http.post('/v1/campanhas', {
        nome: this.nome().trim(), segmentoAlvo: this.segmento(), mensagem: this.mensagem().trim(), janelaDias: this.janela(),
      }))
      this.nome.set(''); this.mensagem.set(''); this.mostrarNova.set(false)
      await this.carregar()
    } catch { /* erro silencioso p/ MVP */ } finally { this.salvando.set(false) }
  }

  async verAudiencia(id: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ total: number }>(`/v1/campanhas/${id}/audiencia`))
      this.audiencia.update((a) => ({ ...a, [id]: r.total }))
    } catch { /* ignore */ }
  }

  async disparar(id: string): Promise<void> {
    this.ocupada.update((s) => new Set(s).add(id))
    try {
      await firstValueFrom(this.http.post(`/v1/campanhas/${id}/disparar`, {}))
      await this.carregar()
      await this.verRoi(id)
    } catch { /* ignore */ } finally {
      this.ocupada.update((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }

  async verRoi(id: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<Roi>(`/v1/campanhas/${id}/roi`))
      this.roi.update((m) => ({ ...m, [id]: r }))
    } catch { /* ignore */ }
  }
}
