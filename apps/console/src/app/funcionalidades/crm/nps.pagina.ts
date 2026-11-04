import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  AbasComponente, CabecalhoTelaComponente, CelulaDiretiva, ConfirmacaoServico, EsqueletoComponente, EstadoComponente,
  GradeFormComponente, IconeComponente, ModalComponente, SelectComponente, TabelaComponente, mensagemDeErro,
  type Aba, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { blocoDoAgente, resumoFaixas, temNpsNoPeriodo, textoScore, type BlocoAgenteNps } from './nps.regras.js'

interface Atendente {
  readonly usuarioId: string; readonly nome: string; readonly total: number
  readonly promotores: number; readonly neutros: number; readonly detratores: number; readonly score: number | null
}
interface Nps {
  readonly dias: number
  readonly geral: { total: number; score: number | null; semAtendente: number }
  readonly porAtendente: Atendente[]
  /** Teto da equipe (200): `true` quando há mais atendentes que os listados. */
  readonly porAtendenteTruncado: boolean
  /** G3: notas que o AGENTE registrou no pós-venda — fora do ranking por atendente. */
  readonly agente?: BlocoAgenteNps
}
interface Membro { readonly id: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const PERIODOS = [{ dias: 30, r: '30d' }, { dias: 90, r: '90d' }, { dias: 180, r: '6m' }, { dias: 365, r: '12m' }]

/**
 * NPS por atendente — a nota é pós-conversa e avalia o atendimento, então o
 * painel mostra o score de cada vendedor. Score DERIVADO (%promotores −
 * %detratores). Padrão Lista: cabeçalho, período em abas, ranking em tabela e
 * registro da nota em modal. O bloco do agente fica à parte (G3).
 */
@Component({
  selector: 'app-nps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, CabecalhoTelaComponente, CelulaDiretiva, EsqueletoComponente, EstadoComponente, GradeFormComponente,
    IconeComponente, ModalComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="NPS por atendente"
      subtitulo="A nota é dada depois da conversa e avalia quem atendeu. A do pós-venda feito pelo agente aparece à parte.">
      <button type="button" class="btn btn--primario" (click)="abrirRegistro()">
        <ui-icone nome="plus" />Registrar nota
      </button>
    </ui-cabecalho-tela>

    <div class="periodo">
      <ui-abas [abas]="abasPeriodo" [ativa]="periodoAtivo()" (ativaChange)="trocar($event)" />
    </div>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="esqueletos" aria-busy="true">
            <ui-esqueleto altura="66px" />
            <ui-esqueleto altura="66px" />
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso ao NPS" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o NPS" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as n) {
            @if (!temDados(n)) {
              <ui-estado titulo="Sem NPS no período" descricao="Registre uma nota para quem atendeu.">
                <button type="button" class="btn btn--primario" (click)="abrirRegistro()">Registrar nota</button>
              </ui-estado>
            } @else {
              <div class="geral">
                <span class="g-num" [attr.data-sinal]="sinal(n.geral.score)">{{ n.geral.score !== null && n.geral.score > 0 ? '+' : '' }}{{ n.geral.score ?? '—' }}</span>
                <span class="g-lab">NPS geral · {{ n.geral.total }} resposta{{ n.geral.total === 1 ? '' : 's' }}</span>
              </div>

              <!-- G3: a nota do pós-venda feito pelo AGENTE, distinguida (não avalia vendedor). -->
              @if (agente(n); as ag) {
                @if (ag.total > 0) {
                  <div class="atd-linha agente">
                    <div class="a-topo">
                      <span class="a-nome encolhe"><span class="selo-ia">Agente</span> Pós-venda pelo agente</span>
                      <span class="a-score txt-dados" [attr.data-sinal]="sinal(ag.score)">{{ score(ag.score) }}</span>
                    </div>
                    <div class="barra">
                      <span class="seg prom" [style.flex]="ag.promotores" [title]="ag.promotores + ' promotores'"></span>
                      <span class="seg neu"  [style.flex]="ag.neutros" [title]="ag.neutros + ' neutros'"></span>
                      <span class="seg det"  [style.flex]="ag.detratores" [title]="ag.detratores + ' detratores'"></span>
                    </div>
                    <div class="a-rodape">
                      <span>{{ faixas(ag) }}</span>
                      <span class="a-total">{{ ag.total }} resposta{{ ag.total === 1 ? '' : 's' }}</span>
                    </div>
                    <p class="obs-ag">Notas coletadas pelo agente na pesquisa do pós-venda. Detrator vira tarefa do gestor.</p>
                  </div>
                }
              }

              <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chaveAtendente">
                <ng-template uiCelula="atendente" let-a>
                  <span class="a-nome">{{ a.nome }}</span>
                </ng-template>
                <ng-template uiCelula="distribuicao" let-a>
                  <span class="distribuicao">
                    <span class="barra" aria-hidden="true">
                      <span class="seg prom" [style.flex]="a.promotores"></span>
                      <span class="seg neu" [style.flex]="a.neutros"></span>
                      <span class="seg det" [style.flex]="a.detratores"></span>
                    </span>
                    <span class="suave">{{ a.promotores }} prom · {{ a.neutros }} neu · {{ a.detratores }} det</span>
                  </span>
                </ng-template>
                <ng-template uiCelula="score" let-a>
                  <span class="a-score txt-dados" [attr.data-sinal]="sinal(a.score)">{{ score(a.score) }}</span>
                </ng-template>
              </ui-tabela>
              @if (n.porAtendenteTruncado) {
                <p class="obs">Mostrando os 200 atendentes com mais respostas; há mais atendentes fora desta lista.</p>
              }
              @if (n.geral.semAtendente > 0) {
                <p class="obs">{{ n.geral.semAtendente }} resposta(s) sem atendente associado não aparecem acima.</p>
              }
            }
          }
        }
      }
    </div>

    <ui-modal [aberto]="registroAberto()" titulo="Registrar nota de NPS" largura="p" (fechar)="fecharRegistro()">
      <form id="form-nps" (submit)="registrar($event)">
        <ui-grade-form>
          <ui-select class="largo" rotulo="Quem atendeu" placeholder="Escolha o atendente" [opcoes]="opcoesEquipe()"
            [obrigatorio]="true" [(valor)]="atendente" [erro]="erroAtendente()" />
          <div class="largo grupo-nota" role="group" aria-labelledby="rotulo-nota" aria-required="true">
            <span class="rotulo" id="rotulo-nota">Nota de 0 a 10<span class="obrig" aria-hidden="true"> *</span></span>
            <span class="notas">
              @for (n of notas; track n) {
                <button type="button" class="nb" [class.sel]="nota() === n" [attr.data-faixa]="faixaDe(n)"
                  [attr.aria-pressed]="nota() === n" [attr.aria-label]="'Nota ' + n" (click)="escolherNota(n)">{{ n }}</button>
              }
            </span>
            <span class="dica">Promotor de 9 a 10, neutro de 7 a 8, detrator de 0 a 6.</span>
            @if (erroNota()) { <span class="erro" role="alert">{{ erroNota() }}</span> }
          </div>
        </ui-grade-form>
        @if (erroForm()) { <p class="erro" role="alert">{{ erroForm() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharRegistro()">Cancelar</button>
        <button type="submit" form="form-nps" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Salvar nota' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .periodo { margin-top: var(--espacamento-3); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .esqueletos { display: grid; gap: var(--espacamento-2); }
    .geral { display: flex; align-items: baseline; gap: var(--espacamento-3); padding: var(--espacamento-4) var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .g-num { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; }
    .g-num[data-sinal="bom"] { color: var(--rfv-campeao); } .g-num[data-sinal="neutro"] { color: var(--rfv-precisa-atencao); } .g-num[data-sinal="ruim"] { color: var(--rfv-perdido); }
    .g-lab { color: var(--texto-suave); font-size: 13px; }
    .atd-linha { padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .a-topo { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-3); }
    .a-nome { color: var(--texto); font-size: 14px; font-weight: 500; }
    .a-score { font-size: 16px; font-weight: 700; }
    .a-score[data-sinal="bom"] { color: var(--rfv-campeao); } .a-score[data-sinal="neutro"] { color: var(--rfv-precisa-atencao); } .a-score[data-sinal="ruim"] { color: var(--rfv-perdido); }
    .barra { display: flex; flex: 1; min-width: 120px; height: 8px; border-radius: var(--raio-completo); overflow: hidden; background: var(--superficie); }
    .seg { display: block; min-width: 0; }
    .seg.prom { background: var(--rfv-campeao); } .seg.neu { background: var(--rfv-precisa-atencao); } .seg.det { background: var(--rfv-perdido); }
    .a-rodape { display: flex; justify-content: space-between; gap: var(--espacamento-3); font-size: 12px; color: var(--texto-suave); }
    .a-total { color: var(--texto-secundario); }
    .distribuicao { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 220px; }
    .suave { color: var(--texto-suave); font-size: 12px; white-space: nowrap; }
    .obs { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .agente { margin-bottom: var(--espacamento-2); border-color: var(--ia); background: var(--ia-suave); }
    .selo-ia { display: inline-block; margin-right: var(--espacamento-1); padding: 0 var(--espacamento-2); border-radius: var(--raio-completo);
      background: var(--ia); color: var(--acao-texto); font-size: 11px; font-weight: 600; vertical-align: middle; }
    .obs-ag { margin: var(--espacamento-1) 0 0; font-size: 12px; color: var(--texto-secundario); }
    .grupo-nota { display: grid; gap: var(--espacamento-2); }
    .rotulo { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .obrig { color: var(--erro); }
    .dica { font-size: 12px; color: var(--texto-suave); }
    .notas { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; }
    .nb { width: 36px; height: 36px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; font-size: 13px; cursor: pointer; }
    .nb:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .nb[data-faixa="promotor"].sel { background: var(--rfv-campeao); border-color: var(--rfv-campeao); color: var(--acao-texto); }
    .nb[data-faixa="neutro"].sel { background: var(--rfv-precisa-atencao); border-color: var(--rfv-precisa-atencao); color: var(--acao-texto); }
    .nb[data-faixa="detrator"].sel { background: var(--rfv-perdido); border-color: var(--rfv-perdido); color: var(--acao-texto); }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    @media (max-width: 640px) { .distribuicao { min-width: 0; flex-wrap: wrap; } }
  `,
})
export class NpsPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly abasPeriodo: readonly Aba[] = PERIODOS.map((p) => ({ id: String(p.dias), rotulo: p.r }))
  readonly notas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  readonly colunas: readonly ColunaTabela[] = [
    { chave: 'atendente', rotulo: 'Atendente' },
    { chave: 'distribuicao', rotulo: 'Distribuição' },
    { chave: 'score', rotulo: 'NPS', alinhamento: 'dir', mono: true, largura: '90px' },
  ]
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Nps | null>(null)
  readonly linhas = computed(() => (this.d()?.porAtendente ?? []) as unknown as LinhaTabela[])
  readonly chaveAtendente = (l: LinhaTabela): string => String(l['usuarioId'])
  readonly equipe = signal<readonly Membro[]>([])
  readonly opcoesEquipe = computed<OpcaoSelect[]>(() => this.equipe().map((m) => ({ valor: m.id, rotulo: m.nome })))
  readonly dias = signal(90)
  readonly periodoAtivo = computed(() => String(this.dias()))
  readonly registroAberto = signal(false)
  readonly nota = signal<number | null>(null)
  readonly atendente = signal('')
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)
  readonly erroAtendente = signal<string | null>(null); readonly erroNota = signal<string | null>(null)

  ngOnInit(): void { void this.carregar(); void this.carregarEquipe() }
  trocar(dias: string): void { this.dias.set(Number(dias)); void this.carregar() }
  faixaDe(n: number): string { return n >= 9 ? 'promotor' : n >= 7 ? 'neutro' : 'detrator' }
  temDados(n: Nps): boolean { return temNpsNoPeriodo(n) }
  agente(n: Nps): BlocoAgenteNps { return blocoDoAgente(n) }
  score(s: number | null): string { return textoScore(s) }
  faixas(b: BlocoAgenteNps): string { return resumoFaixas(b) }
  sinal(score: number | null): string { return score === null ? 'neutro' : score >= 50 ? 'bom' : score >= 0 ? 'neutro' : 'ruim' }

  async carregarEquipe(): Promise<void> {
    try { const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe')); this.equipe.set(r.itens) } catch { /* seletor vazio */ }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Nps>(`/v1/nps?dias=${this.dias()}`))
      this.d.set(r)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrirRegistro(): void { this.erroForm.set(null); this.registroAberto.set(true) }

  /** Fechar com nota ou atendente escolhidos pede confirmação; sem nada digitado, fecha direto. */
  async fecharRegistro(): Promise<void> {
    if (this.salvando()) return
    const digitado = this.nota() !== null || this.atendente() !== ''
    if (digitado && !(await this.confirmacao.confirmar({
      titulo: 'Descartar a nota?', mensagem: 'A nota ainda não foi salva.', acao: 'Descartar', cancelar: 'Continuar editando', perigo: true,
    }))) return
    this.nota.set(null); this.atendente.set(''); this.erroAtendente.set(null); this.erroNota.set(null)
    this.registroAberto.set(false)
  }

  escolherNota(n: number): void { this.nota.set(n); this.erroNota.set(null) }

  async registrar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nota = this.nota(); const atendenteId = this.atendente()
    this.erroAtendente.set(atendenteId ? null : 'Escolha quem atendeu.')
    this.erroNota.set(nota === null ? 'Escolha uma nota de 0 a 10.' : null)
    if (this.salvando() || nota === null || !atendenteId) return
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/nps', { nota, atendenteId }))
      this.nota.set(null); this.atendente.set(''); this.registroAberto.set(false)
      await this.carregar()
    } catch (e) { this.erroForm.set(mensagemDeErro(e, 'Não foi possível registrar a resposta.')) } finally { this.salvando.set(false) }
  }
}
