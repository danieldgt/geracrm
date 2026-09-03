import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { CdkDropListGroup, CdkDropList, CdkDrag, type CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop'
import { AtendimentoKanbanServico, type Card, type CardAtend, type Coluna } from './atendimento-kanban.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'

/**
 * Painel de atendimentos (visão do gestor). 1ª coluna "Aguardando" derivada da
 * fila + etapas configuráveis por empresa. Drag-drop nativo do CDK (ADR: sem
 * virtual scroll), paginação por coluna. Card só metadados (ADR-007); clicar
 * abre a conversa no rail. Espelha funil.pagina — tokens, 5 estados.
 */
@Component({
  selector: 'app-atendimento-kanban',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, FormsModule],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Painel de Atendimentos</h1>
        <p class="sub">Arraste conforme o atendimento avança. O fluxo é configurável pela sua empresa.</p>
      </div>
      <button class="btn btn--secundario" (click)="abrirConfig()">⚙️ Configurar fluxo</button>
    </header>

    @if (servico.erroMove(); as e) { <p class="erro-move" role="alert">{{ e }}</p> }

    @switch (servico.estado()) {
      @case ('carregando') {
        <div class="board"><div class="col-esq"></div><div class="col-esq"></div><div class="col-esq"></div></div>
      }
      @case ('sem_permissao') { <div class="bloco aviso"><h2 class="txt-secao">Sem acesso ao painel</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2 class="txt-secao">Não foi possível carregar</h2>
        <button (click)="servico.carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="board rolagem-x" cdkDropListGroup>
          @for (col of servico.colunas(); track col.chave) {
            <section class="coluna" [class]="'coluna--' + col.tipo">
              <header class="col-topo">
                <span class="col-nome txt-secao">{{ col.nome }}</span>
                <span class="col-total">{{ col.total }}</span>
              </header>
              <div class="col-cards" cdkDropList [cdkDropListData]="col"
                   (cdkDropListDropped)="soltou($event, col)">
                @for (card of col.cards; track cardId(card)) {
                  <article class="card" [class.card--fila]="card.kind === 'fila'" cdkDrag [cdkDragData]="card"
                           (cdkDragStarted)="arrastoComecou()" (cdkDragEnded)="arrastoTerminou()"
                           (click)="abrir(card)" tabindex="0" role="button">
                    <span class="card-nome encolhe">{{ card.contato }}</span>
                    @if (card.kind === 'atend') {
                      <span class="card-meta">
                        <span class="card-proto">#{{ card.protocolo }}</span>
                        @if (card.atendente) { <span class="card-resp">· {{ card.atendente }}</span> }
                      </span>
                      <span class="card-aging" [class.card-aging--velho]="velho(card.entrouEtapaEm)">⏱ {{ aging(card.entrouEtapaEm) }} nesta etapa</span>
                    } @else {
                      <span class="card-aging">💬 {{ aging(card.ultimaMensagemEm) }} aguardando · arraste para assumir</span>
                    }
                  </article>
                }
                @if (col.cards.length === 0) { <p class="col-vazia">Vazio</p> }
              </div>
              @if (col.proximoCursor) {
                <button class="mais" (click)="servico.carregarMais(col)" [disabled]="col.carregandoMais">
                  {{ col.carregandoMais ? 'Carregando…' : 'Carregar mais' }}
                </button>
              }
            </section>
          }
        </div>
      }
    }

    <!-- Configuração do fluxo: CRUD de etapas por empresa. -->
    @if (config()) {
      <div class="fora" (click)="fecharConfig()"></div>
      <div class="config-modal" role="dialog" aria-label="Configurar fluxo de atendimento">
        <header class="cfg-topo">
          <h2 class="txt-secao">Fluxo de atendimento</h2>
          <button class="cfg-x" (click)="fecharConfig()" aria-label="Fechar">✕</button>
        </header>
        <p class="cfg-dica">As etapas viram colunas do painel. Uma empresa monta um fluxo simples ou completo — o tipo <b>Encerrado</b> fecha o atendimento ao receber o card.</p>

        <ul class="cfg-lista">
          @for (e of servico.config(); track e.id) {
            <li class="cfg-item" [class.cfg-item--off]="!e.ativo">
              <span class="cfg-ordem">
                <button (click)="reordenar(e, -1)" [disabled]="$first" aria-label="Subir">▲</button>
                <button (click)="reordenar(e, 1)" [disabled]="$last" aria-label="Descer">▼</button>
              </span>
              <input class="cfg-nome" [value]="e.nome" (change)="renomear(e, $event)" />
              <span class="cfg-tipo" [class.cfg-tipo--enc]="e.tipo === 'encerrado'">{{ e.tipo === 'encerrado' ? 'Encerrado' : 'Atendimento' }}</span>
              <span class="cfg-qtd">{{ e.total }}</span>
              <button class="cfg-toggle" (click)="alternarAtivo(e)">{{ e.ativo ? 'Ativa' : 'Inativa' }}</button>
              <button class="cfg-del" (click)="remover(e)" aria-label="Remover">🗑</button>
            </li>
          }
        </ul>

        <div class="cfg-novo">
          <input class="cfg-nome" [(ngModel)]="novoNome" placeholder="Nova etapa…" (keydown.enter)="criar()" />
          <select class="cfg-select" [(ngModel)]="novoTipo">
            <option value="atendimento">Atendimento</option>
            <option value="encerrado">Encerrado</option>
          </select>
          <button class="cfg-add" (click)="criar()" [disabled]="!novoNome().trim()">Adicionar</button>
        </div>
      </div>
    }
  `,
  styles: `
    /* ⚠️ Altura DEFINIDA — e nem 100%, nem min-height. Um kanban só funciona se
       a tela souber a própria altura; as duas alternativas erradas já quebraram:
       - height 100% vira ZERO: a casca põe a tela numa CÉLULA DE GRID, que não
         resolve altura percentual do filho. O board com flex 1 colapsa e os
         cards espremem para 1px (incidente dos 813 leads, 27/ago);
       - min-height 100dvh não LIMITA nada: a coluna cresce junto com os cards,
         a rolagem interna da coluna nunca dispara e o painel vira uma tira que
         empurra a página — com 11 mil cards numa coluna, tela inutilizável.
       O que sobra para a tela é a viewport MENOS a barra superior da casca.
       ⚠️ E um só display por regra: dois na mesma regra, o segundo vence calado. */
    :host { display: flex; flex-direction: column;
      height: calc(100dvh - var(--altura-barra-topo));
      padding: var(--espacamento-6); overflow: hidden; }
    .cabecalho { margin-bottom: var(--espacamento-4); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .erro-move { margin: 0 0 var(--espacamento-3); color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .board { display: flex; gap: var(--espacamento-3); align-items: stretch; flex: 1; min-height: 0; overflow-x: auto; padding-bottom: var(--espacamento-2); }
    .col-esq { width: 280px; height: 200px; border-radius: var(--raio-painel); background: var(--superficie); flex: none; }
    .coluna { width: 280px; flex: none; display: flex; flex-direction: column; min-height: 0;
      background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .coluna--fila { border-top: 2px solid var(--atencao); background: var(--fundo); }
    .coluna--atendimento { border-top: 2px solid var(--acao); }
    .coluna--encerrado { border-top: 2px solid var(--sucesso); }
    .col-topo { display: flex; align-items: center; justify-content: space-between; padding: var(--espacamento-3) var(--espacamento-4); }
    .col-nome { color: var(--texto); }
    .col-total { font-size: 12px; color: var(--texto-suave); background: var(--superficie); padding: 1px 8px; border-radius: var(--raio-completo); font-variant-numeric: tabular-nums; }
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) var(--espacamento-3); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    /* ⚠️ flex:none: sem ele o flex-shrink do .col-cards ESMAGA os cards até
       caberem (10px cada) em vez de rolar. Ver cards-nao-esmagam.spec.ts. */
    .card { flex: none; display: flex; flex-direction: column; gap: 3px; padding: var(--espacamento-3);
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-left: 3px solid var(--acao);
      border-radius: var(--raio-controle); cursor: grab; box-shadow: var(--elevacao-nenhuma); }
    .card--fila { border-left-color: var(--atencao); }
    .card:active { cursor: grabbing; }
    .card:focus-visible { outline: 2px solid var(--acao); outline-offset: 1px; }
    .card-nome { font-size: 13px; font-weight: 500; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-meta { font-size: 12px; color: var(--texto-secundario); }
    .card-proto { font-variant-numeric: tabular-nums; }
    .card-resp { color: var(--texto-suave); }
    .card-aging { font-size: 11px; color: var(--texto-suave); }
    .card-aging--velho { color: var(--erro); }
    .col-vazia { margin: var(--espacamento-2) 0; color: var(--texto-suave); font-size: 12px; text-align: center; }
    .mais { margin: 0 var(--espacamento-3) var(--espacamento-3); padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    button { cursor: pointer; }
    .cdk-drag-preview { box-shadow: var(--elevacao-modal); border-radius: var(--raio-controle); }
    .cdk-drag-placeholder { opacity: .4; }
    .cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) { transition: transform var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    /* Modal de configuração */
    .fora { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 40; }
    .config-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 41; width: min(560px, 92vw); max-height: 86vh; overflow: auto;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      box-shadow: var(--elevacao-modal); padding: var(--espacamento-5); }
    .cfg-topo { display: flex; align-items: center; justify-content: space-between; }
    .cfg-topo h2 { margin: 0; color: var(--texto); }
    .cfg-x { border: 0; background: transparent; color: var(--texto-secundario); font-size: 16px; }
    .cfg-dica { margin: var(--espacamento-2) 0 var(--espacamento-4); font-size: 12px; color: var(--texto-suave); }
    .cfg-lista { list-style: none; margin: 0 0 var(--espacamento-4); padding: 0; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .cfg-item { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-2); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); }
    .cfg-item--off { opacity: .55; }
    .cfg-ordem { display: flex; flex-direction: column; }
    .cfg-ordem button { border: 0; background: transparent; color: var(--texto-suave); font-size: 9px; line-height: 1; padding: 1px; }
    .cfg-ordem button:disabled { opacity: .3; }
    .cfg-nome { flex: 1; min-width: 0; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 13px; }
    .cfg-tipo { flex: none; font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--acao); }
    .cfg-tipo--enc { background: var(--sucesso-suave); color: var(--sucesso); }
    .cfg-qtd { flex: none; font-size: 12px; color: var(--texto-suave); min-width: 20px; text-align: right; font-variant-numeric: tabular-nums; }
    .cfg-toggle { flex: none; font-size: 11px; padding: 2px 8px; border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); }
    .cfg-del { flex: none; border: 0; background: transparent; font-size: 13px; }
    .cfg-novo { display: flex; gap: var(--espacamento-2); align-items: center; }
    .cfg-select { flex: none; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; font-size: 13px; }
    .cfg-add { flex: none; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; }
    .cfg-add:disabled { opacity: .5; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .coluna, .col-esq { width: 240px; } }
  `,
})
export class AtendimentoKanbanPagina implements OnInit {
  readonly servico = inject(AtendimentoKanbanServico)
  private readonly inbox = inject(InboxServico)
  readonly config = signal(false)
  readonly novoNome = signal('')
  readonly novoTipo = signal<'atendimento' | 'encerrado'>('atendimento')

  ngOnInit(): void { void this.servico.carregar() }

  cardId(c: Card): string { return c.kind === 'atend' ? c.atendimentoId : c.conversaId }

  /** Tempo desde `iso`, humanizado. */
  aging(iso: string | null): string {
    if (!iso) return '—'
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (min < 1) return 'agora'
    if (min < 60) return `há ${min}min`
    const h = Math.floor(min / 60)
    if (h < 24) return `há ${h}h`
    return `há ${Math.floor(h / 24)}d`
  }
  /** Parado há mais de 24h na etapa → sinal de alerta. */
  velho(iso: string | null): boolean {
    return !!iso && Date.now() - new Date(iso).getTime() > 24 * 3600_000
  }

  /**
   * Clicar abre a conversa no rail — mas soltar um card também pode gerar um `click`
   * no navegador, e aí cada drop abriria a conversa. O CDK não filtra isso; a flag
   * vive até o próximo turno de macrotask, quando o click sintético já passou.
   */
  private arrastou = false
  arrastoComecou(): void { this.arrastou = true }
  arrastoTerminou(): void { setTimeout(() => { this.arrastou = false }) }
  abrir(card: Card): void {
    if (this.arrastou) return
    void this.inbox.abrir(card.conversaId)
  }

  async soltou(ev: CdkDragDrop<Coluna>, destino: Coluna): Promise<void> {
    const card = ev.item.data as Card
    const origem = ev.previousContainer.data
    if (ev.previousContainer === ev.container) {
      moveItemInArray(destino.cards, ev.previousIndex, ev.currentIndex)
      this.servico.colunas.set([...this.servico.colunas()])
      return // reordenar dentro da coluna não persiste (ordem é por tempo).
    }
    // Move otimista entre listas; a recarga silenciosa confirma sem piscar o board.
    this.servico.erroMove.set(null)
    transferArrayItem(origem.cards, destino.cards, ev.previousIndex, ev.currentIndex)
    this.servico.colunas.set([...this.servico.colunas()])

    // Não dá para "des-assumir": soltar na fila reverte.
    if (destino.tipo === 'fila') { void this.servico.carregar({ silencioso: true }); return }
    // Da fila para uma etapa = assumir, nascendo NA etapa onde o card foi solto
    // (a API recusa etapa 'encerrado' com erro tipificado; a mensagem explica).
    if (card.kind === 'fila') { await this.servico.assumir(card.conversaId, destino.etapa!.id); return }
    // Entre etapas = mover (encerrado fecha o atendimento).
    await this.servico.mover(card as CardAtend, destino.etapa!.id)
  }

  // ───────── Config ─────────
  abrirConfig(): void { this.config.set(true); void this.servico.carregarConfig() }
  fecharConfig(): void { this.config.set(false); void this.servico.carregar() }
  async criar(): Promise<void> {
    const nome = this.novoNome().trim()
    if (!nome) return
    await this.servico.criarEtapa(nome, this.novoTipo())
    this.novoNome.set('')
  }
  renomear(e: { id: string; nome: string }, ev: Event): void {
    const nome = (ev.target as HTMLInputElement).value.trim()
    if (nome && nome !== e.nome) void this.servico.editarEtapa(e.id, { nome })
  }
  alternarAtivo(e: { id: string; ativo: boolean }): void { void this.servico.editarEtapa(e.id, { ativo: !e.ativo }) }
  remover(e: { id: string }): void { void this.servico.removerEtapa(e.id) }
  async reordenar(e: { id: string; ordem: number }, dir: -1 | 1): Promise<void> {
    const lista = [...this.servico.config()].sort((a, b) => a.ordem - b.ordem)
    const i = lista.findIndex((x) => x.id === e.id)
    const j = i + dir
    if (j < 0 || j >= lista.length) return
    const outro = lista[j]!
    await this.servico.editarEtapa(e.id, { ordem: outro.ordem })
    await this.servico.editarEtapa(outro.id, { ordem: e.ordem })
  }
}
