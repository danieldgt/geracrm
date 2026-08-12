import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { SlicePipe } from '@angular/common'
import { ActivatedRoute } from '@angular/router'
import { PedidoServico, type ProdutoCatalogo, type SkuCatalogo } from './pedido.servico.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'

/**
 * Pedido Assistido — o tira-pedido que nasce na conversa (ADR-005, §3.9 do mapa).
 *
 * ⚠️ Preço e saldo AO VIVO do ERP dependem de `/estoques/tela-venda`, que exige
 * uma tabela de preço — integração ainda não ligada. Até lá o preço é entrado
 * na tela e o rascunho guarda o SNAPSHOT (INV-25). A degradação é VISÍVEL
 * (ADR-008): a tela avisa que o preço é manual, não finge que veio do ERP.
 *
 * Catálogo com grade cor × tamanho é dado REAL (o que a carga do GeraCloud trouxe).
 */
@Component({
  selector: 'app-pedido-assistido',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SlicePipe],
  template: `
    <header class="cabecalho">
      <div>
        <h1>Pedido Assistido</h1>
        <p class="sub">Monte o pedido pela grade do catálogo. O rascunho não se perde.</p>
      </div>
      <span class="degradado" title="Saldo ao vivo entra na próxima etapa">
        ⚠️ saldo ao vivo do ERP: próxima etapa · preço: tabela padrão do ERP
      </span>
    </header>

    <!-- Vários rascunhos por cliente: troque, crie e renomeie; envia um por um. -->
    @if (contatoId()) {
      <div class="rascunhos">
        <span class="r-lab">Rascunhos:</span>
        @for (r of servico.rascunhos(); track r.id) {
          @if (r.estado === 'rascunho') {
            <button class="r-chip" [class.on]="servico.pedido()?.id === r.id" (click)="trocarRascunho(r.id)">
              {{ r.nome || 'Sem nome' }} <span class="r-n">{{ r.itens }}</span>
            </button>
          }
        }
        <button class="r-novo" (click)="novoRascunho()">+ Novo</button>
        @if (servico.pedido()) { <button class="r-rename" (click)="renomear()" title="Renomear rascunho">✎</button> }
      </div>
    }

    <div class="grade-tela">
      <!-- Busca + grade -->
      <section class="cat">
        <div class="perfil">
          <!-- ⚠️ Preço muda por perfil (ADR-019): atacado ≠ varejo. -->
          <button [class.on]="perfil() === 'atacado'" (click)="trocarPerfil('atacado')">Atacado</button>
          <button [class.on]="perfil() === 'varejo'" (click)="trocarPerfil('varejo')">Varejo</button>
        </div>
        <input class="busca" type="search" placeholder="Buscar produto por nome ou referência…"
               [value]="termo()" (input)="onBusca($event)" />

        <!-- Filtros paginados: categoria, cor, tamanho, faixa de preço. -->
        <div class="filtros">
          <select [value]="fCategoria()" (change)="fCategoria.set($any($event.target).value); aplicarFiltro()" aria-label="Categoria">
            <option value="">Categoria</option>
            @for (c of servico.filtros().categorias; track c) { <option [value]="c">{{ c }}</option> }
          </select>
          <select [value]="fCor()" (change)="fCor.set($any($event.target).value); aplicarFiltro()" aria-label="Cor">
            <option value="">Cor</option>
            @for (c of servico.filtros().cores; track c) { <option [value]="c">{{ c }}</option> }
          </select>
          <select [value]="fTamanho()" (change)="fTamanho.set($any($event.target).value); aplicarFiltro()" aria-label="Tamanho">
            <option value="">Tamanho</option>
            @for (t of servico.filtros().tamanhos; track t) { <option [value]="t">{{ t }}</option> }
          </select>
          <input class="preco-f" inputmode="decimal" placeholder="R$ mín" [value]="fPrecoMin()" (change)="fPrecoMin.set($any($event.target).value); aplicarFiltro()" aria-label="Preço mínimo" />
          <input class="preco-f" inputmode="decimal" placeholder="R$ máx" [value]="fPrecoMax()" (change)="fPrecoMax.set($any($event.target).value); aplicarFiltro()" aria-label="Preço máximo" />
        </div>

        @if (servico.buscando()) { <p class="dica">Buscando…</p> }
        @else if (resultados().length === 0 && buscou()) {
          <p class="dica">Nenhum produto encontrado. Tente outro termo.</p>
        } @else if (servico.limitado()) {
          <p class="dica">Mostrando os primeiros resultados — refine a busca para ver outros.</p>
        }

        <ul class="produtos">
          @for (p of resultados(); track p.id) {
            <li class="produto">
              <button class="linha-prod" (click)="alternar(p.id)">
                <span><strong>{{ p.descricao }}</strong> <span class="ref">{{ p.referencia }}</span></span>
                <span class="qtd-var">{{ p.skus.length }} variações</span>
              </button>
              @if (aberto() === p.id) {
                @if (temGrade(p)) {
                  <!-- Grade cor × tamanho (skill grade-cor-tamanho): matriz reutilizável.
                       Célula sem SKU = "—" (grade não retangular). Quantidade por célula
                       + "Adicionar" em lote. Preço/saldo vêm do ERP no title. -->
                  <div class="rolagem-x grade-wrap">
                    <table class="grade-mtx">
                      <thead>
                        <tr>
                          <th class="canto"></th>
                          @for (t of tamanhosDe(p); track t) { <th>{{ t }}</th> }
                        </tr>
                      </thead>
                      <tbody>
                        @for (cor of coresDe(p); track cor) {
                          <tr>
                            <th class="cor-lab" scope="row">{{ cor }}</th>
                            @for (t of tamanhosDe(p); track t) {
                              @if (skuDe(p, cor, t); as s) {
                                <td class="cel" [class.sem-preco]="s.precoCentavos === null" [title]="celTitulo(s)">
                                  @if (s.precoCentavos !== null) {
                                    <input class="q" type="number" min="0" inputmode="numeric" placeholder="0"
                                           [class.tem]="temQtd(s.id)" [value]="qtdGradeDe(s.id)"
                                           (input)="setQtdGrade(s.id, $any($event.target).value)" />
                                  } @else { <span class="sp" title="Sem preço no ERP">s/ preço</span> }
                                </td>
                              } @else { <td class="cel vazia" aria-hidden="true">—</td> }
                            }
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  <div class="grade-acoes">
                    <span class="dica-g">Preço: tabela do ERP · saldo da última sync (passe o mouse na célula)</span>
                    <button class="add" [disabled]="servico.salvandoItem() || !algumaQtd(p)"
                            (click)="adicionarGrade(p)">Adicionar selecionados</button>
                  </div>
                } @else {
                  <!-- Sem eixo cor×tamanho: lista plana (o par de eixos generaliza, mas
                       nem todo produto tem os dois). -->
                  <ul class="grade">
                    @for (s of p.skus; track s.id) {
                      <li class="sku">
                        <span class="attrs">
                          @for (a of atributos(s); track a) { <span class="attr">{{ a }}</span> }
                        </span>
                        <span class="preco-erp mono">
                          {{ s.precoCentavos !== null ? reais(s.precoCentavos) : 'sem preço' }}
                          @if (s.saldo !== null) {
                            <small class="saldo" [class.zerado]="s.saldo <= 0" [title]="'apurado em ' + (s.saldoEm | slice:0:10)">
                              {{ s.saldo <= 0 ? 'sem saldo' : s.saldo + ' un' }}
                            </small>
                          }
                        </span>
                        <input class="qtd" type="number" min="1" value="1" #qtd />
                        <button class="add" [disabled]="servico.salvandoItem() || s.precoCentavos === null"
                                (click)="adicionar(p, s, qtd.value)">Adicionar</button>
                      </li>
                    }
                  </ul>
                }
              }
            </li>
          }
        </ul>
        @if (servico.proximoCursor()) {
          <button class="mais-cat" (click)="carregarMais()" [disabled]="servico.buscando()">Carregar mais produtos</button>
        }
      </section>

      <!-- Rascunho -->
      <aside class="rascunho">
        <h2>Rascunho</h2>
        @if (servico.pedido(); as ped) {
          @if (ped.itens.length === 0) {
            <p class="vazio">Nenhum item ainda. Busque um produto e adicione pela grade.</p>
          } @else {
            <ul class="itens">
              @for (i of ped.itens; track i.seq) {
                <li>
                  <div class="desc">
                    <strong>{{ i.descricaoSnapshot }}</strong>
                    <span class="attrs">
                      @for (a of atributosGrade(i.grade); track a) { <span class="attr">{{ a }}</span> }
                    </span>
                  </div>
                  <span class="mono">{{ i.quantidade }} × {{ reais(i.valorUnitarioCentavos) }}</span>
                  <span class="mono sub-total">{{ reais(i.quantidade * i.valorUnitarioCentavos) }}</span>
                </li>
              }
            </ul>
            <div class="totais">
              <span>{{ ped.totalPecas }} peças</span>
              <strong class="mono">{{ reais(ped.totalCentavos) }}</strong>
            </div>

            <!-- Contexto de venda: entra no resumo enviado ao cliente. -->
            <div class="contexto">
              <label class="ctx">Forma de pagamento
                <input list="formas-pgto" [value]="ped.formaPagamento ?? ''"
                       (change)="salvarContexto(ped.id, 'formaPagamento', $any($event.target).value)"
                       placeholder="Ex.: Pix" />
                <datalist id="formas-pgto">@for (f of formasPagamento; track f) { <option [value]="f"></option> }</datalist>
              </label>
              <label class="ctx">Observação
                <textarea rows="2" [value]="ped.observacao ?? ''"
                          (change)="salvarContexto(ped.id, 'observacao', $any($event.target).value)"
                          placeholder="Prazo, entrega, combinados…"></textarea>
              </label>
            </div>

            <!-- Efetivação (ADR-005): idempotente + falha nomeada + rascunho
                 nunca perdido. Se o ERP não escreve, DEGRADA visível (ADR-008). -->
            <!-- Confirmar com o cliente: manda o resumo na conversa (só se houver itens). -->
            <button class="secundario" (click)="enviarResumo(ped.id)"
                    [disabled]="servico.enviandoResumo() || ped.itens.length === 0">
              {{ servico.enviandoResumo() ? 'Enviando…' : '📤 Confirmar e enviar resumo ao cliente' }}
            </button>
            @if (servico.resumoMsg(); as rm) {
              <div class="efet" [class.efet--ok]="rm.ok" [class.efet--aviso]="!rm.ok">{{ rm.ok ? '✅ ' : '⚠️ ' }}{{ rm.texto }}</div>
            }
            <button class="primario" (click)="servico.efetivar(ped.id)"
                    [disabled]="servico.efetivando() || ped.estado === 'efetivado'">
              {{ ped.estado === 'efetivado' ? 'Efetivado' : servico.efetivando() ? 'Efetivando…' : 'Efetivar pedido' }}
            </button>
            @if (servico.resultado(); as r) {
              <div class="efet" [class.efet--ok]="r.ok" [class.efet--aviso]="!r.ok">
                @if (r.ok) { ✅ Efetivado no ERP — nº {{ r.numeroExterno }} }
                @else { ⚠️ {{ r.mensagem }} }
              </div>
            }
            @if (ped.estado === 'falhou') {
              <p class="efet-nota">O rascunho está intacto — ajuste e efetive de novo.</p>
            } @else if (ped.estado === 'aguardando_conferencia') {
              <p class="efet-nota">Conferindo no ERP se o pedido entrou. Não reenvie.</p>
            }
          }
        } @else {
          <p class="vazio">Adicione o primeiro item para abrir o rascunho.</p>
        }
      </aside>
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-5); flex-wrap: wrap; }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .degradado { font-size: 12px; color: var(--atencao); border: 1px solid var(--atencao); border-radius: var(--raio-controle); padding: 2px var(--espacamento-3); }
    .grade-tela { display: grid; grid-template-columns: 1.6fr 1fr; gap: var(--espacamento-4); align-items: start; }
    .cat, .rascunho { border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); padding: var(--espacamento-4); }
    .perfil { display: inline-flex; gap: 2px; margin-bottom: var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); overflow: hidden; }
    .perfil button { border: none; background: var(--superficie); color: var(--texto-secundario); padding: var(--espacamento-2) var(--espacamento-4); font: inherit; cursor: pointer; }
    .perfil button.on { background: var(--acao); color: var(--acao-texto); }
    .perfil button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .busca { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .dica { font-size: 12px; color: var(--texto-suave); margin: var(--espacamento-2) 0 0; }
    .produtos, .grade, .itens { list-style: none; margin: 0; padding: 0; }
    .produto { border-bottom: 1px solid var(--borda); }
    .linha-prod { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); background: transparent; border: none; padding: var(--espacamento-3) 0; cursor: pointer; color: var(--texto); text-align: left; }
    .linha-prod:hover { color: var(--acao); }
    .ref { font-family: var(--tipografia-familia-dados); font-size: 12px; color: var(--texto-suave); margin-left: var(--espacamento-2); }
    .qtd-var { font-size: 12px; color: var(--texto-suave); white-space: nowrap; }
    .grade { padding: 0 0 var(--espacamento-3); display: grid; gap: var(--espacamento-1); }
    .sku { display: grid; grid-template-columns: 1fr 88px 64px auto; gap: var(--espacamento-2); align-items: center; }
    .preco-erp { text-align: right; font-size: 13px; color: var(--texto); font-variant-numeric: tabular-nums; display: grid; gap: 1px; }
    .saldo { font-size: 10px; color: var(--texto-suave); }
    .saldo.zerado { color: var(--atencao); }
    .attrs { display: flex; flex-wrap: wrap; gap: 4px; }
    .attr { font-size: 11px; background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: 0 6px; color: var(--texto-secundario); }
    .qtd, .preco { padding: 4px var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; font-family: var(--tipografia-familia-dados); width: 100%; }
    .add { padding: 4px var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; cursor: pointer; white-space: nowrap; }
    .add:disabled { opacity: .6; cursor: not-allowed; }
    /* Grade cor × tamanho (matriz) */
    .grade-wrap { padding-bottom: var(--espacamento-2); }
    .grade-mtx { border-collapse: collapse; font-size: 12px; }
    .grade-mtx th, .grade-mtx td { border: 1px solid var(--borda); padding: 2px; text-align: center; }
    .grade-mtx thead th { background: var(--superficie); color: var(--texto-suave); font-weight: 600; padding: 4px 6px; font-variant-numeric: tabular-nums; }
    .grade-mtx .canto { border: 0; background: transparent; }
    .grade-mtx .cor-lab { background: var(--superficie); text-align: left; padding: 4px 10px; white-space: nowrap; font-weight: 500; color: var(--texto); position: sticky; left: 0; }
    .cel { min-width: 46px; }
    .cel.vazia { color: var(--texto-suave); background: var(--superficie); }
    .cel .q { width: 42px; padding: 3px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); text-align: center; font: inherit; font-family: var(--tipografia-familia-dados); font-size: 12px; background: var(--fundo); color: var(--texto); }
    .cel .q.tem { border-color: var(--acao); background: var(--acao-suave); color: var(--marca); font-weight: 600; }
    .cel .q:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 0; }
    .cel .sp { font-size: 10px; color: var(--texto-suave); }
    .grade-acoes { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); flex-wrap: wrap; padding-bottom: var(--espacamento-3); }
    .dica-g { font-size: 11px; color: var(--texto-suave); }
    .rascunho h2 { margin: 0 0 var(--espacamento-3); font-size: 16px; color: var(--texto); }
    .vazio { font-size: 13px; color: var(--texto-suave); }
    .itens li { display: grid; grid-template-columns: 1fr auto auto; gap: var(--espacamento-2); align-items: center; padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); font-size: 13px; }
    .desc strong { display: block; color: var(--texto); }
    .mono { font-family: var(--tipografia-familia-dados); font-variant-numeric: tabular-nums; }
    .sub-total { font-weight: 600; color: var(--texto); }
    .totais { display: flex; justify-content: space-between; align-items: center; padding: var(--espacamento-3) 0; font-size: 15px; color: var(--texto); }
    .primario { width: 100%; padding: var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; cursor: pointer; }
    .primario:disabled { opacity: .7; cursor: default; }
    .contexto { display: grid; gap: var(--espacamento-2); margin: var(--espacamento-3) 0; }
    .ctx { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .ctx input, .ctx textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; resize: vertical; }
    .secundario { width: 100%; padding: var(--espacamento-3); margin-bottom: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    .secundario:hover:not(:disabled) { border-color: var(--acao); color: var(--acao); }
    .secundario:disabled { opacity: .6; cursor: default; }
    .efet { margin-top: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); font-size: 13px; }
    .efet--ok { background: var(--sucesso-suave); color: var(--texto); }
    .efet--aviso { background: var(--atencao-suave); color: var(--texto); }
    .efet-nota { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
    /* Troca de rascunhos (vários por cliente). */
    .rascunhos { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; margin-bottom: var(--espacamento-3); }
    .r-lab { font-size: 12px; color: var(--texto-suave); }
    .r-chip { display: inline-flex; align-items: center; gap: 6px; padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .r-chip.on { background: var(--acao-suave); border-color: var(--acao); color: var(--marca); font-weight: 600; }
    .r-chip .r-n { font-size: 11px; background: var(--superficie); border-radius: var(--raio-completo); padding: 0 6px; }
    .r-novo { padding: var(--espacamento-1) var(--espacamento-3); border: 1px dashed var(--borda-forte); border-radius: var(--raio-completo); background: transparent; color: var(--acao); font: inherit; font-size: 13px; cursor: pointer; }
    .r-rename { border: 0; background: transparent; color: var(--texto-suave); cursor: pointer; font-size: 14px; padding: 0 4px; }
    /* Filtros do catálogo. */
    .filtros { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; margin: var(--espacamento-2) 0; }
    .filtros select, .filtros .preco-f { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; font-size: 13px; }
    .filtros .preco-f { width: 84px; }
    .mais-cat { display: block; width: 100%; margin-top: var(--espacamento-2); padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; cursor: pointer; }
    @media (max-width: 800px) { .grade-tela { grid-template-columns: 1fr; } }
  `,
})
export class PedidoAssistidoPagina implements OnInit {
  readonly servico = inject(PedidoServico)
  private readonly route = inject(ActivatedRoute)
  private readonly inbox = inject(InboxServico)
  readonly resultados = this.servico.resultados
  readonly formasPagamento = ['Pix', 'Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Boleto', 'A prazo']

  readonly aberto = signal<string | null>(null)
  readonly buscou = signal(false)
  readonly perfil = signal<'atacado' | 'varejo'>('atacado')
  readonly termo = signal('')
  // Filtros do catálogo robusto.
  readonly fCor = signal(''); readonly fTamanho = signal(''); readonly fCategoria = signal('')
  readonly fPrecoMin = signal(''); readonly fPrecoMax = signal('')
  readonly contatoId = signal<string | null>(null)
  private conversaId: string | null = null

  /** Entrada: ?contato=<id> (cliente) e/ou ?conversa=<id> (chat). */
  ngOnInit(): void {
    const p = this.route.snapshot.queryParamMap
    const contato = p.get('contato'); this.conversaId = p.get('conversa')
    void this.servico.carregarFiltros()
    void this.iniciar(contato, this.conversaId)
    void this.servico.buscarCatalogo({ perfil: this.perfil() })
    this.buscou.set(true)
  }
  private async iniciar(contato: string | null, conversa: string | null): Promise<void> {
    // Vindo do chat (?conversa=): cai no rascunho NÃO finalizado daquela conversa
    // (retoma o que estava montando); se a conversa é nova ou o pedido anterior já
    // saiu de 'rascunho' (enviado/confirmado/efetivado), o backend cria um vazio.
    // É a idempotência por conversa (INV-52) — a regra que o usuário quer.
    if (conversa) {
      await this.servico.abrirDaConversa(conversa)
      const cid = contato ?? this.servico.pedido()?.contatoId ?? null
      this.contatoId.set(cid)
      if (cid) await this.servico.carregarRascunhos(cid)
      return
    }
    // Sem conversa (aberto por ?contato=): retoma o rascunho não finalizado mais
    // recente do cliente, ou cria um novo. Os demais ficam nos chips.
    if (contato) {
      this.contatoId.set(contato)
      await this.servico.carregarRascunhos(contato)
      const rs = this.servico.rascunhos().filter((r) => r.estado === 'rascunho')
      if (rs.length) await this.servico.abrirRascunho(rs[0]!.id)
      else await this.servico.novoRascunho(contato)
    }
  }

  salvarContexto(id: string, campo: 'formaPagamento' | 'observacao', valor: string): void {
    void this.servico.salvarContexto(id, { [campo]: valor || null })
  }

  private timer: ReturnType<typeof setTimeout> | null = null
  onBusca(e: Event): void {
    this.termo.set((e.target as HTMLInputElement).value)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.rodarBusca(), 250)
  }
  trocarPerfil(p: 'atacado' | 'varejo'): void { this.perfil.set(p); this.rodarBusca() }
  aplicarFiltro(): void { this.rodarBusca() }

  private paramsBusca() {
    return {
      termo: this.termo().trim() || undefined, perfil: this.perfil(),
      cor: this.fCor() || undefined, tamanho: this.fTamanho() || undefined,
      categoria: this.fCategoria() || undefined,
      precoMin: this.fPrecoMin() ? String(Math.round(Number(this.fPrecoMin()) * 100)) : undefined,
      precoMax: this.fPrecoMax() ? String(Math.round(Number(this.fPrecoMax()) * 100)) : undefined,
    }
  }
  private rodarBusca(): void { this.buscou.set(true); void this.servico.buscarCatalogo(this.paramsBusca()) }
  carregarMais(): void { void this.servico.buscarCatalogo(this.paramsBusca(), true) }

  // Rascunhos do cliente.
  async novoRascunho(): Promise<void> {
    const c = this.contatoId(); if (!c) return
    const nome = prompt('Nome do novo rascunho (ex.: Reposição):')?.trim()
    await this.servico.novoRascunho(c, nome || undefined, this.conversaId ?? undefined)
  }
  async trocarRascunho(id: string): Promise<void> { await this.servico.abrirRascunho(id) }

  /** Confirma e envia o resumo; ao enviar, abre o chat (rail) onde a mensagem caiu. */
  async enviarResumo(id: string): Promise<void> {
    const conversaId = await this.servico.enviarResumo(id)
    const alvo = conversaId ?? this.conversaId
    if (alvo) void this.inbox.abrir(alvo)
  }
  async renomear(): Promise<void> {
    const ped = this.servico.pedido(); const c = this.contatoId(); if (!ped) return
    const nome = prompt('Renomear rascunho:', ped.nome ?? '')?.trim()
    if (nome) await this.servico.renomear(ped.id, nome, c ?? undefined)
  }

  alternar(id: string): void { this.aberto.update((a) => (a === id ? null : id)) }

  atributos(s: SkuCatalogo): string[] { return Object.values(s.atributos) }

  // ── Grade cor × tamanho (skill grade-cor-tamanho) ────────────────────────────
  /** Quantidade por SKU digitada na matriz (chave = sku.id). */
  readonly qtdGrade = signal<Record<string, string>>({})
  // Ordem de tamanho NUNCA é alfabética (skill §2). Letras conhecidas primeiro,
  // depois numéricos crescentes; o resto vai ao fim.
  private static readonly ORDEM_TAM = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'XXG', 'EG', 'EGG', 'U', 'UN', 'UNICO', 'ÚNICO']

  temGrade(p: ProdutoCatalogo): boolean {
    return p.skus.some((s) => s.atributos['cor'] !== undefined && s.atributos['tamanho'] !== undefined)
  }
  coresDe(p: ProdutoCatalogo): string[] {
    const vistos = new Set<string>(); const out: string[] = []
    for (const s of p.skus) { const c = s.atributos['cor']; if (c && !vistos.has(c)) { vistos.add(c); out.push(c) } }
    return out
  }
  tamanhosDe(p: ProdutoCatalogo): string[] {
    const set = new Set<string>()
    for (const s of p.skus) { const t = s.atributos['tamanho']; if (t) set.add(t) }
    return [...set].sort((a, b) => this.rankTam(a) - this.rankTam(b) || a.localeCompare(b))
  }
  private rankTam(t: string): number {
    const u = t.toUpperCase().trim()
    const i = PedidoAssistidoPagina.ORDEM_TAM.indexOf(u)
    if (i >= 0) return i
    const n = Number(u.replace(',', '.'))
    if (!Number.isNaN(n)) return 100 + n
    return 100000
  }
  /** SKU do cruzamento (cor,tamanho); undefined = célula inválida (grade não retangular). */
  skuDe(p: ProdutoCatalogo, cor: string, tam: string): SkuCatalogo | undefined {
    return p.skus.find((s) => s.atributos['cor'] === cor && s.atributos['tamanho'] === tam)
  }
  celTitulo(s: SkuCatalogo): string {
    const preco = s.precoCentavos !== null ? this.reais(s.precoCentavos) : 'sem preço'
    const saldo = s.saldo !== null ? (s.saldo <= 0 ? 'sem saldo' : `${s.saldo} un`) : ''
    return saldo ? `${preco} · ${saldo}` : preco
  }
  qtdGradeDe(id: string): string { return this.qtdGrade()[id] ?? '' }
  temQtd(id: string): boolean { return (Number(this.qtdGrade()[id]) || 0) > 0 }
  setQtdGrade(id: string, v: string): void { this.qtdGrade.update((m) => ({ ...m, [id]: v })) }
  algumaQtd(p: ProdutoCatalogo): boolean {
    return p.skus.some((s) => s.precoCentavos !== null && (Number(this.qtdGrade()[s.id]) || 0) > 0)
  }
  /** Adiciona ao rascunho todas as células da grade com quantidade > 0. */
  async adicionarGrade(p: ProdutoCatalogo): Promise<void> {
    const mapa = this.qtdGrade()
    const alvos = p.skus.filter((s) => s.precoCentavos !== null && (Number(mapa[s.id]) || 0) > 0)
    if (alvos.length === 0) return
    const pedidoId = await this.servico.garantirPedido()
    for (const s of alvos) {
      await this.servico.adicionar(pedidoId, {
        skuId: s.id, skuSnapshot: s.codigoBarras ?? p.referencia, descricaoSnapshot: p.descricao,
        grade: s.atributos, quantidade: Number(mapa[s.id]) || 0, valorUnitarioCentavos: s.precoCentavos!,
      })
    }
    // Limpa as quantidades já adicionadas.
    this.qtdGrade.update((m) => { const n = { ...m }; for (const s of alvos) delete n[s.id]; return n })
  }
  atributosGrade(g: Record<string, string>): string[] { return Object.values(g) }

  async adicionar(p: ProdutoCatalogo, s: SkuCatalogo, qtd: string): Promise<void> {
    const quantidade = Number(qtd) || 0
    // ⚠️ Preço do ERP (snapshot na inclusão, INV-25). Sem preço, não adiciona.
    if (quantidade <= 0 || s.precoCentavos === null) return

    const pedidoId = await this.servico.garantirPedido()
    await this.servico.adicionar(pedidoId, {
      skuId: s.id,
      skuSnapshot: s.codigoBarras ?? p.referencia,
      descricaoSnapshot: p.descricao,
      grade: s.atributos,
      quantidade,
      valorUnitarioCentavos: s.precoCentavos,
    })
  }

  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
}
