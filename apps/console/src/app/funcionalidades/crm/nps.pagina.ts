import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Atendente {
  readonly usuarioId: string; readonly nome: string; readonly total: number
  readonly promotores: number; readonly neutros: number; readonly detratores: number; readonly score: number | null
}
interface Nps {
  readonly dias: number
  readonly geral: { total: number; score: number | null; semAtendente: number }
  readonly porAtendente: Atendente[]
}
interface Membro { readonly id: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const PERIODOS = [{ dias: 30, r: '30d' }, { dias: 90, r: '90d' }, { dias: 180, r: '6m' }, { dias: 365, r: '12m' }]

/**
 * NPS por atendente — a nota é pós-conversa e avalia o atendimento, então o
 * painel mostra o score de cada vendedor. Score DERIVADO (%promotores −
 * %detratores). Segue geracrm-layout-ui (5 estados, tokens, responsivo).
 */
@Component({
  selector: 'app-nps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">NPS por atendente</h1>
        <p class="sub">A nota é dada depois da conversa e avalia quem atendeu.</p>
      </div>
      <div class="dir">
        <div class="abas">
          @for (p of periodos; track p.dias) {
            <button [class.on]="dias() === p.dias" (click)="trocar(p.dias)">{{ p.r }}</button>
          }
        </div>
        <button class="btn btn--primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Registrar' }}</button>
      </div>
    </header>

    @if (mostrarNova()) {
      <form class="nova" (submit)="registrar($event)">
        <select class="atd" [value]="atendente()" (change)="atendente.set($any($event.target).value)" aria-label="Atendente avaliado">
          <option value="">Quem atendeu…</option>
          @for (m of equipe(); track m.id) { <option [value]="m.id">{{ m.nome }}</option> }
        </select>
        <div class="notas" role="group" aria-label="Nota de 0 a 10">
          @for (n of notas; track n) {
            <button type="button" class="nb" [class.sel]="nota() === n" [attr.data-faixa]="faixaDe(n)" (click)="nota.set(n)">{{ n }}</button>
          }
        </div>
        <button class="btn btn--primario" type="submit" [disabled]="salvando() || nota() === null || !atendente()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</button>
        @if (erroForm()) { <p class="erro">{{ erroForm() }}</p> }
      </form>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as n) {
          @if (n.porAtendente.length === 0) {
            <div class="bloco"><h2 class="txt-secao">Sem NPS por atendente no período</h2>
              <p>Registre uma nota acima, escolhendo quem atendeu.</p></div>
          } @else {
            <div class="geral">
              <span class="g-num" [attr.data-sinal]="sinal(n.geral.score)">{{ n.geral.score !== null && n.geral.score > 0 ? '+' : '' }}{{ n.geral.score ?? '—' }}</span>
              <span class="g-lab">NPS geral · {{ n.geral.total }} resposta{{ n.geral.total === 1 ? '' : 's' }}</span>
            </div>

            <ul class="lista">
              @for (a of n.porAtendente; track a.usuarioId) {
                <li class="atd-linha">
                  <div class="a-topo">
                    <span class="a-nome encolhe">{{ a.nome }}</span>
                    <span class="a-score txt-dados" [attr.data-sinal]="sinal(a.score)">{{ a.score !== null && a.score > 0 ? '+' : '' }}{{ a.score }}</span>
                  </div>
                  <div class="barra">
                    <span class="seg prom" [style.flex]="a.promotores" [title]="a.promotores + ' promotores'"></span>
                    <span class="seg neu"  [style.flex]="a.neutros" [title]="a.neutros + ' neutros'"></span>
                    <span class="seg det"  [style.flex]="a.detratores" [title]="a.detratores + ' detratores'"></span>
                  </div>
                  <div class="a-rodape">
                    <span>{{ a.promotores }} prom · {{ a.neutros }} neu · {{ a.detratores }} det</span>
                    <span class="a-total">{{ a.total }} resposta{{ a.total === 1 ? '' : 's' }}</span>
                  </div>
                </li>
              }
            </ul>
            @if (n.geral.semAtendente > 0) {
              <p class="obs">{{ n.geral.semAtendente }} resposta(s) sem atendente associado não aparecem acima.</p>
            }
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .dir { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .abas { display: flex; gap: var(--espacamento-1); }
    .abas button { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 12px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .atd { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .notas { display: flex; gap: 4px; flex-wrap: wrap; }
    .nb { width: 32px; height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; font-size: 13px; cursor: pointer; }
    .nb[data-faixa="promotor"].sel { background: var(--rfv-campeao); border-color: var(--rfv-campeao); color: var(--acao-texto); }
    .nb[data-faixa="neutro"].sel { background: var(--rfv-precisa-atencao); border-color: var(--rfv-precisa-atencao); color: var(--acao-texto); }
    .nb[data-faixa="detrator"].sel { background: var(--rfv-perdido); border-color: var(--rfv-perdido); color: var(--acao-texto); }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 66px; border-radius: var(--raio-painel); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .geral { display: flex; align-items: baseline; gap: var(--espacamento-3); padding: var(--espacamento-4) var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); margin-bottom: var(--espacamento-4); }
    .g-num { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; }
    .g-num[data-sinal="bom"] { color: var(--rfv-campeao); } .g-num[data-sinal="neutro"] { color: var(--rfv-precisa-atencao); } .g-num[data-sinal="ruim"] { color: var(--rfv-perdido); }
    .g-lab { color: var(--texto-suave); font-size: 13px; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .atd-linha { padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .a-topo { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-3); }
    .a-nome { color: var(--texto); font-size: 14px; font-weight: 500; }
    .a-score { font-size: 18px; font-weight: 700; }
    .a-score[data-sinal="bom"] { color: var(--rfv-campeao); } .a-score[data-sinal="neutro"] { color: var(--rfv-precisa-atencao); } .a-score[data-sinal="ruim"] { color: var(--rfv-perdido); }
    .barra { display: flex; height: 8px; border-radius: var(--raio-completo); overflow: hidden; background: var(--superficie); margin: var(--espacamento-2) 0; }
    .seg { display: block; min-width: 0; }
    .seg.prom { background: var(--rfv-campeao); } .seg.neu { background: var(--rfv-precisa-atencao); } .seg.det { background: var(--rfv-perdido); }
    .a-rodape { display: flex; justify-content: space-between; gap: var(--espacamento-3); font-size: 12px; color: var(--texto-suave); }
    .a-total { color: var(--texto-secundario); }
    .obs { margin-top: var(--espacamento-3); font-size: 12px; color: var(--texto-suave); }
  `,
})
export class NpsPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly periodos = PERIODOS
  readonly notas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Nps | null>(null)
  readonly equipe = signal<readonly Membro[]>([])
  readonly dias = signal(90)
  readonly mostrarNova = signal(false)
  readonly nota = signal<number | null>(null)
  readonly atendente = signal('')
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  ngOnInit(): void { void this.carregar(); void this.carregarEquipe() }
  trocar(dias: number): void { this.dias.set(dias); void this.carregar() }
  faixaDe(n: number): string { return n >= 9 ? 'promotor' : n >= 7 ? 'neutro' : 'detrator' }
  sinal(score: number | null): string { return score === null ? 'neutro' : score >= 50 ? 'bom' : score >= 0 ? 'neutro' : 'ruim' }

  async carregarEquipe(): Promise<void> {
    try { const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe')); this.equipe.set(r.itens) } catch { /* seletor vazio */ }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Nps>(`/v1/nps?dias=${this.dias()}`))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async registrar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nota = this.nota(); const atendenteId = this.atendente()
    if (this.salvando() || nota === null || !atendenteId) return
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/nps', { nota, atendenteId }))
      this.nota.set(null); this.atendente.set(''); this.mostrarNova.set(false)
      await this.carregar()
    } catch { this.erroForm.set('Não foi possível registrar a resposta.') } finally { this.salvando.set(false) }
  }
}
