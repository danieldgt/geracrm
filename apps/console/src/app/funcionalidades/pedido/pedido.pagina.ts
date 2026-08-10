import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core'
import { SlicePipe } from '@angular/common'
import { PedidoServico, type ProdutoCatalogo, type SkuCatalogo } from './pedido.servico.js'

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
                <ul class="grade">
                  @for (s of p.skus; track s.id) {
                    <li class="sku">
                      <span class="attrs">
                        @for (a of atributos(s); track a) { <span class="attr">{{ a }}</span> }
                      </span>
                      <!-- ⚠️ Preço do ERP (tabela do perfil), não digitado. Sem preço
                           cadastrado → não dá para adicionar (não inventa valor). -->
                      <span class="preco-erp mono">
                        {{ s.precoCentavos !== null ? reais(s.precoCentavos) : 'sem preço' }}
                        <!-- ⚠️ Saldo da última sincronização + data — NÃO ao vivo. -->
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
            </li>
          }
        </ul>
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
            <!-- Efetivação (ADR-005): idempotente + falha nomeada + rascunho
                 nunca perdido. Se o ERP não escreve, DEGRADA visível (ADR-008). -->
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
    :host { display: block; max-width: 1100px; padding: var(--espacamento-6); }
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
    .add:disabled { opacity: .6; }
    .rascunho h2 { margin: 0 0 var(--espacamento-3); font-size: 16px; color: var(--texto); }
    .vazio { font-size: 13px; color: var(--texto-suave); }
    .itens li { display: grid; grid-template-columns: 1fr auto auto; gap: var(--espacamento-2); align-items: center; padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); font-size: 13px; }
    .desc strong { display: block; color: var(--texto); }
    .mono { font-family: var(--tipografia-familia-dados); font-variant-numeric: tabular-nums; }
    .sub-total { font-weight: 600; color: var(--texto); }
    .totais { display: flex; justify-content: space-between; align-items: center; padding: var(--espacamento-3) 0; font-size: 15px; color: var(--texto); }
    .primario { width: 100%; padding: var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; cursor: pointer; }
    .primario:disabled { opacity: .7; cursor: default; }
    .efet { margin-top: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); font-size: 13px; }
    .efet--ok { background: var(--sucesso-suave); color: var(--texto); }
    .efet--aviso { background: var(--atencao-suave); color: var(--texto); }
    .efet-nota { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
    @media (max-width: 800px) { .grade-tela { grid-template-columns: 1fr; } }
  `,
})
export class PedidoAssistidoPagina {
  readonly servico = inject(PedidoServico)
  readonly resultados = this.servico.resultados
  readonly aberto = signal<string | null>(null)
  readonly buscou = signal(false)
  readonly perfil = signal<'atacado' | 'varejo'>('atacado')
  readonly termo = signal('')

  private timer: ReturnType<typeof setTimeout> | null = null
  onBusca(e: Event): void {
    this.termo.set((e.target as HTMLInputElement).value)
    if (this.timer) clearTimeout(this.timer)
    // Debounce leve: não bate no servidor a cada tecla.
    this.timer = setTimeout(() => this.rodarBusca(), 250)
  }

  trocarPerfil(p: 'atacado' | 'varejo'): void {
    // ⚠️ Trocar de perfil re-busca: os preços mudam, não dá para manter na tela
    //    os do perfil anterior.
    this.perfil.set(p)
    this.rodarBusca()
  }

  private rodarBusca(): void {
    const termo = this.termo().trim()
    this.buscou.set(true)
    if (termo.length >= 2) void this.servico.buscar(termo, this.perfil())
    else this.servico.resultados.set([])
  }

  alternar(id: string): void { this.aberto.update((a) => (a === id ? null : id)) }

  atributos(s: SkuCatalogo): string[] { return Object.values(s.atributos) }
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
