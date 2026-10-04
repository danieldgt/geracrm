import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
} from '../../../compartilhado/ui/index.js'
import { InboxServico } from '../../../nucleo/inbox.servico.js'
import { AgenteServico, ehSemPermissao, type Sessao } from './agente.servico.js'
import {
  badgeModo, formatarReais, resumoExtraido, rotuloEstadoSessao, tomEstadoSessao, ROTULO_FASE,
} from './agente.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/**
 * Conversas conduzidas pelo agente (todas as do tenant — a sessão é por
 * conversa, não por número).
 *
 * ⚠️ Não é relatório: é o invariante de auditoria. Sem esta lista, "o que o
 * robô disse para o meu cliente?" só teria resposta no log do fornecedor de IA.
 */
@Component({
  selector: 'app-agente-sessoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq-lista">
          <ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso às conversas do agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar as conversas"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (itens().length === 0) {
          <ui-painel><ui-estado titulo="O agente ainda não conduziu nenhuma conversa" icone="🗂️"
            descricao="Ele entra quando as regras de entrada permitem — por padrão, depois da mensagem de ausência, com ninguém disponível." /></ui-painel>
        } @else {
          <ul class="lista">
            @for (s of itens(); track s.id) {
              <li class="item">
                <div class="linha">
                  <span class="nome encolhe">{{ s.contato ?? 'Contato' }}</span>
                  @if (s.modo) { <ui-badge [tom]="modo(s.modo).tom">{{ modo(s.modo).rotulo }}</ui-badge> }
                  <ui-badge [tom]="tomEstado(s.estado)">{{ rotuloEstado(s.estado) }}</ui-badge>
                  @if (s.fase) { <ui-badge tom="neutro">{{ fase(s.fase) }}</ui-badge> }
                </div>
                <div class="meta txt-dados">
                  <span>{{ s.iniciadaEm | date: 'dd/MM HH:mm' }}</span>
                  <span>{{ s.turnos }} {{ s.turnos === 1 ? 'turno' : 'turnos' }}</span>
                  <span>{{ s.tokens }} tokens</span>
                  <span>{{ reais(s.custoCentavos) }}</span>
                  @if (s.modelo) { <span class="modelo encolhe" title="Modelo">{{ s.modelo }}</span> }
                </div>
                @if (s.motivoSaida) { <p class="motivo">Saiu porque: {{ s.motivoSaida }}</p> }
                @if (resumo(s); as r) { <p class="extraido">{{ r }}</p> }
                <!-- ⚠️ O que o modelo afirmou e foi RECUSADO. É a medida da alucinação. -->
                @if (s.descartados.length > 0) {
                  <p class="descartado">Recusado:
                    @for (d of s.descartados; track $index) { <span>{{ d.campo }} ({{ d.motivo }})</span> }</p>
                }
                <div class="acoes"><ui-botao variante="fantasma" (click)="abrirConversa(s.conversaId)">Abrir conversa</ui-botao></div>
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
    .nome { color: var(--texto); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 120px; }
    .meta { display: flex; gap: var(--espacamento-3); flex-wrap: wrap; color: var(--texto-suave); }
    .modelo { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .motivo { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .extraido { margin: 0; color: var(--texto); font-size: 13px; overflow-wrap: anywhere; }
    .descartado { margin: 0; color: var(--atencao); font-size: 12px; display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .acoes { display: flex; }
    .erro-mais { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .mais { margin-top: var(--espacamento-4); }
    @media (max-width: 640px) { .item { padding: var(--espacamento-3); } }
  `,
})
export class AgenteSessoesComponente implements OnInit {
  private readonly api = inject(AgenteServico)
  private readonly inbox = inject(InboxServico)

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Sessao[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erroMais = signal<string | null>(null)

  ngOnInit(): void { void this.carregar() }

  modo(m: string) { return badgeModo(m) }
  rotuloEstado(e: string): string { return rotuloEstadoSessao(e) }
  tomEstado(e: string) { return tomEstadoSessao(e) }
  fase(f: string): string { return ROTULO_FASE[f] ?? f }
  reais(c: number): string { return formatarReais(c) }
  resumo(s: Sessao): string | null { return resumoExtraido(s.extraido) }
  abrirConversa(conversaId: string): void { void this.inbox.abrir(conversaId) }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroMais.set(null)
    try {
      const p = await this.api.listarSessoes(null)
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
      const p = await this.api.listarSessoes(cursor)
      this.itens.update((a) => [...a, ...p.itens])
      this.proximoCursor.set(p.proximoCursor)
    } catch {
      this.erroMais.set('Não foi possível carregar mais conversas. Tente de novo.')
    } finally { this.carregandoMais.set(false) }
  }
}
