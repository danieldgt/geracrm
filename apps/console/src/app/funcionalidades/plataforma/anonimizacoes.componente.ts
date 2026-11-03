import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { linhasPorMotivo, periodoDoMes, type RelatorioAnonimizacao } from '../crm/lgpd.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro'

/**
 * ANONIMIZAÇÕES do mês (raia H2) — painel de Privacidade e LGPD, só para admin.
 * Lê `GET /v1/lgpd/relatorio` (contagens por motivo; nenhum dado pessoal).
 */
@Component({
  selector: 'app-anonimizacoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="bloco" aria-labelledby="titulo-anonimizacoes">
      <h3 id="titulo-anonimizacoes" class="txt-secao">Anonimizações</h3>
      <p class="dica txt-corpo">Contatos que tiveram os dados pessoais apagados neste mês, por motivo. O prazo de retenção acima define quando os descartados entram.</p>
      @switch (estado()) {
        @case ('carregando') { <div class="esq" aria-hidden="true"></div> }
        @case ('erro') {
          <div class="vazio txt-corpo">Não foi possível carregar o relatório.
            <button class="btn btn--secundario" type="button" (click)="carregar()">Tentar de novo</button></div>
        }
        @case ('pronto') {
          @if (relatorio(); as r) {
            @if (r.total === 0) {
              <p class="vazio txt-corpo">Nenhum contato anonimizado neste mês.</p>
            } @else {
              <ul class="lista">
                @for (l of linhas(); track l.motivo) {
                  <li><span class="txt-corpo">{{ l.rotulo }}</span><strong class="txt-corpo">{{ l.total }}</strong></li>
                }
                <li class="total"><span class="txt-corpo">Total no mês</span><strong class="txt-corpo">{{ r.total }}</strong></li>
              </ul>
              @if (r.porModo.canais > 0) {
                <p class="dica txt-corpo">{{ r.porModo.canais }} com compra: só canais de contato e conversas foram apagados; o vínculo fiscal permanece.</p>
              }
            }
            @if (r.midiasPendentes > 0) {
              <p class="dica txt-corpo">{{ r.midiasPendentes }} arquivo(s) de mídia aguardando remoção do armazenamento.</p>
            }
          }
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; margin-top: var(--espacamento-5); }
    h3 { margin: 0 0 var(--espacamento-1); }
    .dica { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); }
    .esq { height: 96px; border-radius: var(--raio-controle); background: var(--superficie); }
    .vazio { color: var(--texto-suave); display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); margin: 0; }
    .lista { list-style: none; margin: 0 0 var(--espacamento-3); padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-controle); }
    .lista li { display: flex; justify-content: space-between; gap: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); }
    .lista li + li { border-top: 1px solid var(--borda); }
    .lista .total { background: var(--superficie); }
  `,
})
export class AnonimizacoesComponente implements OnInit {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly relatorio = signal<RelatorioAnonimizacao | null>(null)
  readonly linhas = signal<ReturnType<typeof linhasPorMotivo>>([])

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    const { de, ate } = periodoDoMes(new Date())
    try {
      const r = await firstValueFrom(this.http.get<RelatorioAnonimizacao>(`/v1/lgpd/relatorio?de=${de}&ate=${ate}`))
      this.relatorio.set(r)
      this.linhas.set(linhasPorMotivo(r))
      this.estado.set('pronto')
    } catch { this.estado.set('erro') }
  }
}
