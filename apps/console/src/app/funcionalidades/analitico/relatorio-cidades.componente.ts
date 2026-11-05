import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, IconeComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Mapa {
  readonly total: number; readonly semEndereco: number
  readonly porEstado: { uf: string; contatos: number }[]
  readonly porCidade: { cidade: string; uf: string | null; contatos: number }[]
  /** `true` quando há mais cidades que as 50 listadas. */
  readonly porCidadeTruncado: boolean
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Mapa de Clientes — distribuição geográfica pelo ENDEREÇO DECLARADO (sem
 * geocoding). ⚠️ Honesto: não finge um mapa com pino; mostra a base por UF e
 * cidade e nomeia o "sem endereço". Padrão Lista de leitura: duas tabelas com
 * barra de proporção na célula.
 */
@Component({
  selector: 'app-mapa',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, IconeComponente, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Mapa de Clientes" subtitulo="Onde sua base está, pelo endereço declarado." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="grade" aria-busy="true"><ui-esqueleto altura="200px" /></div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso ao mapa de clientes" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o mapa" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as m) {
            @if (m.total === 0) {
              <ui-estado titulo="Base sem endereços ainda" descricao="Cadastre clientes com endereço para ver a distribuição." />
            } @else {
              <p class="nota">
                <ui-icone nome="map-pin" />
                <span>Distribuição por <strong>endereço declarado</strong> — ainda sem mapa geográfico (geocoding). Quando o endereço virar coordenada, isto vira o mapa com pinos.</span>
              </p>

              <div class="grade">
                <section class="painel" aria-labelledby="titulo-uf">
                  <h2 class="txt-secao" id="titulo-uf">Por estado (UF)</h2>
                  <ui-tabela [colunas]="colunasUf" [linhas]="linhasUf()" [chaveLinha]="chaveUf">
                    <ng-template uiCelula="contatos" let-e>
                      <span class="barra-val">
                        <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(e.contatos, maxEstado())"></span></span>
                        <span class="val txt-dados">{{ e.contatos }}</span>
                      </span>
                    </ng-template>
                    <div uiVazio><ui-estado titulo="Nenhum contato com UF" descricao="O endereço declarado ainda não tem estado." /></div>
                  </ui-tabela>
                </section>

                <section class="painel" aria-labelledby="titulo-cidades">
                  <h2 class="txt-secao" id="titulo-cidades">Top cidades</h2>
                  <ui-tabela [colunas]="colunasCidade" [linhas]="linhasCidade()" [chaveLinha]="chaveCidade">
                    <ng-template uiCelula="contatos" let-c>
                      <span class="barra-val">
                        <span class="barra" aria-hidden="true"><span class="fill" [style.width.%]="pct(c.contatos, maxCidade())"></span></span>
                        <span class="val txt-dados">{{ c.contatos }}</span>
                      </span>
                    </ng-template>
                    <div uiVazio><ui-estado titulo="Nenhum contato com cidade" descricao="O endereço declarado ainda não tem cidade." /></div>
                  </ui-tabela>
                  @if (m.porCidadeTruncado) {
                    <p class="corte">Mostrando as 50 maiores cidades; há mais cidades fora desta lista.</p>
                  }
                </section>
              </div>

              @if (m.semEndereco > 0) {
                <p class="sem">
                  <ui-icone nome="alert-triangle" />
                  <span>{{ m.semEndereco }} de {{ m.total }} contatos estão <strong>sem endereço</strong> — não entram na distribuição. Complete o cadastro para o mapa ficar fiel.</span>
                </p>
              }
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .nota, .sem { display: flex; align-items: flex-start; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-3) var(--espacamento-4);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); font-size: 13px; line-height: 1.5; }
    .nota { background: var(--superficie); color: var(--texto-secundario); }
    .sem { background: var(--atencao-suave); color: var(--texto); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: var(--espacamento-4); align-items: start; min-width: 0; }
    .painel { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .barra-val { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 120px; }
    .barra { flex: 1; height: 6px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--acao); }
    .val { color: var(--texto-secundario); font-size: 12px; min-width: 32px; text-align: right; }
    .corte { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
  `,
})
export class MapaPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Mapa | null>(null)

  protected readonly colunasUf: readonly ColunaTabela[] = [
    { chave: 'uf', rotulo: 'UF', mono: true, largura: '72px' },
    { chave: 'contatos', rotulo: 'Contatos' },
  ]
  protected readonly colunasCidade: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', mono: true, largura: '44px' },
    { chave: 'cidade', rotulo: 'Cidade' },
    { chave: 'contatos', rotulo: 'Contatos' },
  ]
  protected readonly linhasUf = computed<LinhaTabela[]>(() => (this.d()?.porEstado ?? []) as unknown as LinhaTabela[])
  protected readonly linhasCidade = computed<LinhaTabela[]>(() => (this.d()?.porCidade ?? []).map((c, i) => ({
    posicao: i + 1, cidade: c.uf ? `${c.cidade}/${c.uf}` : c.cidade, chaveCidade: `${c.cidade}|${c.uf ?? ''}`, contatos: c.contatos,
  })))
  protected readonly chaveUf = (l: LinhaTabela): string => String(l['uf'])
  protected readonly chaveCidade = (l: LinhaTabela): string => String(l['chaveCidade'])

  ngOnInit(): void { void this.carregar() }
  pct(n: number, max: number): number { return max > 0 ? Math.round((n / max) * 100) : 0 }
  maxEstado(): number { return Math.max(1, ...(this.d()?.porEstado.map((e) => e.contatos) ?? [])) }
  maxCidade(): number { return Math.max(1, ...(this.d()?.porCidade.map((c) => c.contatos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Mapa>('/v1/mapa'))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
