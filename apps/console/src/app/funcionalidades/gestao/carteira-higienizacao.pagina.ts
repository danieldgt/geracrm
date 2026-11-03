import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type {
  AcaoEmMassaContato, AgrupamentoCockpit, IndicadorCarteira, RespostaGruposIndicador,
} from '@geracrm/shared'
import {
  AcoesLoteComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente,
  PaginacaoComponente, PainelComponente, TabelaComponente, ToastServico, type LinhaTabela,
} from '../../compartilhado/ui/index.js'
import { ClientesAcaoModalComponente } from '../crm/clientes-acao-modal.componente.js'
import { idsDoLote, rotuloQualificacao, textoResultadoAcao, tomQualificacao } from '../crm/clientes.regras.js'
import { ClientesServico, type ResultadoAcaoEmMassa } from '../crm/clientes.servico.js'
import {
  ACOES_HIGIENIZACAO, META_PROXIMO_PASSO, RECORTE_VAZIO, ROTULO_ESTADO_META, TOM_ESTADO_META, colunasDosGruposCarteira,
  estadoDoIndicador, filtrosDaLista, formatarPercentual, grupoSelecionado, larguraDaBarra, linhasDosGruposCarteira,
  queryDoIndicador, recorteAtivo, recorteDaQuery, recorteDoGrupo, textoDaMeta, type RecorteCarteira,
} from './carteira-higienizacao.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Higienização da carteira (D2) — quem está sem próximo passo. O indicador mostra a cobertura da carteira ativa
 * (qualificado ou em funil) contra a meta; a tabela por vendedor/filial filtra a lista; a lista é a de Contatos
 * (A2) já recortada, com as ações em lote (criar tarefa, descartar, transferir). Estado sempre com cor E texto.
 */
@Component({
  selector: 'app-carteira-higienizacao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, AcoesLoteComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, ClientesAcaoModalComponente,
    EsqueletoComponente, EstadoComponente, PaginacaoComponente, PainelComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Higienização da carteira"
      subtitulo="Quem está sem próximo passo — agende, descarte ou transfira em lote.">
      <button type="button" class="btn btn--secundario" (click)="recarregar()" [disabled]="estado() === 'carregando'">Atualizar</button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') { <ui-esqueleto altura="140px" /><ui-esqueleto altura="180px" /> }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Higienização só para a gestão" descricao="Peça a um administrador o papel de gestor ou supervisor." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o indicador" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="recarregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (indicador(); as i) {
          <ui-painel>
            <section class="indicador" aria-labelledby="titulo-indicador" [attr.data-estado]="estadoMeta()">
              <h2 class="txt-secao" id="titulo-indicador">% da carteira com próximo passo</h2>
              <p class="grande">
                <span class="txt-kpi">{{ percentualTexto() }}</span>
                <ui-badge [tom]="tomBadge()">{{ rotuloEstado() }}</ui-badge>
                <span class="suave txt-denso">meta {{ meta }}%</span>
              </p>
              <div class="barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="i.percentual"
                [attr.aria-valuetext]="percentualTexto() + ' da carteira com próximo passo, meta de ' + meta + '%'">
                <div class="barra-cheia" [style.width.%]="largura()"></div>
                <div class="barra-meta" [style.left.%]="meta" title="Meta"></div>
              </div>
              <p class="txt-denso">
                <strong>{{ i.comProximoPasso }}</strong> de <strong>{{ i.ativos }}</strong> contatos ativos têm próximo passo ·
                <strong>{{ i.semProximoPasso }}</strong> sem. {{ textoMeta() }}
              </p>
              @if (recorteAtivo()) {
                <p class="txt-denso">
                  Recorte aplicado.
                  <button type="button" class="btn btn--fantasma btn--pequeno" (click)="limparRecorte()">Ver a carteira toda</button>
                </p>
              }
            </section>
          </ui-painel>

          <div class="barra-grupos">
            <div class="chips" role="group" aria-label="Agrupar por">
              @for (o of agrupamentos; track o.valor) {
                <button type="button" class="chip" [attr.aria-pressed]="agrupar() === o.valor" (click)="trocarAgrupamento(o.valor)">{{ o.rotulo }}</button>
              }
            </div>
          </div>

          <ui-painel>
            <h2 class="txt-secao">Por {{ agrupar() === 'filial' ? 'filial' : 'vendedor' }}</h2>
            @if (linhasGrupos().length === 0) {
              <ui-estado tipo="vazio" titulo="Nenhum contato ativo" descricao="Sem contatos qualificados ou em funil neste escopo." />
            } @else {
              <ui-tabela [colunas]="colunasGrupos()" [linhas]="linhasGrupos()" [chaveLinha]="chaveGrupo">
                <ng-template uiCelula="rotulo" let-g>
                  @if (clicavel(g.chave)) {
                    <button type="button" class="celula-btn" [attr.aria-pressed]="selecionado(g.chave)" (click)="filtrarPor(g.chave)"
                      [attr.aria-label]="'Filtrar a lista por ' + g.rotulo">{{ g.rotulo }}</button>
                  } @else { <span class="suave">{{ g.rotulo }}</span> }
                </ng-template>
                <ng-template uiCelula="percentual" let-g>
                  <ui-badge [tom]="tomBadgeDe(g.estado)">{{ pct(g.percentual) }} · {{ rotuloDe(g.estado) }}</ui-badge>
                </ng-template>
              </ui-tabela>
            }
          </ui-painel>

          <ui-painel>
            <h2 class="txt-secao">Contatos sem próximo passo</h2>
            <ui-acoes-lote [quantidade]="selecionados().size" (limpar)="selecionados.set(vazio)">
              @for (a of acoes; track a.acao) {
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirAcao(a.acao)">{{ a.rotulo }}</button>
              }
            </ui-acoes-lote>
            @switch (lista.estado()) {
              @case ('erro') {
                <ui-estado tipo="erro" titulo="Não foi possível carregar os contatos" [descricao]="lista.erro() ?? ''">
                  <button type="button" class="btn btn--secundario" (click)="carregarLista()">Tentar de novo</button>
                </ui-estado>
              }
              @default {
                <ui-tabela [colunas]="colunasLista" [linhas]="linhasLista()" [selecionavel]="true" [(selecionados)]="selecionados"
                  [rotuloLinha]="rotuloLinha" [carregando]="lista.estado() === 'carregando'">
                  <ng-template uiCelula="nome" let-c>
                    <span class="pessoa">
                      <a class="nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>
                      <span class="suave txt-denso">{{ c.email || c.telefone || '—' }}</span>
                    </span>
                  </ng-template>
                  <ng-template uiCelula="qualificacao" let-c>
                    <ui-badge [tom]="tom(c.qualificacao)">{{ rotuloQ(c.qualificacao) }}</ui-badge>
                  </ng-template>
                  <ng-template uiCelula="vendedor" let-c>{{ c.vendedor ?? 'Sem dono' }}</ng-template>
                  <ng-template uiCelula="acoes" let-c>
                    <a class="btn btn--fantasma btn--pequeno" [routerLink]="['/contato', c.id]">Ver</a>
                  </ng-template>
                  <div uiVazio>
                    <ui-estado tipo="vazio" titulo="Ninguém sem próximo passo" descricao="Todos os contatos ativos deste recorte têm um próximo passo agendado." />
                  </div>
                </ui-tabela>
                @if (lista.estado() === 'pronto') {
                  <ui-paginacao [mostrados]="lista.clientes().length" [temMais]="lista.temMais()"
                    [carregando]="lista.buscandoMais()" (mais)="lista.carregarMais()" />
                }
              }
            }
          </ui-painel>
        }
      }
    }

    <app-clientes-acao-modal [acao]="acaoAberta()" [contatoIds]="idsAcao()"
      (fechar)="acaoAberta.set(null)" (concluida)="aoConcluir($event)" />
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); width: 100%; min-width: 0; padding: var(--espacamento-6); align-content: start; }
    .indicador { display: grid; gap: var(--espacamento-3); }
    .indicador p { margin: 0; }
    .grande { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--espacamento-3); }
    .suave { color: var(--texto-suave); }
    .barra { position: relative; height: 14px; border-radius: var(--raio-completo); background: var(--superficie-elevada); border: 1px solid var(--borda); overflow: visible; }
    .barra-cheia { height: 100%; border-radius: var(--raio-completo); background: var(--acao); }
    [data-estado='atingida'] .barra-cheia { background: var(--sucesso); }
    [data-estado='atencao'] .barra-cheia { background: var(--atencao); }
    [data-estado='critica'] .barra-cheia { background: var(--erro); }
    .barra-meta { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--texto); }
    .barra-grupos { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3); }
    .chips { display: inline-flex; gap: var(--espacamento-2); }
    .chip { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto); font: inherit; cursor: pointer; }
    .chip[aria-pressed='true'] { border-color: var(--acao); background: var(--acao-suave); }
    .celula-btn { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--acao); font: inherit; cursor: pointer; text-align: left; }
    .celula-btn:hover { background: var(--superficie-hover); }
    .celula-btn[aria-pressed='true'] { border-color: var(--acao); background: var(--acao-suave); }
    .pessoa { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; padding: var(--espacamento-1) 0; }
    .nome { color: var(--texto); text-decoration: none; font-weight: 500; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    ui-tabela, ui-acoes-lote { display: block; margin-top: var(--espacamento-2); }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class CarteiraHigienizacaoPagina {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly toast = inject(ToastServico)
  protected readonly lista = inject(ClientesServico)

  protected readonly meta = META_PROXIMO_PASSO
  protected readonly vazio: ReadonlySet<string> = new Set()
  protected readonly acoes = ACOES_HIGIENIZACAO
  protected readonly agrupamentos: readonly { valor: AgrupamentoCockpit; rotulo: string }[] = [
    { valor: 'vendedor', rotulo: 'Por vendedor' }, { valor: 'filial', rotulo: 'Por filial' },
  ]
  protected readonly colunasLista = [
    { chave: 'nome', rotulo: 'Contato' },
    { chave: 'qualificacao', rotulo: 'Qualificação' },
    { chave: 'vendedor', rotulo: 'Vendedor' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir' as const },
  ]
  protected readonly rotuloLinha = (l: LinhaTabela): string => String(l['nome'] ?? 'contato')
  protected readonly chaveGrupo = (l: LinhaTabela): string => String(l['chave'])

  protected readonly estado = signal<Estado>('carregando')
  protected readonly indicador = signal<IndicadorCarteira | null>(null)
  protected readonly grupos = signal<RespostaGruposIndicador | null>(null)
  protected readonly agrupar = signal<AgrupamentoCockpit>('vendedor')
  protected readonly recorte = signal<RecorteCarteira>(RECORTE_VAZIO)

  protected readonly selecionados = signal<ReadonlySet<string>>(new Set())
  protected readonly acaoAberta = signal<AcaoEmMassaContato | null>(null)
  protected readonly idsAcao = signal<readonly string[]>([])

  protected readonly estadoMeta = computed(() => { const i = this.indicador(); return i ? estadoDoIndicador(i) : 'critica' })
  protected readonly tomBadge = computed(() => this.tomBadgeDe(this.estadoMeta()))
  protected readonly rotuloEstado = computed(() => ROTULO_ESTADO_META[this.estadoMeta()])
  protected readonly percentualTexto = computed(() => formatarPercentual(this.indicador()?.percentual ?? 0))
  protected readonly largura = computed(() => larguraDaBarra(this.indicador()?.percentual ?? 0))
  protected readonly textoMeta = computed(() => { const i = this.indicador(); return i ? textoDaMeta(i) : '' })
  protected readonly recorteAtivo = computed(() => recorteAtivo(this.recorte()))
  protected readonly colunasGrupos = computed(() => colunasDosGruposCarteira(this.agrupar() === 'filial' ? 'Filial' : 'Vendedor'))
  protected readonly linhasGrupos = computed(() => linhasDosGruposCarteira(this.grupos()?.grupos ?? []) as unknown as LinhaTabela[])
  protected readonly linhasLista = computed(() => this.lista.clientes() as unknown as LinhaTabela[])

  constructor() {
    this.recorte.set(recorteDaQuery(this.route.snapshot.queryParams as Record<string, string | undefined>))
    void this.lista.carregarCatalogos()
    void this.recarregar()
  }

  protected async recarregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      await Promise.all([this.carregarIndicador(), this.carregarGrupos()])
      this.estado.set('pronto')
      void this.carregarLista()
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private async carregarIndicador(): Promise<void> {
    const q = queryDoIndicador(this.recorte())
    this.indicador.set(await firstValueFrom(this.http.get<IndicadorCarteira>('/v1/gestao/carteira/indicador' + (q ? '?' + q : ''))))
  }

  private async carregarGrupos(): Promise<void> {
    // A tabela mostra TODOS os grupos (o recorte filtra o indicador e a lista, não a própria tabela).
    this.grupos.set(await firstValueFrom(
      this.http.get<RespostaGruposIndicador>('/v1/gestao/carteira/indicador/grupos?' + queryDoIndicador(RECORTE_VAZIO, this.agrupar()))))
  }

  protected carregarLista(): Promise<void> {
    this.selecionados.set(this.vazio)
    return this.lista.carregar(filtrosDaLista(this.recorte()))
  }

  protected async trocarAgrupamento(a: AgrupamentoCockpit): Promise<void> {
    if (this.agrupar() === a) return
    this.agrupar.set(a)
    try { await this.carregarGrupos() } catch { this.estado.set('erro') }
  }

  // ── filtro pela tabela ──
  protected clicavel(chave: string): boolean { return recorteDoGrupo(this.agrupar(), chave) !== null }
  protected selecionado(chave: string): boolean { return grupoSelecionado(this.agrupar(), chave, this.recorte()) }

  protected filtrarPor(chave: string): void {
    const novo = recorteDoGrupo(this.agrupar(), chave)
    if (novo === null) return
    this.recorte.set(this.selecionado(chave) ? RECORTE_VAZIO : novo)
    void this.aplicarRecorte()
  }

  protected limparRecorte(): void {
    this.recorte.set(RECORTE_VAZIO)
    void this.aplicarRecorte()
  }

  private async aplicarRecorte(): Promise<void> {
    try { await this.carregarIndicador() } catch { this.estado.set('erro'); return }
    void this.carregarLista()
  }

  // ── lote ──
  protected abrirAcao(acao: AcaoEmMassaContato): void {
    const { ids, excedeu } = idsDoLote(this.selecionados())
    if (excedeu) this.toast.mostrar('Só os primeiros 500 contatos selecionados entram nesta ação.', 'neutro')
    this.idsAcao.set(ids)
    this.acaoAberta.set(acao)
  }

  protected aoConcluir(r: ResultadoAcaoEmMassa): void {
    this.acaoAberta.set(null)
    this.toast.sucesso(textoResultadoAcao(r))
    void this.recarregar()
  }

  // ── apresentação ──
  protected tomBadgeDe(e: 'atingida' | 'atencao' | 'critica'): 'sucesso' | 'atencao' | 'erro' {
    const t = TOM_ESTADO_META[e]
    return t === 'sucesso' || t === 'atencao' ? t : 'erro'
  }
  protected rotuloDe(e: 'atingida' | 'atencao' | 'critica'): string { return ROTULO_ESTADO_META[e] }
  protected pct(p: number): string { return formatarPercentual(p) }
  protected rotuloQ(q: string): string { return rotuloQualificacao(q) }
  protected tom(q: string): 'neutro' | 'sucesso' | 'erro' { return tomQualificacao(q) }
}
