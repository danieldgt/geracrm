import { Component, ChangeDetectionStrategy, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
} from '../../../compartilhado/ui/index.js'
import { InboxServico } from '../../../nucleo/inbox.servico.js'
import { AgenteServico, ehSemPermissao, type Decisao } from './agente.servico.js'
import {
  badgeDesfecho, badgeModo, formatarConfianca, formatarReais, jsonLegivel, resumoDeUso, rotuloHandoff, ROTULO_FASE,
} from './agente.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/**
 * As DECISÕES do agente neste número — uma por turno (ADR-023). É a resposta a
 * "por que o robô disse isso?": o que respondeu, quais ferramentas chamou, o
 * que o guardrail barrou, quanto custou.
 *
 * Badges em ORDEM FIXA (modo, desfecho) — quem usa 8 h varre, não lê.
 */
@Component({
  selector: 'app-agente-decisoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq-lista">
          <ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso às decisões do agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar as decisões"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (itens().length === 0) {
          <ui-painel><ui-estado titulo="Nenhuma decisão ainda" icone="🤖"
            descricao="Cada turno do agente neste número aparece aqui — inclusive os do playground, marcados como simulação. Ligue em modo sombra para começar a ver." /></ui-painel>
        } @else {
          <ul class="lista">
            @for (d of itens(); track d.id) {
              <li class="item">
                <div class="linha">
                  <span class="txt-dados quando">{{ d.criadoEm | date: 'dd/MM HH:mm' }}</span>
                  <span class="contato encolhe">{{ d.contato ?? 'Contato' }}</span>
                  <ui-badge [tom]="modo(d.modo).tom">{{ modo(d.modo).rotulo }}</ui-badge>
                  <ui-badge [tom]="desfecho(d.desfecho).tom">{{ desfecho(d.desfecho).rotulo }}</ui-badge>
                </div>
                <div class="metricas txt-dados">
                  <span title="Confiança">conf. {{ confianca(d.confianca) }}</span>
                  <span title="Custo estimado">{{ reais(d.custoCentavos) }}</span>
                  <span title="Latência">{{ d.latenciaMs ?? '—' }} ms</span>
                  <span [title]="d.enviada ? 'Enviada ao cliente' : 'Não enviada'">{{ d.enviada ? 'enviada' : 'não enviada' }}</span>
                  <!-- Qual modelo respondeu — é o que torna custo e qualidade comparáveis por modelo. -->
                  @if (d.modelo) { <span class="modelo encolhe" title="Modelo">{{ d.modelo }}</span> }
                  @if (d.numerosBloqueados.length > 0) {
                    <ui-badge tom="atencao">{{ d.numerosBloqueados.length }} valor(es) barrado(s)</ui-badge>
                  }
                </div>
                <div class="acoes">
                  <ui-botao variante="fantasma" (click)="alternar(d.id)">
                    {{ aberto(d.id) ? 'Esconder' : 'Detalhes' }}</ui-botao>
                  <ui-botao variante="fantasma" (click)="abrirConversa(d.conversaId)">Abrir conversa</ui-botao>
                </div>

                @if (aberto(d.id)) {
                  <dl class="detalhes">
                    @if (d.resposta; as r) {
                      <dt>Resposta</dt>
                      <dd><div class="bolhas">@for (m of r.mensagens; track $index) { <p class="bolha">{{ m }}</p> }</div></dd>
                      @if (r.fase) { <dt>Fase</dt><dd>{{ fase(r.fase) }}</dd> }
                      @if (r.slots && temChaves(r.slots)) {
                        <dt>Colheu</dt><dd class="txt-dados">{{ json(r.slots) }}</dd>
                      }
                    }
                    @if (rotuloHandoff(d.handoffMotivo); as h) {
                      <dt>Entregou porque</dt><dd>{{ h }}@if (d.resposta?.handoff?.resumo) { — {{ d.resposta?.handoff?.resumo }}}</dd>
                    }
                    @if (d.portaoMotivo) { <dt>Portão</dt><dd class="txt-dados">{{ d.portaoMotivo }}</dd> }
                    <!-- ⚠️ O que o modelo afirmou e o guardrail RECUSOU. É a medida da
                         alucinação e some se ninguém mostrar. -->
                    @if (d.numerosBloqueados.length > 0) {
                      <dt>Barrado</dt>
                      <dd class="aviso">Valores citados sem origem em ferramenta, removidos da resposta:
                        @for (n of d.numerosBloqueados; track $index) { <span class="txt-dados">{{ reais(n) }}</span> }</dd>
                    }
                    @if (d.erro) { <dt>Erro</dt><dd class="erro">{{ d.erro }}</dd> }
                    <dt>Modelo</dt><dd class="txt-dados">{{ d.modelo ?? '—' }}</dd>
                    <dt>Rodadas</dt><dd class="txt-dados">{{ d.rodadas }}</dd>
                    <dt>Tokens</dt><dd class="txt-dados">{{ uso(d) }}</dd>
                    <dt>Ferramentas</dt>
                    <dd>
                      @if (d.ferramentas.length === 0) { <span class="dica">Nenhuma.</span> }
                      @for (c of d.ferramentas; track $index) {
                        <details class="ferramenta">
                          <summary><span class="txt-dados">{{ c.nome }}</span>
                            <span class="txt-dados meta">{{ c.ms }} ms</span>
                            @if (c.erro) { <ui-badge tom="erro">erro</ui-badge> }</summary>
                          <p class="txt-rotulo">Entrada</p>
                          <pre class="rolagem-x">{{ json(c.entrada) }}</pre>
                          <p class="txt-rotulo">{{ c.erro ? 'Erro' : 'Saída' }}</p>
                          <pre class="rolagem-x">{{ c.erro ?? json(c.saida) }}</pre>
                        </details>
                      }
                    </dd>
                  </dl>
                }
              </li>
            }
          </ul>
          @if (erroMais(); as e) { <p class="erro-mais" role="alert">{{ e }}</p> }
          @if (proximoCursor()) {
            <div class="mais">
              <ui-botao variante="secundario" (click)="carregarMais()" [carregando]="carregandoMais()">
                {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</ui-botao>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .esq-lista { display: grid; gap: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); overflow: hidden; }
    .item { padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); display: grid;
      gap: var(--espacamento-1); min-width: 0; }
    .item:last-child { border-bottom: none; }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .quando { color: var(--texto-suave); }
    .contato { color: var(--texto); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 120px; }
    .metricas { display: flex; gap: var(--espacamento-3); flex-wrap: wrap; color: var(--texto-secundario); align-items: center; }
    .modelo { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .acoes { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; }
    .detalhes { display: grid; grid-template-columns: max-content 1fr; gap: var(--espacamento-1) var(--espacamento-3);
      margin: var(--espacamento-2) 0 0; padding: var(--espacamento-3); border: 1px solid var(--borda);
      border-radius: var(--raio-controle); background: var(--superficie); font-size: 13px; min-width: 0; }
    .detalhes dt { color: var(--texto-suave); }
    .detalhes dd { margin: 0; min-width: 0; color: var(--texto); }
    .bolhas { display: grid; gap: var(--espacamento-1); }
    .bolha { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-painel);
      background: var(--ia-suave); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 520px; }
    .aviso { color: var(--atencao); display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .erro { color: var(--erro); }
    .dica, .meta { color: var(--texto-suave); }
    .ferramenta { margin-top: var(--espacamento-1); min-width: 0; }
    .ferramenta summary { cursor: pointer; display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .ferramenta .txt-rotulo { margin: var(--espacamento-2) 0 var(--espacamento-1); }
    pre { margin: 0; padding: var(--espacamento-2); font-family: var(--tipografia-familia-dados); font-size: 12px;
      background: var(--fundo); border-radius: var(--raio-controle); max-height: 240px; overflow: auto; max-width: 100%; }
    .erro-mais { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .mais { margin-top: var(--espacamento-4); }
    @media (max-width: 640px) { .detalhes { grid-template-columns: 1fr; } .item { padding: var(--espacamento-3); } }
  `,
})
export class AgenteDecisoesComponente {
  readonly canalId = input.required<string>()

  private readonly api = inject(AgenteServico)
  private readonly inbox = inject(InboxServico)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Decisao[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  /** ⚠️ Parcial: a primeira página está na tela; "carregar mais" falhou. Não derruba a lista. */
  readonly erroMais = signal<string | null>(null)
  private readonly abertos = signal<ReadonlySet<string>>(new Set())

  constructor() {
    effect(() => { this.canalId(); untracked(() => void this.carregar()) })
  }

  modo(m: string) { return badgeModo(m) }
  desfecho(d: string) { return badgeDesfecho(d) }
  confianca(c: number | null): string { return formatarConfianca(c) }
  reais(c: number): string { return formatarReais(c) }
  uso(d: Decisao): string { return resumoDeUso('entrada' in d.uso ? d.uso : null) }
  json(v: unknown): string { return jsonLegivel(v) }
  rotuloHandoff(m: string | null): string | null { return rotuloHandoff(m) }
  fase(f: string): string { return ROTULO_FASE[f] ?? f }
  temChaves(o: Record<string, unknown>): boolean { return Object.keys(o).length > 0 }
  aberto(id: string): boolean { return this.abertos().has(id) }

  alternar(id: string): void {
    this.abertos.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  abrirConversa(conversaId: string): void { void this.inbox.abrir(conversaId) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erroMais.set(null); this.abertos.set(new Set())
    try {
      const p = await this.api.listarDecisoes(this.canalId(), null)
      this.itens.set(p.itens)
      this.proximoCursor.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true); this.erroMais.set(null)
    try {
      const p = await this.api.listarDecisoes(this.canalId(), cursor)
      this.itens.update((a) => [...a, ...p.itens])
      this.proximoCursor.set(p.proximoCursor)
    } catch {
      this.erroMais.set('Não foi possível carregar mais decisões. Tente de novo.')
    } finally { this.carregandoMais.set(false) }
  }
}
