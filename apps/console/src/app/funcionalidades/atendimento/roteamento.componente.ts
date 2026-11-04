import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import type { NumeroRoteamento, SimulacaoRoteamento } from '@geracrm/shared'
import {
  BadgeComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, GradeFormComponente,
  ModalComponente, PaginacaoComponente, PainelComponente, SelectComponente, SelectPaginadoComponente, TabelaComponente,
  ToastServico, codigoDoErro, corpoDoErro, ehStatus, mensagemDeErro, mesclarPagina,
  type CarregarOpcoes, type ColunaTabela, type LinhaTabela, type OpcaoPaginada, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { EtiquetasServico } from '../crm/etiquetas.servico.js'
import {
  FORM_REGRA_VAZIO, ROTULO_TIPO_REGRA, TIPOS_REGRA_ROTEAMENTO, descreverSimulacao, formDaRegra, mapearErroRoteamento,
  montarPayloadRegra, rotuloNumero, rotuloValor, validarFormRegra, type CampoRegra, type FormRegra, type RegraRoteamento,
} from './roteamento.regras.js'
import { RoteamentoServico, type FilialOpcao } from './roteamento.servico.js'

type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
const OPCOES_TIPO: OpcaoSelect[] = TIPOS_REGRA_ROTEAMENTO.map((t) => ({ valor: t, rotulo: ROTULO_TIPO_REGRA[t] }))
const OPCOES_SITUACAO: OpcaoSelect[] = [{ valor: 'true', rotulo: 'Ativa' }, { valor: 'false', rotulo: 'Inativa' }]

/**
 * ROTEAMENTO (raia G4) — aba de Config. do Canal. Padrão L + M:
 *   1. Regras: tabela (tipo, valor, filial, número, prioridade, situação) por cursor + modal de criar/editar;
 *   2. Rodízio na entrada: a chave por número (contato NOVO sem dono ganha vendedor da filial roteada);
 *   3. Simulador: telefone + origem (+ número) → filial e vendedor da vez, SEM avançar o rodízio.
 *
 * ⚠️ A precedência (contato → origem → DDD → padrão do número → filial do número → padrão geral)
 *    é do servidor (shared `resolverFilial`); a tela só a explica, com as mesmas palavras.
 * ⚠️ Gestor de filial vê só as regras e números da filial dele (a API filtra e barra).
 */
@Component({
  selector: 'app-roteamento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, BadgeComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente, ModalComponente,
    PaginacaoComponente, PainelComponente, SelectComponente, SelectPaginadoComponente, TabelaComponente,
  ],
  template: `
    @switch (estado()) {
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso ao roteamento"
          descricao="Regras de roteamento são de administradores e gestores. Peça acesso a um deles." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o roteamento" [descricao]="erroLista()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        <div class="secoes">
          <ui-painel>
            <div class="topo">
              <div>
                <h2 class="txt-secao">Regras de roteamento</h2>
                <p class="txt-denso explica">
                  Para qual filial vai cada cliente: filial já gravada no contato → origem → DDD → padrão do número →
                  filial do número → padrão geral. A regra de um número vence a geral; no mesmo nível, a menor prioridade.
                </p>
              </div>
              <button type="button" class="btn btn--primario" (click)="nova()">+ Nova regra</button>
            </div>
            <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
              <ng-template uiCelula="tipo" let-r><ui-badge [tom]="r.tipo === 'padrao' ? 'neutro' : 'info'">{{ rotuloTipo(r.tipo) }}</ui-badge></ng-template>
              <ng-template uiCelula="valor" let-r><span class="encolhe" [title]="valor(r)">{{ valor(r) }}</span></ng-template>
              <ng-template uiCelula="filial" let-r>
                <span class="encolhe">{{ r.filialNome }}</span>
                @if (!r.filialAtiva) { <ui-badge tom="atencao">filial desativada</ui-badge> }
              </ng-template>
              <ng-template uiCelula="numero" let-r><span class="encolhe" [title]="numero(r)">{{ numero(r) }}</span></ng-template>
              <ng-template uiCelula="ativa" let-r>
                <ui-badge [tom]="r.ativa ? 'sucesso' : 'neutro'">{{ r.ativa ? 'Ativa' : 'Inativa' }}</ui-badge>
              </ng-template>
              <ng-template uiCelula="acoes" let-r>
                <span class="acoes">
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="editar(r.id)">Editar</button>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="remover(r.id)">Remover</button>
                </span>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhuma regra ainda"
                  descricao="Sem regras, o cliente fica sem filial (a não ser que o número tenha uma) e o handoff segue para o pool do número.">
                  <button type="button" class="btn btn--primario" (click)="nova()">+ Nova regra</button>
                </ui-estado>
              </div>
            </ui-tabela>
            @if (estado() === 'pronto') {
              <ui-paginacao [mostrados]="itens().length" [temMais]="cursor() !== null" [carregando]="carregandoMais()" (mais)="carregarMais()" />
            }
          </ui-painel>

          <ui-painel>
            <h2 class="txt-secao">Rodízio na entrada</h2>
            <p class="txt-denso explica">
              Ligado num número: o contato NOVO que chega por mensagem, sem dono, vai para a carteira do próximo vendedor
              da filial roteada (rodízio por vez, só quem está ativo, não ausente e atende o número). Quem já tem dono não muda.
            </p>
            @if (numerosFalharam()) {
              <p class="aviso-erro" role="alert">Não foi possível carregar os números. <button type="button" class="btn btn--secundario btn--pequeno" (click)="carregarNumeros()">Tentar de novo</button></p>
            } @else if (numeros().length === 0) {
              <p class="txt-denso vazio">Nenhum número conectado.</p>
            } @else {
              <ul class="numeros">
                @for (n of numeros(); track n.id) {
                  <li class="numero">
                    <span class="encolhe" [title]="n.nome">{{ n.nome }}</span>
                    <label class="chave">
                      <input type="checkbox" role="switch" [checked]="n.rodizioNaEntrada" [disabled]="alternando() === n.id"
                        (change)="alternarRodizio(n, $any($event.target))" [attr.aria-label]="'Rodízio na entrada em ' + n.nome" />
                      <span>{{ n.rodizioNaEntrada ? 'Ligado' : 'Desligado' }}</span>
                    </label>
                  </li>
                }
              </ul>
              @if (numerosTruncados()) { <p class="txt-denso vazio">Mostrando os primeiros 200 números.</p> }
            }
          </ui-painel>

          <ui-painel>
            <h2 class="txt-secao">Simulador</h2>
            <p class="txt-denso explica">Para onde iria um contato novo — sem gravar nada e sem gastar a vez de ninguém.</p>
            <form class="simulador" (submit)="simular($event)">
              <ui-grade-form [colunas]="3">
                <ui-campo rotulo="Telefone" mascara="telefone" placeholder="(85) 99999-0000" [(valor)]="simTelefone" [erro]="simErro()" />
                <ui-select-paginado rotulo="Origem" placeholder="Sem origem" [carregar]="carregarOrigens"
                  [ngModel]="simOrigem() || null" (ngModelChange)="simOrigem.set($event ?? '')" [ngModelOptions]="{ standalone: true }" />
                <ui-select rotulo="Número" placeholder="Nenhum (só regras gerais)" [opcoes]="opcoesNumero()" [(valor)]="simCanal" />
              </ui-grade-form>
              <div class="sim-acoes">
                <button type="submit" class="btn btn--secundario" [disabled]="simulando()">{{ simulando() ? 'Simulando…' : 'Simular' }}</button>
              </div>
            </form>
            @if (resultado(); as r) {
              <dl class="resultado" aria-live="polite">
                <dt>Filial</dt><dd>{{ r.filial }}</dd>
                <dt>Vendedor da vez</dt><dd>{{ r.vendedor }}</dd>
              </dl>
              @if (r.aviso) { <p class="aviso txt-denso" role="note">{{ r.aviso }}</p> }
            }
          </ui-painel>
        </div>
      }
    }

    <ui-modal [aberto]="edicao() !== null" [titulo]="edicao()?.id ? 'Editar regra' : 'Nova regra'" largura="m" (fechar)="fechar()">
      <form id="form-regra" (submit)="salvar($event)">
        <ui-grade-form [colunas]="2">
          <ui-select rotulo="Tipo" [opcoes]="opcoesTipo" [obrigatorio]="true" [valor]="form().tipo" (valorChange)="mudar('tipo', $event)" [erro]="erros().tipo ?? null" />
          @switch (form().tipo) {
            @case ('ddd') {
              <ui-campo rotulo="DDD" placeholder="85" [obrigatorio]="true" [valor]="form().ddd" (valorChange)="mudar('ddd', $event)"
                [erro]="erros().valor ?? null" dica="Dois dígitos, ex.: 85." />
            }
            @case ('origem') {
              <ui-select-paginado rotulo="Origem" placeholder="Escolha a origem" [obrigatorio]="true" [carregar]="carregarOrigens"
                [opcaoInjetada]="origemInjetada()" [erro]="erros().valor ?? null"
                [ngModel]="form().origemId || null" (ngModelChange)="mudar('origemId', $event ?? '')" [ngModelOptions]="{ standalone: true }" />
            }
            @default { <p class="txt-denso dica-padrao">A regra padrão vale quando nenhuma origem ou DDD casou.</p> }
          }
          <ui-select rotulo="Filial" placeholder="Escolha a filial" [obrigatorio]="true" [opcoes]="opcoesFilial()"
            [valor]="form().filialId" (valorChange)="mudar('filialId', $event)" [erro]="erros().filialId ?? null" />
          <ui-select rotulo="Número" placeholder="Todos os números" [opcoes]="opcoesNumero()"
            [valor]="form().canalId" (valorChange)="mudar('canalId', $event)" [erro]="erros().canalId ?? null" />
          <ui-campo rotulo="Prioridade" tipo="number" [valor]="form().prioridade" (valorChange)="mudar('prioridade', $event)"
            [erro]="erros().prioridade ?? null" dica="Menor vence no mesmo nível." />
          <ui-select rotulo="Situação" [opcoes]="opcoesSituacao" [valor]="form().ativa ? 'true' : 'false'"
            (valorChange)="mudar('ativa', $event === 'true')" />
        </ui-grade-form>
        @if (erroEnvio(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="submit" form="form-regra" class="btn btn--primario" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .secoes { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .topo { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-3); flex-wrap: wrap; margin-bottom: var(--espacamento-3); }
    .topo > div { min-width: 0; flex: 1 1 280px; }
    h2 { margin: 0; color: var(--texto); }
    .explica { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-secundario); max-width: 72ch; }
    ui-tabela { display: block; }
    .encolhe { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); flex-wrap: wrap; justify-content: flex-end; }
    .numeros { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-controle); }
    .numero { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); min-width: 0; }
    .numero:last-child { border-bottom: none; }
    .numero > span { flex: 1; min-width: 0; color: var(--texto); }
    .chave { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); font-size: 13px; flex: none; cursor: pointer; }
    .vazio { color: var(--texto-suave); margin: 0; }
    .aviso-erro { color: var(--erro); margin: 0; display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .simulador { display: grid; gap: var(--espacamento-3); }
    .sim-acoes { display: flex; justify-content: flex-end; }
    .resultado { display: grid; grid-template-columns: max-content 1fr; gap: var(--espacamento-1) var(--espacamento-4); margin: var(--espacamento-4) 0 0; }
    .resultado dt { color: var(--texto-suave); font-size: 13px; }
    .resultado dd { margin: 0; color: var(--texto); min-width: 0; overflow-wrap: anywhere; }
    @media (max-width: 480px) { .resultado { grid-template-columns: 1fr; } }
    .aviso { margin: var(--espacamento-3) 0 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); }
    .dica-padrao { color: var(--texto-suave); align-self: end; margin: 0; }
    .erro-envio { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class RoteamentoComponente implements OnInit {
  private readonly api = inject(RoteamentoServico)
  private readonly catalogos = inject(EtiquetasServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'tipo', rotulo: 'Tipo', largura: '100px' },
    { chave: 'valor', rotulo: 'Valor' },
    { chave: 'filial', rotulo: 'Filial' },
    { chave: 'numero', rotulo: 'Número' },
    { chave: 'prioridade', rotulo: 'Prioridade', mono: true, largura: '100px' },
    { chave: 'ativa', rotulo: 'Situação', largura: '100px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '190px' },
  ]
  protected readonly opcoesTipo = OPCOES_TIPO
  protected readonly opcoesSituacao = OPCOES_SITUACAO

  protected readonly estado = signal<EstadoLista>('carregando')
  protected readonly erroLista = signal('')
  protected readonly itens = signal<readonly RegraRoteamento[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  protected readonly cursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)

  protected readonly filiais = signal<readonly FilialOpcao[]>([])
  protected readonly numeros = signal<readonly NumeroRoteamento[]>([])
  protected readonly numerosFalharam = signal(false)
  protected readonly numerosTruncados = signal(false)
  protected readonly alternando = signal<string | null>(null)
  protected readonly opcoesFilial = computed<OpcaoSelect[]>(() => this.filiais().map((f) => ({ valor: f.id, rotulo: f.nome })))
  protected readonly opcoesNumero = computed<OpcaoSelect[]>(() => this.numeros().map((n) => ({ valor: n.id, rotulo: n.nome })))

  protected readonly edicao = signal<{ id: string | null } | null>(null)
  protected readonly form = signal<FormRegra>(FORM_REGRA_VAZIO)
  protected readonly erros = signal<Partial<Record<CampoRegra, string>>>({})
  protected readonly erroEnvio = signal<string | null>(null)
  protected readonly salvando = signal(false)
  protected readonly origemInjetada = signal<OpcaoPaginada | null>(null)

  protected readonly simTelefone = signal('')
  protected readonly simOrigem = signal('')
  protected readonly simCanal = signal('')
  protected readonly simErro = signal<string | null>(null)
  protected readonly simulando = signal(false)
  protected readonly simulacao = signal<SimulacaoRoteamento | null>(null)
  protected readonly resultado = computed(() => { const s = this.simulacao(); return s ? descreverSimulacao(s) : null })

  protected readonly carregarOrigens: CarregarOpcoes = async (cursor, termo) => {
    const p = await this.catalogos.origens(cursor, true)
    const t = termo.trim().toLowerCase()
    return {
      itens: p.itens.filter((o) => !t || o.nome.toLowerCase().includes(t)).map((o) => ({ valor: o.id, rotulo: o.nome })),
      proximoCursor: p.proximoCursor,
    }
  }

  ngOnInit(): void { void this.carregar() }

  protected rotuloTipo(t: string): string { return ROTULO_TIPO_REGRA[t as keyof typeof ROTULO_TIPO_REGRA] ?? t }
  protected valor = rotuloValor
  protected numero = rotuloNumero

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.api.regras(null)
      this.itens.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) { this.estado.set('sem_permissao'); return }
      this.erroLista.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro'); return
    }
    // Secundários: falham no lugar deles, sem derrubar a tela.
    void this.carregarNumeros()
    try { this.filiais.set((await this.api.filiais()).itens) } catch { this.filiais.set([]) }
  }

  protected async carregarNumeros(): Promise<void> {
    this.numerosFalharam.set(false)
    try {
      const r = await this.api.numeros()
      this.numeros.set(r.itens); this.numerosTruncados.set(r.truncado)
    } catch { this.numerosFalharam.set(true) }
  }

  protected async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.regras(c)
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (x) => x.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais regras.'))
    } finally { this.carregandoMais.set(false) }
  }

  protected nova(): void {
    this.form.set(FORM_REGRA_VAZIO); this.origemInjetada.set(null)
    this.erros.set({}); this.erroEnvio.set(null)
    this.edicao.set({ id: null })
  }

  protected editar(id: string): void {
    const r = this.itens().find((x) => x.id === id)
    if (!r) return
    this.form.set(formDaRegra(r))
    this.origemInjetada.set(r.tipo === 'origem' && r.valor ? { valor: r.valor, rotulo: r.valorRotulo ?? r.valor } : null)
    this.erros.set({}); this.erroEnvio.set(null)
    this.edicao.set({ id })
  }

  protected mudar<K extends keyof FormRegra>(campo: K, v: FormRegra[K]): void {
    this.form.update((f) => ({ ...f, [campo]: v }))
  }

  protected fechar(): void { if (!this.salvando()) this.edicao.set(null) }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const ed = this.edicao()
    if (!ed || this.salvando()) return
    const erros = validarFormRegra(this.form())
    this.erros.set(erros)
    if (Object.keys(erros).length > 0) return
    this.salvando.set(true); this.erroEnvio.set(null)
    const corpo = montarPayloadRegra(this.form())
    try {
      if (ed.id) await this.api.editar(ed.id, corpo)
      else await this.api.criar(corpo)
      this.edicao.set(null)
      this.toast.sucesso(ed.id ? 'Regra salva.' : 'Regra criada.')
      await this.carregar()
    } catch (err) {
      const m = mapearErroRoteamento(codigoDoErro(err), corpoDoErro(err)?.mensagem ?? null)
      if (m?.campo) this.erros.set({ [m.campo]: m.mensagem })
      else this.erroEnvio.set(m?.mensagem ?? mensagemDeErro(err, 'Não foi possível salvar a regra.'))
    } finally { this.salvando.set(false) }
  }

  protected async remover(id: string): Promise<void> {
    const r = this.itens().find((x) => x.id === id)
    if (!r) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover esta regra?',
      mensagem: `${this.rotuloTipo(r.tipo)} ${rotuloValor(r)} → ${r.filialNome} (${rotuloNumero(r)}). Os próximos clientes deixam de ser roteados por ela; quem já tem filial não muda.`,
      acao: 'Remover', perigo: true,
    })
    if (!ok) return
    try {
      await this.api.remover(id)
      this.toast.sucesso('Regra removida.')
      await this.carregar()
    } catch (err) {
      this.toast.erro(mapearErroRoteamento(codigoDoErro(err))?.mensagem ?? mensagemDeErro(err, 'Não foi possível remover.'))
    }
  }

  protected async alternarRodizio(n: NumeroRoteamento, el: HTMLInputElement): Promise<void> {
    const ligar = el.checked
    this.alternando.set(n.id)
    try {
      await this.api.ligarRodizio(n.id, ligar)
      this.numeros.update((lista) => lista.map((x) => (x.id === n.id ? { ...x, rodizioNaEntrada: ligar } : x)))
      this.toast.sucesso(ligar ? `Rodízio na entrada ligado em ${n.nome}.` : `Rodízio na entrada desligado em ${n.nome}.`)
    } catch (err) {
      // Volta a chave ao que o servidor tem (o binding não mudou, então o DOM é desfeito à mão).
      el.checked = n.rodizioNaEntrada
      this.toast.erro(ehStatus(err, 403) || ehStatus(err, 404)
        ? 'Você não pode mudar este número (só administradores ou o gestor da filial dele).'
        : mensagemDeErro(err, 'Não foi possível mudar o rodízio.'))
    } finally { this.alternando.set(null) }
  }

  protected async simular(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.simulando()) return
    const telefone = this.simTelefone().replace(/\D/g, '')
    if (!telefone && !this.simOrigem()) { this.simErro.set('Informe o telefone ou escolha a origem.'); return }
    this.simErro.set(null); this.simulando.set(true)
    try {
      this.simulacao.set(await this.api.simular({ telefone, origemId: this.simOrigem(), canalId: this.simCanal() }))
    } catch (err) {
      this.simulacao.set(null)
      this.simErro.set(mensagemDeErro(err, 'Não foi possível simular.'))
    } finally { this.simulando.set(false) }
  }
}
