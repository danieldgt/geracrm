import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core'
import { CdkDropListGroup, CdkDropList, CdkDrag, type CdkDragDrop, transferArrayItem } from '@angular/cdk/drag-drop'
import { LeadsServico, type CardLead, type ChaveLead, type ColunaLead } from './leads.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'

/**
 * CRM (Leads) — kanban de qualificação do lead novo (eixo negociação/aquisição).
 * Três colunas: Leads / Qualificados / Descartados. Arrastar entre colunas (ou
 * os botões rápidos) muda a qualificação; clicar no card abre a conversa.
 * Segue geracrm-layout-ui: tokens, 5 estados, sem sobreposição.
 */
@Component({
  selector: 'app-leads',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">CRM — Leads</h1>
        <p class="sub">Qualifique quem vale o esforço. Arraste o card ou use os botões.</p>
      </div>
    </header>

    @if (servico.erroMove(); as e) { <p class="erro-move" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') { <div class="board"><div class="col-esq"></div><div class="col-esq"></div><div class="col-esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2 class="txt-secao">Sem acesso aos leads</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
        <button (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="board rolagem-x" cdkDropListGroup>
          @for (col of servico.colunas(); track col.chave) {
            <section class="coluna" [class]="'coluna--' + col.chave">
              <header class="col-topo">
                <span class="col-nome txt-secao">{{ col.nome }}</span>
                <span class="col-total">{{ col.total }}</span>
              </header>
              <div class="col-cards" cdkDropList [cdkDropListData]="col" (cdkDropListDropped)="soltou($event, col)">
                @for (card of col.cards; track card.contatoId) {
                  <article class="card" cdkDrag [cdkDragData]="card">
                    <button class="card-abrir" type="button" (click)="abrir(card)" [disabled]="!card.conversaId"
                            [title]="card.conversaId ? 'Abrir conversa' : 'Sem conversa ainda'">
                      <span class="card-nome encolhe">{{ card.nome }}</span>
                      <span class="card-linha">
                        @if (card.telefone) { <span class="card-tel">{{ card.telefone }}</span> }
                        @if (card.uf) { <span class="card-uf">{{ card.uf }}</span> }
                      </span>
                      <span class="card-linha">
                        <span class="card-resp" [class.orfa]="!card.responsavel">{{ card.responsavel || 'sem responsável' }}</span>
                        @if (card.qtdVendas > 0) { <span class="card-vendas">🛒 {{ card.qtdVendas }}</span> }
                      </span>
                    </button>
                    <div class="card-acoes">
                      @if (col.chave !== 'qualificado') { <button class="a-qualificar" (click)="mover(card, 'qualificado')">Qualificar</button> }
                      @if (col.chave !== 'descartado') { <button class="a-descartar" (click)="mover(card, 'descartado')">Descartar</button> }
                      @if (col.chave !== 'novo') { <button class="a-reabrir" (click)="mover(card, 'novo')">Reabrir</button> }
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
    :host { display: block; height: 100%; padding: var(--espacamento-6); overflow: hidden; display: flex; flex-direction: column; }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .erro-move { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .board { display: flex; gap: var(--espacamento-3); align-items: flex-start; flex: 1; min-height: 0; padding-bottom: var(--espacamento-2); }
    .col-esq { width: 300px; height: 200px; border-radius: var(--raio-painel); background: var(--superficie); flex: none; }
    .coluna { width: 300px; flex: none; display: flex; flex-direction: column; max-height: 100%;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .coluna--novo { border-top: 2px solid var(--acao); }
    .coluna--qualificado { border-top: 2px solid var(--sucesso); }
    .coluna--descartado { border-top: 2px solid var(--texto-suave); }
    .col-topo { display: flex; align-items: center; justify-content: space-between; padding: var(--espacamento-3) var(--espacamento-4); }
    .col-nome { color: var(--texto); }
    .col-total { font-size: 12px; color: var(--texto-suave); background: var(--fundo); padding: 1px 8px; border-radius: var(--raio-completo); font-variant-numeric: tabular-nums; }
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) var(--espacamento-3); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    .card { display: flex; flex-direction: column; background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-left: 3px solid var(--borda-forte); border-radius: var(--raio-controle); cursor: grab; box-shadow: var(--elevacao-nenhuma); overflow: hidden; }
    .card:active { cursor: grabbing; }
    .card-abrir { display: flex; flex-direction: column; gap: 3px; padding: var(--espacamento-3); border: 0; background: none; text-align: left; color: inherit; font: inherit; cursor: pointer; width: 100%; }
    .card-abrir:disabled { cursor: grab; }
    .card-nome { font-size: 13px; font-weight: 600; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-linha { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); }
    .card-tel { font-size: 12px; color: var(--texto-secundario); font-variant-numeric: tabular-nums; }
    .card-uf { font-size: 11px; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-completo); padding: 0 6px; }
    .card-resp { font-size: 11px; color: var(--texto-suave); }
    .card-resp.orfa { color: var(--atencao); }
    .card-vendas { font-size: 11px; color: var(--texto-suave); }
    .card-acoes { display: flex; gap: 4px; padding: 6px var(--espacamento-3) var(--espacamento-3); }
    .card-acoes button { flex: 1; padding: 4px 6px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto-secundario); font: inherit; font-size: 11px; cursor: pointer; }
    .a-qualificar:hover { background: var(--sucesso-suave); color: var(--sucesso); border-color: var(--sucesso); }
    .a-descartar:hover { background: var(--erro-suave); color: var(--erro); border-color: var(--erro); }
    .a-reabrir:hover { background: var(--acao-suave); color: var(--acao); border-color: var(--acao); }
    .col-vazia { margin: var(--espacamento-2) 0; color: var(--texto-suave); font-size: 12px; text-align: center; }
    .mais { margin: 0 var(--espacamento-3) var(--espacamento-3); padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    button { cursor: pointer; }
    .cdk-drag-preview { box-shadow: var(--elevacao-modal); border-radius: var(--raio-controle); }
    .cdk-drag-placeholder { opacity: .4; }
    .cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) { transition: transform var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .coluna, .col-esq { width: 260px; } }
  `,
})
export class LeadsPagina implements OnInit {
  readonly servico = inject(LeadsServico)
  private readonly inbox = inject(InboxServico)

  ngOnInit(): void { void this.servico.carregar() }

  abrir(card: CardLead): void { if (card.conversaId) void this.inbox.abrir(card.conversaId) }

  mover(card: CardLead, estado: ChaveLead): void { void this.servico.qualificar(card.contatoId, estado) }

  async soltou(ev: CdkDragDrop<ColunaLead>, destino: ColunaLead): Promise<void> {
    const card = ev.item.data as CardLead
    const origem = ev.previousContainer.data
    if (ev.previousContainer === ev.container) return // reordenar dentro não persiste
    transferArrayItem(origem.cards, destino.cards, ev.previousIndex, ev.currentIndex)
    this.servico.colunas.set([...this.servico.colunas()])
    await this.servico.qualificar(card.contatoId, destino.chave)
  }
}
