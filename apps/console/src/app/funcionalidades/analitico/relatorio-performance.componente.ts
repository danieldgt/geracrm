import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { MetricaSlaHandoff } from '@geracrm/shared'
import {
  AbasComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, StatCardComponente,
  TabelaComponente, type Aba, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Perf {
  readonly dias: number
  readonly slaMinutos: number
  /** P18: 'handoff' = SLA configurado (cumprido dos handoffs, minutos úteis); 'fixo' = 5 min de relógio. */
  readonly slaFonte?: 'handoff' | 'fixo'
  readonly slaMinutosVariam?: boolean
  /** Contagem geral de atendimentos respondidos por gente (com SLA configurado, `respondidos` vira a base do SLA). */
  readonly respondidosPorGente?: number
  readonly slaHandoff?: MetricaSlaHandoff
  readonly total: number
  readonly assumidos: number
  readonly respondidos: number
  readonly dentroSla: number
  readonly pctDentroSla: number | null
  readonly medianaRespostaSeg: number | null
  readonly porAtendente: { usuarioId: string | null; nome: string; respondidos: number; medianaRespostaSeg: number | null }[]
  /** Teto da equipe (200): `true` quando há mais atendentes que os listados. */
  readonly porAtendenteTruncado: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const PERIODOS = [{ dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }, { dias: 90, rotulo: '90 dias' }]

/**
 * Tempo de resposta (aba Atendimento de Relatórios; era a tela Performance) — SLA e tempo de 1ª resposta HUMANA (a contra-métrica
 * MC-05: a automática de ausência não conta). Agregado sobre `atendimento`.
 * Padrão Lista de leitura: período em abas, indicadores em ui-stat-card e o
 * ranking por atendente em ui-tabela.
 */
@Component({
  selector: 'app-relatorio-performance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbasComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, StatCardComponente, TabelaComponente],
  template: `
    <h2 class="txt-secao titulo">Tempo de resposta</h2>
    <p class="txt-corpo sub">Quão rápido a equipe responde de verdade — a resposta automática de ausência não conta.</p>
    <div class="periodo">
      <ui-abas [abas]="abasPeriodo" [ativa]="periodoAtivo()" (ativaChange)="trocar($event)" />
    </div>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="kpis" aria-busy="true">
            <ui-esqueleto altura="96px" />
            <ui-esqueleto altura="96px" />
            <ui-esqueleto altura="96px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à performance" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a performance" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as p) {
            @if (p.total === 0) {
              <ui-estado titulo="Sem atendimentos no período" descricao="Os números aparecem quando houver conversas atendidas." />
            } @else {
              <div class="kpis">
                <div class="kpi-bloco">
                  <ui-stat-card rotulo="1ª resposta (mediana)" [valor]="p.medianaRespostaSeg !== null ? dur(p.medianaRespostaSeg) : '—'" />
                  <p class="dica">tempo até responder</p>
                </div>
                <div class="kpi-bloco">
                  <ui-stat-card [rotulo]="p.slaFonte === 'handoff' ? 'SLA cumprido' : 'Dentro do SLA'" tom="sucesso"
                    [valor]="p.pctDentroSla !== null ? p.pctDentroSla + '%' : '—'" />
                  @if (p.slaFonte === 'handoff') {
                    <p class="dica">transferidos pelo agente respondidos em até {{ p.slaMinutosVariam ? 'o SLA do número' : p.slaMinutos + ' min úteis' }}
                      ({{ p.slaHandoff?.cumpridos ?? 0 }} de {{ p.slaHandoff?.medidos ?? 0 }})</p>
                  } @else {
                    <p class="dica">respondidos em até {{ p.slaMinutos }} min</p>
                  }
                </div>
                <div class="kpi-bloco">
                  <ui-stat-card rotulo="Atendimentos" [valor]="p.total" />
                  <p class="dica">{{ p.respondidosPorGente ?? p.respondidos }} respondidos por gente</p>
                </div>
              </div>

              <section class="painel" aria-labelledby="titulo-atendentes">
                <h2 class="txt-secao" id="titulo-atendentes">Por atendente</h2>
                <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chaveAtendente">
                  <ng-template uiCelula="mediana" let-a>
                    <span class="txt-dados">{{ a.mediana !== null ? dur(a.mediana) : '—' }}</span>
                  </ng-template>
                  <div uiVazio><ui-estado titulo="Ninguém respondeu no período" descricao="As respostas humanas aparecem aqui assim que houver." /></div>
                </ui-tabela>
                @if (p.porAtendenteTruncado) {
                  <p class="dica">Mostrando os 200 atendentes com mais respostas; há mais atendentes fora desta lista.</p>
                }
              </section>
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .titulo { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); }
    .periodo { margin-top: var(--espacamento-3); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-4); min-width: 0; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: var(--espacamento-3); }
    .kpi-bloco { display: grid; gap: var(--espacamento-1); align-content: start; min-width: 0; }
    .dica { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
  `,
})
export class RelatorioPerformanceComponente implements OnInit {
  private readonly http = inject(HttpClient)
  readonly abasPeriodo: readonly Aba[] = PERIODOS.map((p) => ({ id: String(p.dias), rotulo: p.rotulo }))
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Perf | null>(null)
  readonly dias = signal(30)
  readonly periodoAtivo = computed(() => String(this.dias()))

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '40px' },
    { chave: 'nome', rotulo: 'Atendente' },
    { chave: 'mediana', rotulo: 'Mediana até responder', alinhamento: 'dir', largura: '180px' },
    { chave: 'respondidos', rotulo: 'Respondidos', alinhamento: 'dir', mono: true, largura: '120px' },
  ]
  protected readonly linhas = computed<LinhaTabela[]>(() => (this.d()?.porAtendente ?? []).map((a, i) => ({
    posicao: i + 1, nome: a.nome, mediana: a.medianaRespostaSeg, respondidos: a.respondidos, chaveAtendente: a.usuarioId ?? 'sem',
  })))
  protected readonly chaveAtendente = (l: LinhaTabela): string => String(l['chaveAtendente'])

  ngOnInit(): void { void this.carregar() }
  trocar(dias: string): void { this.dias.set(Number(dias)); void this.carregar() }

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
