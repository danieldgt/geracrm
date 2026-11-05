import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, StatCardComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Fidelidade {
  readonly disponivel: boolean
  readonly motivo?: 'sem_conector' | 'erp_sem_fidelidade'
  readonly resumo?: { clientesComSaldo: number; totalSaldo: number; unidade: string; sincronizadoEm: string | null }
  readonly topSaldos?: { contatoId: string; contato: string; saldo: number; unidade: string }[]
  /** `true` quando há mais saldos positivos que os 20 listados. */
  readonly topSaldosTruncado?: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Fidelidade / Cashback — saldo LIDO do ERP (ADR-020). ⚠️ Degradação honesta: sem
 * um conector que forneça fidelidade, os blocos de saldo SOMEM e a tela explica —
 * não mostra número inventado nem controle desabilitado. Padrão Lista (leitura):
 * cabeçalho, indicadores e a tabela dos maiores saldos.
 */
@Component({
  selector: 'app-fidelidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, CelulaDiretiva, DatePipe, EsqueletoComponente, EstadoComponente, RouterLink, StatCardComponente, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Fidelidade / Cashback"
      subtitulo="O saldo vem do seu ERP; aqui você vê e usa na conversa. A gestão do saldo é no ERP." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true">
            <ui-esqueleto altura="96px" />
            <ui-esqueleto altura="180px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à fidelidade" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a fidelidade" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as f) {
            <!-- Degradação VISÍVEL (ADR-008): explica, não mostra número falso. -->
            @if (!f.disponivel) {
              @if (f.motivo === 'sem_conector') {
                <ui-estado titulo="Fidelidade indisponível: nenhum ERP conectado"
                  descricao="O saldo de fidelidade é lido do ERP. Quando você conectar um que forneça esse recurso, os saldos aparecem aqui automaticamente.">
                  <a class="btn btn--primario" routerLink="/integracao">Conectar um ERP</a>
                </ui-estado>
              } @else {
                <ui-estado titulo="Fidelidade indisponível neste ERP"
                  descricao="O ERP conectado não fornece saldo de fidelidade. Nada é gerido por aqui: o saldo mora no ERP. Se trocar para um conector com esse recurso, os saldos passam a aparecer.">
                  <a class="btn btn--secundario" routerLink="/integracao">Ver conexões</a>
                </ui-estado>
              }
            } @else if (f.resumo; as r) {
              <div class="kpis">
                <ui-stat-card rotulo="Clientes com saldo" [valor]="r.clientesComSaldo" />
                <ui-stat-card [rotulo]="r.unidade === 'pontos' ? 'Saldo total em pontos' : 'Saldo total em cashback'"
                  [valor]="valor(r.totalSaldo, r.unidade)" tom="acao" />
                <ui-stat-card rotulo="Sincronizado do ERP" [valor]="(r.sincronizadoEm | date: 'dd/MM HH:mm') ?? '—'" />
              </div>
              <p class="nota">O saldo não é ao vivo: ele vem da última sincronização com o ERP.</p>

              <h2 class="txt-secao voz">Maiores saldos</h2>
              @if (topo().length === 0) {
                <ui-estado titulo="Nenhum saldo sincronizado ainda"
                  descricao="A fidelidade está ativa no ERP, mas os saldos ainda não chegaram. Eles entram na próxima sincronização." />
              } @else {
                <ui-tabela [colunas]="colunas" [linhas]="topo()" [chaveLinha]="chaveContato">
                  <ng-template uiCelula="contato" let-t>
                    <a class="nome" [routerLink]="['/contato', t.contatoId]">{{ t.contato }}</a>
                  </ng-template>
                </ui-tabela>
                @if (d()?.topSaldosTruncado) {
                  <p class="nota">Mostrando os 20 maiores saldos; há mais clientes com saldo fora desta lista.</p>
                }
              }
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .esqueletos { display: grid; gap: var(--espacamento-2); }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .nota { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .voz { margin: var(--espacamento-4) 0 var(--espacamento-2); }
    .nome { color: var(--acao); text-decoration: none; font-size: 14px; }
    .nome:hover { text-decoration: underline; }
    .nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class FidelidadePagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Fidelidade | null>(null)

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', largura: '56px', mono: true },
    { chave: 'contato', rotulo: 'Contato' },
    { chave: 'saldo', rotulo: 'Saldo', alinhamento: 'dir', mono: true },
  ]
  /** Linhas da tabela: posição 1-based, saldo já formatado para exibição. */
  protected readonly topo = computed<LinhaTabela[]>(() => (this.d()?.topSaldos ?? []).map((t, i) => ({
    posicao: i + 1, contatoId: t.contatoId, contato: t.contato, saldo: this.valor(t.saldo, t.unidade),
  })))
  protected readonly chaveContato = (l: LinhaTabela): string => String(l['contatoId'])

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
