import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { CrmAvancadoServico, type CardCliente } from './crm-avancado.servico.js'
import { CabecalhoTelaComponente, EstadoComponente } from '../../compartilhado/ui/index.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'

/**
 * CRM Avançado — consolidação da base por nº de pedidos + RFV. Board de LEITURA
 * (sem drag: não se forja uma compra). Card mostra o segmento RFV e permite
 * Descartar/Reabrir e abrir a conversa. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-crm-avancado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, EstadoComponente],
  template: `
    <ui-cabecalho-tela titulo="CRM Avançado"
      subtitulo="A base inteira por nº de pedidos e segmento RFV — quem esfria aparece de relance." />

    @if (servico.erroAcao(); as e) { <p class="erro-move" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') { <div class="board"><div class="col-esq"></div><div class="col-esq"></div><div class="col-esq"></div></div> }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Você não tem acesso à base"
          descricao="Peça a um administrador da sua empresa para liberar este acesso." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar a base" descricao="Tente de novo; nenhum dado foi alterado.">
          <button class="btn btn--primario" type="button" (click)="servico.carregar()">Tentar de novo</button>
        </ui-estado>
      }
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
                        <button type="button" class="a-reabrir" (click)="reabrir(card)">Reabrir</button>
                      } @else {
                        <button type="button" class="a-descartar" (click)="descartar(card)">Descartar</button>
                      }
                    </div>
                  </article>
                }
                @if (col.cards.length === 0) { <p class="col-vazia">Vazio</p> }
              </div>
              @if (col.proximoCursor) {
                <button type="button" class="mais" (click)="servico.carregarMais(col.chave)" [disabled]="col.carregandoMais">
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
    /* ⚠️ Altura DEFINIDA, e há dois jeitos de errar isto — os dois já
       aconteceram nesta tela:
       · height 100% vira ZERO, porque a casca é célula de grid e não resolve
         percentual do filho (foi o incidente dos 813 leads virando listras);
       · min-height não LIMITA nada, então o host cresce com o conteúdo, a
         coluna cresce junto e o overflow-y dela nunca dispara — a página
         inteira passa a rolar no lugar da coluna.
       O que sobra é a viewport menos a barra da casca. */
    :host { display: flex; flex-direction: column; height: calc(100dvh - var(--altura-barra-topo));
      padding: var(--espacamento-6); overflow: hidden; }
    .erro-move { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
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
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) calc(var(--espacamento-3) + var(--folga-flutuante, 0px)); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    /* ⚠️ flex:none: sem ele o flex-shrink do container rolável ESMAGA os cards
       até caberem em vez de rolar. Ver cards-nao-esmagam.spec.ts. */
    .card { flex: none; display: flex; flex-direction: column; background: var(--superficie-elevada); border: 1px solid var(--borda);
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
