import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { EventoAgenda } from '@geracrm/shared'
import { BadgeComponente, EsqueletoComponente, EstadoComponente, queryDeLista } from '../../compartilhado/ui/index.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { AgendaDetalheModalComponente } from './agenda-detalhe-modal.componente.js'
import { AgendaEventoModalComponente } from './agenda-evento-modal.componente.js'
import { diaIso, horaLocal, rotuloStatusEvento, rotuloTipoEvento, tomDoStatus } from './agenda.regras.js'

/** Quantos dias à frente a ficha olha (a API aceita até 62). */
const HORIZONTE_DIAS = 60

/**
 * Aba/seção "Agenda" da ficha do contato: próximos eventos agendados + "Agendar".
 * Só renderiza com o módulo Agenda ligado (`ModulosServico.agendaAtiva()`); desligado, não ocupa lugar.
 *
 * Uso na ficha: `<app-agenda-contato [contatoId]="id" [contatoNome]="nome" />`
 * (a ficha decide se mostra a aba — `@if (modulos.agendaAtiva())` — e este componente se protege sozinho).
 */
@Component({
  selector: 'app-agenda-contato',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, EsqueletoComponente, EstadoComponente, AgendaDetalheModalComponente, AgendaEventoModalComponente],
  template: `
    @if (modulos.agendaAtiva()) {
      <div class="topo">
        <h3>Próximos eventos</h3>
        <button type="button" class="btn btn--primario btn--pequeno" (click)="modalNovo.set(true)">+ Agendar</button>
      </div>
      @if (carregando()) {
        <ui-esqueleto altura="64px" />
      } @else if (erro()) {
        <ui-estado tipo="erro" titulo="Não foi possível carregar a agenda do contato" descricao="Tente de novo em instantes.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      } @else {
        @for (e of eventos(); track e.id) {
          <button type="button" class="item" (click)="aberto.set(e)">
            <span class="quando">{{ e.inicio | date: 'dd/MM/yyyy' }} · {{ hora(e.inicio) }}–{{ hora(e.fim) }}</span>
            <span class="titulo">{{ e.titulo }}</span>
            <span class="meta">{{ tipo(e.tipo) }}@if (e.responsavel) { · {{ e.responsavel }} }</span>
            <ui-badge [tom]="tom(e.status)">{{ status(e.status) }}</ui-badge>
          </button>
        } @empty {
          <ui-estado titulo="Nada agendado" descricao="Este contato não tem eventos nos próximos dias. Marque uma reunião, ligação ou visita.">
            <button type="button" class="btn btn--primario" (click)="modalNovo.set(true)">+ Agendar</button>
          </ui-estado>
        }
      }
      <app-agenda-evento-modal [aberto]="modalNovo()" [contatoId]="contatoId()" [contatoNome]="contatoNome()"
        [dataInicial]="hoje" (fechar)="modalNovo.set(false)" (criado)="aoMudar()" />
      <app-agenda-detalhe-modal [evento]="aberto()" (fechar)="aberto.set(null)" (alterado)="aoMudar()" />
    }
  `,
  styles: `
    :host { display: block; }
    .topo { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .topo h3 { margin: 0; font-size: 14px; color: var(--texto); }
    .item { display: grid; gap: 2px; width: 100%; margin-bottom: var(--espacamento-2); padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; text-align: left; cursor: pointer; justify-items: start; }
    .item:hover { background: var(--superficie-hover); }
    .quando { font-size: 12px; color: var(--texto-secundario); }
    .titulo { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
    .meta { font-size: 12px; color: var(--texto-suave); }
  `,
})
export class AgendaContatoComponente {
  protected readonly modulos = inject(ModulosServico)
  private readonly http = inject(HttpClient)

  readonly contatoId = input.required<string>()
  readonly contatoNome = input<string | null>(null)

  protected readonly hoje = diaIso(new Date())
  protected readonly eventos = signal<readonly EventoAgenda[]>([])
  protected readonly carregando = signal(true)
  protected readonly erro = signal(false)
  protected readonly aberto = signal<EventoAgenda | null>(null)
  protected readonly modalNovo = signal(false)

  protected readonly hora = (iso: string): string => horaLocal(new Date(iso))
  protected readonly tipo = rotuloTipoEvento
  protected readonly status = rotuloStatusEvento
  protected readonly tom = tomDoStatus

  constructor() {
    effect(() => {
      this.contatoId()
      if (!this.modulos.agendaAtiva()) return
      untracked(() => void this.carregar())
    })
  }

  protected async carregar(): Promise<void> {
    this.carregando.set(true); this.erro.set(false)
    const ate = new Date(); ate.setDate(ate.getDate() + HORIZONTE_DIAS)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: EventoAgenda[] }>(
        `/v1/agenda/eventos${queryDeLista({ de: this.hoje, ate: diaIso(ate), contatoId: this.contatoId() })}`))
      this.eventos.set(r.itens.filter((e) => e.status === 'agendado' && new Date(e.fim).getTime() > Date.now()))
    } catch { this.erro.set(true) }
    finally { this.carregando.set(false) }
  }

  protected aoMudar(): void { this.modalNovo.set(false); this.aberto.set(null); void this.carregar() }
}
