import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { AuthServico } from '../../nucleo/auth.servico.js'
import { CabecalhoTelaComponente } from '../../compartilhado/ui/cabecalho-tela.componente.js'
import { CelulaDiretiva, TabelaComponente, type ColunaTabela, type LinhaTabela } from '../../compartilhado/ui/tabela.componente.js'
import { EsqueletoComponente } from '../../compartilhado/ui/esqueleto.componente.js'
import { EstadoComponente } from '../../compartilhado/ui/estado.componente.js'
import { FiltroPeriodoComponente } from '../../compartilhado/ui/filtro-periodo.componente.js'
import { PainelComponente } from '../../compartilhado/ui/painel.componente.js'
import { StatCardComponente } from '../../compartilhado/ui/stat-card.componente.js'
import { periodoInvertido } from '../../compartilhado/ui/periodo.js'
import { codigoDoErro } from '../../compartilhado/ui/erro-http.js'
import { formatarReais } from '../../compartilhado/ui/dinheiro.js'
import { BarrasHorizontaisComponente } from '../analitico/barras-horizontais.componente.js'
import { formatarTaxa, queryDoPeriodo } from '../analitico/relatorio-dimensao.regras.js'
import { alturasColunas, dataHoraCurta, rotuloMes, textoSaudacao } from './inicio.regras.js'

interface Painel {
  readonly periodo: { inicio: string; fim: string; fuso: string }
  readonly contatosNovos: number
  readonly pedidos: { quantidade: number; valorCentavos: number }
  readonly ticketMedioCentavos: number | null
  readonly conversao: { convertidos: number; contatosNovos: number; taxa: number | null }
  readonly tarefas: { pendentes: number; atrasadas: number }
  readonly pedidosPorMes: readonly { mes: string; quantidade: number; valorCentavos: number }[]
  readonly qualificacao: readonly { chave: string; rotulo: string; contatos: number }[]
  readonly ranking: readonly { usuarioId: string | null; nome: string; pedidos: number; valorCentavos: number }[]
  readonly contatosRecentes: readonly { id: string; nome: string; criadoEm: string; qualificacao: string }[]
  readonly proximasTarefas: readonly { id: string; titulo: string; venceEm: string; tipo: string; contatoNome: string | null }[]
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const MENSAGENS_PERIODO: Readonly<Record<string, string>> = {
  'periodo.longo_demais': 'O período pode ter no máximo 366 dias.',
  'periodo.invertido': 'A data inicial é depois da final.',
  'periodo.invalido': 'Datas inválidas. Use o seletor de datas.',
  'periodo.incompleto': 'Informe a data inicial e a final.',
}

/**
 * Início v2 — o negócio no período escolhido (padrão: mês atual no fuso do tenant). Saudação, período livre,
 * quatro cartões que levam à tela de origem, pedidos por mês, qualificação, ranking, contatos recentes e
 * próximas tarefas. Cada bloco tem o seu vazio; a tela inteira tem carregando, erro e sem permissão.
 * Segue geracrm-layout-ui (tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-inicio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, BarrasHorizontaisComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente,
    EstadoComponente, FiltroPeriodoComponente, PainelComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="saudacao()" subtitulo="Como o negócio está no período." />

    <div class="filtros">
      <ui-filtro-periodo [(inicio)]="inicio" [(fim)]="fim" (aplicar)="carregar()" />
    </div>

    @switch (estado()) {
      @case ('carregando') {
        <div class="cartoes"><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" /></div>
        <div class="grade"><ui-esqueleto altura="200px" /><ui-esqueleto altura="200px" /></div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso ao painel" descricao="Peça a um administrador a permissão de leitura." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o Início" [descricao]="erroTexto()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (d(); as p) {
          <div class="cartoes">
            <a class="cartao" routerLink="/contatos" aria-label="Contatos novos no período: ver contatos">
              <ui-stat-card [valor]="p.contatosNovos" rotulo="Contatos novos" tom="acao" />
            </a>
            <a class="cartao" routerLink="/pedidos" aria-label="Pedidos efetivados no período: ver pedidos">
              <ui-stat-card [valor]="p.pedidos.quantidade" [rotulo]="rotuloPedidos()" tom="sucesso" />
            </a>
            <a class="cartao" routerLink="/tarefas" aria-label="Tarefas pendentes: ver tarefas">
              <ui-stat-card [valor]="p.tarefas.pendentes" [rotulo]="rotuloTarefas()" [tom]="p.tarefas.atrasadas > 0 ? 'atencao' : 'neutro'" />
            </a>
            <a class="cartao" routerLink="/relatorios" aria-label="Conversão no período: ver relatórios">
              <ui-stat-card [valor]="taxaTexto()" [rotulo]="rotuloConversao()" tom="ia" />
            </a>
          </div>

          <div class="grade">
            <ui-painel>
              <h2 class="txt-secao">Pedidos por mês</h2>
              <p class="txt-denso suave">Efetivados, últimos 6 meses.</p>
              @if (semPedidosNosMeses()) {
                <ui-estado tipo="vazio" titulo="Sem pedidos efetivados" descricao="Os pedidos aparecem aqui quando o ERP efetivar." />
              } @else {
                <ol class="colunas" aria-label="Pedidos efetivados por mês">
                  @for (m of meses(); track m.mes) {
                    <li class="coluna">
                      <span class="c-valor txt-dados">{{ m.quantidade }}</span>
                      <span class="c-trilho" aria-hidden="true"><span class="c-fill" [style.height.%]="m.altura"></span></span>
                      <span class="c-rotulo txt-denso">{{ m.rotulo }}</span>
                    </li>
                  }
                </ol>
              }
            </ui-painel>

            <ui-painel>
              <h2 class="txt-secao">Contatos novos por qualificação</h2>
              @if (p.contatosNovos === 0) {
                <ui-estado tipo="vazio" titulo="Sem contatos novos" descricao="Nenhum contato foi criado no período." />
              } @else {
                <app-barras-horizontais [itens]="qualificacao()" descricao="Contatos novos por qualificação" />
              }
            </ui-painel>
          </div>

          <ui-painel>
            <h2 class="txt-secao">Ranking de vendedores</h2>
            <p class="txt-denso suave">Top 10 por valor de pedidos efetivados no período.</p>
            @if (p.ranking.length === 0) {
              <ui-estado tipo="vazio" titulo="Sem pedidos efetivados no período" descricao="O ranking aparece quando houver pedidos efetivados." />
            } @else {
              <ui-tabela [colunas]="colunasRanking" [linhas]="linhasRanking()" [chaveLinha]="chaveLinha">
                <ng-template uiCelula="valor" let-l>{{ reais(l.valorCentavos) }}</ng-template>
              </ui-tabela>
            }
          </ui-painel>

          <div class="grade">
            <ui-painel>
              <h2 class="txt-secao">Contatos recentes</h2>
              @if (p.contatosRecentes.length === 0) {
                <ui-estado tipo="vazio" titulo="Nenhum contato ainda" descricao="Cadastre ou importe contatos para vê-los aqui." />
              } @else {
                <ul class="lista">
                  @for (c of p.contatosRecentes; track c.id) {
                    <li><a [routerLink]="['/contato', c.id]" class="item">
                      <span class="nome">{{ c.nome }}</span>
                      <span class="meta txt-denso">{{ quando(c.criadoEm) }}</span>
                    </a></li>
                  }
                </ul>
              }
            </ui-painel>

            <ui-painel>
              <h2 class="txt-secao">Próximas tarefas</h2>
              @if (p.proximasTarefas.length === 0) {
                <ui-estado tipo="vazio" titulo="Nenhuma tarefa aberta" descricao="Agende um follow-up em Tarefas." />
              } @else {
                <ul class="lista">
                  @for (t of p.proximasTarefas; track t.id) {
                    <li><a routerLink="/tarefas" class="item">
                      <span class="nome">{{ t.titulo }}@if (t.contatoNome) { <span class="suave"> · {{ t.contatoNome }}</span> }</span>
                      <span class="meta txt-denso" [class.atrasada]="atrasada(t.venceEm)">{{ quando(t.venceEm) }}</span>
                    </a></li>
                  }
                </ul>
              }
            </ui-painel>
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); width: 100%; padding: var(--espacamento-6); align-content: start; }
    ui-cabecalho-tela { display: block; }
    h2 { margin: 0 0 var(--espacamento-1); color: var(--texto); }
    .suave { color: var(--texto-suave); }
    p { margin: 0 0 var(--espacamento-3); }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); }
    .cartao { display: block; min-width: 0; border: 2px solid transparent; border-radius: var(--raio-painel); text-decoration: none; color: inherit; }
    .cartao:hover, .cartao:focus-visible { border-color: var(--acao); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--espacamento-4); }
    .colunas { list-style: none; margin: 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: var(--espacamento-3); align-items: end; }
    .coluna { display: grid; justify-items: center; gap: var(--espacamento-1); min-width: 0; }
    .c-trilho { display: flex; align-items: flex-end; width: 100%; max-width: 48px; height: 120px; border-radius: var(--raio-controle); background: var(--superficie); overflow: hidden; }
    .c-fill { display: block; width: 100%; background: var(--acao); border-radius: var(--raio-controle); }
    .c-valor { color: var(--texto); }
    .c-rotulo { color: var(--texto-secundario); white-space: nowrap; }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; }
    .item { display: flex; align-items: baseline; justify-content: space-between; gap: var(--espacamento-3); padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); text-decoration: none; color: var(--texto); min-width: 0; }
    .item:hover .nome { color: var(--acao); }
    .nome { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .meta { flex: none; color: var(--texto-suave); }
    .meta.atrasada { color: var(--erro); }
  `,
})
export class InicioPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly auth = inject(AuthServico)

  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Painel | null>(null)
  readonly inicio = signal('')
  readonly fim = signal('')
  readonly erroTexto = signal('')

  protected readonly saudacao = computed(() =>
    textoSaudacao(new Date(), this.d()?.periodo.fuso ?? null, this.auth.usuario()?.nome ?? null))
  protected readonly taxaTexto = computed(() => formatarTaxa(this.d()?.conversao.taxa ?? null))
  protected readonly rotuloPedidos = computed(() => {
    const p = this.d()
    return p ? `Pedidos efetivados · ${formatarReais(p.pedidos.valorCentavos)}` : 'Pedidos efetivados'
  })
  protected readonly rotuloTarefas = computed(() => {
    const t = this.d()?.tarefas
    return t && t.atrasadas > 0 ? `Tarefas pendentes · ${t.atrasadas} atrasadas` : 'Tarefas pendentes'
  })
  protected readonly rotuloConversao = computed(() => {
    const c = this.d()?.conversao
    return c ? `Conversão · ${c.convertidos} de ${c.contatosNovos}` : 'Conversão'
  })
  protected readonly meses = computed(() => {
    const m = this.d()?.pedidosPorMes ?? []
    const alturas = alturasColunas(m.map((x) => x.quantidade))
    return m.map((x, i) => ({ mes: x.mes, rotulo: rotuloMes(x.mes), quantidade: x.quantidade, altura: alturas[i] ?? 0 }))
  })
  protected readonly semPedidosNosMeses = computed(() => this.meses().every((m) => m.quantidade === 0))
  protected readonly qualificacao = computed(() =>
    (this.d()?.qualificacao ?? []).map((q) => ({ chave: q.chave, rotulo: q.rotulo, valor: q.contatos })))

  protected readonly colunasRanking: readonly ColunaTabela[] = [
    { chave: 'posicao', rotulo: '#', largura: '48px' },
    { chave: 'nome', rotulo: 'Vendedor' },
    { chave: 'pedidos', rotulo: 'Pedidos', alinhamento: 'dir' },
    { chave: 'valor', rotulo: 'Valor', alinhamento: 'dir' },
  ]
  protected readonly linhasRanking = computed<LinhaTabela[]>(() =>
    (this.d()?.ranking ?? []).map((r, i) => ({ ...r, posicao: i + 1 })))
  protected readonly chaveLinha = (l: LinhaTabela): string => String(l['usuarioId'] ?? 'sem-vendedor')

  ngOnInit(): void { void this.carregar() }

  protected reais(c: unknown): string { return formatarReais(Number(c)) }
  protected quando(iso: string): string { return dataHoraCurta(iso, this.d()?.periodo.fuso ?? null) }
  protected atrasada(iso: string): boolean { return new Date(iso).getTime() < Date.now() }

  async carregar(): Promise<void> {
    if (periodoInvertido(this.inicio(), this.fim())) return
    this.estado.set('carregando')
    const q = queryDoPeriodo(this.inicio(), this.fim())
    try {
      const r = await firstValueFrom(this.http.get<Painel>(`/v1/painel/inicio${q ? `?${q}` : ''}`))
      this.d.set(r)
      // Na 1ª carga o servidor escolhe o mês atual no fuso do tenant; o filtro passa a refletir isso.
      this.inicio.set(r.periodo.inicio)
      this.fim.set(r.periodo.fim)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroTexto.set(MENSAGENS_PERIODO[codigoDoErro(e) ?? ''] ?? 'Confira a conexão e tente de novo.')
      this.estado.set('erro')
    }
  }
}
