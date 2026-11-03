import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, SelectPaginadoComponente, ToastServico,
  corpoDoErro, mensagemDeErro, queryDeLista, type CarregarOpcoes, type OpcaoPaginada, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import {
  OPCOES_COR, OPCOES_LEMBRETE, OPCOES_MODALIDADE, OPCOES_TIPO_EVENTO, formVazio, payloadEvento, validarEvento,
  textoDoConflito, type ErrosEvento,
} from './agenda.regras.js'

/**
 * Modal "Novo evento" (padrão A). Com `contatoId` o contato vem fixo (ficha); sem ele, busca em
 * `GET /v1/contatos/busca`. Conflito de horário (409 `agenda.horario_ocupado`) é nomeado no próprio
 * formulário, com o evento que ocupa o horário. Emite `criado` e quem abriu fecha.
 */
@Component({
  selector: 'app-agenda-evento-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalComponente, GradeFormComponente, CampoComponente, SelectComponente, SelectPaginadoComponente],
  template: `
    <ui-modal [aberto]="aberto()" titulo="Novo evento" largura="m" (fechar)="fechar.emit()">
      <form id="form-evento" (submit)="salvar($event)" novalidate>
        <ui-grade-form>
          <ui-campo rotulo="Título" [obrigatorio]="true" [largo]="true" placeholder="Ex.: reunião de apresentação"
            [(valor)]="titulo" [erro]="erros().titulo ?? null" />
          @if (contatoId()) {
            <p class="contato-fixo largo">Contato: <strong>{{ contatoNome() || 'selecionado' }}</strong></p>
          } @else {
            <ui-select-paginado rotulo="Contato" placeholder="Busque por nome ou telefone" [largo]="true"
              [carregar]="buscarContatos" [ngModel]="contato()" (ngModelChange)="contato.set($event ?? '')" name="contato" />
          }
          <ui-campo rotulo="Data" tipo="date" [obrigatorio]="true" [(valor)]="data" [erro]="erros().data ?? null" />
          <ui-select rotulo="Tipo" [opcoes]="tipos" [(valor)]="tipo" />
          <ui-campo rotulo="Início" tipo="time" [obrigatorio]="true" [(valor)]="inicio" [erro]="erros().inicio ?? null" />
          <ui-campo rotulo="Fim" tipo="time" [obrigatorio]="true" [(valor)]="fim" [erro]="erros().fim ?? null" />
          <ui-select rotulo="Modalidade" [opcoes]="modalidades" [(valor)]="modalidade" />
          <ui-select rotulo="Lembrete" [opcoes]="lembretes" [(valor)]="lembrete" />
          <ui-campo rotulo="Local" [(valor)]="local" placeholder="Endereço ou sala" />
          <ui-campo rotulo="Link"  [(valor)]="link" placeholder="https://" [erro]="erros().link ?? null" />
          <ui-select rotulo="Cor" [opcoes]="cores" [(valor)]="cor" />
          <ui-select rotulo="Responsável" placeholder="Eu (padrão)" [opcoes]="equipe()" [(valor)]="responsavel" />
          <ui-campo rotulo="Descrição" tipo="textarea" [largo]="true" [(valor)]="descricao" />
        </ui-grade-form>
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-evento" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Criar evento' }}
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
export class AgendaEventoModalComponente {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  readonly aberto = input(false)
  /** Data (YYYY-MM-DD) sugerida ao abrir — o dia selecionado no calendário. */
  readonly dataInicial = input('')
  /** Contato fixo (ficha). Sem ele, o modal mostra a busca. */
  readonly contatoId = input<string | null>(null)
  readonly contatoNome = input<string | null>(null)
  /** Equipe para o seletor de responsável (só gestor/admin conseguem agendar para outro; a API confere). */
  readonly equipe = input<OpcaoSelect[]>([])
  readonly criado = output<string>()
  readonly fechar = output<void>()

  protected readonly tipos = OPCOES_TIPO_EVENTO as OpcaoSelect[]
  protected readonly modalidades = OPCOES_MODALIDADE as OpcaoSelect[]
  protected readonly lembretes = OPCOES_LEMBRETE as OpcaoSelect[]
  protected readonly cores = OPCOES_COR as OpcaoSelect[]

  protected readonly titulo = signal('')
  protected readonly descricao = signal('')
  protected readonly contato = signal('')
  protected readonly data = signal('')
  protected readonly inicio = signal('09:00')
  protected readonly fim = signal('10:00')
  protected readonly tipo = signal('reuniao')
  protected readonly modalidade = signal('presencial')
  protected readonly local = signal('')
  protected readonly link = signal('')
  protected readonly lembrete = signal('15')
  protected readonly cor = signal('acao')
  protected readonly responsavel = signal('')
  protected readonly erros = signal<ErrosEvento>({})
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly salvando = signal(false)

  constructor() {
    // Ao abrir: formulário limpo, na data sugerida.
    effect(() => {
      if (!this.aberto()) return
      const data = this.dataInicial()
      untracked(() => {
        const v = formVazio(data)
        this.titulo.set(v.titulo); this.descricao.set(v.descricao); this.contato.set(''); this.data.set(v.data)
        this.inicio.set(v.inicio); this.fim.set(v.fim); this.tipo.set(v.tipo); this.modalidade.set(v.modalidade)
        this.local.set(v.local); this.link.set(v.link); this.lembrete.set(v.lembrete); this.cor.set(v.cor)
        this.responsavel.set(''); this.erros.set({}); this.erroGeral.set(null)
      })
    })
  }

  protected readonly buscarContatos: CarregarOpcoes = async (_cursor, termo) => {
    // A busca devolve os 20 melhores (sem cursor): uma página só.
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
      titulo: this.titulo(), descricao: this.descricao(), contatoId: this.contatoId() ?? this.contato(), data: this.data(),
      inicio: this.inicio(), fim: this.fim(), tipo: this.tipo(), modalidade: this.modalidade(), local: this.local(),
      link: this.link(), lembrete: this.lembrete(), cor: this.cor(), responsavelId: this.responsavel(),
    }
    const erros = validarEvento(form)
    this.erros.set(erros)
    const corpo = payloadEvento(form)
    if (Object.keys(erros).length > 0 || !corpo) return
    this.salvando.set(true); this.erroGeral.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/agenda/eventos', corpo))
      this.toast.sucesso('Evento criado')
      this.criado.emit(r.id)
    } catch (e) { this.erroGeral.set(textoDoConflito(corpoDoErro(e)) ?? mensagemDeErro(e, 'Não foi possível criar o evento.')) }
    finally { this.salvando.set(false) }
  }
}
