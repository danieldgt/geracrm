import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { CdkDropListGroup, CdkDropList, CdkDrag, type CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop'
import { FunilServico, type Card, type Coluna } from './funil.servico.js'

/**
 * Kanban do funil de relacionamento (Onda 2). Colunas paginadas + drag-drop
 * nativo do CDK (ADR: sem virtual scroll). Arrastar para "Perdido" pede motivo.
 * Segue a skill geracrm-layout-ui: tokens, 5 estados, sem sobreposição.
 */
@Component({
  selector: 'app-funil',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Funil de vendas</h1>
        <p class="sub">Arraste o card conforme a relação com o cliente evolui.</p>
      </div>
      <button class="btn-metricas" [class.on]="mostrarMetricas()" (click)="alternarMetricas()">
        📊 {{ mostrarMetricas() ? 'Ocultar métricas' : 'Métricas' }}
      </button>
    </header>

    @if (mostrarMetricas()) {
      @if (servico.carregandoMetricas() && !servico.metricas()) {
        <div class="metricas"><p class="dica-m">Calculando métricas…</p></div>
      } @else if (servico.metricas(); as m) {
        <div class="metricas">
          <!-- KPIs de recompra (a métrica central do recorrente) -->
          <div class="kpis">
            <div class="kpi">
              <span class="k-rot">Taxa de recompra</span>
              <span class="k-val txt-dados">{{ m.recompra.taxa !== null ? m.recompra.taxa + '%' : '—' }}</span>
              <span class="k-sub">{{ m.recompra.recompraram }} de {{ m.recompra.comCompra }} clientes compraram 2+ vezes</span>
            </div>
            <div class="kpi">
              <span class="k-rot">Tempo até o 2º pedido</span>
              <span class="k-val txt-dados">{{ m.tempoSegundoPedido.medianaDias !== null ? m.tempoSegundoPedido.medianaDias + 'd' : '—' }}</span>
              <span class="k-sub">mediana · média {{ m.tempoSegundoPedido.mediaDias !== null ? m.tempoSegundoPedido.mediaDias + 'd' : '—' }} (n={{ m.tempoSegundoPedido.base }})</span>
            </div>
            <div class="kpi">
              <span class="k-rot">Perda no funil</span>
              <span class="k-val txt-dados">{{ m.perda.taxaPerda !== null ? m.perda.taxaPerda + '%' : '—' }}</span>
              <span class="k-sub">{{ m.perda.perdidas }} de {{ m.perda.fechadas }} fechadas</span>
            </div>
          </div>

          <!-- Conversão + tempo por estágio -->
          <div class="rolagem-x">
            <table class="tab-etapas">
              <thead><tr><th>Estágio</th><th class="dir">Entraram</th><th class="dir">Tempo médio</th><th class="dir">Conversão → próximo</th></tr></thead>
              <tbody>
                @for (e of m.etapas; track e.chave) {
                  <tr>
                    <td>{{ e.nome }}</td>
                    <td class="dir txt-dados">{{ e.entraram }}</td>
                    <td class="dir txt-dados">{{ e.tempoMedioDias !== null ? e.tempoMedioDias + 'd' : '—' }}</td>
                    <td class="dir txt-dados">{{ e.conversaoParaProxima !== null ? e.conversaoParaProxima + '%' : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (m.perda.motivos.length) {
            <div class="motivos-perda">
              <span class="mp-rot">Motivos de perda:</span>
              @for (mv of m.perda.motivos; track mv.codigo) {
                <span class="mp-chip">{{ mv.nome }} <b>{{ mv.qtd }}</b></span>
              }
            </div>
          }
          <p class="dica-m">Conversão A→B: quantos dos que entraram no estágio avançaram ao próximo. Tempo médio conta só estadias concluídas.</p>
        </div>
      }
    }

    @if (servico.erroMove(); as e) { <p class="erro-move" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') {
        <div class="board"><div class="col-esq"></div><div class="col-esq"></div><div class="col-esq"></div></div>
      }
      @case ('sem_permissao') { <div class="bloco aviso"><h2 class="txt-secao">Sem acesso ao funil</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
        <button (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="board rolagem-x" cdkDropListGroup>
          @for (col of servico.colunas(); track col.etapa.id) {
            <section class="coluna" [class]="'coluna--' + col.etapa.tipo">
              <header class="col-topo">
                <span class="col-nome txt-secao">{{ col.etapa.nome }}</span>
                <span class="col-total">{{ col.etapa.total }}</span>
              </header>
              <div class="col-cards" cdkDropList [cdkDropListData]="col"
                   (cdkDropListDropped)="soltou($event, col)">
                @for (card of col.cards; track card.id) {
                  <article class="card" cdkDrag [cdkDragData]="card">
                    <span class="card-nome encolhe">{{ card.nome }}</span>
                    @if (card.valorCentavos !== null) {
                      <span class="card-valor txt-dados">{{ reais(card.valorCentavos) }}</span>
                    }
                    @if (card.responsavel) { <span class="card-resp">👤 {{ card.responsavel }}</span> }
                  </article>
                }
                @if (col.cards.length === 0) { <p class="col-vazia">Vazio</p> }
              </div>
              @if (col.proximoCursor) {
                <button class="mais" (click)="servico.carregarMais(col.etapa.id)" [disabled]="col.carregandoMais">
                  {{ col.carregandoMais ? 'Carregando…' : 'Carregar mais' }}
                </button>
              }
            </section>
          }
        </div>
      }
    }

    <!-- Prompt de motivo ao arrastar para Perdido. -->
    @if (perdendo(); as p) {
      <div class="fora" (click)="cancelarPerda()"></div>
      <div class="motivo-modal" role="dialog" aria-label="Motivo da perda">
        <h2 class="txt-secao">Por que perdeu?</h2>
        <p class="motivo-sub">{{ p.card.nome }}</p>
        <div class="motivos">
          @for (m of servico.motivos(); track m.codigo) {
            <button class="motivo" (click)="confirmarPerda(m.codigo)">{{ m.nome }}</button>
          }
        </div>
        <button class="cancelar" (click)="cancelarPerda()">Cancelar</button>
      </div>
    }
  `,
  styles: `
    :host { display: block; height: 100%; padding: var(--espacamento-6); overflow: hidden; display: flex; flex-direction: column; }
    .cabecalho { margin-bottom: var(--espacamento-4); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-4); }
    .btn-metricas { flex: none; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 13px; cursor: pointer; }
    .btn-metricas.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    /* Painel de métricas */
    .metricas { margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); }
    .kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); }
    .k-rot { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--texto-suave); }
    .k-val { font-size: 24px; font-weight: 600; color: var(--texto); }
    .k-sub { font-size: 12px; color: var(--texto-secundario); }
    .tab-etapas { width: 100%; border-collapse: collapse; font-size: 13px; }
    .tab-etapas th, .tab-etapas td { padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); text-align: left; white-space: nowrap; }
    .tab-etapas th { color: var(--texto-suave); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .tab-etapas .dir { text-align: right; }
    .motivos-perda { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
    .mp-rot { font-size: 12px; color: var(--texto-suave); }
    .mp-chip { font-size: 12px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--erro-suave); color: var(--erro); }
    .dica-m { margin: var(--espacamento-3) 0 0; font-size: 11px; color: var(--texto-suave); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .erro-move { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .board { display: flex; gap: var(--espacamento-3); align-items: flex-start; flex: 1; min-height: 0; padding-bottom: var(--espacamento-2); }
    .col-esq { width: 280px; height: 200px; border-radius: var(--raio-painel); background: var(--superficie); flex: none; }
    .coluna { width: 280px; flex: none; display: flex; flex-direction: column; max-height: 100%;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .coluna--ganho { border-top: 2px solid var(--sucesso); }
    .coluna--perdido { border-top: 2px solid var(--erro); }
    .coluna--aberto { border-top: 2px solid var(--acao); }
    .col-topo { display: flex; align-items: center; justify-content: space-between; padding: var(--espacamento-3) var(--espacamento-4); }
    .col-nome { color: var(--texto); }
    .col-total { font-size: 12px; color: var(--texto-suave); background: var(--fundo); padding: 1px 8px; border-radius: var(--raio-completo); font-variant-numeric: tabular-nums; }
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) var(--espacamento-3); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    .card { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-3);
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-left: 3px solid var(--borda-forte);
      border-radius: var(--raio-controle); cursor: grab; box-shadow: var(--elevacao-nenhuma); }
    .card:active { cursor: grabbing; }
    .card-nome { font-size: 13px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-valor { font-size: 12px; color: var(--sucesso); }
    .card-resp { font-size: 11px; color: var(--texto-suave); }
    .col-vazia { margin: var(--espacamento-2) 0; color: var(--texto-suave); font-size: 12px; text-align: center; }
    .mais { margin: 0 var(--espacamento-3) var(--espacamento-3); padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    button { cursor: pointer; }
    /* CDK drag-drop */
    .cdk-drag-preview { box-shadow: var(--elevacao-modal); border-radius: var(--raio-controle); }
    .cdk-drag-placeholder { opacity: .4; }
    .cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) { transition: transform var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    .fora { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 40; }
    .motivo-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41; width: 320px;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      box-shadow: var(--elevacao-modal); padding: var(--espacamento-5); }
    .motivo-modal h2 { margin: 0; color: var(--texto); }
    .motivo-sub { margin: var(--espacamento-1) 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 13px; }
    .motivos { display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .motivo { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); font: inherit; text-align: left; }
    .motivo:hover { background: var(--superficie-hover); }
    .cancelar { margin-top: var(--espacamento-4); width: 100%; padding: var(--espacamento-2); border: 0; background: transparent; color: var(--texto-secundario); font: inherit; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .coluna, .col-esq { width: 240px; } }
  `,
})
export class FunilPagina implements OnInit {
  readonly servico = inject(FunilServico)
  readonly perdendo = signal<{ card: Card; deEtapa: string; indice: number } | null>(null)
  readonly mostrarMetricas = signal(false)

  ngOnInit(): void { void this.servico.carregar() }

  alternarMetricas(): void {
    this.mostrarMetricas.update((v) => !v)
    if (this.mostrarMetricas()) void this.servico.carregarMetricas()
  }

  reais(centavos: number): string {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  async soltou(ev: CdkDragDrop<Coluna>, destino: Coluna): Promise<void> {
    const card = ev.item.data as Card
    const origem = ev.previousContainer.data
    // Aplica otimista (o CDK move o item entre as listas locais).
    if (ev.previousContainer === ev.container) {
      moveItemInArray(destino.cards, ev.previousIndex, ev.currentIndex)
    } else {
      transferArrayItem(origem.cards, destino.cards, ev.previousIndex, ev.currentIndex)
    }
    this.servico.colunas.set([...this.servico.colunas()])

    // Perdido pede motivo ANTES de persistir.
    if (destino.etapa.tipo === 'perdido') {
      this.perdendo.set({ card, deEtapa: origem.etapa.id, indice: ev.currentIndex })
      return
    }
    const r = await this.servico.mover(card, origem.etapa.id, destino.etapa.id, ev.currentIndex)
    if (!r.ok) {
      this.servico.erroMove.set(r.motivo === 'move.conflito'
        ? 'Alguém moveu este card antes de você — recarreguei o funil.' : 'Não foi possível mover.')
    } else { this.servico.erroMove.set(null) }
  }

  async confirmarPerda(motivo: string): Promise<void> {
    const p = this.perdendo()
    if (!p) return
    const perdidoCol = this.servico.colunas().find((c) => c.etapa.tipo === 'perdido')!
    this.perdendo.set(null)
    const r = await this.servico.mover(p.card, p.deEtapa, perdidoCol.etapa.id, p.indice, motivo)
    if (!r.ok) this.servico.erroMove.set('Não foi possível registrar a perda — recarreguei o funil.')
  }

  cancelarPerda(): void {
    this.perdendo.set(null)
    void this.servico.carregar() // reverte o move otimista
  }
}
