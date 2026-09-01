import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { CdkDropListGroup, CdkDropList, CdkDrag, type CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop'
import { FunilServico, type Card, type Coluna, type EtapaConfig, type MotivoConfig } from './funil.servico.js'

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
      <div class="acoes">
        <button class="btn" [class.btn--primario]="mostrarMetricas()" [class.btn--secundario]="!mostrarMetricas()" (click)="alternarMetricas()">
          📊 {{ mostrarMetricas() ? 'Ocultar métricas' : 'Métricas' }}
        </button>
        <button class="btn btn--secundario" (click)="abrirConfig()">⚙️ Configurar funil</button>
      </div>
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
        <button class="btn btn--fantasma btn--bloco" (click)="cancelarPerda()">Cancelar</button>
      </div>
    }

    <!-- Configuração das raias: a empresa monta o próprio funil. -->
    @if (configAberta()) {
      <div class="fora" (click)="fecharConfig()"></div>
      <div class="cfg-modal" role="dialog" aria-label="Configurar funil">
        <header class="cfg-topo">
          <h2 class="txt-secao">Raias do funil</h2>
          <button class="cfg-x" (click)="fecharConfig()" aria-label="Fechar">✕</button>
        </header>
        <p class="cfg-dica">
          As raias viram as colunas do quadro. <b>Aberto</b> é negociação em andamento;
          <b>Ganho</b> encerra com sucesso; <b>Perdido</b> encerra e pede o motivo.
        </p>

        @if (servico.erroConfig(); as e) { <p class="cfg-erro" role="alert">{{ e }}</p> }

        <ul class="cfg-lista">
          @for (e of servico.config(); track e.id) {
            <li class="cfg-item" [class.cfg-item--off]="!e.ativo">
              <span class="cfg-ordem">
                <button (click)="reordenar(e, -1)" [disabled]="$first" aria-label="Subir">▲</button>
                <button (click)="reordenar(e, 1)" [disabled]="$last" aria-label="Descer">▼</button>
              </span>
              <input class="cfg-nome" [value]="e.nome" (change)="renomear(e, $event)" aria-label="Nome da raia" />
              <select class="cfg-select" [value]="e.tipo" (change)="mudarTipo(e, $event)" aria-label="Tipo da raia">
                <option value="aberto">Aberto</option>
                <option value="ganho">Ganho</option>
                <option value="perdido">Perdido</option>
              </select>
              <span class="cfg-qtd txt-dados" [title]="e.total + ' oportunidade(s)'">{{ e.total }}</span>
              <button class="cfg-toggle" (click)="alternarAtivo(e)">{{ e.ativo ? 'Ativa' : 'Inativa' }}</button>
              <button class="cfg-del" (click)="removerEtapa(e)" aria-label="Remover raia">🗑</button>
            </li>
          }
        </ul>

        <div class="cfg-novo">
          <input class="cfg-nome" [value]="novoNome()" (input)="novoNome.set(valor($event))"
                 (keydown.enter)="criarEtapa()" placeholder="Nova raia…" aria-label="Nome da nova raia" />
          <select class="cfg-select" [value]="novoTipo()" (change)="novoTipo.set(tipoDe($event))" aria-label="Tipo">
            <option value="aberto">Aberto</option>
            <option value="ganho">Ganho</option>
            <option value="perdido">Perdido</option>
          </select>
          <button class="cfg-add" (click)="criarEtapa()" [disabled]="!novoNome().trim()">Adicionar</button>
        </div>

        <h3 class="cfg-sub txt-rotulo">Motivos de perda</h3>
        <p class="cfg-dica">Quem arrasta um card para uma raia de perda escolhe um destes.</p>
        <ul class="cfg-lista">
          @for (m of servico.motivosConfig(); track m.codigo) {
            <li class="cfg-item cfg-item--motivo" [class.cfg-item--off]="!m.ativo">
              <span class="cfg-nome-fixo encolhe">{{ m.nome }}</span>
              <span class="cfg-qtd txt-dados" [title]="m.total + ' perda(s)'">{{ m.total }}</span>
              <button class="cfg-del" (click)="removerMotivo(m)" aria-label="Remover motivo">🗑</button>
            </li>
          }
          @if (servico.motivosConfig().length === 0) { <li class="cfg-vazio">Nenhum motivo cadastrado.</li> }
        </ul>
        <div class="cfg-novo">
          <input class="cfg-nome" [value]="novoMotivo()" (input)="novoMotivo.set(valor($event))"
                 (keydown.enter)="criarMotivo()" placeholder="Novo motivo…" aria-label="Nome do novo motivo" />
          <button class="cfg-add" (click)="criarMotivo()" [disabled]="!novoMotivo().trim()">Adicionar</button>
        </div>
      </div>
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
    .cabecalho { margin-bottom: var(--espacamento-4); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-4); }
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
    .board { display: flex; gap: var(--espacamento-3); align-items: stretch; flex: 1; min-height: 0; overflow-x: auto; padding-bottom: var(--espacamento-2); }
    .col-esq { width: 280px; height: 200px; border-radius: var(--raio-painel); background: var(--superficie); flex: none; }
    .coluna { width: 280px; flex: none; display: flex; flex-direction: column; min-height: 0;
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
    .acoes { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    /* Modal de configuração das raias. Rola por dentro: o funil de ERP tem 6
       raias, mas nada impede uma operação com 12 — a lista não pode empurrar o
       modal para fora da viewport. */
    .cfg-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41;
      width: min(560px, calc(100vw - var(--espacamento-8))); max-height: calc(100dvh - var(--espacamento-12));
      overflow-y: auto; background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); padding: var(--espacamento-5); }
    .cfg-topo { display: flex; align-items: center; justify-content: space-between; }
    .cfg-topo h2 { margin: 0; color: var(--texto); }
    .cfg-x { border: 0; background: none; color: var(--texto-suave); font-size: 16px; padding: var(--espacamento-1); }
    .cfg-dica { margin: var(--espacamento-1) 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 12px; }
    .cfg-erro { margin: 0 0 var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--erro-suave); color: var(--erro); font-size: 12px; }
    .cfg-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .cfg-item { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-2);
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); }
    .cfg-item--off { opacity: .55; }
    .cfg-ordem { display: flex; flex-direction: column; gap: 2px; }
    .cfg-ordem button { border: 1px solid var(--borda); border-radius: 3px; background: var(--superficie-elevada);
      color: var(--texto-secundario); font-size: 11px; line-height: 1; padding: 3px 5px; }
    .cfg-ordem button:hover:not(:disabled) { background: var(--superficie-hover); color: var(--texto); }
    .cfg-ordem button:disabled { opacity: .25; cursor: default; }
    .cfg-nome { flex: 1; min-width: 0; padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 13px; }
    .cfg-nome-fixo { flex: 1; min-width: 0; font-size: 13px; color: var(--texto); }
    .cfg-select { padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; }
    .cfg-qtd { min-width: 28px; text-align: right; font-size: 12px; color: var(--texto-suave); }
    .cfg-toggle { padding: 2px 8px; border: 1px solid var(--borda-controle); border-radius: var(--raio-completo);
      background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 11px; }
    .cfg-del { border: 0; background: none; font-size: 13px; padding: var(--espacamento-1); }
    .cfg-novo { display: flex; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
    .cfg-add { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid transparent; border-radius: var(--raio-controle);
      background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; }
    .cfg-add:disabled { opacity: .5; cursor: default; }
    .cfg-sub { display: block; margin: var(--espacamento-6) 0 var(--espacamento-1); color: var(--texto); }
    .cfg-vazio { color: var(--texto-suave); font-size: 12px; padding: var(--espacamento-2); }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .coluna, .col-esq { width: 240px; } }
  `,
})
export class FunilPagina implements OnInit {
  readonly servico = inject(FunilServico)
  readonly perdendo = signal<{ card: Card; deEtapa: string; indice: number } | null>(null)
  readonly mostrarMetricas = signal(false)
  readonly configAberta = signal(false)
  readonly novoNome = signal('')
  readonly novoTipo = signal<EtapaConfig['tipo']>('aberto')
  readonly novoMotivo = signal('')

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

  // ───────── Configuração das raias ─────────

  valor(ev: Event): string { return (ev.target as HTMLInputElement).value }
  tipoDe(ev: Event): EtapaConfig['tipo'] { return (ev.target as HTMLSelectElement).value as EtapaConfig['tipo'] }

  abrirConfig(): void {
    this.servico.erroConfig.set(null)
    this.servico.configSujo.set(false)
    this.configAberta.set(true)
    void this.servico.carregarConfig()
  }

  /** ⚠️ Recarrega o quadro só se a estrutura mudou — o board é caro (uma busca por coluna). */
  fecharConfig(): void {
    this.configAberta.set(false)
    if (this.servico.configSujo()) {
      this.servico.configSujo.set(false)
      void this.servico.carregar()
    }
  }

  /** Troca a `ordem` com a raia vizinha. */
  async reordenar(e: EtapaConfig, delta: number): Promise<void> {
    const lista = [...this.servico.config()]
    const i = lista.findIndex((x) => x.id === e.id)
    const vizinho = lista[i + delta]
    if (!vizinho) return
    if (await this.servico.editarEtapa(e.id, { ordem: vizinho.ordem })) {
      await this.servico.editarEtapa(vizinho.id, { ordem: e.ordem })
    }
  }

  async renomear(e: EtapaConfig, ev: Event): Promise<void> {
    const nome = this.valor(ev).trim()
    if (!nome || nome === e.nome) return
    await this.servico.editarEtapa(e.id, { nome })
  }

  async mudarTipo(e: EtapaConfig, ev: Event): Promise<void> {
    await this.servico.editarEtapa(e.id, { tipo: this.tipoDe(ev) })
  }

  async alternarAtivo(e: EtapaConfig): Promise<void> {
    await this.servico.editarEtapa(e.id, { ativo: !e.ativo })
  }

  async removerEtapa(e: EtapaConfig): Promise<void> {
    await this.servico.removerEtapa(e.id)
  }

  async criarEtapa(): Promise<void> {
    const nome = this.novoNome().trim()
    if (!nome) return
    if (await this.servico.criarEtapa(nome, this.novoTipo())) this.novoNome.set('')
  }

  async criarMotivo(): Promise<void> {
    const nome = this.novoMotivo().trim()
    if (!nome) return
    if (await this.servico.criarMotivo(nome)) this.novoMotivo.set('')
  }

  async removerMotivo(m: MotivoConfig): Promise<void> {
    await this.servico.removerMotivo(m.codigo)
  }
}
