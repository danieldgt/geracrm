import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { NgTemplateOutlet } from '@angular/common'
import { ActivatedRoute, Router } from '@angular/router'
import type { PerfilPreco } from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  FiltrosComponente, IconeComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente, ToastServico,
  formatarReais, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { CatalogoProdutosServico, type FiltroOrigem, type ProdutoLinha, type SkuLinha } from './catalogo-produtos.servico.js'
import {
  corpoParaEdicao, formDeProduto, formDeSku, produtoVazio, rotuloSku, skuVazio, validarProduto, validarSku,
  type AtributoForm, type Erros, type ProdutoForm, type SkuForm,
} from './catalogo-produtos.regras.js'
import { corClara, montarGrade, saldoDaLinha, type CelulaGrade, type Grade } from './catalogo-grade.regras.js'

const OPCOES_ORIGEM: OpcaoSelect[] = [{ valor: 'manual', rotulo: 'Só manuais' }, { valor: 'erp', rotulo: 'Só do ERP' }]
const OPCOES_PERFIL: OpcaoSelect[] = [{ valor: 'atacado', rotulo: 'Atacado' }, { valor: 'varejo', rotulo: 'Varejo' }]

/**
 * Catálogo — UMA tela para consultar e cadastrar (fusão de "Catálogo" com
 * "Cadastro de Produtos" na reorganização de 2026-11-05; `/catalogo-produtos`
 * redireciona para cá). Padrão Lista (L) com cadastro em modal (M):
 *
 *  · a lista é paginada por cursor, com busca, origem, perfil de preço e inativos;
 *  · "Variações" abre a GRADE cor × tamanho com o saldo (skill grade-cor-tamanho)
 *    e, abaixo, as variações — onde o produto manual cria e edita SKU;
 *  · "Novo produto" e "Editar" abrem em ui-modal;
 *  · vindo da ficha (`?contato=<id>`), cada linha ganha "Adicionar ao pedido".
 *
 * ⚠️ Convive com o catálogo do ERP (ADR-025): produto `origem: 'erp'` ganha o
 * selo e só aceita o que o ERP não tem (descrição longa, imagens, categoria) —
 * o resto fica travado AQUI, dizendo por quê, e a regra pura garante que o
 * PATCH não leva campo vetado (a API responderia 409 `catalogo.origem_erp`).
 *
 * ⚠️ O preço vem cotado pela API no perfil escolhido; a tela nunca calcula preço.
 */
@Component({
  selector: 'app-catalogo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet, BadgeComponente, BotaoComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva,
    EstadoComponente, FiltrosComponente, IconeComponente, ModalComponente, PaginacaoComponente, SelectComponente,
    TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Catálogo"
      subtitulo="Produtos com grade cor × tamanho, saldo e preço — do ERP e cadastrados à mão.">
      <ui-botao variante="secundario" [carregando]="reindexando()" (click)="reindexar()"
        title="Refaz o índice que o agente e o pedido assistido usam para achar produtos">Reindexar busca</ui-botao>
      <ui-botao (click)="abrirNovo()">Novo produto</ui-botao>
    </ui-cabecalho-tela>

    @if (estado() !== 'sem_permissao') {
      <ui-filtros placeholder="Buscar por referência ou descrição" rotuloBusca="Busca"
        (buscar)="onBusca($event)" (aplicar)="servico.carregar()" (limpar)="limparFiltros()">
        <ui-select rotulo="Origem" placeholder="Todas as origens" [opcoes]="opcoesOrigem" [valor]="servico.origem()"
          (valorChange)="trocarOrigem($event)" />
        <ui-select rotulo="Perfil de preço" [opcoes]="opcoesPerfil" [valor]="servico.perfil()" (valorChange)="trocarPerfil($event)" />
        <label class="chk">
          <input type="checkbox" [checked]="servico.inativos()" (change)="trocarInativos($any($event.target).checked)" /> Mostrar inativos
        </label>
      </ui-filtros>
    }

    <div class="corpo">
      <!-- Vindo da ficha: o pedido já tem cliente, e cada linha ganha "Adicionar ao pedido". -->
      @if (contatoId()) {
        <p class="contexto txt-denso" role="status"><ui-icone nome="shopping-cart" [tamanho]="14" />Escolha o produto: "Adicionar ao pedido" abre o pedido do cliente com ele.</p>
      }
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas()" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso ao catálogo" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o catálogo" [descricao]="servico.erroLista() ?? ''">
            <ui-botao variante="secundario" (click)="servico.carregar()">Tentar de novo</ui-botao>
          </ui-estado>
        }
        @case ('pronto') {
          @if (itens().length === 0) {
            @if (temFiltro()) {
              <ui-estado titulo="Nada encontrado" descricao="Nenhum produto bate com a busca ou o filtro.">
                <ui-botao variante="secundario" (click)="limparFiltros()">Limpar filtros</ui-botao>
              </ui-estado>
            } @else {
              <ui-estado titulo="Cadastre o primeiro produto" descricao="Com um ERP ligado, o catálogo chega sozinho; sem ERP, ele nasce aqui — e é dele que o agente e o pedido assistido leem.">
                <ui-botao variante="secundario" (click)="abrirNovo()">Novo produto</ui-botao>
              </ui-estado>
            }
          } @else {
            <ui-tabela [colunas]="colunas()" [linhas]="linhas()">
              <ng-template uiCelula="origem" let-p>
                <span class="selos">
                  <ui-badge [tom]="p.origem === 'erp' ? 'info' : 'neutro'">{{ p.origem === 'erp' ? 'ERP' : 'Manual' }}</ui-badge>
                  @if (!p.ativo) { <ui-badge tom="atencao">Inativo</ui-badge> }
                </span>
              </ng-template>
              <ng-template uiCelula="preco" let-p><span class="txt-dados">{{ precoRotulo(p) }}</span></ng-template>
              <ng-template uiCelula="saldo" let-p><span class="txt-dados">{{ saldo(p) }}</span></ng-template>
              <ng-template uiCelula="acoes" let-p>
                <span class="acoes">
                  @if (contatoId()) {
                    <ui-botao variante="secundario" (click)="adicionarAoPedido(p)">Adicionar ao pedido</ui-botao>
                  }
                  <ui-botao variante="fantasma" (click)="abrirVariacoes(p)">{{ temGrade(p) ? 'Grade' : 'Variações' }}</ui-botao>
                  <ui-botao variante="fantasma" (click)="abrirEdicao(p)">Editar</ui-botao>
                  @if (p.ativo) { <ui-botao variante="fantasma" (click)="desativar(p)">Desativar</ui-botao> }
                </span>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhum produto" descricao="Ajuste a busca ou os filtros." />
              </div>
            </ui-tabela>
            @if (servico.erroMais(); as e) { <p class="erro" role="alert">{{ e }}</p> }
            <ui-paginacao [mostrados]="itens().length" [temMais]="!!servico.proximoCursor()"
              [carregando]="servico.carregandoMais()" (mais)="servico.carregarMais()" />
          }
        }
      }
    </div>

    <!-- Novo produto. Fechar NÃO apaga o rascunho (fica em rascunhoNovo). -->
    <ui-modal [aberto]="painel() === 'novo'" titulo="Novo produto" largura="g" [sujo]="false" (fechar)="fecharPainel()">
      <form id="form-novo-produto" class="form" (submit)="criar($event)" novalidate>
        <ng-container *ngTemplateOutlet="camposProduto; context: { erp: false }" />
        <h3 class="txt-secao">Variações (SKU)</h3>
        <p class="dica">Cada linha é uma variação: cor × tamanho, ou o que fizer sentido (ciclo: mensal). Preços em R$. Sem controle de estoque = vende sob demanda.</p>
        @for (s of form().skus; track $index; let i = $index) {
          <ng-container *ngTemplateOutlet="camposSku; context: { s: s, i: i, prefixo: 'skus.' + i + '.' }" />
        }
        <div class="linha-acoes">
          <ui-botao variante="fantasma" (click)="addLinhaSku()">+ Variação</ui-botao>
        </div>
        @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <ui-botao variante="secundario" (click)="fecharPainel()">Cancelar</ui-botao>
        <button type="submit" form="form-novo-produto" class="btn btn--primario" [disabled]="salvando()">{{ salvando() ? "Criando…" : "Criar produto" }}</button>
      </div>
    </ui-modal>

    <!-- Editar produto: mesmos campos do cadastro; origem ERP trava o que é do ERP e diz por quê. -->
    <ui-modal [aberto]="produtoEditando() !== null" [titulo]="'Editar ' + (produtoEditando()?.referencia ?? 'produto')" largura="g" (fechar)="fecharPainel()">
      @if (produtoEditando(); as p) {
        <form id="form-editar-produto" class="form" (submit)="salvarEdicao($event, p)" novalidate>
          @if (p.origem === 'erp') {
            <p class="aviso-erp" role="status">Este produto vem do ERP: referência, descrição, variações, preço e saldo só mudam lá. Aqui você completa o que o ERP não tem — descrição longa, imagens e categoria —, que é o que o agente usa para explicar o produto.</p>
          }
          <ng-container *ngTemplateOutlet="camposProduto; context: { erp: p.origem === 'erp' }" />
          @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
        </form>
      }
      <div rodape>
        <ui-botao variante="secundario" (click)="fecharPainel()">Cancelar</ui-botao>
        <button type="submit" form="form-editar-produto" class="btn btn--primario" [disabled]="salvando()">{{ salvando() ? "Salvando…" : "Salvar" }}</button>
      </div>
    </ui-modal>

    <!-- Variações: a GRADE cor × tamanho (quando há) e a tabela das variações; o produto manual edita aqui. -->
    <ui-modal [aberto]="produtoVariacoes() !== null" [titulo]="(produtoVariacoes()?.referencia ?? '') + ' · variações'" largura="g" [sujo]="skuAlvo() !== null" (fechar)="fecharVariacoes()">
      @if (produtoVariacoes(); as p) {
        <p class="sub-modal">{{ p.descricao }} · {{ precoRotulo(p) }}</p>
        @if (p.origem === 'erp') {
          <p class="aviso-erp" role="status">Variações, preços e saldo deste produto vêm do ERP e só mudam lá.</p>
        }

        @if (gradeAberta(); as g) {
          @if (g.temGrade) {
            <h3 class="txt-secao">Grade · saldo por cor e tamanho</h3>
            <div class="rolagem-x">
              <table class="grade">
                <thead>
                  <tr>
                    <th class="canto">cor \\ tam</th>
                    @for (t of g.tamanhos; track t) { <th class="tcol">{{ t }}</th> }
                    <th class="ttot">Total</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of g.cores; track c.nome) {
                    <tr>
                      <th class="crow">
                        <span class="sw" [class.borda]="c.hex === null || claro(c.hex)" [style.background]="c.hex ?? 'transparent'"></span>
                        <span class="encolhe">{{ c.nome }}</span>
                      </th>
                      @for (t of g.tamanhos; track t) {
                        @let cel = g.celulas[c.nome + '||' + t];
                        @if (cel) {
                          <td class="cel" [class.zero]="(cel.saldo ?? 0) <= 0"
                              [title]="c.nome + ' ' + t + saldoTitulo(cel) + precoTitulo(cel) + (cel.codigoBarras ? ' · ' + cel.codigoBarras : '')">
                            {{ cel.saldo === null ? '?' : cel.saldo }}
                          </td>
                        } @else {
                          <td class="cel vazio" aria-label="sem esta combinação">—</td>
                        }
                      }
                      <td class="cel tot">{{ g.totalCor[c.nome] }}</td>
                    </tr>
                  }
                </tbody>
                <tfoot>
                  <tr>
                    <th class="crow">Total</th>
                    @for (t of g.tamanhos; track t) { <td class="cel tot">{{ g.totalTam[t] }}</td> }
                    <td class="cel tot geral">{{ g.total }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <h3 class="txt-secao">Variações</h3>
          }
        }

        @if (p.skus.length === 0) {
          <ui-estado titulo="Sem variações" [descricao]="p.origem === 'erp' ? 'O ERP ainda não mandou variações deste produto.' : 'Adicione a primeira abaixo.'" />
        } @else {
          <ui-tabela [colunas]="colunasSku" [linhas]="linhasSku(p)">
            <ng-template uiCelula="variacao" let-s>{{ rotulo(s) }}</ng-template>
            <ng-template uiCelula="preco" let-s>
              <span class="txt-dados" [title]="'Preço do perfil ' + servico.perfil()">{{ s.precoCentavos === null ? 'sem preço' : reais(s.precoCentavos) }}</span>
            </ng-template>
            <ng-template uiCelula="saldo" let-s>
              <span class="txt-dados">{{ s.saldo === null ? 'sob demanda' : s.saldo + ' un' }}</span>
            </ng-template>
            <ng-template uiCelula="situacao" let-s>
              @if (!s.ativo) { <ui-badge tom="atencao">Inativo</ui-badge> } @else { <ui-badge tom="sucesso">Ativa</ui-badge> }
            </ng-template>
            <ng-template uiCelula="acoes" let-s>
              @if (p.origem !== 'erp') {
                <span class="acoes">
                  <ui-botao variante="fantasma" (click)="abrirSku(p, s)">Editar</ui-botao>
                  @if (s.ativo) { <ui-botao variante="fantasma" (click)="desativarSku(p, s)">Desativar</ui-botao> }
                </span>
              }
            </ng-template>
          </ui-tabela>
        }

        @if (p.origem !== 'erp') {
          @if (skuAlvo()?.produtoId === p.id) {
            <form id="form-sku" class="form sku-editor" (submit)="salvarSku($event, p)" novalidate>
              <h3 class="txt-secao">{{ skuAlvo()!.skuId ? 'Editar variação' : 'Nova variação' }}</h3>
              @if (precosIndisponiveis()) { <p class="aviso-erp" role="status">Não deu para ler os preços atuais desta variação — os campos abaixo começam vazios; o que você salvar vale.</p> }
              <ng-container *ngTemplateOutlet="camposSku; context: { s: skuForm(), i: -1, prefixo: '' }" />
              @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
            </form>
            <div class="linha-acoes">
              <ui-botao variante="secundario" (click)="fecharSku()">Cancelar variação</ui-botao>
              <button type="submit" form="form-sku" class="btn btn--primario" [disabled]="salvando()">{{ skuAlvo()!.skuId ? "Salvar variação" : "Adicionar variação" }}</button>
            </div>
          } @else {
            <div class="linha-acoes"><ui-botao variante="fantasma" (click)="abrirSku(p, null)">+ Variação</ui-botao></div>
          }
        }
      }
      <div rodape>
        @if (contatoId()) {
          @if (produtoVariacoes(); as p) {
            <ui-botao variante="secundario" (click)="adicionarAoPedido(p)">Adicionar ao pedido</ui-botao>
          }
        }
        <ui-botao variante="secundario" (click)="fecharVariacoes()">Fechar</ui-botao>
      </div>
    </ui-modal>

    <!-- Campos do produto (criação e edição). Rótulo VISÍVEL em tudo. -->
    <ng-template #camposProduto let-erp="erp">
      <div class="grade-campos">
        <ui-campo rotulo="Referência" [valor]="form().referencia" (valorChange)="setCampo('referencia', $event)"
          [desabilitado]="erp" [erro]="erros()['referencia'] ?? null" [obrigatorio]="true" />
        <ui-campo class="campo-2" rotulo="Descrição" [valor]="form().descricao" (valorChange)="setCampo('descricao', $event)"
          [desabilitado]="erp" [erro]="erros()['descricao'] ?? null" [obrigatorio]="true" />
        <ui-campo rotulo="Categoria" [valor]="form().categoria" (valorChange)="setCampo('categoria', $event)"
          [erro]="erros()['categoria'] ?? null" />
        <ui-campo class="campo-2" tipo="textarea" rotulo="Imagens (uma URL por linha)" [valor]="form().imagens"
          (valorChange)="setCampo('imagens', $event)" [erro]="erros()['imagens'] ?? null" />
        <ui-campo class="campo-3" tipo="textarea" rotulo="Descrição longa (o que o agente usa para explicar o produto)"
          [valor]="form().descricaoLonga" (valorChange)="setCampo('descricaoLonga', $event)" [erro]="erros()['descricaoLonga'] ?? null" />
      </div>
    </ng-template>

    <!-- Campos de UMA variação. i = índice no form de criação; -1 = form de SKU avulso. -->
    <ng-template #camposSku let-s="s" let-i="i" let-prefixo="prefixo">
      <div class="sku-form">
        <div class="atributos">
          @for (a of s.atributos; track $index; let j = $index) {
            <span class="par">
              <ui-campo rotulo="Atributo" placeholder="cor" [valor]="a.chave" (valorChange)="setAtributo(i, j, 'chave', $event)" />
              <ui-campo rotulo="Valor" placeholder="VERDE" [valor]="a.valor" (valorChange)="setAtributo(i, j, 'valor', $event)" />
            </span>
          }
          <button type="button" class="link txt-denso" (click)="addAtributo(i)">+ atributo</button>
        </div>
        @if (erros()[prefixo + 'atributos']; as e) { <span class="msg-erro">{{ e }}</span> }
        <div class="grade-campos">
          <ui-campo rotulo="Código de barras" [valor]="s.codigoBarras" (valorChange)="setSku(i, 'codigoBarras', $event)"
            [erro]="erros()[prefixo + 'codigoBarras'] ?? null" />
          <ui-campo rotulo="Preço varejo (R$)" placeholder="0,00" dica="Em reais, ex.: 12,90" [valor]="s.precoVarejo"
            (valorChange)="setSku(i, 'precoVarejo', $event)" [erro]="erros()[prefixo + 'precoVarejo'] ?? null" />
          <ui-campo rotulo="Preço atacado (R$)" placeholder="0,00" dica="Em reais, ex.: 12,90" [valor]="s.precoAtacado"
            (valorChange)="setSku(i, 'precoAtacado', $event)" [erro]="erros()[prefixo + 'precoAtacado'] ?? null" />
          <label class="chk txt-denso">
            <input type="checkbox" [checked]="s.controlaEstoque" (change)="setSku(i, 'controlaEstoque', $any($event.target).checked)" /> controla estoque
          </label>
          @if (s.controlaEstoque) {
            <ui-campo rotulo="Saldo" tipo="number" placeholder="0" [valor]="s.saldo" (valorChange)="setSku(i, 'saldo', $event)"
              [erro]="erros()[prefixo + 'saldo'] ?? null" />
          }
          @if (i >= 0 && form().skus.length > 1) {
            <button type="button" class="link txt-denso remover" (click)="removerLinhaSku(i)">remover variação</button>
          }
        </div>
      </div>
    </ng-template>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-filtros { display: block; }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); white-space: nowrap; }
    .selos { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .acoes { display: inline-flex; flex-wrap: nowrap; white-space: nowrap; justify-content: flex-end; gap: var(--espacamento-1); }
    .contexto { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto); font-size: 13px; }
    .form { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .dica { margin: 0; font-size: 13px; color: var(--texto-suave); }
    .sub-modal { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .aviso-erp { margin: 0 0 var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto); font-size: 13px; }
    h3.txt-secao { margin: var(--espacamento-3) 0 var(--espacamento-2); }
    .grade-campos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--espacamento-3); align-items: start; }
    .campo-2 { grid-column: span 2; }
    .campo-3 { grid-column: span 3; }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .sku-editor { margin-top: var(--espacamento-3); padding-top: var(--espacamento-3); border-top: 1px solid var(--borda); }
    .sku-form { display: grid; gap: var(--espacamento-2); padding: var(--espacamento-3); border: 1px dashed var(--borda-forte); border-radius: var(--raio-controle); }
    .atributos { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: end; }
    .par { display: inline-flex; gap: var(--espacamento-1); align-items: end; }
    .link { border: 0; background: transparent; color: var(--acao); cursor: pointer; padding: var(--espacamento-1) 0; align-self: end; }
    .link:hover { text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .remover { color: var(--erro); }
    .linha-acoes { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); justify-content: flex-start; margin-top: var(--espacamento-2); }
    /* Grade cor × tamanho */
    .rolagem-x { overflow-x: auto; max-width: 100%; }
    table.grade { border-collapse: collapse; font-size: 13px; min-width: max-content; }
    table.grade th, table.grade td { border: 1px solid var(--borda); padding: var(--espacamento-1) var(--espacamento-3); text-align: center; }
    .canto { color: var(--texto-suave); font-weight: 500; font-size: 11px; text-align: left; white-space: nowrap; }
    .tcol { color: var(--texto-secundario); font-weight: 600; }
    .ttot, .tot { background: var(--superficie); color: var(--texto); font-weight: 600; }
    .crow { text-align: left; color: var(--texto); font-weight: 500; white-space: nowrap; }
    .crow > .encolhe { display: inline-block; vertical-align: middle; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
    .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
    .sw.borda { box-shadow: inset 0 0 0 1px var(--borda-forte); }
    .cel { color: var(--texto); font-variant-numeric: tabular-nums; }
    .cel.zero { color: var(--texto-suave); }
    .cel.vazio { color: var(--texto-suave); background: var(--superficie); }
    .cel.geral { color: var(--acao); }
    @media (max-width: 640px) {
      :host { padding: var(--espacamento-3); }
      .grade-campos { grid-template-columns: 1fr; }
      .campo-2, .campo-3 { grid-column: auto; }
    }
  `,
})
export class CatalogoPagina implements OnInit {
  readonly servico = inject(CatalogoProdutosServico)
  private readonly toasts = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)

  readonly estado = this.servico.estado
  readonly itens = this.servico.itens
  readonly opcoesOrigem = OPCOES_ORIGEM
  readonly opcoesPerfil = OPCOES_PERFIL
  /** Cliente de contexto (?contato=<id>) — vem da ficha. Sem ele, não há pedido a abrir. */
  readonly contatoId = signal<string | null>(null)
  readonly temFiltro = computed(() => this.servico.busca().trim() !== '' || this.servico.origem() !== '' || this.servico.inativos())

  protected readonly colunas = computed<ColunaTabela[]>(() => [
    { chave: 'referencia', rotulo: 'Referência', mono: true, largura: '150px' },
    { chave: 'descricao', rotulo: 'Descrição' },
    { chave: 'origem', rotulo: 'Origem', largura: '140px' },
    { chave: 'preco', rotulo: `Preço (${this.servico.perfil()})`, alinhamento: 'dir', largura: '200px' },
    { chave: 'saldo', rotulo: 'Saldo', alinhamento: 'dir', largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: this.contatoId() ? '420px' : '260px' },
  ])
  protected readonly colunasSku: ColunaTabela[] = [
    { chave: 'variacao', rotulo: 'Variação' },
    { chave: 'codigoBarras', rotulo: 'Código de barras', mono: true, largura: '150px' },
    { chave: 'preco', rotulo: 'Preço', alinhamento: 'dir', largura: '130px' },
    { chave: 'saldo', rotulo: 'Saldo', alinhamento: 'dir', largura: '110px' },
    { chave: 'situacao', rotulo: 'Situação', largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '170px' },
  ]
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])

  /** Qual modal de produto está aberto. O rascunho de "novo" sobrevive ao fechar. */
  readonly painel = signal<'nenhum' | 'novo' | 'editar'>('nenhum')
  readonly editandoId = signal<string | null>(null)
  readonly produtoEditando = computed(() => {
    const id = this.editandoId()
    return this.painel() === 'editar' && id ? (this.itens().find((p) => p.id === id) ?? null) : null
  })
  readonly form = signal<ProdutoForm>(produtoVazio())
  private rascunhoNovo: ProdutoForm = produtoVazio()
  readonly erros = signal<Erros>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)
  readonly reindexando = signal(false)

  /** Produto cujas variações (e grade) estão no modal; `null` = fechado. */
  readonly variacoesId = signal<string | null>(null)
  readonly produtoVariacoes = computed(() => {
    const id = this.variacoesId()
    return id ? (this.itens().find((p) => p.id === id) ?? null) : null
  })
  readonly gradeAberta = computed<Grade | null>(() => {
    const p = this.produtoVariacoes()
    return p ? montarGrade(p.skus) : null
  })
  readonly skuAlvo = signal<{ produtoId: string; skuId: string | null } | null>(null)
  readonly skuForm = signal<SkuForm>(skuVazio())
  readonly precosIndisponiveis = signal(false)

  ngOnInit(): void {
    this.contatoId.set(this.route.snapshot.queryParamMap.get('contato'))
    void this.servico.carregar()
  }

  reais(c: number): string { return formatarReais(c) }
  rotulo(s: SkuLinha): string { return rotuloSku(s.atributos) }
  linhasSku(p: ProdutoLinha): readonly LinhaTabela[] { return p.skus as unknown as readonly LinhaTabela[] }
  temGrade(p: ProdutoLinha): boolean { return montarGrade(p.skus).temGrade }
  saldo(p: ProdutoLinha): string { return saldoDaLinha(p.skus) }
  claro(hex: string): boolean { return corClara(hex) }
  saldoTitulo(c: CelulaGrade): string { return c.saldo === null ? ' · saldo não sincronizado' : ` · ${c.saldo} un` }
  precoTitulo(c: CelulaGrade): string { return c.precoCentavos === null ? '' : ` · ${formatarReais(c.precoCentavos)}` }
  /** Preço único, ou faixa mín–máx, no perfil escolhido (cotado pela API). */
  precoRotulo(p: ProdutoLinha): string {
    const precos = [...new Set(p.skus.map((s) => s.precoCentavos).filter((x): x is number => x !== null))]
    if (precos.length === 0) return 'sem preço'
    if (precos.length === 1) return formatarReais(precos[0]!)
    return `${formatarReais(Math.min(...precos))} – ${formatarReais(Math.max(...precos))}`
  }

  /** Abre o pedido do cliente já com a busca no produto escolhido. */
  adicionarAoPedido(p: ProdutoLinha): void {
    const contato = this.contatoId()
    if (!contato) return
    void this.router.navigate(['/pedido'], { queryParams: { contato, busca: p.referencia } })
  }

  // ── Barra ──────────────────────────────────────────────────────────────────
  /** O filtro de busca já espera 300 ms; igual ao termo atual, não recarrega. */
  onBusca(termo: string): void {
    if (termo === this.servico.busca()) return
    this.servico.busca.set(termo)
    void this.servico.carregar()
  }
  trocarOrigem(v: string): void { this.servico.origem.set(v as FiltroOrigem); void this.servico.carregar() }
  trocarPerfil(v: string): void { this.servico.perfil.set(v as PerfilPreco); void this.servico.carregar() }
  trocarInativos(v: boolean): void { this.servico.inativos.set(v); void this.servico.carregar() }
  limparFiltros(): void {
    this.servico.busca.set(''); this.servico.origem.set(''); this.servico.inativos.set(false)
    void this.servico.carregar()
  }

  // ── Modal do produto ───────────────────────────────────────────────────────
  abrirNovo(): void {
    this.form.set(this.rascunhoNovo); this.erros.set({}); this.erroGeral.set(null)
    this.painel.set('novo')
  }
  abrirEdicao(p: ProdutoLinha): void {
    if (this.painel() === 'novo') this.rascunhoNovo = this.form()
    this.form.set(formDeProduto(p)); this.erros.set({}); this.erroGeral.set(null)
    this.editandoId.set(p.id); this.painel.set('editar')
  }
  fecharPainel(): void {
    // ⚠️ Preserva o que foi digitado no "novo": fechar por engano não apaga.
    if (this.painel() === 'novo') this.rascunhoNovo = this.form()
    this.painel.set('nenhum'); this.editandoId.set(null); this.erros.set({}); this.erroGeral.set(null)
  }
  setCampo(campo: keyof Omit<ProdutoForm, 'skus'>, valor: string): void {
    this.form.update((f) => ({ ...f, [campo]: valor }))
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const v = validarProduto(this.form())
    if (!v.ok) { this.erros.set(v.erros); this.erroGeral.set('Confira os campos marcados.'); return }
    this.erros.set({}); this.erroGeral.set(null); this.salvando.set(true)
    try {
      const r = await this.servico.criarProduto(v.corpo)
      if (!r.ok) { this.erroGeral.set(r.mensagem); this.marcarCampos(r.campos); return }
      this.toasts.sucesso(`Produto ${v.corpo.referencia} criado.`)
      this.rascunhoNovo = produtoVazio(); this.form.set(produtoVazio())
      this.painel.set('nenhum')
      await this.servico.carregar()
    } finally { this.salvando.set(false) }
  }

  async salvarEdicao(ev: Event, p: ProdutoLinha): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const v = corpoParaEdicao(this.form(), p.origem)
    if (!v.ok) { this.erros.set(v.erros); this.erroGeral.set('Confira os campos marcados.'); return }
    this.erros.set({}); this.erroGeral.set(null); this.salvando.set(true)
    try {
      const r = await this.servico.editarProduto(p.id, v.corpo)
      if (!r.ok) { this.erroGeral.set(r.mensagem); this.marcarCampos(r.campos); return }
      this.toasts.sucesso('Produto salvo.')
      this.painel.set('nenhum'); this.editandoId.set(null)
      await this.servico.carregar()
    } finally { this.salvando.set(false) }
  }

  async desativar(p: ProdutoLinha): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: `Desativar ${p.referencia}?`,
      mensagem: 'O produto some da busca e do agente, mas continua nos pedidos antigos. Dá para ver em "Mostrar inativos".',
      acao: 'Desativar',
    })
    if (!ok) return
    const r = await this.servico.desativarProduto(p.id)
    if (!r.ok) { this.toasts.erro(r.mensagem); return }
    this.toasts.sucesso(`Produto ${p.referencia} desativado.`)
    await this.servico.carregar()
  }

  async reindexar(): Promise<void> {
    if (this.reindexando()) return
    this.reindexando.set(true)
    try {
      const r = await this.servico.reindexar()
      if (!r.ok) { this.toasts.erro(r.mensagem); return }
      this.toasts.sucesso(`Índice de busca refeito: ${r.indexados} indexados, ${r.inalterados} inalterados, ${r.ausentes} removidos.`)
    } finally { this.reindexando.set(false) }
  }

  /** A API aponta os campos (422/409); marca cada um sem inventar frase. */
  private marcarCampos(campos?: readonly string[]): void {
    if (!campos?.length) return
    const erros: Erros = {}
    for (const c of campos) erros[c] = 'Confira este campo.'
    this.erros.set(erros)
  }

  // ── SKUs no form de criação (i >= 0) ou no form avulso (i = -1) ────────────
  addLinhaSku(): void { this.form.update((f) => ({ ...f, skus: [...f.skus, skuVazio()] })) }
  removerLinhaSku(i: number): void { this.form.update((f) => ({ ...f, skus: f.skus.filter((_, k) => k !== i) })) }

  private mudarSku(i: number, fn: (s: SkuForm) => SkuForm): void {
    if (i < 0) { this.skuForm.update(fn); return }
    this.form.update((f) => ({ ...f, skus: f.skus.map((s, k) => (k === i ? fn(s) : s)) }))
  }
  setSku(i: number, campo: 'codigoBarras' | 'precoVarejo' | 'precoAtacado' | 'saldo' | 'controlaEstoque', valor: string | boolean): void {
    this.mudarSku(i, (s) => ({ ...s, [campo]: valor }))
  }
  setAtributo(i: number, j: number, campo: keyof AtributoForm, valor: string): void {
    this.mudarSku(i, (s) => ({ ...s, atributos: s.atributos.map((a, k) => (k === j ? { ...a, [campo]: valor } : a)) }))
  }
  addAtributo(i: number): void { this.mudarSku(i, (s) => ({ ...s, atributos: [...s.atributos, { chave: '', valor: '' }] })) }

  // ── Modal de variações (grade + SKUs) ──────────────────────────────────────
  abrirVariacoes(p: ProdutoLinha): void {
    this.variacoesId.set(p.id); this.fecharSku()
  }
  fecharVariacoes(): void { this.variacoesId.set(null); this.fecharSku() }

  async abrirSku(p: ProdutoLinha, s: SkuLinha | null): Promise<void> {
    this.erros.set({}); this.erroGeral.set(null); this.precosIndisponiveis.set(false)
    this.skuAlvo.set({ produtoId: p.id, skuId: s?.id ?? null })
    if (!s) { this.skuForm.set(skuVazio()); return }
    // ⚠️ A lista só traz o preço de UM perfil; a edição precisa dos dois.
    const precos = await this.servico.precosPorSku(p.id)
    const par = precos?.get(s.id) ?? { varejo: null, atacado: null }
    if (!precos) this.precosIndisponiveis.set(true)
    this.skuForm.set(formDeSku(s, par))
  }
  fecharSku(): void { this.skuAlvo.set(null); this.erros.set({}); this.erroGeral.set(null) }

  async salvarSku(ev: Event, p: ProdutoLinha): Promise<void> {
    ev.preventDefault()
    const alvo = this.skuAlvo()
    if (!alvo || this.salvando()) return
    const v = validarSku(this.skuForm())
    if (!v.ok) { this.erros.set(v.erros); this.erroGeral.set('Confira os campos marcados.'); return }
    this.erros.set({}); this.erroGeral.set(null); this.salvando.set(true)
    try {
      const r = alvo.skuId
        ? await this.servico.editarSku(p.id, alvo.skuId, v.corpo)
        : await this.servico.adicionarSku(p.id, v.corpo)
      if (!r.ok) { this.erroGeral.set(r.mensagem); this.marcarCampos(r.campos); return }
      this.toasts.sucesso(alvo.skuId ? 'Variação salva.' : 'Variação adicionada.')
      this.fecharSku()
      await this.servico.carregar()
    } finally { this.salvando.set(false) }
  }

  async desativarSku(p: ProdutoLinha, s: SkuLinha): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: `Desativar a variação ${rotuloSku(s.atributos)}?`,
      mensagem: 'Ela sai da busca e do pedido assistido, mas continua nos pedidos antigos.',
      acao: 'Desativar',
    })
    if (!ok) return
    const r = await this.servico.desativarSku(p.id, s.id)
    if (!r.ok) { this.toasts.erro(r.mensagem); return }
    this.toasts.sucesso('Variação desativada.')
    await this.servico.carregar()
  }
}
