import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Meta {
  readonly id: string
  readonly usuarioId: string | null
  readonly usuario: string
  readonly tipo: string
  readonly alvo: number
  readonly realizado: number
  readonly realizadoDisponivel: boolean
  readonly pct: number
}
interface Membro { readonly id: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

/**
 * Metas de venda — alvo mensal (equipe e por vendedor) com o realizado derivado
 * das vendas do período. A equipe aparece no topo; abaixo, uma barra por vendedor.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-metas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Metas</h1>
        <p class="sub">Alvo do mês contra o que já foi vendido.</p>
      </div>
      <div class="periodo">
        <button class="nav" (click)="mudarMes(-1)" aria-label="Mês anterior">‹</button>
        <span class="mes txt-dados">{{ rotuloMes() }}</span>
        <button class="nav" (click)="mudarMes(1)" aria-label="Próximo mês">›</button>
      </div>
    </header>

    <form class="nova" (submit)="salvar($event)">
      <label class="campo rotulado">
        <span>De quem é a meta</span>
        <select [value]="alvoUsuario()" (change)="alvoUsuario.set($any($event.target).value)">
          <option value="">Equipe (todos)</option>
          @for (m of equipe(); track m.id) { <option [value]="m.id">{{ m.nome }}</option> }
        </select>
      </label>
      <label class="campo rotulado alvo">
        <span>Alvo do mês</span>
        <!-- ⚠️ O "R$" é UNIDADE, não rótulo: quem lê só ele não sabe se o campo é
             alvo, realizado ou saldo. -->
        <span class="campo-valor">
          <span class="prefixo">R$</span>
          <input inputmode="numeric" [value]="valor()" (input)="valor.set($any($event.target).value)" placeholder="0,00" />
        </span>
      </label>
      <button class="btn btn--primario" type="submit" [disabled]="salvando() || !valorNumerico()">
        {{ salvando() ? 'Salvando…' : 'Definir meta' }}
      </button>
      @if (erroForm()) { <p class="erro">{{ erroForm() }}</p> }
    </form>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Sem metas neste mês</h2>
            <p>Defina uma meta acima — da equipe ou de um vendedor.</p></div>
        } @else {
          <ul class="lista">
            @for (m of itens(); track m.id) {
              <li class="meta" [class.equipe]="m.usuarioId === null">
                <div class="topo">
                  <strong class="nome encolhe">{{ m.usuario }}</strong>
                  @if (m.realizadoDisponivel) {
                    <span class="pct txt-dados" [class.bateu]="m.pct >= 100">{{ m.pct }}%</span>
                  } @else {
                    <span class="pct-indisp">sem cálculo</span>
                  }
                  <button class="x" (click)="excluir(m.id)" title="Remover meta">×</button>
                </div>
                <div class="barra"><span class="preenche" [class.bateu]="m.pct >= 100" [style.width.%]="min(m.pct, 100)"></span></div>
                <div class="rodape">
                  <span class="realizado txt-dados">{{ reais(m.realizado) }}</span>
                  <span class="de">de {{ reais(m.alvo) }}</span>
                </div>
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .periodo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .nav { width: 32px; height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font-size: 18px; cursor: pointer; }
    .mes { min-width: 92px; text-align: center; color: var(--texto); }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .nova select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .nova .campo.rotulado { flex-direction: column; gap: 4px; }
    .nova .campo.rotulado > span:first-child { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .nova .alvo { flex: 1; min-width: 160px; }
    .campo-valor { display: flex; align-items: center; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); padding-left: var(--espacamento-3); flex: 1; min-width: 160px; }
    .prefixo { color: var(--texto-suave); font-size: 14px; }
    .campo-valor input { flex: 1; padding: var(--espacamento-2) var(--espacamento-3); border: 0; background: transparent; color: var(--texto); font: inherit; }
    .campo-valor input:focus { outline: none; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 76px; border-radius: var(--raio-painel); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .meta { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .meta.equipe { border-left: 3px solid var(--acao); }
    .topo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .nome { flex: 1; color: var(--texto); font-size: 14px; }
    .pct { color: var(--texto-secundario); font-weight: 600; }
    .pct.bateu { color: var(--sucesso); }
    .pct-indisp { font-size: 12px; color: var(--texto-suave); }
    .x { border: 0; background: transparent; color: var(--texto-suave); font-size: 16px; padding: 0 4px; cursor: pointer; flex: none; }
    .x:hover { color: var(--erro); }
    .barra { height: 8px; border-radius: var(--raio-completo); background: var(--superficie); margin: var(--espacamento-2) 0; overflow: hidden; }
    .preenche { display: block; height: 100%; background: var(--acao); }
    .preenche.bateu { background: var(--sucesso); }
    .rodape { display: flex; gap: var(--espacamento-2); align-items: baseline; }
    .realizado { color: var(--texto); }
    .de { font-size: 12px; color: var(--texto-suave); }
  `,
})
export class MetasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Meta[]>([])
  readonly equipe = signal<readonly Membro[]>([])
  private readonly hoje = new Date()
  readonly ano = signal(this.hoje.getUTCFullYear())
  readonly mes = signal(this.hoje.getUTCMonth() + 1)
  readonly alvoUsuario = signal(''); readonly valor = signal('')
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  readonly rotuloMes = computed(() => `${MESES[this.mes() - 1]} ${this.ano()}`)
  readonly valorNumerico = computed(() => this.parseReais(this.valor()))

  ngOnInit(): void { void this.carregar(); void this.carregarEquipe() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  min(a: number, b: number): number { return Math.min(a, b) }

  // "1.234,56" ou "1234,56" ou "1234" → centavos. null se inválido/zero.
  private parseReais(v: string): number | null {
    const limpo = v.trim().replace(/\./g, '').replace(',', '.')
    if (!limpo || !/^\d+(\.\d{1,2})?$/.test(limpo)) return null
    const c = Math.round(Number(limpo) * 100)
    return c > 0 ? c : null
  }

  mudarMes(delta: number): void {
    let m = this.mes() + delta, a = this.ano()
    if (m < 1) { m = 12; a-- } else if (m > 12) { m = 1; a++ }
    this.mes.set(m); this.ano.set(a)
    void this.carregar()
  }

  async carregarEquipe(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe'))
      this.equipe.set(r.itens)
    } catch { /* seletor fica só com "Equipe" */ }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Meta[] }>(`/v1/metas?ano=${this.ano()}&mes=${this.mes()}`))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const alvo = this.valorNumerico()
    if (this.salvando() || alvo === null) return
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/metas', {
        usuarioId: this.alvoUsuario() || null, ano: this.ano(), mes: this.mes(), alvoCentavos: alvo,
      }))
      this.valor.set('')
      await this.carregar()
    } catch { this.erroForm.set('Não foi possível salvar a meta.') } finally { this.salvando.set(false) }
  }

  async excluir(id: string): Promise<void> {
    try { await firstValueFrom(this.http.delete(`/v1/metas/${id}`)); await this.carregar() } catch { /* ignore */ }
  }
}
