import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { CrmAvancadoServico, type CardCliente } from './crm-avancado.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'

/**
 * CRM Avançado — consolidação da base por nº de pedidos + RFV. Board de LEITURA
 * (sem drag: não se forja uma compra). Card mostra o segmento RFV e permite
 * Descartar/Reabrir e abrir a conversa. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-crm-avancado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">CRM Avançado</h1>
        <p class="sub">A base inteira por nº de pedidos e segmento RFV — quem esfria aparece de relance.</p>
      </div>
    </header>

    @if (servico.erroAcao(); as e) { <p class="erro-move" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') { <div class="board"><div class="col-esq"></div><div class="col-esq"></div><div class="col-esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2 class="txt-secao">Sem acesso à base</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
        <button (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="board rolagem-x">
          @for (col of servico.colunas(); track col.chave) {
            <section class="coluna" [class]="'coluna--' + col.chave">
              <header class="col-topo">
                <span class="col-nome txt-secao">{{ col.nome }}</span>
                <span class="col-total">{{ col.total }}</span>
              </header>
              <div class="col-cards">
                @for (card of col.cards; track card.contatoId) {
                  <article class="card">
                    <button class="card-abrir" type="button" (click)="abrir(card)" [disabled]="!card.conversaId"
                            [title]="card.conversaId ? 'Abrir conversa' : 'Sem conversa ainda'">
                      <span class="card-topo">
                        <span class="card-nome encolhe">{{ card.nome }}</span>
                        @if (card.segmento) {
                          <span class="rfv" [style.--c]="cor(card.segmento.codigo)">{{ card.segmento.rotulo }}</span>
                        }
                      </span>
                      <span class="card-linha">
                        @if (card.telefone) { <span class="card-tel">{{ card.telefone }}</span> }
                        @if (card.uf) { <span class="card-uf">{{ card.uf }}</span> }
                      </span>
                      <span class="card-linha">
                        <span class="card-resp" [class.orfa]="!card.responsavel">{{ card.responsavel || 'sem responsável' }}</span>
                        <span class="card-valor">{{ reais(card.totalCentavos) }}</span>
                      </span>
                      <span class="card-linha sub2">
                        <span>{{ card.qtdVendas }} {{ card.qtdVendas === 1 ? 'pedido' : 'pedidos' }}</span>
                        @if (card.ultimaVendaEm) { <span>última {{ diasDe(card.ultimaVendaEm) }}</span> }
                      </span>
                    </button>
                    <div class="card-acoes">
                      @if (col.chave === 'descartados') {
                        <button class="a-reabrir" (click)="reabrir(card)">Reabrir</button>
                      } @else {
                        <button class="a-descartar" (click)="descartar(card)">Descartar</button>
                      }
                    </div>
                  </article>
                }
                @if (col.cards.length === 0) { <p class="col-vazia">Vazio</p> }
              </div>
              @if (col.proximoCursor) {
                <button class="mais" (click)="servico.carregarMais(col.chave)" [disabled]="col.carregandoMais">
                  {{ col.carregandoMais ? 'Carregando…' : 'Carregar mais' }}
                </button>
              }
            </section>
          }
        </div>
      }
    }
  `,
  styles: `
    /* ⚠️ NÃO volte para height 100%. A casca põe a tela numa CÉLULA DE GRID com
       overflow próprio, e célula de grid não resolve altura percentual do filho:
       o 100% vira zero, o board com flex 1 colapsa e os cards espremem para 1px.
       Aconteceu com 813 leads em 27/ago. E havia DOIS display na mesma regra —
       o segundo vencia calado. */
    :host { display: flex; flex-direction: column; min-height: 100dvh;
      padding: var(--espacamento-6); overflow: hidden; }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .erro-move { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .board { display: flex; gap: var(--espacamento-3); align-items: stretch; flex: 1; min-height: 0; overflow-x: auto; padding-bottom: var(--espacamento-2); }
    .col-esq { width: 300px; height: 200px; border-radius: var(--raio-painel); background: var(--superficie); flex: none; }
    .coluna { width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .coluna--leads { border-top: 2px solid var(--texto-suave); }
    .coluna--p1 { border-top: 2px solid var(--acao); }
    .coluna--p2 { border-top: 2px solid var(--acao); }
    .coluna--p3 { border-top: 2px solid var(--sucesso); }
    .coluna--representantes { border-top: 2px solid var(--atencao); }
    .coluna--descartados { border-top: 2px solid var(--texto-suave); }
    .col-topo { display: flex; align-items: center; justify-content: space-between; padding: var(--espacamento-3) var(--espacamento-4); }
    .col-nome { color: var(--texto); }
    .col-total { font-size: 12px; color: var(--texto-suave); background: var(--fundo); padding: 1px 8px; border-radius: var(--raio-completo); font-variant-numeric: tabular-nums; }
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) var(--espacamento-3); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    .card { display: flex; flex-direction: column; background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-radius: var(--raio-controle); box-shadow: var(--elevacao-nenhuma); overflow: hidden; }
    .card-abrir { display: flex; flex-direction: column; gap: 4px; padding: var(--espacamento-3); border: 0; background: none; text-align: left; color: inherit; font: inherit; cursor: pointer; width: 100%; }
    .card-abrir:disabled { cursor: default; }
    .card-topo { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); }
    .card-nome { font-size: 13px; font-weight: 600; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rfv { flex: none; font-size: 10px; font-weight: 600; color: var(--c); border: 1px solid var(--c); border-radius: var(--raio-completo); padding: 0 7px; white-space: nowrap; }
    .card-linha { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); }
    .card-tel { font-size: 12px; color: var(--texto-secundario); font-variant-numeric: tabular-nums; }
    .card-uf { font-size: 11px; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-completo); padding: 0 6px; }
    .card-resp { font-size: 11px; color: var(--texto-suave); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-resp.orfa { color: var(--atencao); }
    .card-valor { font-size: 12px; color: var(--sucesso); font-variant-numeric: tabular-nums; }
    .sub2 { font-size: 11px; color: var(--texto-suave); }
    .card-acoes { display: flex; gap: 4px; padding: 4px var(--espacamento-3) var(--espacamento-3); }
    .card-acoes button { flex: 1; padding: 4px 6px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto-secundario); font: inherit; font-size: 11px; cursor: pointer; }
    .a-descartar:hover { background: var(--erro-suave); color: var(--erro); border-color: var(--erro); }
    .a-reabrir:hover { background: var(--acao-suave); color: var(--acao); border-color: var(--acao); }
    .col-vazia { margin: var(--espacamento-2) 0; color: var(--texto-suave); font-size: 12px; text-align: center; }
    .mais { margin: 0 var(--espacamento-3) var(--espacamento-3); padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    button { cursor: pointer; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .coluna, .col-esq { width: 260px; } }
  `,
})
export class CrmAvancadoPagina implements OnInit {
  readonly servico = inject(CrmAvancadoServico)
  private readonly inbox = inject(InboxServico)

  ngOnInit(): void { void this.servico.carregar() }

  abrir(card: CardCliente): void { if (card.conversaId) void this.inbox.abrir(card.conversaId) }
  descartar(card: CardCliente): void { void this.servico.qualificar(card.contatoId, 'descartado') }
  reabrir(card: CardCliente): void { void this.servico.qualificar(card.contatoId, 'novo') }

  cor(codigo: string): string { return `var(--rfv-${codigo})` }
  reais(centavos: number): string { return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  diasDe(iso: string): string {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
    return d <= 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d}d`
  }
}
