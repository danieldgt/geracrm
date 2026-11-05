import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { MOTIVOS_DESCARTE_CONTATO, type AcaoEmMassaContato } from '@geracrm/shared'
import {
  CampoComponente, ChipsEtiquetaComponente, GradeFormComponente, ModalComponente, SelectComponente,
  type OpcaoChip, type OpcaoSelect, focarPrimeiroInvalido,
} from '../../compartilhado/ui/index.js'
import { ClientesServico, ErroAcaoEmMassa, type ResultadoAcaoEmMassa } from './clientes.servico.js'
import {
  ACAO_SEM_FORMULARIO, FORM_ACAO_VAZIO, TITULO_ACAO, corpoDaAcao, validarAcao, type ErrosAcao, type FormAcao,
} from './clientes.regras.js'
import { OPCOES_TIPO_TAREFA } from './tarefas.regras.js'

/** Campos da API que o formulário sabe mostrar (422 com `campos`). */
const CAMPO_DO_FORM: Record<string, keyof ErrosAcao> = {
  motivo: 'motivo', observacao: 'observacao', usuarioId: 'usuarioId', etiquetaIds: 'etiquetaIds',
  listaId: 'listaId', titulo: 'titulo', venceEm: 'data',
}

/**
 * Modal único das ações em massa da lista de Contatos (A2): cada ação mostra só o seu
 * formulário, valida com `validarAcao` (a API continua sendo a regra) e chama
 * `POST /v1/contatos/acoes-em-massa/:acao`. Emite `concluida` com `{aplicados, ignorados}`;
 * o pai fecha, recarrega e limpa a seleção.
 */
@Component({
  selector: 'app-clientes-acao-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalComponente, GradeFormComponente, CampoComponente, SelectComponente, ChipsEtiquetaComponente],
  template: `
    <ui-modal [aberto]="!!acao()" [titulo]="titulo()" largura="m" (fechar)="fechar.emit()">
      <form id="form-acao-contatos" (submit)="enviar($event)" novalidate>
        <p class="resumo">{{ resumo() }}</p>
        @switch (acao()) {
          @case ('descartar') {
            <ui-grade-form>
              <ui-select rotulo="Motivo" [obrigatorio]="true" [largo]="true" placeholder="Escolha o motivo"
                [opcoes]="motivos" [(valor)]="motivo" [erro]="erros().motivo ?? null" />
              <ui-campo rotulo="Observação" tipo="textarea" [obrigatorio]="true" [largo]="true"
                dica="Fica como nota no contato." [(valor)]="observacao" [erro]="erros().observacao ?? null" />
            </ui-grade-form>
          }
          @case ('transferir') {
            <ui-grade-form>
              <ui-select rotulo="Novo vendedor" [obrigatorio]="true" [largo]="true" placeholder="Escolha o vendedor"
                [opcoes]="servico.equipe()" [(valor)]="usuarioId" [erro]="erros().usuarioId ?? null" />
              <ui-campo rotulo="Motivo" [obrigatorio]="true" [largo]="true" placeholder="Ex.: redistribuição da carteira"
                [(valor)]="motivo" [erro]="erros().motivo ?? null" />
            </ui-grade-form>
          }
          @case ('etiquetar') {
            @if (opcoesEtiqueta().length === 0) {
              <p class="vazio">Nenhuma etiqueta ativa. Cadastre em Etiquetas e origens.</p>
            } @else {
              <ui-chips-etiqueta [opcoes]="opcoesEtiqueta()" [(selecionadas)]="etiquetaIds" />
            }
            @if (erros().etiquetaIds; as e) { <p class="erro" role="alert">{{ e }}</p> }
          }
          @case ('adicionar-lista') {
            <ui-grade-form>
              <ui-select rotulo="Lista" [obrigatorio]="true" [largo]="true" placeholder="Escolha a lista"
                [opcoes]="servico.listas()" [(valor)]="listaId" [erro]="erros().listaId ?? null" />
            </ui-grade-form>
          }
          @case ('criar-tarefa') {
            <ui-grade-form>
              <ui-select rotulo="Tipo" [opcoes]="tipos" [(valor)]="tipo" />
              <ui-select rotulo="Responsável" placeholder="Eu (padrão)" [opcoes]="servico.equipe()" [(valor)]="responsavelId" />
              <ui-campo rotulo="Título" [obrigatorio]="true" [largo]="true" placeholder="Ex.: reativar cliente"
                [(valor)]="tituloTarefa" [erro]="erros().titulo ?? null" />
              <ui-campo rotulo="Data" tipo="date" [obrigatorio]="true" [(valor)]="data" [erro]="erros().data ?? null" />
              <ui-campo rotulo="Hora" tipo="time" [obrigatorio]="true" [(valor)]="hora" [erro]="erros().hora ?? null" />
              <ui-campo rotulo="Descrição" tipo="textarea" [largo]="true" [(valor)]="descricao" />
            </ui-grade-form>
          }
        }
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-acao-contatos" class="btn btn--primario" [disabled]="servico.aplicando()">
          {{ servico.aplicando() ? 'Aplicando…' : rotuloConfirmar() }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .resumo { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 14px; }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .vazio { margin: 0; color: var(--texto-secundario); }
  `,
})
export class ClientesAcaoModalComponente {
  protected readonly servico = inject(ClientesServico)

  /** Ação aberta; null = modal fechado. */
  readonly acao = input<AcaoEmMassaContato | null>(null)
  readonly contatoIds = input<readonly string[]>([])
  readonly concluida = output<ResultadoAcaoEmMassa>()
  readonly fechar = output<void>()

  protected readonly motivos: OpcaoSelect[] = MOTIVOS_DESCARTE_CONTATO.map((m) => ({ valor: m.codigo, rotulo: m.rotulo }))
  protected readonly tipos: OpcaoSelect[] = OPCOES_TIPO_TAREFA.map((o) => ({ valor: o.valor, rotulo: o.rotulo }))

  protected readonly motivo = signal('')
  protected readonly observacao = signal('')
  protected readonly usuarioId = signal('')
  protected readonly etiquetaIds = signal<string[]>([])
  protected readonly listaId = signal('')
  protected readonly tituloTarefa = signal('')
  protected readonly tipo = signal('outro')
  protected readonly data = signal('')
  protected readonly hora = signal('09:00')
  protected readonly responsavelId = signal('')
  protected readonly descricao = signal('')
  protected readonly erros = signal<ErrosAcao>({})
  protected readonly erroGeral = signal<string | null>(null)

  protected readonly opcoesEtiqueta = computed<OpcaoChip[]>(() =>
    this.servico.etiquetas().map((e) => ({ valor: e.valor, rotulo: e.rotulo, cor: e.cor })))
  protected readonly titulo = computed(() => {
    const a = this.acao()
    return a ? TITULO_ACAO[a] : ''
  })
  protected readonly resumo = computed(() => {
    const n = this.contatoIds().length
    const quem = n === 1 ? '1 contato selecionado' : `${n.toLocaleString('pt-BR')} contatos selecionados`
    return ACAO_SEM_FORMULARIO(this.acao() ?? 'qualificar') ? `${TITULO_ACAO[this.acao() ?? 'qualificar']}: ${quem}.` : `${quem}.`
  })
  protected readonly rotuloConfirmar = computed(() => {
    switch (this.acao()) {
      case 'descartar': return 'Descartar'
      case 'transferir': return 'Transferir'
      case 'etiquetar': return 'Etiquetar'
      case 'adicionar-lista': return 'Adicionar'
      case 'criar-tarefa': return 'Criar tarefas'
      case 'reabrir': return 'Reabrir'
      default: return 'Qualificar'
    }
  })

  constructor() {
    // Ao abrir: formulário limpo e catálogos carregados (uma vez).
    effect(() => {
      if (!this.acao()) return
      untracked(() => {
        this.motivo.set(''); this.observacao.set(''); this.usuarioId.set(''); this.etiquetaIds.set([])
        this.listaId.set(''); this.tituloTarefa.set(''); this.tipo.set('outro'); this.data.set('')
        this.hora.set('09:00'); this.responsavelId.set(''); this.descricao.set('')
        this.erros.set({}); this.erroGeral.set(null)
        void this.servico.carregarCatalogos()
      })
    })
  }

  private formulario(): FormAcao {
    return {
      ...FORM_ACAO_VAZIO, motivo: this.motivo(), observacao: this.observacao(), usuarioId: this.usuarioId(),
      etiquetaIds: this.etiquetaIds(), listaId: this.listaId(), titulo: this.tituloTarefa(), tipo: this.tipo(),
      data: this.data(), hora: this.hora(), responsavelId: this.responsavelId(), descricao: this.descricao(),
    }
  }

  protected async enviar(ev: Event): Promise<void> {
    ev.preventDefault()
    const acao = this.acao()
    if (!acao || this.servico.aplicando()) return
    const form = this.formulario()
    const erros = validarAcao(acao, form)
    this.erros.set(erros)
    const corpo = corpoDaAcao(acao, this.contatoIds(), form)
    if (Object.keys(erros).length > 0 || !corpo) return
    this.erroGeral.set(null)
    try {
      this.concluida.emit(await this.servico.acaoEmMassa(acao, corpo))
    } catch (e) {
      if (e instanceof ErroAcaoEmMassa) {
        const porCampo: Record<string, string> = {}
        for (const c of e.campos) { const k = CAMPO_DO_FORM[c]; if (k) porCampo[k] = e.message }
        if (Object.keys(porCampo).length > 0) { this.erros.set(porCampo); focarPrimeiroInvalido() }
        else this.erroGeral.set(e.message)
      } else this.erroGeral.set('Não foi possível aplicar a ação.')
    }
  }
}
