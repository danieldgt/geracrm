import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, SelectPaginadoComponente, ToastServico,
  mensagemDeErro, queryDeLista, type CarregarOpcoes, type OpcaoPaginada, type OpcaoSelect, focarPrimeiroInvalido,
} from '../../compartilhado/ui/index.js'
import { OPCOES_TIPO_TAREFA, errosDoServidor, payloadTarefa, validarTarefa, type ErrosTarefa } from './tarefas.regras.js'

/**
 * Modal "Nova tarefa" (padrão A). Reutilizável: com `contatoId` o contato vem fixo (ficha);
 * sem ele, o usuário busca em `GET /v1/contatos/busca`. Emite `criada` com o id e fecha pelo pai.
 */
@Component({
  selector: 'app-tarefa-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalComponente, GradeFormComponente, CampoComponente, SelectComponente, SelectPaginadoComponente],
  template: `
    <ui-modal [aberto]="aberto()" titulo="Nova tarefa" largura="m" (fechar)="fechar.emit()">
      <form id="form-tarefa" (submit)="salvar($event)" novalidate>
        <ui-grade-form>
          @if (contatoId()) {
            <p class="contato-fixo">Contato: <strong>{{ contatoNome() || 'selecionado' }}</strong></p>
          } @else {
            <ui-select-paginado rotulo="Contato" placeholder="Busque por nome ou telefone" [largo]="true"
              [carregar]="buscarContatos" [erro]="erros().contatoId ?? null"
              [ngModel]="contato()" (ngModelChange)="contato.set($event ?? '')" name="contato" />
          }
          <ui-select rotulo="Tipo" [opcoes]="tipos" [(valor)]="tipo" />
          <ui-select rotulo="Responsável" placeholder="Eu (padrão)" [opcoes]="equipe()" [(valor)]="responsavel" />
          <ui-campo rotulo="Título" [obrigatorio]="true" [largo]="true" placeholder="Ex.: ligar para fechar o pedido"
            [(valor)]="titulo" [erro]="erros().titulo ?? null" />
          <ui-campo rotulo="Data" tipo="date" [obrigatorio]="true" [(valor)]="data" [erro]="erros().data ?? null" />
          <ui-campo rotulo="Hora" tipo="time" [obrigatorio]="true" [(valor)]="hora" [erro]="erros().hora ?? null" />
          <ui-campo rotulo="Descrição" tipo="textarea" [largo]="true" [(valor)]="descricao" />
        </ui-grade-form>
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-tarefa" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Criando…' : 'Criar tarefa' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .contato-fixo { grid-column: 1 / -1; margin: 0; color: var(--texto-secundario); font-size: 14px; }
    .contato-fixo strong { color: var(--texto); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class TarefaModalComponente {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  readonly aberto = input(false)
  /** Contato fixo (ficha). Sem ele, o modal mostra a busca. */
  readonly contatoId = input<string | null>(null)
  readonly contatoNome = input<string | null>(null)
  readonly criada = output<string>()
  readonly fechar = output<void>()

  protected readonly tipos: OpcaoSelect[] = OPCOES_TIPO_TAREFA.map((o) => ({ valor: o.valor, rotulo: o.rotulo }))
  protected readonly equipe = signal<OpcaoSelect[]>([])
  protected readonly contato = signal('')
  protected readonly tipo = signal('outro')
  protected readonly responsavel = signal('')
  protected readonly titulo = signal('')
  protected readonly data = signal('')
  protected readonly hora = signal('09:00')
  protected readonly descricao = signal('')
  protected readonly erros = signal<ErrosTarefa>({})
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly salvando = signal(false)
  private equipeCarregada = false

  constructor() {
    // Ao abrir: formulário limpo e equipe carregada uma vez.
    effect(() => {
      if (!this.aberto()) return
      untracked(() => {
        this.contato.set(''); this.tipo.set('outro'); this.responsavel.set(''); this.titulo.set('')
        this.data.set(''); this.hora.set('09:00'); this.descricao.set('')
        this.erros.set({}); this.erroGeral.set(null)
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
    } catch { /* o select fica só com o padrão; criar a tarefa continua possível */ }
  }

  protected readonly buscarContatos: CarregarOpcoes = async (_cursor, termo) => {
    // A busca de contatos devolve os 20 melhores (sem cursor): uma página só.
    if (termo.trim().length < 2) return { itens: [], proximoCursor: null }
    const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string; telefone: string | null }[] }>(
      `/v1/contatos/busca${queryDeLista({ q: termo.trim() })}`))
    const itens: OpcaoPaginada[] = r.itens.map((c) => ({ valor: c.id, rotulo: c.nome, ...(c.telefone ? { dica: c.telefone } : {}) }))
    return { itens, proximoCursor: null }
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const form = {
      contatoId: this.contatoId() ?? this.contato(), tipo: this.tipo(), titulo: this.titulo(), data: this.data(),
      hora: this.hora(), responsavelId: this.responsavel(), descricao: this.descricao(),
    }
    // Tarefa avulsa é válida: o contato é opcional quando o modal abre sem contato fixo.
    const erros = validarTarefa(form)
    this.erros.set(erros)
    const corpo = payloadTarefa(form)
    if (Object.keys(erros).length > 0 || !corpo) return
    this.salvando.set(true); this.erroGeral.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/tarefas', corpo))
      this.toast.sucesso('Tarefa criada')
      this.criada.emit(r.id)
    } catch (e) {
      // 422 with `campos`: show the message on the offending field; anything else is the general banner.
      const campos = e instanceof HttpErrorResponse && e.status === 422 ? (e.error as { campos?: string[] } | null)?.campos : undefined
      const porCampo = errosDoServidor(campos)
      if (Object.keys(porCampo).length > 0) { this.erros.set(porCampo); focarPrimeiroInvalido() }
      else this.erroGeral.set(mensagemDeErro(e, 'Não foi possível criar a tarefa.'))
    }
    finally { this.salvando.set(false) }
  }
}
