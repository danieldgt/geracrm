import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, ToastServico, type OpcaoSelect } from '../../compartilhado/ui/index.js'
import { FunilServico, type Card } from './funil.servico.js'
import { payloadTransferencia, validarTransferencia, type ErrosTransferencia } from './funil-acoes.regras.js'

/** Modal "Transferir" (padrão A): novo vendedor (`GET /v1/equipe`) e motivo obrigatório. A carteira do contato troca e fica auditada. */
@Component({
  selector: 'app-funil-transferir-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalComponente, GradeFormComponente, CampoComponente, SelectComponente],
  template: `
    <ui-modal [aberto]="card() !== null" titulo="Transferir negócio" largura="p" (fechar)="fechar.emit()">
      <form id="form-transferir" (submit)="salvar($event)" novalidate>
        <p class="contato-fixo">Contato: <strong>{{ card()?.nome }}</strong></p>
        <ui-grade-form>
          <ui-select rotulo="Novo vendedor" [obrigatorio]="true" [largo]="true" [opcoes]="equipe()"
            [valor]="usuarioId()" (valorChange)="usuarioId.set($event)" [erro]="erros().usuarioId ?? null" />
          <ui-campo rotulo="Motivo" tipo="textarea" [obrigatorio]="true" [largo]="true"
            [valor]="motivo()" (valorChange)="motivo.set($event)" [erro]="erros().motivo ?? null" />
        </ui-grade-form>
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-transferir" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Transferindo…' : 'Transferir' }}
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
export class FunilTransferirModalComponente {
  private readonly http = inject(HttpClient)
  private readonly funil = inject(FunilServico)
  private readonly toast = inject(ToastServico)

  readonly card = input<Card | null>(null)
  readonly concluido = output<void>()
  readonly fechar = output<void>()

  protected readonly equipe = signal<OpcaoSelect[]>([])
  protected readonly usuarioId = signal('')
  protected readonly motivo = signal('')
  protected readonly erros = signal<ErrosTransferencia>({})
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly salvando = signal(false)
  private equipeCarregada = false

  constructor() {
    effect(() => {
      if (!this.card()) return
      untracked(() => {
        this.usuarioId.set(''); this.motivo.set(''); this.erros.set({}); this.erroGeral.set(null)
        void this.carregarEquipe()
      })
    })
  }

  private async carregarEquipe(): Promise<void> {
    if (this.equipeCarregada) return
    try {
      const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/equipe'))
      this.equipe.set(r.itens.map((u) => ({ valor: u.id, rotulo: u.nome })))
      this.equipeCarregada = true
    } catch { this.erroGeral.set('Não foi possível carregar a equipe. Feche e abra de novo.') }
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const c = this.card()
    if (!c || this.salvando()) return
    const form = { usuarioId: this.usuarioId(), motivo: this.motivo() }
    const e = validarTransferencia(form)
    this.erros.set(e); this.erroGeral.set(null)
    if (Object.keys(e).length > 0) return
    this.salvando.set(true)
    const r = await this.funil.transferir(c.id, payloadTransferencia(form))
    this.salvando.set(false)
    if (!r.ok) { this.erroGeral.set(r.mensagem); return }
    this.toast.sucesso('Negócio transferido')
    this.concluido.emit()
  }
}
