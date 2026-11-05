import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, GradeFormComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, SelectPaginadoComponente, TabelaComponente, ToastServico, ehStatus,
  mensagemDeErro, mesclarPagina, queryDeLista, type CarregarOpcoes, type ColunaTabela, type LinhaTabela, type OpcaoPaginada,
} from '../../compartilhado/ui/index.js'

interface Sequencia { readonly id: string; readonly nome: string; readonly objetivo: string | null; readonly ativa: boolean; readonly passos: number }
interface Passo { readonly seq: number; readonly offsetDias: number; readonly titulo: string; readonly descricao: string | null }
interface Pagina { readonly itens: Sequencia[]; readonly proximoCursor: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Réguas de contato (aba de Automações) — playbook de toques em coluna dupla
 * (réguas | passos). Aplicar a um contato materializa as Tarefas (D+N): é ação
 * sobre um registro, então abre modal de ação (padrão A) que nomeia a régua.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-sequencias',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, FormsModule, GradeFormComponente,
    IconeComponente, ModalComponente, PaginacaoComponente, SelectPaginadoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Réguas de contato"
      subtitulo="Um playbook de toques que você aplica a um cliente e vira tarefas.">
      <button type="button" class="btn btn--primario" (click)="criarAberto.set(true)">
        <ui-icone nome="plus" />Nova régua
      </button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="grade">
          <ui-tabela [colunas]="colunasSeqs" [linhas]="[]" [carregando]="true" />
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso às réguas" descricao="Peça acesso a um administrador." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as réguas" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        <div class="grade">
          <section class="col">
            <ui-tabela [colunas]="colunasSeqs" [linhas]="linhasSeqs()" [selecionados]="marcadas()">
              <ng-template uiCelula="nome" let-l>
                <button type="button" class="nome" (click)="abrir(l)">{{ l.nome }}</button>
              </ng-template>
              <ng-template uiCelula="passos" let-l>{{ l.passos }} passo{{ l.passos === 1 ? '' : 's' }}</ng-template>
              <ng-template uiCelula="acoes" let-l>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="excluir(l, $event)">Excluir</button>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhuma régua ainda"
                  descricao="Crie uma régua de toques, como pós-venda ou reativação, e aplique a clientes.">
                  <button type="button" class="btn btn--secundario" (click)="criarAberto.set(true)">Nova régua</button>
                </ui-estado>
              </div>
            </ui-tabela>
            <ui-paginacao [mostrados]="seqs().length" [temMais]="proximoCursor() !== null"
              [carregando]="carregandoMais()" (mais)="carregarMais()" />
          </section>

          <section class="col">
            @if (sel(); as s) {
              <div class="det-topo">
                <h2 class="txt-secao encolhe">{{ s.nome }}</h2>
                <span class="det-acoes">
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirPasso()">
                    <ui-icone nome="plus" />Novo passo
                  </button>
                  <button type="button" class="btn btn--primario btn--pequeno" (click)="abrirAplicar()"
                    [disabled]="passos().length === 0"
                    [title]="passos().length === 0 ? 'Adicione ao menos um passo antes de aplicar' : 'Criar as tarefas desta régua para um cliente'">
                    Aplicar a um cliente…
                  </button>
                </span>
              </div>
              @if (msg(); as m) { <p [class.ok]="m.ok" [class.erro]="!m.ok" [attr.role]="m.ok ? 'status' : 'alert'">{{ m.texto }}</p> }

              @if (erroPassos()) { <p class="erro" role="alert">{{ erroPassos() }}</p> }
              <ui-tabela [colunas]="colunasPassos" [linhas]="linhasPassos()" [chaveLinha]="chaveDoPasso">
                <ng-template uiCelula="dia" let-p>D+{{ p.offsetDias }}</ng-template>
                <ng-template uiCelula="titulo" let-p>
                  <span class="ps-tit">{{ p.titulo }}</span>
                  @if (p.descricao) { <span class="ps-desc">{{ p.descricao }}</span> }
                </ng-template>
                <ng-template uiCelula="acoes" let-p>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="removerPasso(p)">Remover</button>
                </ng-template>
                <div uiVazio>
                  <ui-estado titulo="Sem passos" descricao="Adicione o primeiro toque com o botão Novo passo." />
                </div>
              </ui-tabela>

            } @else {
              <ui-estado titulo="Escolha uma régua" descricao="Selecione uma régua ao lado para montar os passos e aplicar a um cliente." />
            }
          </section>
        </div>
      }
    }

    <ui-modal [aberto]="aplicarAberto()" titulo="Aplicar a um cliente" largura="p" (fechar)="fecharAplicar()">
      <form id="form-aplicar" (submit)="aplicar($event)" novalidate>
        <p class="ap-sub">Régua <strong>{{ sel()?.nome }}</strong>: cria {{ passos().length }} tarefa{{ passos().length === 1 ? '' : 's' }},
          com vencimento em D+N a partir de hoje.</p>
        <ui-grade-form>
          <ui-select-paginado rotulo="Cliente" placeholder="Busque por nome ou telefone" [largo]="true" [obrigatorio]="true"
            [carregar]="buscarContatos" [erro]="erroAplicar()"
            [ngModel]="contatoAplicar()" (ngModelChange)="contatoAplicar.set($event ?? '')" name="contato" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharAplicar()">Cancelar</button>
        <button type="submit" form="form-aplicar" class="btn btn--primario" [disabled]="aplicando()">
          {{ aplicando() ? 'Aplicando…' : 'Aplicar régua' }}
        </button>
      </div>
    </ui-modal>
    <ui-modal [aberto]="criarAberto()" titulo="Nova régua" largura="p" (fechar)="fecharCriar()">
      <form id="form-sequencia" (submit)="criar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Nome da régua" placeholder="Ex.: Pós-venda" [obrigatorio]="true"
            [(valor)]="novoNome" [erro]="erroNova()" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharCriar()">Cancelar</button>
        <button type="submit" form="form-sequencia" class="btn btn--primario" [disabled]="criando()">
          {{ criando() ? 'Criando…' : 'Criar régua' }}
        </button>
      </div>
    </ui-modal>

    <ui-modal [aberto]="passoAberto()" titulo="Novo passo" largura="p" (fechar)="fecharPasso()">
      <form id="form-passo" (submit)="addPasso($event)">
        <ui-grade-form>
          <ui-campo rotulo="Dia (D+N)" tipo="number" dica="Dias depois de aplicar a régua." [obrigatorio]="true"
            [valor]="pOffset().toString()" (valorChange)="pOffset.set(+$event)" />
          <ui-campo rotulo="O que fazer" placeholder="Ex.: Ligar para confirmar o pedido" [obrigatorio]="true"
            [(valor)]="pTitulo" [erro]="erroPasso()" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharPasso()">Cancelar</button>
        <button type="submit" form="form-passo" class="btn btn--primario" [disabled]="addP()">
          {{ addP() ? 'Adicionando…' : 'Adicionar passo' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .grade { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--espacamento-4); align-items: start;
      margin-top: var(--espacamento-4); }
    @media (max-width: 720px) { .grade { grid-template-columns: minmax(0, 1fr); } }
    .col { min-width: 0; display: grid; gap: var(--espacamento-3); align-content: start; }
    .nome { padding: 0; border: 0; background: transparent; color: var(--texto); font: inherit; text-align: left; cursor: pointer; }
    .nome:hover { color: var(--acao); text-decoration: underline; }
    .det-topo { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); }
    .det-topo h2 { margin: 0; min-width: 0; }
    .det-acoes { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-2); justify-content: flex-end; }
    .ps-tit { color: var(--texto); }
    .ps-desc { display: block; color: var(--texto-suave); font-size: 12px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .ok { margin: 0; color: var(--sucesso); font-size: 13px; }
    .ap-sub { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .encolhe { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class SequenciasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunasSeqs: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Régua' },
    { chave: 'passos', rotulo: 'Passos', alinhamento: 'dir', mono: true, largura: '120px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '120px' },
  ]
  protected readonly colunasPassos: ColunaTabela[] = [
    { chave: 'dia', rotulo: 'Dia', mono: true, largura: '90px' },
    { chave: 'titulo', rotulo: 'Passo' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '120px' },
  ]
  protected readonly chaveDoPasso = (l: LinhaTabela): string => String(l['seq'])

  readonly estado = signal<Estado>('carregando')
  readonly seqs = signal<readonly Sequencia[]>([])
  protected readonly linhasSeqs = computed(() => this.seqs() as unknown as readonly LinhaTabela[])
  protected readonly marcadas = computed<ReadonlySet<string>>(() => {
    const s = this.sel()
    return new Set(s ? [s.id] : [])
  })
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly sel = signal<Sequencia | null>(null)
  readonly passos = signal<readonly Passo[]>([])
  protected readonly linhasPassos = computed(() => this.passos() as unknown as readonly LinhaTabela[])
  readonly erroPassos = signal<string | null>(null)
  readonly criarAberto = signal(false)
  readonly novoNome = signal(''); readonly criando = signal(false); readonly erroNova = signal<string | null>(null)
  readonly passoAberto = signal(false)
  readonly pOffset = signal(7); readonly pTitulo = signal(''); readonly addP = signal(false); readonly erroPasso = signal<string | null>(null)
  readonly aplicarAberto = signal(false); readonly contatoAplicar = signal(''); readonly aplicando = signal(false)
  readonly erroAplicar = signal<string | null>(null)
  /** Nome de cada contato visto na busca — para a mensagem "N tarefas criadas para Fulano". */
  private readonly nomes = new Map<string, string>()
  readonly msg = signal<{ ok: boolean; texto: string } | null>(null)

  ngOnInit(): void { void this.carregar() }

  private pagina(cursor: string | null): Promise<Pagina> {
    return firstValueFrom(this.http.get<Pagina>(`/v1/sequencias${queryDeLista({ cursor })}`))
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.pagina(null)
      this.seqs.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
      const s = this.sel()
      if (s) {
        // A selecionada pode estar numa página ainda não carregada: mantém o
        // que já havia em vez de perder a seleção.
        const atual = r.itens.find((x) => x.id === s.id)
        if (atual) { this.sel.set(atual); await this.carregarPassos() }
      }
    } catch (e) { this.estado.set(ehStatus(e, 403) ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.pagina(cursor)
      this.seqs.update((a) => mesclarPagina(a, r.itens, (s) => s.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais réguas.'))
    } finally { this.carregandoMais.set(false) }
  }

  abrir(s: Sequencia): void { this.sel.set(s); this.msg.set(null); void this.carregarPassos() }

  async carregarPassos(): Promise<void> {
    const s = this.sel(); if (!s) return
    this.erroPassos.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Passo[] }>(`/v1/sequencias/${s.id}/passos`))
      this.passos.set(r.itens)
    } catch (e) {
      this.erroPassos.set(mensagemDeErro(e, 'Não foi possível carregar os passos. Tente abrir a régua de novo.'))
    }
  }

  /** Atualiza a contagem de passos da selecionada na lista, sem recarregar tudo. */
  private atualizarContagem(id: string, delta: number): void {
    this.seqs.update((a) => a.map((s) => (s.id === id ? { ...s, passos: s.passos + delta } : s)))
    const sel = this.sel()
    if (sel?.id === id) this.sel.set({ ...sel, passos: sel.passos + delta })
  }

  fecharCriar(): void { if (!this.criando()) this.criarAberto.set(false) }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nome = this.novoNome().trim()
    if (this.criando() || !nome) return
    this.criando.set(true); this.erroNova.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/sequencias', { nome }))
      this.novoNome.set('')
      this.criarAberto.set(false)
      this.toast.sucesso('Régua criada')
      await this.carregar()
    } catch (e) {
      this.erroNova.set(ehStatus(e, 409) ? 'Já existe uma régua com esse nome.' : mensagemDeErro(e, 'Não foi possível criar a régua.'))
    } finally { this.criando.set(false) }
  }

  async excluir(s: Sequencia, ev: Event): Promise<void> {
    ev.stopPropagation()
    const ok = await this.confirmacao.confirmar({
      titulo: `Excluir “${s.nome}”?`,
      mensagem: s.passos > 0
        ? `Os ${s.passos} passos somem junto. Tarefas já criadas a partir dela continuam na agenda.`
        : 'Tarefas já criadas a partir dela continuam na agenda.',
      acao: 'Excluir',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/sequencias/${s.id}`))
      if (this.sel()?.id === s.id) { this.sel.set(null); this.passos.set([]) }
      this.seqs.update((a) => a.filter((x) => x.id !== s.id))
      this.toast.sucesso('Régua excluída')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível excluir a régua.'))
    }
  }

  abrirPasso(): void { this.erroPasso.set(null); this.pTitulo.set(''); this.passoAberto.set(true) }

  fecharPasso(): void { if (!this.addP()) this.passoAberto.set(false) }

  async addPasso(ev: Event): Promise<void> {
    ev.preventDefault()
    const s = this.sel(); const titulo = this.pTitulo().trim()
    if (!s || this.addP()) return
    if (!titulo) { this.erroPasso.set('Descreva o que fazer neste toque.'); return }
    this.addP.set(true); this.erroPasso.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/sequencias/${s.id}/passos`, { offsetDias: this.pOffset(), titulo }))
      this.pTitulo.set('')
      this.passoAberto.set(false)
      this.toast.sucesso('Passo adicionado')
      this.atualizarContagem(s.id, 1)
      await this.carregarPassos()
    } catch (e) {
      this.erroPasso.set(mensagemDeErro(e, 'Não foi possível adicionar o passo.'))
    } finally { this.addP.set(false) }
  }

  async removerPasso(p: Passo): Promise<void> {
    const s = this.sel(); if (!s) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover este passo?',
      mensagem: `D+${p.offsetDias} · ${p.titulo}. Tarefas já criadas por ele continuam na agenda.`,
      acao: 'Remover',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/sequencias/${s.id}/passos/${p.seq}`))
      this.toast.sucesso('Passo removido')
      this.atualizarContagem(s.id, -1)
      await this.carregarPassos()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível remover o passo.'))
    }
  }

  protected readonly buscarContatos: CarregarOpcoes = async (_cursor, termo) => {
    // A busca de contatos devolve os 20 melhores (sem cursor): uma página só.
    if (termo.trim().length < 2) return { itens: [], proximoCursor: null }
    const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string; telefone: string | null }[] }>(
      `/v1/contatos/busca${queryDeLista({ q: termo.trim() })}`))
    for (const c of r.itens) this.nomes.set(c.id, c.nome)
    const itens: OpcaoPaginada[] = r.itens.map((c) => ({ valor: c.id, rotulo: c.nome, ...(c.telefone ? { dica: c.telefone } : {}) }))
    return { itens, proximoCursor: null }
  }

  abrirAplicar(): void { this.contatoAplicar.set(''); this.erroAplicar.set(null); this.aplicarAberto.set(true) }
  fecharAplicar(): void { if (!this.aplicando()) this.aplicarAberto.set(false) }

  async aplicar(ev: Event): Promise<void> {
    ev.preventDefault()
    const s = this.sel(); const contatoId = this.contatoAplicar()
    if (!s || this.aplicando()) return
    if (!contatoId) { this.erroAplicar.set('Escolha o cliente.'); return }
    this.aplicando.set(true); this.erroAplicar.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ tarefasCriadas: number }>(`/v1/sequencias/${s.id}/aplicar`, { contatoId }))
      const n = r.tarefasCriadas
      const nome = this.nomes.get(contatoId) ?? 'o cliente'
      this.msg.set({ ok: true, texto: `${n} tarefa${n === 1 ? '' : 's'} criada${n === 1 ? '' : 's'} para ${nome}.` })
      this.aplicarAberto.set(false)
      this.toast.sucesso('Régua aplicada')
    } catch (e) {
      this.erroAplicar.set(mensagemDeErro(e, 'Não foi possível aplicar a régua.'))
    } finally { this.aplicando.set(false) }
  }
}
