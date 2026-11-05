import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { EventoAgenda, StatusEvento } from '@geracrm/shared'
import {
  BadgeComponente, CampoComponente, ConfirmacaoServico, GradeFormComponente, ListaDefinicaoComponente, ModalComponente,
  ToastServico, corpoDoErro, mensagemDeErro, type ItemDefinicao,
} from '../../compartilhado/ui/index.js'
import {
  diaSemanaCurto,
  ROTULO_MODALIDADE, acoesDoStatus, payloadEvento, formDoEvento, rotuloStatusEvento, rotuloTipoEvento,
  textoDoConflito, tomDoStatus, validarEvento,
} from './agenda.regras.js'

/**
 * Detalhe do evento (padrão A): dados + ações Realizado / Não compareceu / Reagendar (formulário inline:
 * nova data, início e fim) / Cancelar. Toda mudança é pela API (versão otimista e conflito de horário
 * voltam como mensagem no próprio modal). Emite `alterado` para o calendário recarregar.
 */
@Component({
  selector: 'app-agenda-detalhe-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, BadgeComponente, CampoComponente, GradeFormComponente, ListaDefinicaoComponente, ModalComponente],
  template: `
    <ui-modal [aberto]="!!evento()" [titulo]="evento()?.titulo ?? 'Evento'" largura="m" (fechar)="fechar.emit()">
      @if (evento(); as e) {
        <p class="linha">
          <span class="ponto" [attr.data-cor]="e.cor" aria-hidden="true"></span>
          <ui-badge [tom]="tom()">{{ rotuloStatus() }}</ui-badge>
          <span class="quando">{{ diaSemanaCurto(e.inicio) }}, {{ e.inicio | date: "dd/MM/yyyy 'das' HH:mm" }} às {{ e.fim | date: 'HH:mm' }}</span>
        </p>
        <ui-lista-definicao [colunas]="2" [itens]="itens()" />
        @if (e.contatoId) {
          <p class="contato">Contato: <a [routerLink]="['/contato', e.contatoId]" (click)="fechar.emit()">{{ e.contato ?? 'abrir ficha' }}</a></p>
        }
        @if (e.link) { <p class="contato">Link: <a [href]="e.link" target="_blank" rel="noopener noreferrer">{{ e.link }}</a></p> }
        @if (e.descricao) { <p class="descricao">{{ e.descricao }}</p> }

        @if (reagendando()) {
          <form id="form-reagendar" class="reagendar" (submit)="reagendar($event)" novalidate>
            <ui-grade-form [colunas]="3">
              <ui-campo rotulo="Nova data" tipo="date" [obrigatorio]="true" [(valor)]="novaData" [erro]="erroCampo()" />
              <ui-campo rotulo="Início" tipo="time" [obrigatorio]="true" [(valor)]="novoInicio" />
              <ui-campo rotulo="Fim" tipo="time" [obrigatorio]="true" [(valor)]="novoFim" />
            </ui-grade-form>
          </form>
        }
        @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }
      }
      <div rodape>
        @if (reagendando()) {
          <button type="button" class="btn btn--secundario" (click)="reagendando.set(false)">Voltar</button>
          <button type="submit" form="form-reagendar" class="btn btn--primario" [disabled]="ocupado()">
            {{ ocupado() ? 'Reagendando…' : 'Confirmar novo horário' }}
          </button>
        } @else {
          <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Fechar</button>
          @if (evento(); as e) {
            @if (acoes().includes('cancelado')) {
              <button type="button" class="btn btn--fantasma" [disabled]="ocupado()" (click)="cancelar()">Cancelar evento</button>
            }
            @if (acoes().includes('nao_compareceu')) {
              <button type="button" class="btn btn--secundario" [disabled]="ocupado()" (click)="mudar('nao_compareceu')">Não compareceu</button>
            }
            <button type="button" class="btn btn--secundario" [disabled]="ocupado()" (click)="abrirReagendar()">Reagendar</button>
            @if (acoes().includes('realizado')) {
              <button type="button" class="btn btn--primario" [disabled]="ocupado()" (click)="mudar('realizado')">Realizado</button>
            }
            @if (e.status === 'cancelado' || e.status === 'realizado' || e.status === 'nao_compareceu') { <span class="suave">Reagende para voltar ao calendário.</span> }
          }
        }
      </div>
    </ui-modal>
  `,
  styles: `
    .linha { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin: 0 0 var(--espacamento-4); }
    .quando { color: var(--texto-secundario); font-size: 14px; }
    .ponto { width: 10px; height: 10px; border-radius: var(--raio-completo); background: var(--acao); flex: none; }
    .ponto[data-cor='sucesso'] { background: var(--sucesso); }
    .ponto[data-cor='atencao'] { background: var(--atencao); }
    .ponto[data-cor='erro'] { background: var(--erro); }
    .ponto[data-cor='ia'] { background: var(--ia); }
    .ponto[data-cor='neutro'] { background: var(--texto-suave); }
    .contato { margin: var(--espacamento-3) 0 0; font-size: 14px; color: var(--texto-secundario); overflow-wrap: anywhere; }
    .contato a { color: var(--acao); text-decoration: none; }
    .contato a:hover { text-decoration: underline; }
    .descricao { margin: var(--espacamento-3) 0 0; white-space: pre-wrap; color: var(--texto); font-size: 14px; }
    .reagendar { margin-top: var(--espacamento-4); padding-top: var(--espacamento-4); border-top: 1px solid var(--borda); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .suave { color: var(--texto-suave); font-size: 12px; margin-right: auto; }
  `,
})
export class AgendaDetalheModalComponente {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  /** O evento aberto; `null` = modal fechado. */
  readonly evento = input<EventoAgenda | null>(null)
  protected readonly diaSemanaCurto = diaSemanaCurto
  readonly alterado = output<void>()
  readonly fechar = output<void>()

  protected readonly reagendando = signal(false)
  protected readonly novaData = signal('')
  protected readonly novoInicio = signal('')
  protected readonly novoFim = signal('')
  protected readonly erro = signal<string | null>(null)
  protected readonly erroCampo = signal<string | null>(null)
  protected readonly ocupado = signal(false)

  protected readonly tom = computed(() => { const e = this.evento(); return e ? tomDoStatus(e.status) : 'neutro' })
  protected readonly rotuloStatus = computed(() => { const e = this.evento(); return e ? rotuloStatusEvento(e.status) : '' })
  protected readonly acoes = computed<readonly StatusEvento[]>(() => { const e = this.evento(); return e ? acoesDoStatus(e.status) : [] })
  protected readonly itens = computed<readonly ItemDefinicao[]>(() => {
    const e = this.evento()
    if (!e) return []
    return [
      { rotulo: 'Tipo', valor: rotuloTipoEvento(e.tipo) },
      { rotulo: 'Modalidade', valor: ROTULO_MODALIDADE[e.modalidade] ?? e.modalidade },
      { rotulo: 'Responsável', valor: e.responsavel },
      { rotulo: 'Local', valor: e.local },
      { rotulo: 'Lembrete', valor: e.lembreteMin ? `${e.lembreteMin >= 1440 ? '1 dia' : e.lembreteMin >= 60 ? '1 hora' : `${e.lembreteMin} min`} antes` : 'Sem lembrete' },
    ]
  })

  constructor() {
    // Ao abrir outro evento: volta ao modo leitura, sem erro antigo.
    effect(() => {
      const e = this.evento()
      untracked(() => { this.reagendando.set(false); this.erro.set(null); this.erroCampo.set(null); if (e) this.preencher(e) })
    })
  }

  private preencher(e: EventoAgenda): void {
    const f = formDoEvento(e)
    this.novaData.set(f.data); this.novoInicio.set(f.inicio); this.novoFim.set(f.fim)
  }

  protected abrirReagendar(): void {
    const e = this.evento()
    if (!e) return
    this.preencher(e); this.erro.set(null); this.erroCampo.set(null); this.reagendando.set(true)
  }

  protected async mudar(status: StatusEvento): Promise<void> {
    const e = this.evento()
    if (!e || this.ocupado()) return
    this.ocupado.set(true); this.erro.set(null)
    try {
      await firstValueFrom(this.http.patch(`/v1/agenda/eventos/${e.id}/status`, { status }))
      this.toast.sucesso(status === 'realizado' ? 'Marcado como realizado' : 'Marcado como não compareceu')
      this.alterado.emit()
    } catch (err) { this.erro.set(mensagemDeErro(err, 'Não foi possível atualizar o evento.')) }
    finally { this.ocupado.set(false) }
  }

  protected async cancelar(): Promise<void> {
    const e = this.evento()
    if (!e || this.ocupado()) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Cancelar evento?',
      mensagem: `"${e.titulo}" sai do calendário, mas continua no histórico como cancelado.`,
      acao: 'Cancelar evento',
      cancelar: 'Manter',
    })
    if (!ok) return
    this.ocupado.set(true); this.erro.set(null)
    try {
      await firstValueFrom(this.http.delete(`/v1/agenda/eventos/${e.id}`))
      this.toast.sucesso('Evento cancelado')
      this.alterado.emit()
    } catch (err) { this.erro.set(mensagemDeErro(err, 'Não foi possível cancelar o evento.')) }
    finally { this.ocupado.set(false) }
  }

  protected async reagendar(ev: Event): Promise<void> {
    ev.preventDefault()
    const e = this.evento()
    if (!e || this.ocupado()) return
    const form = { ...formDoEvento(e), data: this.novaData(), inicio: this.novoInicio(), fim: this.novoFim() }
    const erros = validarEvento(form)
    const primeiro = erros.data ?? erros.inicio ?? erros.fim ?? null
    this.erroCampo.set(primeiro)
    const corpo = payloadEvento(form, e.versao)
    if (primeiro || !corpo) return
    this.ocupado.set(true); this.erro.set(null)
    try {
      await firstValueFrom(this.http.put(`/v1/agenda/eventos/${e.id}`, corpo))
      this.toast.sucesso('Evento reagendado')
      this.alterado.emit()
    } catch (err) {
      const c = corpoDoErro(err)
      this.erro.set(textoDoConflito(c)
        ?? (c?.erro === 'agenda.versao_desatualizada' ? 'Alguém alterou este evento. Feche e abra de novo.' : mensagemDeErro(err, 'Não foi possível reagendar.')))
    } finally { this.ocupado.set(false) }
  }
}
