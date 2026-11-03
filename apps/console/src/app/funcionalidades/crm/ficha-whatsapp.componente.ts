import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, mensagemDeErro,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico, type ResumoWhatsapp } from './ficha-blocos.servico.js'

/** Aba WhatsApp: resumo das últimas mensagens da conversa mais recente + "Abrir no chat". Estado próprio. */
@Component({
  selector: 'app-ficha-whatsapp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') { <div aria-busy="true"><ui-esqueleto altura="120px" /></div> }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as mensagens" [descricao]="erro()">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado>
      }
      @default {
        @if (resumo(); as r) {
          @if (!r.conversa) {
            <ui-estado titulo="Ainda não há conversa" descricao="Quando houver troca de mensagens com este contato, o resumo aparece aqui." icone="message-circle">
              <ui-botao variante="primario" (click)="abrir.emit()">Abrir no chat</ui-botao>
            </ui-estado>
          } @else {
            <div class="topo">
              <span class="txt-denso suave">Número {{ r.conversa.canal }}@if (r.conversa.ultimaMensagemEm) { · última mensagem {{ r.conversa.ultimaMensagemEm | date: 'dd/MM/yyyy HH:mm' }} }</span>
              <ui-botao variante="primario" (click)="abrir.emit()">Abrir no chat</ui-botao>
            </div>
            @if (r.mensagens.length === 0) {
              <p class="txt-corpo suave">Conversa aberta, sem mensagens ainda.</p>
            } @else {
              <ul class="msgs" aria-label="Últimas mensagens">
                @for (m of r.mensagens; track m.id) {
                  <li class="msg" [attr.data-dir]="m.direcao">
                    <ui-badge [tom]="m.direcao === 'entrante' ? 'info' : 'neutro'">{{ m.direcao === 'entrante' ? 'Cliente' : 'Equipe' }}</ui-badge>
                    <span class="txt-corpo texto">{{ m.resumo }}</span>
                    <span class="txt-denso suave">{{ m.criadoEm | date: 'dd/MM HH:mm' }}</span>
                  </li>
                }
              </ul>
            }
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .topo { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .suave { color: var(--texto-secundario); margin: 0; }
    .msgs { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .msg { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--espacamento-3);
      padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); }
    .texto { color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class FichaWhatsappComponente {
  private readonly blocos = inject(FichaBlocosServico)
  readonly contatoId = input.required<string>()
  readonly abrir = output<void>()
  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  readonly resumo = signal<ResumoWhatsapp | null>(null)

  constructor() {
    effect(() => { this.contatoId(); untracked(() => { void this.carregar() }) })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      this.resumo.set(await this.blocos.whatsapp(this.contatoId()))
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }
}
