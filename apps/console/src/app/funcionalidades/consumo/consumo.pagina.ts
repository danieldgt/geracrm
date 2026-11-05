import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import {
  BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, IconeComponente, PainelComponente,
  StatCardComponente, TabelaComponente, formatarReais, type ColunaTabela,
} from '../../compartilhado/ui/index.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { ConsumoServico } from './consumo.servico.js'
import { PrecosWhatsappComponente } from './precos-whatsapp.componente.js'
import {
  FONTES, diaMesCurto, empilhar, mesAnterior, mesDeHoje, mesSeguinte, percentualDoOrcamento, rotuloCategoria,
  rotuloFinalidade, rotuloMes, type BarraEmpilhada,
} from './consumo.regras.js'

/**
 * Consumo — quanto custaram WhatsApp, IA e transcrição no mês (F2, #79-#81).
 *
 * ⚠️ Estimativa, não fatura: a fatura é a da Meta e dos provedores. WhatsApp = mensagens do número
 * oficial × preço por categoria (editável aqui); IA = custo gravado em cada turno do agente, contra o
 * orçamento mensal (só alerta, não corta — ADR-032); transcrição = minutos de áudio × tarifa.
 * Cinco estados como ramos explícitos; cor só de token; a barra do dia tem legenda com rótulo.
 */
@Component({
  selector: 'app-consumo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, IconeComponente, PainelComponente,
    StatCardComponente, TabelaComponente, PrecosWhatsappComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Consumo" subtitulo="Quanto custaram WhatsApp, IA e transcrição no mês">
      <div class="navmes" role="group" aria-label="Mês">
        <button type="button" class="btn btn--secundario btn--pequeno" aria-label="Mês anterior" (click)="ir(-1)">‹</button>
        <span class="mes txt-secao" aria-live="polite">{{ rotuloDoMes() }}</span>
        <button type="button" class="btn btn--secundario btn--pequeno" aria-label="Mês seguinte"
          [disabled]="!podeAvancar()" (click)="ir(1)">›</button>
      </div>
      <button type="button" class="btn btn--secundario" (click)="precosAbertos.set(true)">Preços do WhatsApp</button>
    </ui-cabecalho-tela>

    @switch (servico.estado()) {
      @case ('carregando') {
        <div class="cartoes" aria-busy="true">
          <div class="esq"></div><div class="esq"></div><div class="esq"></div>
        </div>
        <div class="esq grande"></div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso ao consumo" descricao="Peça a um administrador a permissão para ver os custos." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o consumo" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="recarregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        @if (dados(); as d) {
          @if (semConsumo()) {
            <ui-estado titulo="Sem consumo neste mês"
              descricao="Nenhuma mensagem do número oficial, turno de agente ou áudio transcrito foi registrado em {{ rotuloDoMes() }}.">
              <button type="button" class="btn btn--secundario" (click)="ir(-1)">Ver o mês anterior</button>
            </ui-estado>
          } @else {
            @if (d.precosPadrao) {
              <p class="aviso" role="status">
                Usando os preços padrão do WhatsApp. Ajuste em <b>Preços do WhatsApp</b> para refletir o seu contrato.
              </p>
            }
            <div class="cartoes">
              <div class="bloco">
                <ui-stat-card [valor]="reais(d.whatsapp.totalCentavos)" rotulo="WhatsApp" tom="sucesso" [rotuloAcima]="true">
                  <ui-icone uiIcone nome="message-circle" />
                </ui-stat-card>
                <p class="detalhe">{{ mensagensWhatsapp() }} mensagens do número oficial</p>
              </div>
              <div class="bloco">
                <ui-stat-card [valor]="reais(d.ia.totalCentavos)" rotulo="IA" tom="ia" [rotuloAcima]="true">
                  <ui-icone uiIcone nome="bot" />
                </ui-stat-card>
                <p class="detalhe">
                  @if (d.ia.orcamentoCentavos !== null) {
                    Orçamento {{ reais(d.ia.orcamentoCentavos) }} · {{ percentualOrcamento() }}% usado
                  } @else { Sem orçamento mensal definido (defina no Agente vendedor) }
                </p>
                <p class="detalhe">Projeção do mês: <b>{{ reais(d.ia.projecaoCentavos) }}</b></p>
                @if (d.ia.alerta === '100') { <ui-badge tom="erro">Orçamento atingido (100%)</ui-badge> }
                @else if (d.ia.alerta === '80') { <ui-badge tom="atencao">80% do orçamento</ui-badge> }
              </div>
              <div class="bloco">
                <ui-stat-card [valor]="reais(d.transcricao.custoCentavos)" rotulo="Transcrição" tom="atencao" [rotuloAcima]="true">
                  <ui-icone uiIcone nome="file-text" />
                </ui-stat-card>
                <p class="detalhe">{{ minutos(d.transcricao.minutos) }} min de áudio transcrito</p>
              </div>
            </div>

            <ui-painel>
              <h2 class="txt-secao titulo">Custo por dia</h2>
              <ul class="legenda">
                @for (f of fontes; track f.fonte) {
                  <li><i class="cor" [attr.data-fonte]="f.fonte"></i>{{ f.rotulo }}</li>
                }
              </ul>
              <div class="grafico" role="img" [attr.aria-label]="resumoGrafico()">
                @for (b of barras().barras; track b.dia) {
                  <div class="coluna" [attr.title]="dica(b)">
                    <div class="pilha">
                      @for (s of b.segmentos; track s.fonte) {
                        @if (s.alturaPct > 0) { <span class="seg" [attr.data-fonte]="s.fonte" [style.height.%]="s.alturaPct"></span> }
                      }
                    </div>
                    <span class="eixo txt-denso">{{ rotuloEixo(b) }}</span>
                  </div>
                }
              </div>
              <p class="detalhe">Maior dia: {{ reais(barras().maximoCentavos) }}. Passe o cursor sobre a barra para ver o dia.</p>
            </ui-painel>

            <div class="duas">
              <ui-painel>
                <h2 class="txt-secao titulo">WhatsApp por categoria</h2>
                <ui-tabela [colunas]="colCategoria" [linhas]="linhasCategoria()">
                  <div uiVazio><p class="vazio">Sem mensagens no mês.</p></div>
                </ui-tabela>
              </ui-painel>
              <ui-painel>
                <h2 class="txt-secao titulo">IA por finalidade</h2>
                <ui-tabela [colunas]="colFinalidade" [linhas]="linhasFinalidade()">
                  <div uiVazio><p class="vazio">Sem turnos de agente no mês.</p></div>
                </ui-tabela>
              </ui-painel>
              <ui-painel>
                <h2 class="txt-secao titulo">IA por modelo</h2>
                <ui-tabela [colunas]="colModelo" [linhas]="linhasModelo()">
                  <div uiVazio><p class="vazio">Sem turnos de agente no mês.</p></div>
                </ui-tabela>
              </ui-painel>
              <ui-painel>
                <h2 class="txt-secao titulo">Campanhas que mais custaram</h2>
                <ui-tabela [colunas]="colCampanha" [linhas]="linhasCampanha()">
                  <div uiVazio><p class="vazio">Nenhuma campanha enviou mensagens no mês.</p></div>
                </ui-tabela>
              </ui-painel>
            </div>

            <ui-painel>
              <h2 class="txt-secao titulo">Conversas que mais custaram em IA</h2>
              <ui-tabela [colunas]="colConversa" [linhas]="linhasConversa()">
                <ng-template uiCelula="contato" let-l>
                  <button type="button" class="link" (click)="abrirConversa(l.conversaId)">{{ l.contato }}</button>
                </ng-template>
                <div uiVazio><p class="vazio">Nenhuma conversa com custo de IA no mês.</p></div>
              </ui-tabela>
            </ui-painel>
            <p class="detalhe">Estimativa: a fatura é a da Meta e dos provedores de IA e de transcrição. Hoje é completado ao vivo; os dias anteriores atualizam a cada 15 minutos.</p>
          }
        }
      }
    }

    <app-precos-whatsapp [aberto]="precosAbertos()" (fechar)="precosAbertos.set(false)" (salvo)="recarregar()" />
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .navmes { display: inline-flex; align-items: center; gap: var(--espacamento-2); }
    .mes { min-width: 11ch; text-align: center; color: var(--texto); text-transform: capitalize; }
    .cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); }
    .bloco { display: flex; flex-direction: column; align-items: flex-start; gap: var(--espacamento-2); min-width: 0; }
    .bloco ui-stat-card { width: 100%; }
    .detalhe { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .aviso { margin: 0 0 var(--espacamento-3); padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto-secundario); font-size: 13px; }
    .esq { height: 96px; border-radius: var(--raio-painel); background: var(--superficie); }
    .esq.grande { height: 240px; }
    ui-painel { display: block; margin-bottom: var(--espacamento-4); min-width: 0; }
    .titulo { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .legenda { display: flex; flex-wrap: wrap; gap: var(--espacamento-4); margin: 0 0 var(--espacamento-3); padding: 0; list-style: none; color: var(--texto-secundario); font-size: 13px; }
    .legenda li { display: inline-flex; align-items: center; gap: var(--espacamento-2); }
    .cor { display: inline-block; width: 12px; height: 12px; border-radius: var(--raio-controle); }
    .cor[data-fonte='whatsapp'], .seg[data-fonte='whatsapp'] { background: var(--acao); }
    .cor[data-fonte='ia'], .seg[data-fonte='ia'] { background: var(--ia); }
    .cor[data-fonte='transcricao'], .seg[data-fonte='transcricao'] { background: var(--atencao); }
    .grafico { display: flex; align-items: flex-end; gap: 2px; min-width: 0; padding-bottom: var(--espacamento-1); border-bottom: 1px solid var(--borda); }
    .coluna { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: var(--espacamento-1); }
    .pilha { width: 100%; height: 160px; display: flex; flex-direction: column-reverse; }
    .seg { display: block; width: 100%; min-height: 1px; }
    .eixo { height: 1.4em; color: var(--texto-secundario); font-size: 11px; white-space: nowrap; }
    .duas { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--espacamento-4); }
    .vazio { margin: 0; padding: var(--espacamento-4); color: var(--texto-secundario); font-size: 13px; }
    .link { padding: 0; border: 0; background: transparent; color: var(--acao); font: inherit; cursor: pointer; text-align: left; }
    .link:hover { text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } .duas { grid-template-columns: 1fr; } }
  `,
})
export class ConsumoPagina implements OnInit {
  protected readonly servico = inject(ConsumoServico)
  private readonly inbox = inject(InboxServico)

  protected readonly fontes = FONTES
  protected readonly precosAbertos = signal(false)
  /** Mês pedido (null = o da API, no fuso do tenant). */
  private readonly pedido = signal<string | null>(null)

  protected readonly dados = this.servico.dados
  private readonly mesAtual = computed(() => this.dados()?.mes ?? this.pedido() ?? mesDeHoje())
  protected readonly rotuloDoMes = computed(() => rotuloMes(this.mesAtual()))
  protected readonly podeAvancar = computed(() => this.mesAtual() < mesDeHoje())
  protected readonly barras = computed(() => empilhar(this.dados()?.serieDiaria ?? []))

  protected readonly semConsumo = computed(() => {
    const d = this.dados()
    if (!d) return false
    return d.whatsapp.totalCentavos === 0 && d.ia.totalCentavos === 0 && d.transcricao.custoCentavos === 0
      && d.whatsapp.porCategoria.every((c) => c.mensagens === 0) && d.ia.porFinalidade.length === 0 && d.transcricao.minutos === 0
  })
  protected readonly mensagensWhatsapp = computed(() => (this.dados()?.whatsapp.porCategoria ?? []).reduce((s, c) => s + c.mensagens, 0))
  protected readonly percentualOrcamento = computed(() => {
    const d = this.dados()
    return d ? percentualDoOrcamento(d.ia.totalCentavos, d.ia.orcamentoCentavos) : null
  })
  protected readonly resumoGrafico = computed(() => {
    const d = this.dados()
    if (!d) return ''
    return `Custo por dia em ${rotuloMes(d.mes)}: WhatsApp ${this.reais(d.whatsapp.totalCentavos)}, IA ${this.reais(d.ia.totalCentavos)}, transcrição ${this.reais(d.transcricao.custoCentavos)}.`
  })

  protected readonly colCategoria: readonly ColunaTabela[] = [
    { chave: 'categoria', rotulo: 'Categoria' },
    { chave: 'mensagens', rotulo: 'Mensagens', alinhamento: 'dir', mono: true },
    { chave: 'custo', rotulo: 'Custo', alinhamento: 'dir', mono: true },
  ]
  protected readonly colFinalidade: readonly ColunaTabela[] = [
    { chave: 'finalidade', rotulo: 'Finalidade' },
    { chave: 'turnos', rotulo: 'Turnos', alinhamento: 'dir', mono: true },
    { chave: 'custo', rotulo: 'Custo', alinhamento: 'dir', mono: true },
  ]
  protected readonly colModelo: readonly ColunaTabela[] = [
    { chave: 'modelo', rotulo: 'Modelo' },
    { chave: 'turnos', rotulo: 'Turnos', alinhamento: 'dir', mono: true },
    { chave: 'custo', rotulo: 'Custo', alinhamento: 'dir', mono: true },
  ]
  protected readonly colCampanha: readonly ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Campanha' },
    { chave: 'mensagens', rotulo: 'Mensagens', alinhamento: 'dir', mono: true },
    { chave: 'custo', rotulo: 'Custo', alinhamento: 'dir', mono: true },
  ]
  protected readonly colConversa: readonly ColunaTabela[] = [
    { chave: 'contato', rotulo: 'Contato' },
    { chave: 'custo', rotulo: 'Custo de IA', alinhamento: 'dir', mono: true },
  ]

  protected readonly linhasCategoria = computed(() => (this.dados()?.whatsapp.porCategoria ?? [])
    .filter((c) => c.mensagens > 0)
    .map((c) => ({ id: c.categoria, categoria: rotuloCategoria(c.categoria), mensagens: c.mensagens, custo: this.reais(c.custoCentavos) })))
  protected readonly linhasFinalidade = computed(() => (this.dados()?.ia.porFinalidade ?? [])
    .map((f) => ({ id: f.finalidade, finalidade: rotuloFinalidade(f.finalidade), turnos: f.turnos, custo: this.reais(f.custoCentavos) })))
  protected readonly linhasModelo = computed(() => (this.dados()?.ia.porModelo ?? [])
    .map((m) => ({ id: m.modelo, modelo: m.modelo, turnos: m.turnos, custo: this.reais(m.custoCentavos) })))
  protected readonly linhasCampanha = computed(() => (this.dados()?.porCampanha ?? [])
    .map((c) => ({ id: c.campanhaId, nome: c.nome, mensagens: c.mensagens, custo: this.reais(c.custoCentavos) })))
  protected readonly linhasConversa = computed(() => (this.dados()?.conversasMaisCaras ?? [])
    .map((c) => ({ id: c.conversaId, conversaId: c.conversaId, contato: c.contatoNome, custo: this.reais(c.custoCentavos) })))

  ngOnInit(): void { void this.servico.carregar(null) }

  protected reais(centavos: number): string { return formatarReais(centavos) }
  protected minutos(n: number): string { return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) }

  protected ir(delta: -1 | 1): void {
    const base = this.mesAtual()
    const alvo = delta < 0 ? mesAnterior(base) : mesSeguinte(base)
    this.pedido.set(alvo)
    void this.servico.carregar(alvo)
  }

  protected recarregar(): void { void this.servico.carregar(this.pedido()) }

  /** Rótulo no eixo só em alguns dias, para não amontoar 31 números. */
  protected rotuloEixo(b: BarraEmpilhada): string {
    const n = Number(b.diaCurto)
    return n === 1 || n % 5 === 0 ? b.diaCurto : ''
  }

  protected dica(b: BarraEmpilhada): string {
    const partes = b.segmentos.filter((s) => s.centavos > 0)
      .map((s) => `${FONTES.find((f) => f.fonte === s.fonte)?.rotulo ?? s.fonte} ${this.reais(s.centavos)}`)
    return `${diaMesCurto(b.dia)}: ${this.reais(b.totalCentavos)}${partes.length ? ` (${partes.join(', ')})` : ''}`
  }

  protected abrirConversa(id: string): void { void this.inbox.abrir(id) }
}
