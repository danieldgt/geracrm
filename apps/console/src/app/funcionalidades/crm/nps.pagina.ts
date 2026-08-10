import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Comentario {
  readonly id: string; readonly nota: number; readonly comentario: string
  readonly respondidoEm: string; readonly contatoId: string | null; readonly contato: string | null
  readonly faixa: 'promotor' | 'neutro' | 'detrator'
}
interface Nps {
  readonly dias: number; readonly total: number; readonly score: number | null
  readonly distribuicao: { promotores: number; neutros: number; detratores: number }
  readonly comentarios: Comentario[]; readonly proximoCursor: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const PERIODOS = [{ dias: 30, r: '30d' }, { dias: 90, r: '90d' }, { dias: 180, r: '6m' }, { dias: 365, r: '12m' }]

/**
 * NPS — satisfação. Score DERIVADO (%promotores − %detratores), distribuição por
 * faixa e comentários recentes; registro de resposta à mão. A faixa colore pela
 * rampa RFV (campeão→perdido) por proximidade de sentido. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-nps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">NPS</h1>
        <p class="sub">O quanto seus clientes recomendariam você — de −100 a +100.</p>
      </div>
      <div class="dir">
        <div class="abas">
          @for (p of periodos; track p.dias) {
            <button [class.on]="dias() === p.dias" (click)="trocar(p.dias)">{{ p.r }}</button>
          }
        </div>
        <button class="primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Registrar' }}</button>
      </div>
    </header>

    @if (mostrarNova()) {
      <form class="nova" (submit)="registrar($event)">
        <div class="notas" role="group" aria-label="Nota de 0 a 10">
          @for (n of notas; track n) {
            <button type="button" class="nb" [class.sel]="nota() === n" [attr.data-faixa]="faixaDe(n)" (click)="nota.set(n)">{{ n }}</button>
          }
        </div>
        <input class="coment" [value]="comentario()" (input)="comentario.set($any($event.target).value)" placeholder="Comentário (opcional)" aria-label="Comentário" />
        <button class="primario" type="submit" [disabled]="salvando() || nota() === null">{{ salvando() ? 'Salvando…' : 'Salvar' }}</button>
        @if (erroForm()) { <p class="erro">{{ erroForm() }}</p> }
      </form>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="painel esq"></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as n) {
          @if (n.total === 0) {
            <div class="bloco"><h2 class="txt-secao">Sem respostas no período</h2>
              <p>Registre a primeira resposta acima — inclusive o que você ouviu no telefone.</p></div>
          } @else {
            <div class="topo">
              <div class="score" [attr.data-sinal]="sinal(n.score)">
                <span class="score-num">{{ n.score! > 0 ? '+' : '' }}{{ n.score }}</span>
                <span class="score-lab">NPS · {{ n.total }} resposta{{ n.total === 1 ? '' : 's' }}</span>
              </div>
              <div class="dist">
                <div class="barra">
                  <span class="seg prom" [style.flex]="n.distribuicao.promotores" title="Promotores"></span>
                  <span class="seg neu"  [style.flex]="n.distribuicao.neutros" title="Neutros"></span>
                  <span class="seg det"  [style.flex]="n.distribuicao.detratores" title="Detratores"></span>
                </div>
                <div class="leg">
                  <span><i class="pt prom"></i>Promotores {{ n.distribuicao.promotores }}</span>
                  <span><i class="pt neu"></i>Neutros {{ n.distribuicao.neutros }}</span>
                  <span><i class="pt det"></i>Detratores {{ n.distribuicao.detratores }}</span>
                </div>
              </div>
            </div>

            @if (n.comentarios.length > 0) {
              <h2 class="txt-secao voz">O que estão dizendo</h2>
              <ul class="coments">
                @for (c of comentarios(); track c.id) {
                  <li class="cm" [attr.data-faixa]="c.faixa">
                    <div class="cm-topo">
                      <span class="cm-nota">{{ c.nota }}</span>
                      @if (c.contato && c.contatoId) { <a [routerLink]="['/contato', c.contatoId]">{{ c.contato }}</a> }
                      @else { <span class="anon">Anônimo</span> }
                      <span class="cm-data">{{ c.respondidoEm | date: 'dd/MM/yy' }}</span>
                    </div>
                    <p class="cm-txt">{{ c.comentario }}</p>
                  </li>
                }
              </ul>
              @if (temMais()) { <button class="mais" (click)="carregar(true)">Carregar mais</button> }
            }
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 760px; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .dir { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .abas { display: flex; gap: var(--espacamento-1); }
    .abas button { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 12px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .primario { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; cursor: pointer; }
    .primario:disabled { opacity: .6; cursor: default; }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .notas { display: flex; gap: 4px; flex-wrap: wrap; }
    .nb { width: 32px; height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; font-size: 13px; cursor: pointer; }
    .nb[data-faixa="promotor"].sel { background: var(--rfv-campeao); border-color: var(--rfv-campeao); color: var(--acao-texto); }
    .nb[data-faixa="neutro"].sel { background: var(--rfv-precisa-atencao); border-color: var(--rfv-precisa-atencao); color: var(--acao-texto); }
    .nb[data-faixa="detrator"].sel { background: var(--rfv-perdido); border-color: var(--rfv-perdido); color: var(--acao-texto); }
    .coment { flex: 1; min-width: 180px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .painel.esq { height: 150px; border-radius: var(--raio-painel); background: var(--superficie); }
    .topo { display: grid; grid-template-columns: auto 1fr; gap: var(--espacamento-6); align-items: center; padding: var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    @media (max-width: 560px) { .topo { grid-template-columns: 1fr; gap: var(--espacamento-4); } }
    .score { display: flex; flex-direction: column; align-items: center; }
    .score-num { font-size: 52px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
    .score[data-sinal="bom"] .score-num { color: var(--rfv-campeao); }
    .score[data-sinal="neutro"] .score-num { color: var(--rfv-precisa-atencao); }
    .score[data-sinal="ruim"] .score-num { color: var(--rfv-perdido); }
    .score-lab { margin-top: var(--espacamento-1); font-size: 12px; color: var(--texto-suave); }
    .barra { display: flex; height: 12px; border-radius: var(--raio-completo); overflow: hidden; background: var(--superficie); }
    .seg { display: block; min-width: 2px; }
    .seg.prom { background: var(--rfv-campeao); } .seg.neu { background: var(--rfv-precisa-atencao); } .seg.det { background: var(--rfv-perdido); }
    .leg { display: flex; gap: var(--espacamento-4); flex-wrap: wrap; margin-top: var(--espacamento-3); font-size: 12px; color: var(--texto-secundario); }
    .leg i { display: inline-block; width: 8px; height: 8px; border-radius: var(--raio-completo); margin-right: 6px; }
    .pt.prom { background: var(--rfv-campeao); } .pt.neu { background: var(--rfv-precisa-atencao); } .pt.det { background: var(--rfv-perdido); }
    .voz { margin: var(--espacamento-6) 0 var(--espacamento-3); }
    .coments { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .cm { padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-left: 3px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .cm[data-faixa="promotor"] { border-left-color: var(--rfv-campeao); }
    .cm[data-faixa="neutro"] { border-left-color: var(--rfv-precisa-atencao); }
    .cm[data-faixa="detrator"] { border-left-color: var(--rfv-perdido); }
    .cm-topo { display: flex; align-items: center; gap: var(--espacamento-2); font-size: 13px; }
    .cm-nota { font-weight: 700; color: var(--texto); font-variant-numeric: tabular-nums; }
    .cm-topo a { color: var(--acao); text-decoration: none; }
    .anon { color: var(--texto-suave); }
    .cm-data { margin-left: auto; color: var(--texto-suave); font-size: 12px; }
    .cm-txt { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; line-height: 1.4; }
    .mais { display: block; width: 100%; margin-top: var(--espacamento-2); padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; cursor: pointer; }
  `,
})
export class NpsPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly periodos = PERIODOS
  readonly notas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Nps | null>(null)
  readonly comentarios = signal<readonly Comentario[]>([])
  readonly temMais = signal(false)
  readonly dias = signal(90)
  readonly mostrarNova = signal(false)
  readonly nota = signal<number | null>(null)
  readonly comentario = signal(''); readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)
  private cursor: string | null = null

  ngOnInit(): void { void this.carregar() }
  trocar(dias: number): void { this.dias.set(dias); void this.carregar() }
  faixaDe(n: number): string { return n >= 9 ? 'promotor' : n >= 7 ? 'neutro' : 'detrator' }
  sinal(score: number | null): string { return score === null ? 'neutro' : score >= 50 ? 'bom' : score >= 0 ? 'neutro' : 'ruim' }

  async carregar(anexar = false): Promise<void> {
    if (!anexar) { this.estado.set('carregando'); this.cursor = null }
    try {
      const url = `/v1/nps?dias=${this.dias()}${this.cursor ? `&cursor=${this.cursor}` : ''}`
      const r = await firstValueFrom(this.http.get<Nps>(url))
      this.d.set(r)
      this.comentarios.set(anexar ? [...this.comentarios(), ...r.comentarios] : r.comentarios)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async registrar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nota = this.nota()
    if (this.salvando() || nota === null) return
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/nps', { nota, comentario: this.comentario().trim() || undefined }))
      this.nota.set(null); this.comentario.set(''); this.mostrarNova.set(false)
      await this.carregar()
    } catch { this.erroForm.set('Não foi possível registrar a resposta.') } finally { this.salvando.set(false) }
  }
}
