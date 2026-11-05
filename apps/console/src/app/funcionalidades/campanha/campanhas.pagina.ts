import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { ESTADOS_CAMPANHA, ROTULO_ESTADO_CAMPANHA, rotuloSegmento } from '@geracrm/shared'
import {
  BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ToastServico, ehStatus, mensagemDeErro, mesclarPagina, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { avisoDeBloqueio, avisoDePausa, rotuloEstado, rotuloMotivoPausa, tomDoEstado } from './campanhas.regras.js'
import { CampanhasServico, type CampanhaResumo } from './campanhas.servico.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

const OPCOES_ESTADO: OpcaoSelect[] = [
  { valor: '', rotulo: 'Todos os estados' },
  ...ESTADOS_CAMPANHA.map((e) => ({ valor: e, rotulo: ROTULO_ESTADO_CAMPANHA[e] })),
]

/**
 * Campanhas (F1b, padrão Lista): por cursor, com filtro de estado, selo de estado e o motivo da pausa à vista.
 * Criar leva ao wizard (`/campanhas/nova`); a linha leva ao detalhe (`/campanhas/:id`), onde ficam o funil e as ações.
 * As campanhas antigas (segmento + texto livre) seguem na lista, marcadas, e abrem em modo leitura.
 */
@Component({
  selector: 'app-campanhas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente, SelectComponente, TabelaComponente, RouterLink],
  template: `
    <ui-cabecalho-tela titulo="Campanhas"
      subtitulo="Fale com um público escolhido, confira o custo antes de enviar e acompanhe do envio até a venda.">
      <a class="btn btn--primario" routerLink="/campanhas/nova">+ Nova campanha</a>
    </ui-cabecalho-tela>

    <div class="filtros">
      <ui-select rotulo="Estado" [opcoes]="opcoesEstado" [valor]="filtro()" (valorChange)="filtrar($event)" />
    </div>

    <div class="corpo">
      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso a campanhas" descricao="Peça acesso a um administrador, gestor ou supervisor." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as campanhas" [descricao]="erroLista()">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @default {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
            <ng-template uiCelula="nome" let-c>
              <a class="nome" [routerLink]="['/campanhas', c.id]">{{ c.nome }}</a>
              @if (c.modeloVersao !== 2) { <span class="legada">Campanha antiga</span> }
            </ng-template>
            <ng-template uiCelula="estado" let-c>
              <ui-badge [tom]="tom(c.estado)">{{ rotulo(c.estado) }}</ui-badge>
              @if (pausa(c); as p) { <span class="pausa">{{ p }}</span> }
              @if (bloqueio(c); as b) { <span class="bloqueio" role="status"><strong>{{ b.titulo }}.</strong> {{ b.acao }}</span> }
            </ng-template>
            <ng-template uiCelula="onde" let-c>{{ onde(c) }}</ng-template>
            <ng-template uiCelula="lote" let-c>{{ c.loteDiario ? c.loteDiario + ' por dia' : '—' }}</ng-template>
            <ng-template uiCelula="criadoEm" let-c>{{ data(c.criadoEm) }}</ng-template>
            <div uiVazio>
              @if (filtro()) {
                <ui-estado titulo="Nenhuma campanha neste estado" descricao="Troque o filtro de estado para ver as demais." />
              } @else {
                <ui-estado titulo="Nenhuma campanha ainda"
                  descricao="Monte a primeira: escolha o número, o público e veja o custo antes de enviar.">
                  <a class="btn btn--secundario" routerLink="/campanhas/nova">+ Nova campanha</a>
                </ui-estado>
              }
            </div>
          </ui-tabela>
          @if (estado() === 'pronto') {
            <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null" [carregando]="carregandoMais()" (mais)="carregarMais()" />
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .filtros { max-width: 260px; margin-bottom: var(--espacamento-4); }
    .corpo { display: grid; gap: var(--espacamento-2); min-width: 0; }
    ui-tabela { display: block; }
    .nome { color: var(--texto); font-weight: 500; text-decoration: none; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .legada { display: block; font-size: 11px; color: var(--texto-suave); }
    .pausa { display: block; margin-top: var(--espacamento-1); font-size: 12px; color: var(--atencao); max-width: 320px; white-space: normal; }
    .bloqueio { display: block; margin-top: var(--espacamento-1); font-size: 12px; color: var(--erro); max-width: 320px; white-space: normal; }
  `,
})
export class CampanhasPagina implements OnInit {
  private readonly api = inject(CampanhasServico)
  private readonly toast = inject(ToastServico)

  protected readonly opcoesEstado = OPCOES_ESTADO
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Campanha' },
    { chave: 'estado', rotulo: 'Estado', largura: '260px' },
    { chave: 'onde', rotulo: 'Número ou segmento', largura: '200px' },
    { chave: 'lote', rotulo: 'Lote', largura: '120px', alinhamento: 'dir' },
    { chave: 'criadoEm', rotulo: 'Criada em', largura: '120px' },
  ]

  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly filtro = signal('')
  protected readonly itens = signal<readonly CampanhaResumo[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  /** Geração da consulta: troca de filtro no meio de uma busca descarta a resposta velha. */
  private geracao = 0

  ngOnInit(): void { void this.carregar() }

  protected rotulo(e: string): string { return rotuloEstado(e) }
  protected tom(e: string) { return tomDoEstado(e) }
  protected data(iso: string): string { return new Date(iso).toLocaleDateString('pt-BR') }
  protected onde(c: CampanhaResumo): string {
    return c.canal?.nome ?? (c.modeloVersao !== 2 ? rotuloSegmento(c.segmentoAlvo) : '—')
  }
  /** Motivo da pausa à vista na lista (manual, automática por taxa/qualidade, ou número suspenso pela Meta). */
  protected pausa(c: CampanhaResumo): string | null {
    if (c.estado === 'pausada') return rotuloMotivoPausa(c.pausaMotivo)
    return avisoDePausa(c.pausadaPorQualidade)?.titulo ?? null
  }

  /** Envio parado pelo número (campanha em curso): título e ação corretiva na própria linha. */
  protected bloqueio(c: CampanhaResumo) { return avisoDeBloqueio(c.bloqueio) }

  protected filtrar(estado: string): void {
    this.filtro.set(estado)
    void this.carregar()
  }

  protected async carregar(): Promise<void> {
    const g = ++this.geracao
    this.estado.set('carregando')
    try {
      const r = await this.api.listar(this.filtro() || null, null)
      if (g !== this.geracao) return
      this.itens.set(r.itens); this.cursor.set(r.proximoCursor); this.estado.set('pronto')
    } catch (e) {
      if (g !== this.geracao) return
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else { this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    const g = this.geracao
    this.carregandoMais.set(true)
    try {
      const r = await this.api.listar(this.filtro() || null, c)
      if (g !== this.geracao) return
      this.itens.update((a) => mesclarPagina(a, r.itens, (x) => x.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais campanhas.')) }
    finally { this.carregandoMais.set(false) }
  }
}

