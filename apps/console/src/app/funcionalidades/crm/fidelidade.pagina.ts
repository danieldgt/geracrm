import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Fidelidade {
  readonly disponivel: boolean
  readonly motivo?: 'sem_conector' | 'erp_sem_fidelidade'
  readonly resumo?: { clientesComSaldo: number; totalSaldo: number; unidade: string; sincronizadoEm: string | null }
  readonly topSaldos?: { contatoId: string; contato: string; saldo: number; unidade: string }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Fidelidade / Cashback — saldo LIDO do ERP (ADR-020). ⚠️ Degradação honesta: sem
 * um conector que forneça fidelidade, os blocos de saldo SOMEM e a tela explica —
 * não mostra número inventado nem controle desabilitado. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-fidelidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Fidelidade / Cashback</h1>
      <p class="sub">O saldo vem do seu ERP; aqui você vê e usa na conversa. A gestão do saldo é no ERP.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="bloco esq"></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (d(); as f) {
          @if (!f.disponivel) {
            <!-- Degradação VISÍVEL (ADR-008): explica, não mostra número falso. -->
            <div class="degradado">
              <span class="ícone" aria-hidden="true">🎁</span>
              <h2 class="txt-secao">Fidelidade indisponível neste ERP</h2>
              @if (f.motivo === 'sem_conector') {
                <p>Você ainda não conectou um ERP. O saldo de fidelidade é <strong>lido do ERP</strong> — quando conectar um que forneça esse recurso, os saldos aparecem aqui automaticamente.</p>
                <a class="cta" routerLink="/integracao">Conectar um ERP</a>
              } @else {
                <p>O ERP conectado <strong>não fornece</strong> saldo de fidelidade. Nada é gerido por aqui (o saldo mora no ERP); se trocar para um conector com esse recurso, os saldos passam a aparecer.</p>
                <a class="cta" routerLink="/integracao">Ver conexões</a>
              }
            </div>
          } @else if (f.resumo; as r) {
            <div class="kpis">
              <div class="kpi">
                <span class="txt-rotulo">Clientes com saldo</span>
                <span class="txt-kpi">{{ r.clientesComSaldo }}</span>
              </div>
              <div class="kpi">
                <span class="txt-rotulo">Saldo total</span>
                <span class="txt-kpi">{{ valor(r.totalSaldo, r.unidade) }}</span>
                <span class="kpi-sub">{{ r.unidade === 'pontos' ? 'em pontos' : 'em cashback' }}</span>
              </div>
              <div class="kpi sync">
                <span class="txt-rotulo">Sincronizado do ERP</span>
                <span class="kpi-sync">{{ r.sincronizadoEm ? (r.sincronizadoEm | date: 'dd/MM HH:mm') : '—' }}</span>
                <span class="kpi-sub">o saldo não é ao vivo</span>
              </div>
            </div>

            <h2 class="txt-secao voz">Maiores saldos</h2>
            @if (!f.topSaldos || f.topSaldos.length === 0) {
              <div class="bloco"><p>Fidelidade ativa no ERP, mas nenhum saldo sincronizado ainda.</p></div>
            } @else {
              <ul class="lista">
                @for (t of f.topSaldos; track t.contatoId; let i = $index) {
                  <li class="linha">
                    <span class="pos">{{ i + 1 }}</span>
                    <a class="nome encolhe" [routerLink]="['/contato', t.contatoId]">{{ t.contato }}</a>
                    <span class="saldo txt-dados">{{ valor(t.saldo, t.unidade) }}</span>
                  </li>
                }
              </ul>
            }
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; max-width: 60ch; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 140px; }
    .degradado { padding: var(--espacamento-8) var(--espacamento-6); border: 1px dashed var(--borda-forte); border-radius: var(--raio-painel); background: var(--superficie); text-align: center; }
    .degradado .ícone { font-size: 34px; display: block; margin-bottom: var(--espacamento-2); }
    .degradado h2 { margin: 0 0 var(--espacamento-2); }
    .degradado p { margin: 0 auto var(--espacamento-4); color: var(--texto-secundario); font-size: 14px; max-width: 52ch; line-height: 1.5; }
    .cta { display: inline-block; padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); text-decoration: none; font-size: 14px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); }
    .kpi { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); display: flex; flex-direction: column; gap: 2px; }
    .kpi-sub { font-size: 12px; color: var(--texto-suave); }
    .kpi-sync { font-size: 15px; color: var(--texto); font-variant-numeric: tabular-nums; }
    .voz { margin: var(--espacamento-4) 0 var(--espacamento-3); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .linha { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .linha:last-child { border-bottom: none; }
    .pos { color: var(--texto-suave); font-size: 12px; width: 18px; text-align: center; flex: none; }
    .nome { flex: 1; color: var(--acao); text-decoration: none; font-size: 14px; }
    .saldo { color: var(--texto); font-weight: 600; flex: none; }
  `,
})
export class FidelidadePagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Fidelidade | null>(null)

  ngOnInit(): void { void this.carregar() }
  valor(v: number, unidade: string): string {
    return unidade === 'pontos'
      ? `${v.toLocaleString('pt-BR')} pts`
      : (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Fidelidade>('/v1/fidelidade'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
