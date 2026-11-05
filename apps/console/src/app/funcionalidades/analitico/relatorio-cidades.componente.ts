import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CelulaDiretiva, EsqueletoComponente, EstadoComponente, IconeComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Mapa {
  readonly total: number; readonly semEndereco: number
  readonly porCidade: { cidade: string; uf: string | null; contatos: number }[]
  /** `true` quando há mais cidades que as 50 listadas. */
  readonly porCidadeTruncado: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Top cidades da BASE INTEIRA (Relatórios → Contatos → UF; era a tela Mapa de Clientes). O relatório por UF
 * acima conta os contatos NOVOS do período; este bloco é o retrato da base toda, pelo endereço declarado (sem
 * geocoding), e nomeia quantos estão sem endereço.
 */
@Component({
  selector: 'app-relatorio-cidades',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CelulaDiretiva, EsqueletoComponente, EstadoComponente, IconeComponente, TabelaComponente],
  template: `
    <section class="painel" aria-labelledby="titulo-cidades">
      <h2 class="txt-secao" id="titulo-cidades">Top cidades da base</h2>
      <p class="txt-denso sub">A base inteira (não só o período), pelo endereço declarado.</p>
      @switch (estado()) {
        @case ('carregando') { <ui-esqueleto altura="160px" /> }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à distribuição da base" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as cidades" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as m) {
            <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chave">
              <ng-template uiCelula="contatos" let-c>
                <span class="barra-val">
                  <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(c.contatos, max())"></span></span>
                  <span class="val txt-dados">{{ c.contatos }}</span>
                </span>
              </ng-template>
              <div uiVazio><ui-estado titulo="Nenhum contato com cidade" descricao="O endereço declarado ainda não tem cidade." /></div>
            </ui-tabela>
            @if (m.porCidadeTruncado) {
              <p class="corte">Mostrando as 50 maiores cidades; há mais cidades fora desta lista.</p>
            }
            @if (m.semEndereco > 0) {
              <p class="sem">
                <ui-icone nome="alert-triangle" />
                <span>{{ m.semEndereco }} de {{ m.total }} contatos estão <strong>sem endereço</strong> e não entram na distribuição.</span>
              </p>
            }
          }
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .painel { display: grid; gap: var(--espacamento-3); padding: var(--espacamento-4); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    h2 { margin: 0; }
    .sub { margin: calc(-1 * var(--espacamento-2)) 0 0; color: var(--texto-secundario); }
    .barra-val { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 120px; }
    .barra { flex: 1; height: 6px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--acao); }
    .val { color: var(--texto-secundario); font-size: 12px; min-width: 32px; text-align: right; }
    .corte { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .sem { display: flex; align-items: flex-start; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-3) var(--espacamento-4);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
  `,
})
export class RelatorioCidadesComponente implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Mapa | null>(null)

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '44px' },
    { chave: 'cidade', rotulo: 'Cidade' },
    { chave: 'contatos', rotulo: 'Contatos' },
  ]
  protected readonly linhas = computed<LinhaTabela[]>(() => (this.d()?.porCidade ?? []).map((c, i) => ({
    posicao: i + 1, cidade: c.uf ? `${c.cidade}/${c.uf}` : c.cidade, chaveCidade: `${c.cidade}|${c.uf ?? ''}`, contatos: c.contatos,
  })))
  protected readonly chave = (l: LinhaTabela): string => String(l['chaveCidade'])

  ngOnInit(): void { void this.carregar() }
  pct(n: number, max: number): number { return max > 0 ? Math.round((n / max) * 100) : 0 }
  max(): number { return Math.max(1, ...(this.d()?.porCidade.map((c) => c.contatos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Mapa>('/v1/mapa'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
