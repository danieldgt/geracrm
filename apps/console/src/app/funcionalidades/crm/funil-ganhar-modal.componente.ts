import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { Router } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  BotaoComponente, CampoComponente, GradeFormComponente, ModalComponente, SelectComponente, ToastServico, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { FunilServico, type Card } from './funil.servico.js'
import { ContatoFormServico } from './contato-form.servico.js'
import { UFS, mensagemConsulta, podeConsultarCep, podeConsultarCnpj } from './contato-form.regras.js'
import {
  ganhoDaFicha, ganhoPelaEmpresa, ganhoPeloEndereco, ganhoVazio, mapearErrosGanho, payloadGanho, rotuloDoPedido,
  validarGanhoLocal, type ErrosGanho, type FichaParaGanho, type PedidoDoContato, type ValoresGanho,
} from './funil-acoes.regras.js'

/**
 * Modal "Ganhar" (padrão A). Ganhar exige CNPJ válido, razão social, nome fantasia e endereço completo:
 * os campos vêm pré-preenchidos com o que o contato já tem, "Consultar" completa pelo CNPJ e o CEP completa
 * o endereço ao sair. A API revalida (422 por campo vai para o campo). Cancelar não persiste nada.
 */
@Component({
  selector: 'app-funil-ganhar-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalComponente, GradeFormComponente, CampoComponente, SelectComponente, BotaoComponente],
  template: `
    <ui-modal [aberto]="card() !== null" titulo="Ganhar negócio" largura="m" (fechar)="cancelado.emit()">
      <form id="form-ganhar" (submit)="salvar($event)" novalidate>
        <p class="contato-fixo">Contato: <strong>{{ card()?.nome }}</strong></p>
        @if (carregando()) {
          <p class="dica-geral">Carregando os dados do contato…</p>
        }
        <ui-grade-form>
          <ui-campo rotulo="CNPJ" mascara="cnpj" [obrigatorio]="true" placeholder="00.000.000/0000-00"
            [valor]="v().cnpj" (valorChange)="definir('cnpj', $event)" [erro]="erros().cnpj ?? null"
            [dica]="mensagemCnpj() ?? ''">
            <ui-botao acao variante="secundario" [carregando]="consultandoCnpj()" [desabilitado]="!podeCnpj()"
              (click)="consultarCnpj()">Consultar</ui-botao>
          </ui-campo>
          <ui-campo rotulo="Razão social" [obrigatorio]="true" [valor]="v().razaoSocial"
            (valorChange)="definir('razaoSocial', $event)" [erro]="erros().razaoSocial ?? null" />
          <ui-campo rotulo="Nome fantasia" [obrigatorio]="true" [valor]="v().nomeFantasia"
            (valorChange)="definir('nomeFantasia', $event)" [erro]="erros().nomeFantasia ?? null" />
          <ui-campo rotulo="CEP" mascara="cep" [obrigatorio]="true" placeholder="00000-000" [valor]="v().cep"
            (valorChange)="definir('cep', $event)" [erro]="erros().cep ?? null" [dica]="mensagemCep() ?? ''"
            (focusout)="aoSairCep()" />
          <ui-campo [largo]="true" rotulo="Logradouro" [obrigatorio]="true" [valor]="v().logradouro"
            (valorChange)="definir('logradouro', $event)" [erro]="erros().logradouro ?? null" />
          <ui-campo rotulo="Número" [obrigatorio]="true" [valor]="v().numero"
            (valorChange)="definir('numero', $event)" [erro]="erros().numero ?? null" />
          <ui-campo rotulo="Complemento" [valor]="v().complemento" (valorChange)="definir('complemento', $event)" />
          <ui-campo rotulo="Bairro" [obrigatorio]="true" [valor]="v().bairro"
            (valorChange)="definir('bairro', $event)" [erro]="erros().bairro ?? null" />
          <ui-campo rotulo="Cidade" [obrigatorio]="true" [valor]="v().cidade"
            (valorChange)="definir('cidade', $event)" [erro]="erros().cidade ?? null" />
          <ui-select rotulo="UF" [obrigatorio]="true" [opcoes]="opcoesUf" [valor]="v().uf"
            (valorChange)="definir('uf', $event)" [erro]="erros().uf ?? null" />
        </ui-grade-form>

        <h3 class="secao txt-rotulo">Pedido</h3>
        <ui-grade-form>
          <ui-select rotulo="Vincular pedido existente" placeholder="Sem vínculo" [largo]="true"
            [opcoes]="opcoesPedido()" [valor]="pedidoId()" (valorChange)="pedidoId.set($event)"
            [desabilitado]="abrirPedido() || opcoesPedido().length === 0" [erro]="erroPedido()"
            [dica]="opcoesPedido().length === 0 ? 'Este contato ainda não tem pedidos.' : 'Os pedidos mais recentes do contato.'" />
        </ui-grade-form>
        <label class="marca">
          <input type="checkbox" [checked]="abrirPedido()" (change)="alternarAbrirPedido($any($event.target).checked)" />
          <span>Abrir pedido assistido depois de ganhar</span>
        </label>

        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="cancelado.emit()">Cancelar</button>
        <button type="submit" form="form-ganhar" class="btn btn--primario" [disabled]="salvando() || carregando()">
          {{ salvando() ? 'Salvando…' : 'Ganhar negócio' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .contato-fixo { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); font-size: 14px; }
    .contato-fixo strong { color: var(--texto); }
    .dica-geral { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .secao { margin: var(--espacamento-6) 0 var(--espacamento-3); }
    .marca { display: flex; align-items: center; gap: var(--espacamento-2); margin-top: var(--espacamento-3);
      font-size: 14px; color: var(--texto); cursor: pointer; }
    .marca input { width: 16px; height: 16px; accent-color: var(--acao); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class FunilGanharModalComponente {
  private readonly http = inject(HttpClient)
  private readonly funil = inject(FunilServico)
  private readonly consultas = inject(ContatoFormServico)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastServico)

  /** Card a ganhar; `null` = modal fechado. */
  readonly card = input<Card | null>(null)
  readonly concluido = output<void>()
  readonly cancelado = output<void>()

  protected readonly opcoesUf: OpcaoSelect[] = UFS.map((u) => ({ valor: u, rotulo: u }))
  protected readonly v = signal<ValoresGanho>(ganhoVazio())
  protected readonly erros = signal<ErrosGanho>({})
  protected readonly erroPedido = signal<string | null>(null)
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly carregando = signal(false)
  protected readonly salvando = signal(false)
  protected readonly consultandoCnpj = signal(false)
  protected readonly mensagemCnpj = signal<string | null>(null)
  protected readonly mensagemCep = signal<string | null>(null)
  protected readonly pedidos = signal<PedidoDoContato[]>([])
  protected readonly pedidoId = signal('')
  protected readonly abrirPedido = signal(false)
  protected readonly opcoesPedido = computed<OpcaoSelect[]>(() => this.pedidos().map((p) => ({ valor: p.id, rotulo: rotuloDoPedido(p) })))
  protected readonly podeCnpj = computed(() => podeConsultarCnpj(this.v().cnpj))
  private ultimoCep = ''

  constructor() {
    // Ao abrir (card novo): zera, pré-preenche pela ficha e carrega os pedidos do contato.
    effect(() => {
      const c = this.card()
      if (!c) return
      untracked(() => {
        this.v.set(ganhoVazio()); this.erros.set({}); this.erroPedido.set(null); this.erroGeral.set(null)
        this.mensagemCnpj.set(null); this.mensagemCep.set(null); this.pedidoId.set(''); this.abrirPedido.set(false)
        this.pedidos.set([]); this.ultimoCep = ''
        void this.carregarContato(c)
      })
    })
  }

  private async carregarContato(c: Card): Promise<void> {
    this.carregando.set(true)
    try {
      const [ficha, pedidos] = await Promise.all([
        firstValueFrom(this.http.get<FichaParaGanho>(`/v1/contatos/${c.contatoId}`)).catch(() => null),
        this.funil.pedidosDoContato(c.contatoId),
      ])
      if (this.card()?.id !== c.id) return // trocou de card enquanto carregava
      if (ficha) { this.v.set(ganhoDaFicha(ficha)); this.ultimoCep = this.v().cep.replace(/\D/g, '') }
      this.pedidos.set(pedidos)
    } finally { this.carregando.set(false) }
  }

  protected definir(campo: keyof ValoresGanho, valor: string): void {
    this.v.update((x) => ({ ...x, [campo]: valor }))
    if (campo !== 'complemento' && this.erros()[campo]) this.erros.update((e) => ({ ...e, [campo]: undefined }))
  }

  protected alternarAbrirPedido(marcado: boolean): void {
    this.abrirPedido.set(marcado)
    if (marcado) { this.pedidoId.set(''); this.erroPedido.set(null) }
  }

  protected async consultarCnpj(): Promise<void> {
    if (!this.podeCnpj() || this.consultandoCnpj()) return
    this.consultandoCnpj.set(true); this.mensagemCnpj.set(null)
    const r = await this.consultas.consultarCnpj(this.v().cnpj)
    this.consultandoCnpj.set(false)
    if (!r.ok) { this.mensagemCnpj.set(mensagemConsulta(r.codigo, 'CNPJ')); return }
    this.v.set(ganhoPelaEmpresa(this.v(), r.dado))
    this.ultimoCep = this.v().cep.replace(/\D/g, '')
    this.erros.set({})
  }

  /** Ao sair do CEP, completa logradouro/bairro/cidade/UF — uma vez por CEP. */
  protected async aoSairCep(): Promise<void> {
    const cep = this.v().cep
    const digitos = cep.replace(/\D/g, '')
    if (!podeConsultarCep(cep) || digitos === this.ultimoCep) return
    this.ultimoCep = digitos; this.mensagemCep.set(null)
    const r = await this.consultas.consultarCep(cep)
    if (!r.ok) { this.mensagemCep.set(mensagemConsulta(r.codigo, 'CEP')); return }
    this.v.set(ganhoPeloEndereco(this.v(), r.dado))
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const c = this.card()
    if (!c || this.salvando()) return
    const locais = validarGanhoLocal(this.v())
    this.erroGeral.set(null); this.erroPedido.set(null)
    this.erros.set(locais)
    if (Object.keys(locais).length > 0) return
    this.salvando.set(true)
    const r = await this.funil.ganhar(c.id, payloadGanho(this.v(), c.versao, this.pedidoId()))
    this.salvando.set(false)
    if (!r.ok) {
      const m = r.status === 422 ? mapearErrosGanho(r.corpo) : { campos: {}, pedido: null, geral: null }
      this.erros.set(m.campos); this.erroPedido.set(m.pedido)
      const temCampo = Object.keys(m.campos).length > 0 || m.pedido !== null
      this.erroGeral.set(m.geral ?? (temCampo ? null : r.mensagem))
      // 409 (alguém moveu) já recarregou o quadro: o card mudou de versão, então o modal fecha.
      if (r.status === 409) this.cancelado.emit()
      return
    }
    this.toast.sucesso('Negócio ganho')
    if (this.abrirPedido()) void this.router.navigate(['/pedido'], { queryParams: { contato: c.contatoId } })
    this.concluido.emit()
  }
}
