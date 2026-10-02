import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { NgTemplateOutlet } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, CabecalhoTelaComponente, ConfirmacaoServico, EstadoComponente,
  EsqueletoComponente, ToastServico, formatarReais,
} from '../../compartilhado/ui/index.js'
import { CatalogoProdutosServico, type FiltroOrigem, type ProdutoLinha, type SkuLinha } from './catalogo-produtos.servico.js'
import {
  corpoParaEdicao, formDeProduto, formDeSku, produtoVazio, rotuloSku, skuVazio, validarProduto, validarSku,
  type AtributoForm, type Erros, type ProdutoForm, type SkuForm,
} from './catalogo-produtos.regras.js'

/**
 * Cadastro manual de produtos (ADR-025) — o CRUD canônico (skill
 * geracrm-layout-ui): cabeçalho, barra de busca/filtros, lista por CURSOR,
 * painel de criar/editar inline que preserva o que foi digitado, cinco estados.
 *
 * ⚠️ Convive com o catálogo do ERP: produto `origem: 'erp'` ganha o selo e só
 * aceita o que o ERP não tem (descrição longa, imagens, categoria). O resto
 * fica desabilitado AQUI, e a regra pura garante que o PATCH não leva campo
 * vetado — a API responderia 409 `catalogo.origem_erp`.
 *
 * ⚠️ Preço na lista é o do perfil padrão (atacado). Os dois preços só aparecem
 * ao abrir a variação para editar — a API cota um perfil por chamada.
 */
@Component({
  selector: 'app-catalogo-produtos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, CabecalhoTelaComponente, BotaoComponente, BadgeComponente, EstadoComponente, EsqueletoComponente],
  template: `
    <div class="pagina">
      <ui-cabecalho-tela titulo="Cadastro de Produtos"
        subtitulo="Produtos, variações, preços e saldo cadastrados à mão — lado a lado com o que vem do ERP.">
        <ui-botao variante="secundario" [carregando]="reindexando()" (click)="reindexar()">Reindexar busca</ui-botao>
        <ui-botao (click)="alternarNovo()">{{ painel() === 'novo' ? 'Fechar' : '+ Novo produto' }}</ui-botao>
      </ui-cabecalho-tela>

      <!-- Painel de criação: inline, abaixo do cabeçalho. Fechar NÃO apaga o rascunho. -->
      @if (painel() === 'novo') {
        <form class="painel" (submit)="criar($event)" novalidate>
          <h2 class="txt-secao">Novo produto</h2>
          <ng-container *ngTemplateOutlet="camposProduto; context: { erp: false }" />
          <h3 class="txt-rotulo">Variações (SKU)</h3>
          <p class="txt-denso dica">Cada linha é uma variação: cor × tamanho, ou o que fizer sentido (ciclo: mensal). Preços em R$. Sem controle de estoque = vende sob demanda.</p>
          @for (s of form().skus; track $index; let i = $index) {
            <ng-container *ngTemplateOutlet="camposSku; context: { s: s, i: i, prefixo: 'skus.' + i + '.' }" />
          }
          <div class="linha-acoes">
            <ui-botao variante="fantasma" (click)="addLinhaSku()">+ Variação</ui-botao>
          </div>
          @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
          <div class="acoes">
            <ui-botao variante="secundario" (click)="fecharPainel()">Cancelar</ui-botao>
            <ui-botao tipo="submit" [carregando]="salvando()">Criar produto</ui-botao>
          </div>
        </form>
      }

      <!-- Barra: busca + filtros. Some no vazio-sem-filtro (regra do padrão). -->
      @if (estado() !== 'sem_permissao' && (itens().length > 0 || temFiltro())) {
        <div class="barra">
          <input class="busca" type="search" [value]="buscaTexto()" (input)="onBusca($any($event.target).value)"
                 placeholder="Buscar por referência ou descrição" aria-label="Buscar produto" />
          <select class="sel" [value]="servico.origem()" (change)="trocarOrigem($any($event.target).value)" aria-label="Origem">
            <option value="">Todas as origens</option>
            <option value="manual">Só manuais</option>
            <option value="erp">Só do ERP</option>
          </select>
          <label class="chk txt-denso">
            <input type="checkbox" [checked]="servico.inativos()" (change)="trocarInativos($any($event.target).checked)" /> mostrar inativos
          </label>
        </div>
      }

      @switch (estado()) {
        @case ('carregando') {
          <div class="lista" aria-busy="true">
            @for (n of [1, 2, 3]; track n) { <div class="prod"><ui-esqueleto altura="20px" largura="60%" /><ui-esqueleto altura="14px" largura="40%" /></div> }
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso ao cadastro de produtos" descricao="Peça a um administrador para liberar." />
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
              <ui-estado titulo="Cadastre o primeiro produto" descricao="Sem ERP ligado, o catálogo nasce aqui — e é dele que o agente e o pedido assistido leem.">
                <ui-botao (click)="alternarNovo()">+ Novo produto</ui-botao>
              </ui-estado>
            }
          } @else {
            <ul class="lista">
              @for (p of itens(); track p.id) {
                <li class="prod" [class.inativo]="!p.ativo">
                  <div class="prod-topo">
                    <button type="button" class="abrir encolhe" (click)="alternarAberto(p.id)" [attr.aria-expanded]="aberto() === p.id">
                      <span class="ref txt-dados">{{ p.referencia }}</span>
                      <span class="desc encolhe">{{ p.descricao }}</span>
                    </button>
                    <span class="selos">
                      <ui-badge [tom]="p.origem === 'erp' ? 'info' : 'neutro'">{{ p.origem === 'erp' ? 'ERP' : 'Manual' }}</ui-badge>
                      @if (!p.ativo) { <ui-badge tom="atencao">Inativo</ui-badge> }
                    </span>
                    <span class="meta txt-denso">{{ p.skus.length }} {{ p.skus.length === 1 ? 'variação' : 'variações' }} · {{ precoRotulo(p) }}</span>
                    <span class="prod-acoes">
                      <ui-botao variante="fantasma" (click)="abrirEdicao(p)">Editar</ui-botao>
                      @if (p.ativo) { <ui-botao variante="fantasma" (click)="desativar(p)">Desativar</ui-botao> }
                    </span>
                  </div>
                  @if (p.categoria) { <span class="txt-denso cat">{{ p.categoria }}</span> }

                  <!-- Edição do produto: painel inline no próprio item. -->
                  @if (painel() === 'editar' && editandoId() === p.id) {
                    <form class="painel interno" (submit)="salvarEdicao($event, p)" novalidate>
                      <h2 class="txt-secao">Editar produto</h2>
                      @if (p.origem === 'erp') {
                        <p class="aviso-erp txt-denso" role="status">Este produto vem do ERP: referência e descrição só mudam lá. Aqui você edita descrição longa, imagens e categoria.</p>
                      }
                      <ng-container *ngTemplateOutlet="camposProduto; context: { erp: p.origem === 'erp' }" />
                      @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
                      <div class="acoes">
                        <ui-botao variante="secundario" (click)="fecharPainel()">Cancelar</ui-botao>
                        <ui-botao tipo="submit" [carregando]="salvando()">Salvar</ui-botao>
                      </div>
                    </form>
                  }

                  <!-- Variações: abertas sob demanda. -->
                  @if (aberto() === p.id) {
                    <div class="skus">
                      @if (p.skus.length === 0) { <p class="txt-denso dica">Sem variações. Adicione a primeira abaixo.</p> }
                      @for (s of p.skus; track s.id) {
                        <div class="sku" [class.inativo]="!s.ativo">
                          <span class="sku-rot encolhe">{{ rotulo(s) }}</span>
                          @if (s.codigoBarras) { <span class="txt-dados sku-cb">{{ s.codigoBarras }}</span> }
                          <span class="txt-dados sku-preco" [title]="'Preço do perfil atacado'">{{ s.precoCentavos === null ? 'sem preço' : reais(s.precoCentavos) }}</span>
                          <span class="txt-dados sku-saldo">{{ s.saldo === null ? 'sob demanda' : s.saldo + ' un' }}</span>
                          @if (!s.ativo) { <ui-badge tom="atencao">Inativo</ui-badge> }
                          <span class="sku-acoes">
                            <ui-botao variante="fantasma" [desabilitado]="p.origem === 'erp'" (click)="abrirSku(p, s)">Editar</ui-botao>
                            @if (s.ativo) { <ui-botao variante="fantasma" [desabilitado]="p.origem === 'erp'" (click)="desativarSku(p, s)">Desativar</ui-botao> }
                          </span>
                        </div>
                      }
                      @if (p.origem === 'erp') {
                        <p class="txt-denso dica">Variações, preços e saldo deste produto vêm do ERP e só mudam lá.</p>
                      } @else if (skuAlvo()?.produtoId === p.id) {
                        <form class="painel interno" (submit)="salvarSku($event, p)" novalidate>
                          <h2 class="txt-secao">{{ skuAlvo()!.skuId ? 'Editar variação' : 'Nova variação' }}</h2>
                          @if (precosIndisponiveis()) { <p class="txt-denso aviso-erp" role="status">Não deu para ler os preços atuais desta variação — os campos abaixo começam vazios; o que você salvar vale.</p> }
                          <ng-container *ngTemplateOutlet="camposSku; context: { s: skuForm(), i: -1, prefixo: '' }" />
                          @if (erroGeral(); as e) { <p class="erro" role="alert">{{ e }}</p> }
                          <div class="acoes">
                            <ui-botao variante="secundario" (click)="fecharSku()">Cancelar</ui-botao>
                            <ui-botao tipo="submit" [carregando]="salvando()">{{ skuAlvo()!.skuId ? 'Salvar variação' : 'Adicionar variação' }}</ui-botao>
                          </div>
                        </form>
                      } @else {
                        <div class="linha-acoes"><ui-botao variante="fantasma" (click)="abrirSku(p, null)">+ Variação</ui-botao></div>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
            @if (servico.erroMais(); as e) { <p class="erro" role="alert">{{ e }}</p> }
            @if (servico.proximoCursor()) {
              <div class="mais"><ui-botao variante="secundario" [carregando]="servico.carregandoMais()" (click)="servico.carregarMais()">Carregar mais</ui-botao></div>
            }
          }
        }
      }
    </div>

    <!-- Campos do produto (criação e edição). Rótulo VISÍVEL em tudo. -->
    <ng-template #camposProduto let-erp="erp">
      <div class="grade-campos">
        <label class="campo">
          <span class="rot">Referência</span>
          <input [value]="form().referencia" (input)="setCampo('referencia', $any($event.target).value)" [disabled]="erp" maxlength="60"
                 [attr.aria-invalid]="erros()['referencia'] ? 'true' : null" />
          @if (erros()['referencia']; as e) { <span class="msg-erro">{{ e }}</span> }
        </label>
        <label class="campo campo-2">
          <span class="rot">Descrição</span>
          <input [value]="form().descricao" (input)="setCampo('descricao', $any($event.target).value)" [disabled]="erp" maxlength="160"
                 [attr.aria-invalid]="erros()['descricao'] ? 'true' : null" />
          @if (erros()['descricao']; as e) { <span class="msg-erro">{{ e }}</span> }
        </label>
        <label class="campo">
          <span class="rot">Categoria</span>
          <input [value]="form().categoria" (input)="setCampo('categoria', $any($event.target).value)" maxlength="80" />
          @if (erros()['categoria']; as e) { <span class="msg-erro">{{ e }}</span> }
        </label>
        <label class="campo campo-2">
          <span class="rot">Imagens (uma URL por linha)</span>
          <textarea rows="2" [value]="form().imagens" (input)="setCampo('imagens', $any($event.target).value)"
                    [attr.aria-invalid]="erros()['imagens'] ? 'true' : null"></textarea>
          @if (erros()['imagens']; as e) { <span class="msg-erro">{{ e }}</span> }
        </label>
        <label class="campo campo-3">
          <span class="rot">Descrição longa (o que o agente usa para explicar o produto)</span>
          <textarea rows="3" [value]="form().descricaoLonga" (input)="setCampo('descricaoLonga', $any($event.target).value)" maxlength="4000"></textarea>
          @if (erros()['descricaoLonga']; as e) { <span class="msg-erro">{{ e }}</span> }
        </label>
      </div>
    </ng-template>

    <!-- Campos de UMA variação. i = índice no form de criação; -1 = form de SKU avulso. -->
    <ng-template #camposSku let-s="s" let-i="i" let-prefixo="prefixo">
      <div class="sku-form">
        <div class="atributos">
          @for (a of s.atributos; track $index; let j = $index) {
            <span class="par">
              <label class="campo mini">
                <span class="rot">Atributo</span>
                <input [value]="a.chave" (input)="setAtributo(i, j, 'chave', $any($event.target).value)" placeholder="cor" maxlength="40" />
              </label>
              <label class="campo mini">
                <span class="rot">Valor</span>
                <input [value]="a.valor" (input)="setAtributo(i, j, 'valor', $any($event.target).value)" placeholder="VERDE" maxlength="80" />
              </label>
            </span>
          }
          <button type="button" class="link txt-denso" (click)="addAtributo(i)">+ atributo</button>
        </div>
        @if (erros()[prefixo + 'atributos']; as e) { <span class="msg-erro">{{ e }}</span> }
        <div class="grade-campos">
          <label class="campo">
            <span class="rot">Código de barras</span>
            <input [value]="s.codigoBarras" (input)="setSku(i, 'codigoBarras', $any($event.target).value)" maxlength="40" />
            @if (erros()[prefixo + 'codigoBarras']; as e) { <span class="msg-erro">{{ e }}</span> }
          </label>
          <label class="campo">
            <span class="rot">Preço varejo (R$)</span>
            <input inputmode="decimal" [value]="s.precoVarejo" (input)="setSku(i, 'precoVarejo', $any($event.target).value)" placeholder="0,00"
                   [attr.aria-invalid]="erros()[prefixo + 'precoVarejo'] ? 'true' : null" />
            @if (erros()[prefixo + 'precoVarejo']; as e) { <span class="msg-erro">{{ e }}</span> }
          </label>
          <label class="campo">
            <span class="rot">Preço atacado (R$)</span>
            <input inputmode="decimal" [value]="s.precoAtacado" (input)="setSku(i, 'precoAtacado', $any($event.target).value)" placeholder="0,00"
                   [attr.aria-invalid]="erros()[prefixo + 'precoAtacado'] ? 'true' : null" />
            @if (erros()[prefixo + 'precoAtacado']; as e) { <span class="msg-erro">{{ e }}</span> }
          </label>
          <label class="chk txt-denso">
            <input type="checkbox" [checked]="s.controlaEstoque" (change)="setSku(i, 'controlaEstoque', $any($event.target).checked)" /> controla estoque
          </label>
          @if (s.controlaEstoque) {
            <label class="campo">
              <span class="rot">Saldo</span>
              <input inputmode="numeric" [value]="s.saldo" (input)="setSku(i, 'saldo', $any($event.target).value)" placeholder="0"
                     [attr.aria-invalid]="erros()[prefixo + 'saldo'] ? 'true' : null" />
              @if (erros()[prefixo + 'saldo']; as e) { <span class="msg-erro">{{ e }}</span> }
            </label>
          }
          @if (i >= 0 && form().skus.length > 1) {
            <button type="button" class="link txt-denso remover" (click)="removerLinhaSku(i)">remover variação</button>
          }
        </div>
      </div>
    </ng-template>
  `,
  styles: `
    :host { display: block; width: 100%; }
    .pagina { max-width: 960px; margin: 0 auto; padding: var(--espacamento-6) var(--espacamento-4); }
    .barra { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--espacamento-4); }
    .busca { flex: 1; min-width: 200px; min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .sel { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); white-space: nowrap; }
    .busca:focus-visible, .sel:focus-visible, input:focus-visible, textarea:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .prod { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); display: grid; gap: var(--espacamento-2); }
    .prod.inativo { opacity: .7; }
    .prod-topo { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .abrir { display: flex; align-items: baseline; gap: var(--espacamento-3); flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; font: inherit; color: var(--texto); cursor: pointer; text-align: left; }
    .abrir:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .ref { color: var(--acao); flex: none; }
    .desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selos { display: inline-flex; gap: var(--espacamento-1); flex: none; }
    .meta { color: var(--texto-suave); flex: none; }
    .cat { color: var(--texto-suave); }
    .prod-acoes, .sku-acoes { display: inline-flex; gap: var(--espacamento-1); flex: none; }
    .skus { display: grid; gap: var(--espacamento-2); padding-top: var(--espacamento-2); border-top: 1px solid var(--borda); }
    .sku { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; padding: var(--espacamento-1) 0; }
    .sku.inativo { opacity: .6; }
    .sku-rot { flex: 1; min-width: 120px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sku-cb, .sku-saldo { color: var(--texto-suave); }
    .sku-preco { color: var(--texto); min-width: 90px; text-align: right; }
    .painel { display: grid; gap: var(--espacamento-3); padding: var(--espacamento-5); margin-bottom: var(--espacamento-5);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .painel.interno { margin: var(--espacamento-2) 0 0; background: var(--superficie); }
    .painel h2 { margin: 0; }
    .painel h3 { margin: var(--espacamento-2) 0 0; }
    .dica { margin: 0; color: var(--texto-suave); }
    .aviso-erp { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto); }
    .grade-campos { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--espacamento-3); align-items: end; }
    .campo-2 { grid-column: span 2; }
    .campo-3 { grid-column: span 3; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); min-width: 0; }
    .campo .rot { font-size: 13px; color: var(--texto); }
    .campo input, .campo textarea { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; width: 100%; }
    .campo textarea { resize: vertical; }
    .campo input:disabled { opacity: .6; }
    .campo input[aria-invalid='true'] { border-color: var(--borda-erro); }
    .campo.mini input { min-height: 32px; }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .sku-form { display: grid; gap: var(--espacamento-2); padding: var(--espacamento-3); border: 1px dashed var(--borda-forte); border-radius: var(--raio-controle); }
    .atributos { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: end; }
    .par { display: inline-flex; gap: var(--espacamento-1); }
    .link { border: 0; background: transparent; color: var(--acao); cursor: pointer; padding: var(--espacamento-1) 0; align-self: end; }
    .link:hover { text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .remover { color: var(--erro); }
    .linha-acoes { display: flex; }
    .acoes { display: flex; justify-content: flex-end; gap: var(--espacamento-2); flex-wrap: wrap; }
    .mais { margin-top: var(--espacamento-4); display: flex; justify-content: center; }
    @media (max-width: 640px) {
      .grade-campos { grid-template-columns: 1fr; }
      .campo-2, .campo-3 { grid-column: auto; }
      .meta { display: none; }
    }
  `,
})
export class CatalogoProdutosPagina implements OnInit {
  readonly servico = inject(CatalogoProdutosServico)
  private readonly toasts = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly estado = this.servico.estado
  readonly itens = this.servico.itens
  readonly buscaTexto = signal('')
  readonly temFiltro = computed(() => this.servico.busca().trim() !== '' || this.servico.origem() !== '' || this.servico.inativos())

  /** Qual painel está aberto. O rascunho de "novo" sobrevive ao fechar. */
  readonly painel = signal<'nenhum' | 'novo' | 'editar'>('nenhum')
  readonly editandoId = signal<string | null>(null)
  readonly form = signal<ProdutoForm>(produtoVazio())
  private rascunhoNovo: ProdutoForm = produtoVazio()
  readonly erros = signal<Erros>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)
  readonly reindexando = signal(false)

  readonly aberto = signal<string | null>(null)
  readonly skuAlvo = signal<{ produtoId: string; skuId: string | null } | null>(null)
  readonly skuForm = signal<SkuForm>(skuVazio())
  readonly precosIndisponiveis = signal(false)

  private timer?: ReturnType<typeof setTimeout>

  ngOnInit(): void { void this.servico.carregar() }

  reais(c: number): string { return formatarReais(c) }
  rotulo(s: SkuLinha): string { return rotuloSku(s.atributos) }
  precoRotulo(p: ProdutoLinha): string {
    const precos = [...new Set(p.skus.map((s) => s.precoCentavos).filter((x): x is number => x !== null))]
    if (precos.length === 0) return 'sem preço'
    if (precos.length === 1) return `atacado ${formatarReais(precos[0]!)}`
    return `atacado ${formatarReais(Math.min(...precos))} – ${formatarReais(Math.max(...precos))}`
  }

  // ── Barra ──────────────────────────────────────────────────────────────────
  onBusca(v: string): void {
    this.buscaTexto.set(v)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.servico.busca.set(v); void this.servico.carregar() }, 300)
  }
  trocarOrigem(v: string): void { this.servico.origem.set(v as FiltroOrigem); void this.servico.carregar() }
  trocarInativos(v: boolean): void { this.servico.inativos.set(v); void this.servico.carregar() }
  limparFiltros(): void {
    this.buscaTexto.set(''); this.servico.busca.set(''); this.servico.origem.set(''); this.servico.inativos.set(false)
    void this.servico.carregar()
  }

  // ── Painel do produto ──────────────────────────────────────────────────────
  alternarNovo(): void {
    if (this.painel() === 'novo') { this.fecharPainel(); return }
    if (this.painel() === 'editar') this.fecharPainel()
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
      mensagem: 'O produto some da busca e do agente, mas continua nos pedidos antigos. Dá para ver em "mostrar inativos".',
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

  alternarAberto(id: string): void {
    this.aberto.update((a) => (a === id ? null : id))
    if (this.skuAlvo()?.produtoId !== this.aberto()) this.fecharSku()
  }

  async abrirSku(p: ProdutoLinha, s: SkuLinha | null): Promise<void> {
    this.aberto.set(p.id); this.erros.set({}); this.erroGeral.set(null); this.precosIndisponiveis.set(false)
    this.skuAlvo.set({ produtoId: p.id, skuId: s?.id ?? null })
    if (!s) { this.skuForm.set(skuVazio()); return }
    // ⚠️ A lista só traz o preço do perfil padrão; a edição precisa dos dois.
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
      this.aberto.set(p.id)
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
    this.aberto.set(p.id)
  }
}
