import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, EstadoComponente, PaginacaoComponente, TabelaComponente, CelulaDiretiva,
  mensagemDeErro, mesclarPagina, type ColunaTabela,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico, type TarefaDoContato } from './ficha-blocos.servico.js'
import { rotuloTipoTarefa } from './tarefas.regras.js'

/** Aba Tarefas: as tarefas DESTE contato (cursor) + "Nova tarefa" (o modal é do pai). Estado próprio. */
@Component({
  selector: 'app-ficha-tarefas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, EstadoComponente, PaginacaoComponente, TabelaComponente, CelulaDiretiva],
  template: `
    <div class="topo">
      <ui-botao variante="primario" (click)="nova.emit()">Nova tarefa</ui-botao>
    </div>
    @if (estado() === 'erro') {
      <ui-estado tipo="erro" titulo="Não foi possível carregar as tarefas" [descricao]="erro()">
        <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
      </ui-estado>
    } @else {
      <ui-tabela [colunas]="colunas" [linhas]="itens()" [carregando]="estado() === 'carregando'">
        <ng-template uiCelula="titulo" let-t>
          <span class="tit">{{ t.titulo }}</span>
          @if (t.resultado) { <span class="res">{{ t.resultado }}</span> }
        </ng-template>
        <ng-template uiCelula="tipo" let-t>{{ rotuloTipo(t.tipo) }}</ng-template>
        <ng-template uiCelula="venceEm" let-t><span [class.atrasada]="t.vencida">{{ t.venceEm | date: 'dd/MM/yyyy HH:mm' }}</span></ng-template>
        <ng-template uiCelula="responsavel" let-t>{{ t.responsavel ?? '—' }}</ng-template>
        <ng-template uiCelula="estado" let-t>
          <ui-badge [tom]="t.estado === 'concluida' ? 'sucesso' : t.vencida ? 'erro' : 'neutro'">{{ t.estado === 'concluida' ? 'Concluída' : t.vencida ? 'Atrasada' : 'Aberta' }}</ui-badge>
        </ng-template>
        <div uiVazio>
          <ui-estado titulo="Nenhuma tarefa" descricao="Crie um follow-up para não deixar este contato esfriar." icone="check-square" />
        </div>
      </ui-tabela>
      @if (estado() === 'pronto') {
        <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximo()" [carregando]="carregandoMais()" (mais)="mais()" />
      }
    }
  `,
  styles: `
    :host { display: block; }
    .topo { display: flex; justify-content: flex-end; margin-bottom: var(--espacamento-3); }
    .tit { color: var(--texto); }
    .res { display: block; max-width: 36ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--texto-suave); font-size: 12px; }
    .atrasada { color: var(--erro); }
  `,
})
export class FichaTarefasComponente {
  private readonly blocos = inject(FichaBlocosServico)
  readonly contatoId = input.required<string>()
  /** Muda quando uma tarefa foi criada fora da aba (cabeçalho). */
  readonly versao = input(0)
  readonly nova = output<void>()
  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  readonly itens = signal<readonly TarefaDoContato[]>([])
  readonly proximo = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly colunas: readonly ColunaTabela[] = [
    { chave: 'titulo', rotulo: 'Tarefa' },
    { chave: 'tipo', rotulo: 'Tipo' },
    { chave: 'venceEm', rotulo: 'Vence', mono: true },
    { chave: 'responsavel', rotulo: 'Responsável' },
    { chave: 'estado', rotulo: 'Situação' },
  ]
  readonly rotuloTipo = rotuloTipoTarefa

  constructor() {
    effect(() => { this.contatoId(); this.versao(); untracked(() => { void this.carregar() }) })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const p = await this.blocos.tarefas(this.contatoId(), null)
      this.itens.set(p.itens); this.proximo.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }

  async mais(): Promise<void> {
    const cursor = this.proximo()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const p = await this.blocos.tarefas(this.contatoId(), cursor)
      this.itens.update((a) => mesclarPagina(a, p.itens, (x) => x.id))
      this.proximo.set(p.proximoCursor)
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar mais tarefas.'))
      this.estado.set('erro')
    } finally {
      this.carregandoMais.set(false)
    }
  }
}
