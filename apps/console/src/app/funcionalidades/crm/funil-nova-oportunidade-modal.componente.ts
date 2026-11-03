import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, SelectPaginadoComponente, ToastServico,
  queryDeLista, reaisParaCentavos, type CarregarOpcoes, type OpcaoPaginada, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { FunilServico, type Etapa } from './funil.servico.js'
import {
  payloadNovaOportunidade, validarNovaOportunidade, type ErrosNovaOportunidade,
} from './funil-acoes.regras.js'

/** Modal "Nova oportunidade" (padrão A): contato (busca paginada), etapa inicial (só etapas abertas) e valor estimado. */
@Component({
  selector: 'app-funil-nova-oportunidade-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalComponente, GradeFormComponente, CampoComponente, SelectComponente, SelectPaginadoComponente],
  template: `
    <ui-modal [aberto]="aberto()" titulo="Nova oportunidade" largura="m" (fechar)="fechar.emit()">
      <form id="form-nova-op" (submit)="salvar($event)" novalidate>
        <ui-grade-form>
          <ui-select-paginado rotulo="Contato" placeholder="Busque por nome ou telefone" [obrigatorio]="true" [largo]="true"
            [carregar]="buscarContatos" [erro]="erros().contatoId ?? null"
            [ngModel]="contato()" (ngModelChange)="contato.set($event ?? '')" name="contato" />
          <ui-select rotulo="Etapa inicial" [obrigatorio]="true" [opcoes]="etapas()" [valor]="etapaId()"
            (valorChange)="etapaId.set($event)" [erro]="erros().etapaId ?? null" />
          <ui-campo rotulo="Valor estimado" tipo="dinheiro" placeholder="0,00" [valor]="valor()" (valorChange)="valor.set($event)" />
        </ui-grade-form>
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-nova-op" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Criando…' : 'Criar oportunidade' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class FunilNovaOportunidadeModalComponente {
  private readonly http = inject(HttpClient)
  private readonly funil = inject(FunilServico)
  private readonly toast = inject(ToastServico)

  readonly aberto = input(false)
  readonly criada = output<void>()
  readonly fechar = output<void>()

  protected readonly etapas = computed<OpcaoSelect[]>(() =>
    this.funil.colunas().map((c) => c.etapa).filter((e: Etapa) => e.tipo === 'aberto').map((e) => ({ valor: e.id, rotulo: e.nome })))
  protected readonly contato = signal('')
  protected readonly etapaId = signal('')
  protected readonly valor = signal('')
  protected readonly erros = signal<ErrosNovaOportunidade>({})
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly salvando = signal(false)

  constructor() {
    effect(() => {
      if (!this.aberto()) return
      untracked(() => {
        this.contato.set(''); this.valor.set(''); this.erros.set({}); this.erroGeral.set(null)
        this.etapaId.set(this.etapas()[0]?.valor ?? '') // padrão: a primeira etapa aberta
      })
    })
  }

  /** Busca de contato (mínimo de 2 letras; a API devolve os 20 melhores, uma página só). */
  protected readonly buscarContatos: CarregarOpcoes = async (_cursor, termo) => {
    if (termo.trim().length < 2) return { itens: [], proximoCursor: null }
    const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string; telefone: string | null }[] }>(
      `/v1/contatos/busca${queryDeLista({ q: termo.trim() })}`))
    const itens: OpcaoPaginada[] = r.itens.map((c) => ({ valor: c.id, rotulo: c.nome, ...(c.telefone ? { dica: c.telefone } : {}) }))
    return { itens, proximoCursor: null }
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const form = { contatoId: this.contato(), etapaId: this.etapaId(), valorCentavos: reaisParaCentavos(this.valor()) }
    const e = validarNovaOportunidade(form)
    this.erros.set(e); this.erroGeral.set(null)
    if (Object.keys(e).length > 0) return
    this.salvando.set(true)
    const r = await this.funil.criar(payloadNovaOportunidade(form))
    this.salvando.set(false)
    if (!r.ok) { this.erroGeral.set(r.mensagem); return }
    this.toast.sucesso('Oportunidade criada')
    this.criada.emit()
  }
}
