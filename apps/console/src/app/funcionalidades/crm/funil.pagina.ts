import { Component, ChangeDetectionStrategy, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild, OnInit } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router'
import { CdkDropListGroup, CdkDropList, CdkDrag, type CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop'
import { FunilServico, type Card, type Coluna, type EtapaConfig, type MotivoConfig } from './funil.servico.js'
import {
  AbasComponente, ConfirmacaoServico, EstadoComponente, FiltrosComponente, IconeComponente, SelectComponente, SelectPaginadoComponente, ToastServico,
  type Aba, type CarregarOpcoes, type OpcaoPaginada,
} from '../../compartilhado/ui/index.js'
import { PresencaServico } from '../../nucleo/presenca.servico.js'
import { EtiquetasServico } from './etiquetas.servico.js'
import { FunilPanoramaComponente } from './funil-panorama.componente.js'
import {
  FILTROS_VAZIOS, contarFiltros, filtrosDoGrupo, lerQueryParams, montarCartoes, paraQueryParams,
  type Agrupar, type EstadoDaUrl, type FiltrosBoard, type Visao,
} from './funil-filtros.regras.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { ClientesServico } from './clientes.servico.js'
import { TarefaModalComponente } from './tarefa-modal.componente.js'
import { FunilGanharModalComponente } from './funil-ganhar-modal.componente.js'
import { FunilPerderModalComponente } from './funil-perder-modal.componente.js'
import { FunilTransferirModalComponente } from './funil-transferir-modal.componente.js'
import { FunilNovaOportunidadeModalComponente } from './funil-nova-oportunidade-modal.componente.js'
import { decidirAcaoAoSoltar, itensDoMenu, proximoItemDoMenu, type AcaoDoCard, type TipoEtapa } from './funil-acoes.regras.js'

/**
 * Kanban do funil de relacionamento (Onda 2). Colunas paginadas + drag-drop
 * nativo do CDK (ADR: sem virtual scroll). Soltar em coluna de ganho/perdido abre o
 * modal (dados mínimos / motivo); o menu ⋯ do card dá as mesmas ações + transferir/tarefa.
 * Segue a skill geracrm-layout-ui: tokens, 5 estados, sem sobreposição.
 */
@Component({
  selector: 'app-funil',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDropListGroup, CdkDropList, CdkDrag, RouterLink, FormsModule, IconeComponente, AbasComponente, EstadoComponente, FiltrosComponente,
    SelectComponente, SelectPaginadoComponente, FunilPanoramaComponente, TarefaModalComponente, FunilGanharModalComponente,
    FunilPerderModalComponente, FunilTransferirModalComponente, FunilNovaOportunidadeModalComponente,
  ],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Funil de vendas</h1>
        <p class="sub">Arraste o card conforme a relação com o cliente evolui.</p>
      </div>
      <div class="acoes">
        <button class="btn btn--primario" (click)="novaOportunidade.set(true)">Nova oportunidade</button>
        <button class="btn" [class.btn--primario]="mostrarMetricas()" [class.btn--secundario]="!mostrarMetricas()" (click)="alternarMetricas()">
          📊 {{ mostrarMetricas() ? 'Ocultar métricas' : 'Métricas' }}
        </button>
        <button class="btn btn--secundario" (click)="abrirConfig()">⚙️ Configurar funil</button>
      </div>
    </header>

    <ui-abas class="abas-visao" [abas]="abasVisao" [ativa]="visao()" (ativaChange)="mudarVisao($any($event))" />

    @if (visao() === 'panorama') {
      <app-funil-panorama [agrupar]="agrupar()" [estado]="servico.estadoPanorama()" [cartoes]="cartoes()"
        [truncado]="servico.panoramaTruncado()" (trocarAgrupar)="trocarAgrupar($event)"
        (abrir)="abrirGrupo($event)" (tentarDeNovo)="servico.carregarPanorama(agrupar())" />
    } @else {
    <ui-filtros class="filtros-board" rotuloBusca="Buscar no board" placeholder="Nome ou telefone do cliente"
      (buscar)="rascunhar('busca', $event)" (aplicar)="aplicarFiltros()" (limpar)="limparFiltros()">
      @if (gestao()) {
        <ui-select rotulo="Vendedor" placeholder="Todos" [opcoes]="servico.vendedores()"
          [valor]="rascunho().vendedorId" (valorChange)="rascunhar('vendedorId', $event)" />
        <ui-select rotulo="Filial" placeholder="Todas" [opcoes]="servico.filiais()"
          [valor]="rascunho().filialId" (valorChange)="rascunhar('filialId', $event)" />
      }
      <ui-select-paginado rotulo="Etiqueta" placeholder="Todas" [carregar]="carregarEtiquetas" [opcaoInjetada]="etiquetaInjetada()"
        [ngModel]="rascunho().etiquetaId || null" (ngModelChange)="rascunhar('etiquetaId', $event ?? '')" [ngModelOptions]="{ standalone: true }" />
      <ui-select-paginado rotulo="Origem" placeholder="Todas" [carregar]="carregarOrigens" [opcaoInjetada]="origemInjetada()"
        [ngModel]="rascunho().origemId || null" (ngModelChange)="rascunhar('origemId', $event ?? '')" [ngModelOptions]="{ standalone: true }" />
    </ui-filtros>
    @if (filtrosAtivos() > 0) {
      <p class="resumo-filtros txt-denso" role="status">{{ filtrosAtivos() }} {{ filtrosAtivos() === 1 ? 'filtro aplicado' : 'filtros aplicados' }} · o link desta tela leva os filtros junto.</p>
    }

    @if (mostrarMetricas()) {
      @if (servico.carregandoMetricas() && !servico.metricas()) {
        <div class="metricas"><p class="dica-m">Calculando métricas…</p></div>
      } @else if (servico.erroMetricas(); as e) {
        <div class="metricas"><p class="dica-m erro-m" role="alert">{{ e }}
          <button class="btn btn--secundario" (click)="servico.carregarMetricas()">Tentar de novo</button></p></div>
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
        @if (semResultado()) {
          <ui-estado tipo="vazio" titulo="Nenhum card com esses filtros"
                     descricao="Ajuste a busca ou limpe os filtros para ver o funil inteiro.">
            <button type="button" class="btn btn--secundario" (click)="limparFiltros()">Limpar filtros</button>
          </ui-estado>
        } @else {
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
                    <button type="button" class="card-menu" aria-label="Ações do card" aria-haspopup="menu"
                            [attr.aria-expanded]="menu()?.card?.id === card.id"
                            (click)="abrirMenu($event, card, col.etapa.tipo)" (mousedown)="$event.stopPropagation()">
                      <ui-icone nome="more-horizontal" [tamanho]="14" />
                    </button>
                    <!-- Sem beco: o card leva à ficha do cliente. stopPropagation
                         para o link não disputar com o drag/abrir do card. -->
                    <a class="card-nome encolhe" [routerLink]="['/contato', card.contatoId]"
                       (click)="$event.stopPropagation()" [title]="'Abrir a ficha de ' + card.nome">{{ card.nome }}</a>
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
    }
    }

    <!-- Menu do card (⋯): posicionado na tela, fora da coluna que rola. -->
    @if (menu(); as m) {
      <div class="menu-fora" (click)="fecharMenu()"></div>
      <div #menuCard class="menu-card" role="menu" aria-label="Ações do card" [style.top.px]="m.y" [style.left.px]="m.x"
           (keydown)="teclaNoMenu($event)">
        @for (i of itensDoMenu(m.tipo); track i.acao) {
          <button type="button" role="menuitem" class="menu-item" tabindex="-1" (click)="escolher(i.acao)">{{ i.rotulo }}</button>
        }
      </div>
    }

    <app-funil-ganhar-modal [card]="ganhando()" (concluido)="ganhando.set(null)" (cancelado)="cancelar('ganhando')" />
    <app-funil-perder-modal [card]="perdendo()" (concluido)="perdendo.set(null)" (cancelado)="cancelar('perdendo')" />
    <app-funil-transferir-modal [card]="transferindo()" (concluido)="transferindo.set(null)" (fechar)="transferindo.set(null)" />
    <app-tarefa-modal [aberto]="tarefando() !== null" [contatoId]="tarefando()?.contatoId ?? null"
      [contatoNome]="tarefando()?.nome ?? null" (criada)="tarefando.set(null)" (fechar)="tarefando.set(null)" />
    <app-funil-nova-oportunidade-modal [aberto]="novaOportunidade()" (criada)="novaOportunidade.set(false)"
      (fechar)="novaOportunidade.set(false)" />

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
    .abas-visao { margin-bottom: var(--espacamento-4); }
    .filtros-board { margin-bottom: var(--espacamento-3); }
    .resumo-filtros { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); }
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
    .col-cards { flex: 1; overflow-y: auto; padding: 0 var(--espacamento-3) calc(var(--espacamento-3) + var(--folga-flutuante, 0px)); display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 40px; }
    /* ⚠️ flex:none: sem ele o flex-shrink do .col-cards ESMAGA os cards até
       caberem (10px cada) em vez de rolar. Ver cards-nao-esmagam.spec.ts. */
    .card { flex: none; display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-3);
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-left: 3px solid var(--borda-forte);
      border-radius: var(--raio-controle); cursor: grab; box-shadow: var(--elevacao-nenhuma); }
    .card:active { cursor: grabbing; }
    .card { position: relative; }
    .card-menu { position: absolute; top: var(--espacamento-1); right: var(--espacamento-1); display: grid; place-items: center;
      min-width: 28px; min-height: 28px; border: 0; border-radius: var(--raio-controle); background: transparent; color: var(--texto-suave); }
    .card-menu:hover { background: var(--superficie-hover); color: var(--texto); }
    .card-menu:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .card-nome { padding-right: var(--espacamento-6); }
    .menu-fora { position: fixed; inset: 0; z-index: 40; }
    .menu-card { position: fixed; z-index: 41; min-width: 180px; display: flex; flex-direction: column; padding: var(--espacamento-1);
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-controle); box-shadow: var(--elevacao-modal); }
    .menu-item { padding: var(--espacamento-2) var(--espacamento-3); border: 0; border-radius: var(--raio-controle); background: transparent;
      color: var(--texto); font: inherit; font-size: 13px; text-align: left; }
    .menu-item:hover, .menu-item:focus-visible { background: var(--superficie-hover); outline: none; }
    .card-nome { font-size: 13px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
    .card-nome:hover { color: var(--acao); text-decoration: underline; }
    .card-nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; border-radius: var(--raio-controle); }
    .erro-m { color: var(--erro); display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
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
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)
  private readonly router = inject(Router)
  private readonly clientes = inject(ClientesServico)
  private readonly inbox = inject(InboxServico)
  readonly ganhando = signal<Card | null>(null)
  readonly perdendo = signal<Card | null>(null)
  readonly transferindo = signal<Card | null>(null)
  readonly tarefando = signal<Card | null>(null)
  readonly novaOportunidade = signal(false)
  private readonly menuCard = viewChild<ElementRef<HTMLElement>>('menuCard')
  private gatilhoDoMenu: HTMLElement | null = null
  readonly menu = signal<{ card: Card; tipo: TipoEtapa; x: number; y: number } | null>(null)
  protected readonly itensDoMenu = itensDoMenu
  readonly mostrarMetricas = signal(false)
  readonly configAberta = signal(false)
  readonly novoNome = signal('')
  readonly novoTipo = signal<EtapaConfig['tipo']>('aberto')
  readonly novoMotivo = signal('')

  private readonly route = inject(ActivatedRoute)
  private readonly destroyRef = inject(DestroyRef)
  private readonly presenca = inject(PresencaServico)
  private readonly catalogos = inject(EtiquetasServico)

  /** Estado vindo da URL (fonte da verdade): visão, agrupamento e filtros. */
  private readonly estadoUrl = signal<EstadoDaUrl>(lerQueryParams({}))
  readonly visao = computed<Visao>(() => this.estadoUrl().visao)
  readonly agrupar = computed<Agrupar>(() => this.estadoUrl().agrupar)
  /** Filtros ainda não aplicados (a barra edita o rascunho; Filtrar/Enter grava na URL). */
  readonly rascunho = signal<FiltrosBoard>(FILTROS_VAZIOS)
  readonly filtrosAtivos = computed(() => contarFiltros(this.estadoUrl().filtros))
  readonly gestao = this.presenca.gestao
  readonly cartoes = computed(() => montarCartoes(this.servico.panorama(), this.servico.etapasPanorama()))
  readonly semResultado = computed(() => this.filtrosAtivos() > 0 && this.servico.colunas().every((c) => c.cards.length === 0))
  readonly etiquetaInjetada = signal<OpcaoPaginada | null>(null)
  readonly origemInjetada = signal<OpcaoPaginada | null>(null)
  protected readonly abasVisao: readonly Aba[] = [
    { id: 'panorama', rotulo: 'Panorama' }, { id: 'board', rotulo: 'Board' },
  ]

  protected readonly carregarEtiquetas: CarregarOpcoes = async (cursor, termo) => {
    const p = await this.catalogos.etiquetas(cursor, true)
    const t = termo.trim().toLowerCase()
    return {
      itens: p.itens.filter((e) => !t || e.nome.toLowerCase().includes(t)).map((e) => ({ valor: e.id, rotulo: e.nome })),
      proximoCursor: p.proximoCursor,
    }
  }
  protected readonly carregarOrigens: CarregarOpcoes = async (cursor, termo) => {
    const p = await this.catalogos.origens(cursor, true)
    const t = termo.trim().toLowerCase()
    return {
      itens: p.itens.filter((o) => !t || o.nome.toLowerCase().includes(t)).map((o) => ({ valor: o.id, rotulo: o.nome })),
      proximoCursor: p.proximoCursor,
    }
  }

  constructor() {
    // Menu recém-aberto: o foco vai ao primeiro item (teclado e leitor de tela entram no menu).
    effect(() => { this.itensDoContainer()[0]?.focus() })
  }

  private itensDoContainer(): HTMLElement[] {
    const el = this.menuCard()?.nativeElement
    return el ? Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []
  }

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => this.aoMudarUrl(m))
  }

  /** A URL mudou (clique, link compartilhado, voltar do navegador): sincroniza a tela e recarrega só o que mudou. */
  private aoMudarUrl(m: ParamMap): void {
    const novo = lerQueryParams(Object.fromEntries(m.keys.map((k) => [k, m.get(k)])))
    const antigo = this.estadoUrl()
    const primeira = !this.carregouUmaVez
    this.carregouUmaVez = true
    this.estadoUrl.set(novo)
    this.rascunho.set(novo.filtros)
    if (novo.visao === 'panorama') {
      if (primeira || antigo.visao !== 'panorama' || antigo.agrupar !== novo.agrupar) void this.servico.carregarPanorama(novo.agrupar)
      return
    }
    const mudouFiltros = JSON.stringify(antigo.filtros) !== JSON.stringify(novo.filtros)
    if (primeira || antigo.visao !== 'board' || mudouFiltros) {
      this.servico.filtros.set(novo.filtros)
      void this.servico.carregar()
    }
    if (this.gestao()) void this.servico.carregarOpcoesGestao()
    void this.rotularFiltrosDeCatalogo(novo.filtros)
  }
  private carregouUmaVez = false

  /** Filtro vindo do link: acha o nome da etiqueta/origem para a opção aparecer escolhida (varre poucas páginas). */
  private async rotularFiltrosDeCatalogo(f: FiltrosBoard): Promise<void> {
    const achar = async (carregar: CarregarOpcoes, id: string): Promise<OpcaoPaginada | null> => {
      let cursor: string | null = null
      for (let i = 0; i < 5; i++) {
        const p = await carregar(cursor, '')
        const o = p.itens.find((x) => x.valor === id)
        if (o) return o
        if (!p.proximoCursor) return null
        cursor = p.proximoCursor
      }
      return null
    }
    try {
      this.etiquetaInjetada.set(f.etiquetaId ? await achar(this.carregarEtiquetas, f.etiquetaId) : null)
      this.origemInjetada.set(f.origemId ? await achar(this.carregarOrigens, f.origemId) : null)
    } catch { /* o select segue funcionando sem o rótulo */ }
  }

  private navegar(e: EstadoDaUrl): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: paraQueryParams(e), queryParamsHandling: 'merge' })
  }
  mudarVisao(v: Visao): void {
    if (v !== this.visao()) this.navegar({ ...this.estadoUrl(), visao: v })
  }
  trocarAgrupar(a: Agrupar): void { this.navegar({ ...this.estadoUrl(), agrupar: a }) }
  /** Cartão do panorama: abre o board já filtrado por aquele grupo. */
  abrirGrupo(chave: string): void {
    this.navegar({ visao: 'board', agrupar: this.agrupar(), filtros: filtrosDoGrupo(this.agrupar(), chave) })
  }
  rascunhar(campo: keyof FiltrosBoard, valor: string): void {
    this.rascunho.update((r) => ({ ...r, [campo]: valor }))
  }
  aplicarFiltros(): void { this.navegar({ ...this.estadoUrl(), visao: 'board', filtros: this.rascunho() }) }
  limparFiltros(): void { this.navegar({ ...this.estadoUrl(), visao: 'board', filtros: FILTROS_VAZIOS }) }

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

    // Ganho e perda abrem o modal ANTES de persistir (dados mínimos / motivo); cancelar devolve o card.
    const acao = decidirAcaoAoSoltar(origem.etapa.id, destino.etapa.id, destino.etapa.tipo)
    // Reordenar dentro de coluna fechada não persiste (exigiria dados/motivo de novo): só volta ao estado do servidor.
    if (acao === 'reordenar' && destino.etapa.tipo !== 'aberto') { void this.servico.carregar(); return }
    if (acao === 'abrir_ganho') { this.ganhando.set(card); return }
    if (acao === 'abrir_perda') { this.perdendo.set(card); return }
    const r = await this.servico.mover(card, origem.etapa.id, destino.etapa.id, ev.currentIndex)
    if (!r.ok) {
      this.servico.erroMove.set(r.motivo === 'move.conflito'
        ? 'Alguém moveu este card antes de você — recarreguei o funil.' : 'Não foi possível mover.')
    } else { this.servico.erroMove.set(null) }
  }

  /** Cancelar o modal de ganho/perda desfaz o movimento otimista: recarrega o quadro. */
  cancelar(qual: 'ganhando' | 'perdendo'): void {
    this[qual].set(null)
    void this.servico.carregar()
  }

  abrirMenu(ev: MouseEvent, card: Card, tipo: TipoEtapa): void {
    ev.stopPropagation()
    this.gatilhoDoMenu = ev.currentTarget as HTMLElement
    const alvo = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    // 180px de largura mínima; encosta na borda direita do botão sem sair da tela.
    const x = Math.max(8, Math.min(alvo.right - 180, window.innerWidth - 188))
    this.menu.set({ card, tipo, x, y: alvo.bottom + 4 })
  }

  /** Fecha o menu e devolve o foco ao botão ⋯ que o abriu. */
  fecharMenu(): void {
    this.menu.set(null)
    this.gatilhoDoMenu?.focus()
  }

  /** ↑↓ Home End navegam; Esc e Tab fecham (foco volta ao botão). */
  teclaNoMenu(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); this.fecharMenu(); return }
    const itens = this.itensDoContainer()
    const proximo = proximoItemDoMenu(itens.indexOf(document.activeElement as HTMLElement), itens.length, ev.key)
    if (proximo === null) return
    ev.preventDefault()
    itens[proximo]?.focus()
  }

  async escolher(acao: AcaoDoCard): Promise<void> {
    const m = this.menu()
    this.menu.set(null) // o foco segue para o modal da ação (não volta ao botão)
    if (!m) return
    const card = m.card
    switch (acao) {
      case 'ganhar': this.ganhando.set(card); break
      case 'perder': this.perdendo.set(card); break
      case 'transferir': this.transferindo.set(card); break
      case 'tarefa': this.tarefando.set(card); break
      case 'ficha': void this.router.navigate(['/contato', card.contatoId]); break
      case 'conversa': {
        const conversaId = await this.clientes.iniciarConversa(card.contatoId)
        if (conversaId) void this.inbox.abrir(conversaId)
        else this.servico.erroMove.set('Não foi possível abrir a conversa.')
        break
      }
    }
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
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover raia?',
      mensagem: e.total > 0
        ? `"${e.nome}" tem ${e.total} oportunidade(s). A API só remove raia vazia — mova os cards antes, ou marque a raia como inativa.`
        : `"${e.nome}" some do funil. Não dá para desfazer.`,
      acao: 'Remover',
    })
    if (!ok) return
    if (await this.servico.removerEtapa(e.id)) this.toast.sucesso('Raia removida')
  }

  async criarEtapa(): Promise<void> {
    const nome = this.novoNome().trim()
    if (!nome) return
    if (await this.servico.criarEtapa(nome, this.novoTipo())) { this.novoNome.set(''); this.toast.sucesso('Raia criada') }
  }

  async criarMotivo(): Promise<void> {
    const nome = this.novoMotivo().trim()
    if (!nome) return
    if (await this.servico.criarMotivo(nome)) { this.novoMotivo.set(''); this.toast.sucesso('Motivo criado') }
  }

  async removerMotivo(m: MotivoConfig): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover motivo de perda?',
      mensagem: `"${m.nome}" deixa de ser opção ao registrar uma perda. As perdas já registradas com ele continuam no histórico.`,
      acao: 'Remover',
    })
    if (!ok) return
    if (await this.servico.removerMotivo(m.codigo)) this.toast.sucesso('Motivo removido')
  }
}
