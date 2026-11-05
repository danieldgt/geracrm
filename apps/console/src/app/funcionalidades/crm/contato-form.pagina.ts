import { ChangeDetectionStrategy, Component, computed, inject, input, signal, type OnInit } from '@angular/core'
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms'
import { Router, RouterLink } from '@angular/router'
import {
  BotaoComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, EsqueletoComponente,
  EstadoComponente, FormPaginaComponente, GradeFormComponente, SecaoFormComponente, SelectComponente,
  ToastServico, type ItemTrilha, type OpcaoSelect, focarPrimeiroInvalido,
} from '../../compartilhado/ui/index.js'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { ClientesServico } from './clientes.servico.js'
import { ContatoFormServico } from './contato-form.servico.js'
import {
  OPCOES_MODALIDADE, OPCOES_PRIORIDADE, OPCOES_TEMPERATURA, UFS, estadoOrigem, formDaFicha, formVazio,
  mensagemConsulta, montarPayload, opcoesOrigem, ordenarOrigens, podeConsultarCep, podeConsultarCnpj,
  preencherEndereco, preencherPelaEmpresa, validarLocal,
  type ErrosForm, type OrigemLista, type StatusOrigens, type ValoresContatoForm,
} from './contato-form.regras.js'

type Acao = 'salvar' | 'outro' | 'conversar'

const OPCOES_UF: OpcaoSelect[] = UFS.map((u) => ({ valor: u, rotulo: u }))

/**
 * Cadastro/edição de contato — formulário-página (padrão F).
 *
 * ⚠️ A API é a fonte de verdade da validação: o 422 chega POR CAMPO e é pintado
 * no campo certo. Aqui só se barra o óbvio (nome e telefone em branco). A regra
 * de montar payload / mapear erro / preencher pela consulta mora em
 * `contato-form.regras.ts`.
 */
@Component({
  selector: 'app-contato-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule, BotaoComponente, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente,
    EsqueletoComponente, EstadoComponente, FormPaginaComponente, GradeFormComponente, SecaoFormComponente,
    SelectComponente, RouterLink,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="editando() ? 'Editar contato' : 'Novo contato'"
                       subtitulo="Só nome e telefone são obrigatórios — o resto ajuda a vender melhor.">
      <ui-breadcrumb trilha [itens]="trilha()" />
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="esqueleto" aria-busy="true" aria-label="Carregando contato">
          @for (i of [1, 2, 3, 4, 5, 6]; track i) { <ui-esqueleto altura="40px" /> }
        </div>
      }
      @case ('erro') {
        <ui-estado tipo="erro" [titulo]="erroCarga()">
          <ui-botao variante="primario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado>
      }
      @case ('pronto') {
        <form [formGroup]="form" (ngSubmit)="salvar('salvar')" novalidate>
          <ui-form-pagina [titulo]="editando() ? 'Editar contato' : 'Cadastrar contato'">
            <ui-secao-form titulo="Dados principais">
              <ui-grade-form>
                <ui-campo [largo]="true" rotulo="Nome" formControlName="nome" [obrigatorio]="true" [erro]="erros().nome ?? null"
                          autocomplete="off" />
                <ui-campo rotulo="Razão social" formControlName="razaoSocial" [erro]="erros().razaoSocial ?? null" />
                <ui-campo rotulo="Nome fantasia" formControlName="nomeFantasia" [erro]="erros().nomeFantasia ?? null" />
                <ui-campo rotulo="E-mail" tipo="email" formControlName="email" [erro]="erros().email ?? null"
                          autocomplete="off" />
                <ui-campo rotulo="Telefone" tipo="tel" mascara="telefone" formControlName="telefone" [obrigatorio]="true"
                          placeholder="(81) 99999-9999" [erro]="erros().telefone ?? null" />
                <ui-select rotulo="WhatsApp" placeholder="Selecione" [opcoes]="opcoesWhatsapp" [valor]="whatsappTexto()"
                           (valorChange)="definirWhatsapp($event)"
                           dica="Este telefone recebe mensagens no WhatsApp?" />
                <ui-campo rotulo="CNPJ / CPF" mascara="cpfCnpj" formControlName="documento" [erro]="erroDocumento()"
                          [dica]="mensagemCnpj() ?? ''">
                  <ui-botao acao variante="secundario" [carregando]="consultandoCnpj()"
                            [desabilitado]="!podeCnpj()" (click)="consultarCnpj()">Consultar</ui-botao>
                </ui-campo>
              </ui-grade-form>
            </ui-secao-form>

            <ui-secao-form titulo="Endereço">
              <ui-grade-form>
                <ui-campo rotulo="CEP" mascara="cep" formControlName="cep" placeholder="00000-000"
                          [erro]="erros().cep ?? null" [dica]="mensagemCep() ?? ''" (focusout)="aoSairCep()" />
                <ui-campo [largo]="true" rotulo="Logradouro" formControlName="logradouro" [erro]="erros().logradouro ?? null" />
                <ui-campo rotulo="Número" formControlName="numero" [erro]="erros().numero ?? null" />
                <ui-campo rotulo="Complemento" formControlName="complemento" [erro]="erros().complemento ?? null" />
                <ui-campo rotulo="Bairro" formControlName="bairro" [erro]="erros().bairro ?? null" />
                <ui-campo rotulo="Cidade" formControlName="cidade" [erro]="erros().cidade ?? null" />
                <ui-select rotulo="UF" formControlName="uf" [opcoes]="opcoesUf" [erro]="erros().uf ?? null" />
              </ui-grade-form>
            </ui-secao-form>

            <ui-secao-form titulo="Classificação">
              <ui-grade-form>
                <div class="campo-origem">
                  <ui-select rotulo="Origem" formControlName="origemId" [opcoes]="opcoesSelectOrigem()"
                             [desabilitado]="estadoSelectOrigem().desabilitado"
                             [placeholder]="estadoSelectOrigem().placeholder" [dica]="estadoSelectOrigem().dica"
                             [erro]="erros().origemId ?? null" />
                  @if (estadoSelectOrigem().linkCadastro) {
                    <a class="link-origens" routerLink="/etiquetas-origens">Cadastrar origens</a>
                  }
                </div>
                <ui-select rotulo="Prioridade" formControlName="prioridade" [opcoes]="opcoesPrioridade"
                           [erro]="erros().prioridade ?? null" />
                <ui-select rotulo="Temperatura" formControlName="temperatura" [opcoes]="opcoesTemperatura"
                           [erro]="erros().temperatura ?? null" />
                <ui-select rotulo="Modalidade" formControlName="modalidade" [opcoes]="opcoesModalidade"
                           [erro]="erros().modalidade ?? null" />
                <ui-campo rotulo="Valor estimado" tipo="dinheiro" formControlName="valorEstimadoCentavos"
                          placeholder="0,00" [erro]="erros().valorEstimadoCentavos ?? null" />
              </ui-grade-form>
            </ui-secao-form>

            <ui-secao-form titulo="Observações">
              <ui-grade-form>
                <ui-campo [largo]="true" tipo="textarea" rotulo="Observações" formControlName="observacoes"
                          [erro]="erros().observacoes ?? null" />
              </ui-grade-form>
            </ui-secao-form>

            @if (erroGeral(); as g) { <p class="erro-geral" role="alert">{{ g }}</p> }

            <div rodape class="rodape">
              <ui-botao variante="secundario" (click)="voltar()" [desabilitado]="salvando() !== null">Voltar</ui-botao>
              @if (!editando()) {
                <ui-botao variante="secundario" (click)="salvar('conversar')" [desabilitado]="salvando() !== null"
                          [carregando]="salvando() === 'conversar'">Salvar e conversar</ui-botao>
                <ui-botao variante="secundario" (click)="salvar('outro')" [desabilitado]="salvando() !== null"
                          [carregando]="salvando() === 'outro'">Salvar e criar outro</ui-botao>
              }
              <ui-botao variante="primario" tipo="submit" [desabilitado]="salvando() !== null"
                        [carregando]="salvando() === 'salvar'">Salvar</ui-botao>
            </div>
          </ui-form-pagina>
        </form>
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    .esqueleto { display: grid; gap: var(--espacamento-4); max-width: 960px; }
    .erro-geral { margin: 0; color: var(--erro); font-size: 13px; }
    .rodape { display: contents; }
    .campo-origem { display: grid; gap: var(--espacamento-2); align-content: start; }
    .link-origens { color: var(--acao); font-size: 13px; text-decoration: none; }
    @media (max-width: 480px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class ContatoFormPagina implements OnInit {
  /** `id` da rota (`contato/:id/editar`); ausente = criação. */
  readonly id = input<string | undefined>(undefined)

  private readonly servico = inject(ContatoFormServico)
  private readonly clientes = inject(ClientesServico)
  private readonly inbox = inject(InboxServico)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastServico)

  readonly opcoesUf = OPCOES_UF
  readonly opcoesPrioridade = OPCOES_PRIORIDADE
  readonly opcoesTemperatura = OPCOES_TEMPERATURA
  readonly opcoesModalidade = OPCOES_MODALIDADE
  readonly opcoesWhatsapp: OpcaoSelect[] = [{ valor: 'sim', rotulo: 'Sim' }, { valor: 'nao', rotulo: 'Não' }]

  readonly editando = computed(() => !!this.id())
  readonly trilha = computed<ItemTrilha[]>(() => [
    { rotulo: 'Contatos', rota: '/contatos' },
    ...(this.editando()
      ? [{ rotulo: 'Contato', rota: `/contato/${this.id()}` }, { rotulo: 'Editar' }]
      : [{ rotulo: 'Novo contato' }]),
  ])

  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  /** Origens ativas (ordenadas) e, na edição, a origem atual se estiver inativa. */
  readonly statusOrigens = signal<StatusOrigens>('carregando')
  private readonly origensAtivas = signal<OrigemLista[]>([])
  private readonly origemAtual = signal<OrigemLista | null>(null)
  readonly opcoesSelectOrigem = computed(() => opcoesOrigem(this.origensAtivas(), this.origemAtual()))
  readonly estadoSelectOrigem = computed(() => estadoOrigem(this.statusOrigens(), this.origensAtivas().length))
  readonly erroCarga = signal('')
  readonly erros = signal<ErrosForm>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal<Acao | null>(null)
  readonly consultandoCnpj = signal(false)
  readonly mensagemCnpj = signal<string | null>(null)
  readonly mensagemCep = signal<string | null>(null)
  readonly whatsapp = signal(true)
  readonly whatsappTexto = computed(() => (this.whatsapp() ? 'sim' : 'nao'))
  /** Habilita o botão Consultar conforme o documento digitado; atualizado a cada edição. */
  readonly podeCnpj = signal(false)
  /** CEP já consultado, para não repetir ao sair do campo sem mudar. */
  private ultimoCepConsultado = ''

  readonly form = new FormGroup({
    nome: new FormControl<string | null>(''),
    razaoSocial: new FormControl<string | null>(''),
    nomeFantasia: new FormControl<string | null>(''),
    email: new FormControl<string | null>(''),
    telefone: new FormControl<string | null>(''),
    documento: new FormControl<string | null>(''),
    cep: new FormControl<string | null>(''),
    logradouro: new FormControl<string | null>(''),
    numero: new FormControl<string | null>(''),
    complemento: new FormControl<string | null>(''),
    bairro: new FormControl<string | null>(''),
    cidade: new FormControl<string | null>(''),
    uf: new FormControl<string | null>(''),
    modalidade: new FormControl<string | null>(''),
    prioridade: new FormControl<string | null>(''),
    temperatura: new FormControl<string | null>(''),
    origemId: new FormControl<string | null>(''),
    valorEstimadoCentavos: new FormControl<number | null>(null),
    observacoes: new FormControl<string | null>(''),
  })

  /** Erro do documento: o da API; sem ele, nada. */
  readonly erroDocumento = computed(() => this.erros().documento ?? null)

  constructor() {
    this.form.controls.documento.valueChanges.subscribe((v) => this.podeCnpj.set(podeConsultarCnpj(v ?? '')))
  }

  ngOnInit(): void {
    void this.carregar()
  }

  async carregar(): Promise<void> {
    const id = this.id()
    if (!id) { this.aplicar(formVazio()); this.estado.set('pronto'); void this.carregarOrigens(null); return }
    this.estado.set('carregando')
    const r = await this.servico.carregar(id)
    if (!r.ok) { this.erroCarga.set(r.mensagem); this.estado.set('erro'); return }
    this.aplicar(formDaFicha(r.ficha))
    this.estado.set('pronto')
    void this.carregarOrigens(r.ficha.origemId)
  }

  /**
   * Origens ativas (até 5 páginas). Se o contato aponta para uma origem inativa, busca
   * a lista completa só para achar o nome dela — assim a edição não abre com o select vazio.
   */
  private async carregarOrigens(origemAtualId: string | null): Promise<void> {
    this.statusOrigens.set('carregando')
    const ativas = await this.servico.origens(true)
    if (!ativas.ok) { this.statusOrigens.set('erro'); return }
    this.origensAtivas.set(ordenarOrigens(ativas.itens))
    this.statusOrigens.set('pronto')
    if (!origemAtualId || ativas.itens.some((o) => o.id === origemAtualId)) { this.origemAtual.set(null); return }
    const todas = await this.servico.origens(false)
    const achada = todas.ok ? todas.itens.find((o) => o.id === origemAtualId) : undefined
    this.origemAtual.set(achada ?? { id: origemAtualId, nome: 'Origem sem nome', ativa: false, ordem: 0 })
  }

  definirWhatsapp(v: string): void { this.whatsapp.set(v !== 'nao') }

  voltar(): void {
    void this.router.navigateByUrl(this.editando() ? `/contato/${this.id()}` : '/contatos')
  }

  async consultarCnpj(): Promise<void> {
    const v = this.valores()
    if (!podeConsultarCnpj(v.documento) || this.consultandoCnpj()) return
    this.consultandoCnpj.set(true)
    this.mensagemCnpj.set(null)
    const r = await this.servico.consultarCnpj(v.documento)
    this.consultandoCnpj.set(false)
    if (!r.ok) { this.mensagemCnpj.set(mensagemConsulta(r.codigo, 'CNPJ')); return }
    this.aplicar(preencherPelaEmpresa(this.valores(), r.dado))
    this.ultimoCepConsultado = this.valores().cep.replace(/\D/g, '')
    this.limparErro('documento')
  }

  /** Ao sair do CEP, completa logradouro/bairro/cidade/UF — uma vez por CEP. */
  async aoSairCep(): Promise<void> {
    const cep = this.valores().cep
    const digitos = cep.replace(/\D/g, '')
    if (!podeConsultarCep(cep) || digitos === this.ultimoCepConsultado) return
    this.ultimoCepConsultado = digitos
    this.mensagemCep.set(null)
    const r = await this.servico.consultarCep(cep)
    if (!r.ok) { this.mensagemCep.set(mensagemConsulta(r.codigo, 'CEP')); return }
    this.aplicar(preencherEndereco(this.valores(), r.dado))
    this.limparErro('cep')
  }

  async salvar(acao: Acao): Promise<void> {
    if (this.salvando() !== null) return
    const v = this.valores()
    const locais = validarLocal(v)
    this.erroGeral.set(null)
    if (Object.keys(locais).length > 0) { this.erros.set(locais); return }
    this.erros.set({})
    this.salvando.set(acao)
    const corpo = montarPayload(v)
    const id = this.id()
    const r = id ? await this.servico.atualizar(id, corpo) : await this.servico.criar(corpo)
    this.salvando.set(null)
    if (!r.ok) { this.erros.set(r.campos); this.erroGeral.set(r.geral); focarPrimeiroInvalido(); return }

    if (id) {
      this.toast.sucesso('Contato atualizado.')
      void this.router.navigateByUrl(`/contato/${id}`)
    } else if (!r.novo) {
      this.toast.sucesso('Já existia um contato com este telefone — abrindo o cadastro dele.')
      void this.router.navigateByUrl(`/contato/${r.id}`)
    } else if (acao === 'outro') {
      this.toast.sucesso('Contato cadastrado.')
      this.reiniciar()
    } else {
      this.toast.sucesso('Contato cadastrado.')
      if (acao === 'conversar') {
        const conversaId = await this.clientes.iniciarConversa(r.id)
        if (conversaId) void this.inbox.abrir(conversaId)
      }
      void this.router.navigateByUrl(`/contato/${r.id}`)
    }
  }

  private reiniciar(): void {
    this.aplicar(formVazio())
    this.erros.set({})
    this.mensagemCnpj.set(null)
    this.mensagemCep.set(null)
    this.ultimoCepConsultado = ''
    this.origemAtual.set(null)
  }

  private limparErro(campo: keyof ValoresContatoForm): void {
    const resto = { ...this.erros() }
    delete resto[campo]
    this.erros.set(resto)
  }

  private valores(): ValoresContatoForm {
    const f = this.form.getRawValue()
    return {
      nome: f.nome ?? '', razaoSocial: f.razaoSocial ?? '', nomeFantasia: f.nomeFantasia ?? '', email: f.email ?? '',
      telefone: f.telefone ?? '', whatsapp: this.whatsapp(), documento: f.documento ?? '',
      cep: f.cep ?? '', logradouro: f.logradouro ?? '', numero: f.numero ?? '', complemento: f.complemento ?? '',
      bairro: f.bairro ?? '', cidade: f.cidade ?? '', uf: f.uf ?? '',
      modalidade: f.modalidade ?? '', prioridade: f.prioridade ?? '', temperatura: f.temperatura ?? '',
      origemId: f.origemId ?? '',
      valorEstimadoCentavos: f.valorEstimadoCentavos, observacoes: f.observacoes ?? '',
    }
  }

  private aplicar(v: ValoresContatoForm): void {
    const { whatsapp, ...resto } = v
    this.whatsapp.set(whatsapp)
    this.form.setValue(resto)
    this.podeCnpj.set(podeConsultarCnpj(v.documento))
  }
}
