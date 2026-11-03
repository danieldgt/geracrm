import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, ToastServico, type OpcaoSelect } from '../../compartilhado/ui/index.js'
import { FunilServico, type Card } from './funil.servico.js'
import { payloadPerda, validarPerda } from './funil-acoes.regras.js'

/** Modal "Perder" (padrão A): motivo do catálogo (obrigatório) + descrição livre. Cancelar não persiste nada. */
@Component({
  selector: 'app-funil-perder-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalComponente, GradeFormComponente, CampoComponente, SelectComponente],
  template: `
    <ui-modal [aberto]="card() !== null" titulo="Perder negócio" largura="p" (fechar)="cancelado.emit()">
      <form id="form-perder" (submit)="salvar($event)" novalidate>
        <p class="contato-fixo">Contato: <strong>{{ card()?.nome }}</strong></p>
        <ui-grade-form>
          <ui-select rotulo="Motivo da perda" [obrigatorio]="true" [largo]="true" [opcoes]="opcoes()"
            [valor]="motivo()" (valorChange)="motivo.set($event); erro.set(null)" [erro]="erro()" />
          <ui-campo rotulo="Descrição" tipo="textarea" [largo]="true" [valor]="descricao()" (valorChange)="descricao.set($event)" />
        </ui-grade-form>
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="cancelado.emit()">Cancelar</button>
        <button type="submit" form="form-perder" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Registrar perda' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .contato-fixo { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 14px; }
    .contato-fixo strong { color: var(--texto); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class FunilPerderModalComponente {
  private readonly funil = inject(FunilServico)
  private readonly toast = inject(ToastServico)

  readonly card = input<Card | null>(null)
  readonly concluido = output<void>()
  readonly cancelado = output<void>()

  protected readonly opcoes = computed<OpcaoSelect[]>(() => this.funil.motivos().map((m) => ({ valor: m.codigo, rotulo: m.nome })))
  protected readonly motivo = signal('')
  protected readonly descricao = signal('')
  protected readonly erro = signal<string | null>(null)
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly salvando = signal(false)

  constructor() {
    effect(() => {
      if (!this.card()) return
      untracked(() => { this.motivo.set(''); this.descricao.set(''); this.erro.set(null); this.erroGeral.set(null) })
    })
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const c = this.card()
    if (!c || this.salvando()) return
    const form = { motivoCodigo: this.motivo(), descricao: this.descricao() }
    const e = validarPerda(form)
    this.erro.set(e.motivoCodigo ?? null); this.erroGeral.set(null)
    if (e.motivoCodigo) return
    this.salvando.set(true)
    const r = await this.funil.perder(c.id, payloadPerda(form, c.versao))
    this.salvando.set(false)
    if (!r.ok) {
      this.erroGeral.set(r.mensagem)
      if (r.status !== 422) this.cancelado.emit() // o quadro já recarregou; o card pode ter mudado
      return
    }
    this.toast.sucesso('Perda registrada')
    this.concluido.emit()
  }
}
