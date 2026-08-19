import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Perf {
  readonly dias: number
  readonly slaMinutos: number
  readonly total: number
  readonly assumidos: number
  readonly respondidos: number
  readonly dentroSla: number
  readonly pctDentroSla: number | null
  readonly medianaRespostaSeg: number | null
  readonly porAtendente: { usuarioId: string | null; nome: string; respondidos: number; medianaRespostaSeg: number | null }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const PERIODOS = [{ dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }, { dias: 90, rotulo: '90 dias' }]

/**
 * Performance de atendimento — SLA e tempo de 1ª resposta HUMANA (a contra-métrica
 * MC-05: a automática de ausência não conta). Agregado sobre `atendimento`.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-performance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Performance</h1>
        <p class="sub">Quão rápido a equipe responde de verdade.</p>
      </div>
      <div class="abas">
        @for (p of periodos; track p.dias) {
          <button [class.on]="dias() === p.dias" (click)="trocar(p.dias)">{{ p.rotulo }}</button>
        }
      </div>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="kpis"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as p) {
          @if (p.total === 0) {
            <div class="bloco"><h2 class="txt-secao">Sem atendimentos no período</h2>
              <p>Os números aparecem quando houver conversas atendidas.</p></div>
          } @else {
            <div class="kpis">
              <div class="kpi">
                <span class="txt-rotulo">1ª resposta (mediana)</span>
                <span class="txt-kpi">{{ p.medianaRespostaSeg !== null ? dur(p.medianaRespostaSeg) : '—' }}</span>
                <span class="kpi-sub">tempo até responder</span>
              </div>
              <div class="kpi">
                <span class="txt-rotulo">Dentro do SLA</span>
                <span class="txt-kpi" [class.bom]="(p.pctDentroSla ?? 0) >= 80">{{ p.pctDentroSla !== null ? p.pctDentroSla + '%' : '—' }}</span>
                <span class="kpi-sub">respondidos em até {{ p.slaMinutos }} min</span>
              </div>
              <div class="kpi">
                <span class="txt-rotulo">Atendimentos</span>
                <span class="txt-kpi">{{ p.total }}</span>
                <span class="kpi-sub">{{ p.respondidos }} respondidos por gente</span>
              </div>
            </div>

            <section class="painel">
              <h2 class="txt-secao">Por atendente</h2>
              @if (p.porAtendente.length === 0) { <p class="vazio">Ninguém respondeu no período.</p> }
              @else {
                <ul>
                  @for (a of p.porAtendente; track a.usuarioId ?? 'sem'; let i = $index) {
                    <li>
                      <span class="pos">{{ i + 1 }}</span>
                      <span class="rot encolhe">{{ a.nome }}</span>
                      <span class="mid txt-dados">{{ a.medianaRespostaSeg !== null ? dur(a.medianaRespostaSeg) : '—' }}</span>
                      <span class="val txt-dados">{{ a.respondidos }} resp.</span>
                    </li>
                  }
                </ul>
              }
            </section>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .abas { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .abas button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); }
    .kpi { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); display: flex; flex-direction: column; gap: var(--espacamento-1); }
    .kpi-sub { font-size: 12px; color: var(--texto-suave); }
    .txt-kpi.bom { color: var(--sucesso); }
    .esq { height: 96px; border-radius: var(--raio-painel); background: var(--superficie); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    li { display: grid; grid-template-columns: 20px 1fr auto auto; align-items: center; gap: var(--espacamento-3); }
    .pos { color: var(--texto-suave); font-size: 12px; text-align: center; }
    .rot { color: var(--texto); font-size: 13px; }
    .mid { color: var(--texto-secundario); font-size: 12px; }
    .val { color: var(--texto-suave); font-size: 12px; }
    .vazio { color: var(--texto-suave); font-size: 13px; margin: 0; }
  `,
})
export class PerformancePagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly periodos = PERIODOS
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Perf | null>(null)
  readonly dias = signal(30)

  ngOnInit(): void { void this.carregar() }
  trocar(dias: number): void { this.dias.set(dias); void this.carregar() }

  // Segundos → "42s" / "3m 20s" / "1h 05m".
  dur(seg: number): string {
    if (seg < 60) return `${seg}s`
    const m = Math.floor(seg / 60), s = seg % 60
    if (m < 60) return s ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`
    const h = Math.floor(m / 60), mm = m % 60
    return `${h}h ${String(mm).padStart(2, '0')}m`
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Perf>(`/v1/performance?dias=${this.dias()}`))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
