import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, GradeFormComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente, ToastServico, ehStatus, mensagemDeErro,
  mesclarPagina, queryDeLista, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Sequencia { readonly id: string; readonly nome: string; readonly objetivo: string | null; readonly ativa: boolean; readonly passos: number }
interface Passo { readonly seq: number; readonly offsetDias: number; readonly titulo: string; readonly descricao: string | null }
interface AchadoContato { readonly id: string; readonly nome: string }
interface Pagina { readonly itens: Sequencia[]; readonly proximoCursor: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Sequências (régua de relacionamento) — playbook de toques em coluna dupla
 * (sequências | passos). Aplicar a um contato materializa as Tarefas (D+N).
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-sequencias',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente,
    IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Sequências"
      subtitulo="Réguas de relacionamento: um playbook de toques que você aplica a um cliente e vira tarefas.">
      <button type="button" class="btn btn--primario" (click)="criarAberto.set(true)">
        <ui-icone nome="plus" />Nova sequência
      </button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="grade">
          <ui-tabela [colunas]="colunasSeqs" [linhas]="[]" [carregando]="true" />
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso às sequências" descricao="Peça acesso a um administrador." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as sequências" descricao="Verifique a conexão e tente de novo.">
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
                <ui-estado titulo="Nenhuma sequência ainda"
                  descricao="Crie uma sequência de toques, como pós-venda ou reativação, e aplique a clientes.">
                  <button type="button" class="btn btn--primario" (click)="criarAberto.set(true)">Nova sequência</button>
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
                <button type="button" class="btn btn--primario btn--pequeno" (click)="abrirPasso()">
                  <ui-icone nome="plus" />Novo passo
                </button>
              </div>

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

              <div class="aplicar">
                <h3 class="txt-secao">Aplicar a um cliente</h3>
                <p class="ap-sub">Cria uma tarefa por passo, com vencimento em D+N a partir de hoje.</p>
                <div class="busca">
                  <input [value]="termo()" (input)="buscar($any($event.target).value)" placeholder="Buscar contato…"
                    aria-label="Buscar contato" [disabled]="passos().length === 0" />
                  @if (achados().length > 0) {
                    <ul class="achados">
                      @for (a of achados(); track a.id) {
                        <li><button type="button" class="achado" (click)="aplicar(a)">{{ a.nome }}</button></li>
                      }
                    </ul>
                  }
                </div>
                @if (erroBusca()) { <p class="erro" role="alert">{{ erroBusca() }}</p> }
                @if (msg(); as m) { <p [class.ok]="m.ok" [class.erro]="!m.ok" [attr.role]="m.ok ? 'status' : 'alert'">{{ m.texto }}</p> }
              </div>
            } @else {
              <ui-estado titulo="Escolha uma sequência" descricao="Selecione uma sequência ao lado para montar os passos e aplicar a um cliente." />
            }
          </section>
        </div>
      }
    }

    <ui-modal [aberto]="criarAberto()" titulo="Nova sequência" largura="p" (fechar)="fecharCriar()">
      <form id="form-sequencia" (submit)="criar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Nome da sequência" placeholder="Ex.: Pós-venda" [obrigatorio]="true"
            [(valor)]="novoNome" [erro]="erroNova()" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharCriar()">Cancelar</button>
        <button type="submit" form="form-sequencia" class="btn btn--primario" [disabled]="criando()">
          {{ criando() ? 'Criando…' : 'Criar sequência' }}
        </button>
      </div>
    </ui-modal>

    <ui-modal [aberto]="passoAberto()" titulo="Novo passo" largura="p" (fechar)="fecharPasso()">
      <form id="form-passo" (submit)="addPasso($event)">
        <ui-grade-form>
          <ui-campo rotulo="Dia (D+N)" tipo="number" dica="Dias depois de aplicar a sequência." [obrigatorio]="true"
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
    .ps-tit { color: var(--texto); }
    .ps-desc { display: block; color: var(--texto-suave); font-size: 12px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .ok { margin: var(--espacamento-3) 0 0; color: var(--sucesso); font-size: 13px; }
    .aplicar { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie); }
    .aplicar h3 { margin: 0; }
    .ap-sub { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .busca { position: relative; }
    .busca input { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; }
    .busca input:disabled { opacity: .6; }
    .achados { position: absolute; z-index: 5; left: 0; right: 0; margin: var(--espacamento-1) 0 0; padding: 0; list-style: none;
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada);
      box-shadow: var(--elevacao-dropdown); max-height: 220px; overflow: auto; }
    .achado { display: block; width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 0; background: transparent;
      color: var(--texto); font: inherit; text-align: left; cursor: pointer; }
    .achado:hover { background: var(--acao-suave); }
    .encolhe { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class SequenciasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunasSeqs: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Sequência' },
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
  readonly termo = signal(''); readonly achados = signal<readonly AchadoContato[]>([]); readonly erroBusca = signal<string | null>(null)
  readonly msg = signal<{ ok: boolean; texto: string } | null>(null)
  private buscaSeq = 0

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
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais sequências.'))
    } finally { this.carregandoMais.set(false) }
  }

  abrir(s: Sequencia): void { this.sel.set(s); this.msg.set(null); this.termo.set(''); this.achados.set([]); void this.carregarPassos() }

  async carregarPassos(): Promise<void> {
    const s = this.sel(); if (!s) return
    this.erroPassos.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Passo[] }>(`/v1/sequencias/${s.id}/passos`))
      this.passos.set(r.itens)
    } catch (e) {
      this.erroPassos.set(mensagemDeErro(e, 'Não foi possível carregar os passos. Tente abrir a sequência de novo.'))
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
      this.toast.sucesso('Sequência criada')
      await this.carregar()
    } catch (e) {
      this.erroNova.set(ehStatus(e, 409) ? 'Já existe uma sequência com esse nome.' : mensagemDeErro(e, 'Não foi possível criar a sequência.'))
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
      this.toast.sucesso('Sequência excluída')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível excluir a sequência.'))
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

  async buscar(q: string): Promise<void> {
    this.termo.set(q); this.msg.set(null); this.erroBusca.set(null)
    const seq = ++this.buscaSeq
    if (q.trim().length < 2) { this.achados.set([]); return }
    try {
      const r = await firstValueFrom(this.http.get<{ itens: AchadoContato[] }>(`/v1/contatos/busca?q=${encodeURIComponent(q.trim())}`))
      if (seq === this.buscaSeq) this.achados.set(r.itens)
    } catch (e) {
      if (seq === this.buscaSeq) this.erroBusca.set(mensagemDeErro(e, 'A busca de contatos falhou. Tente de novo.'))
    }
  }

  async aplicar(a: AchadoContato): Promise<void> {
    const s = this.sel(); if (!s) return
    this.termo.set(''); this.achados.set([])
    try {
      const r = await firstValueFrom(this.http.post<{ tarefasCriadas: number }>(`/v1/sequencias/${s.id}/aplicar`, { contatoId: a.id }))
      const n = r.tarefasCriadas
      const texto = `${n} tarefa${n === 1 ? '' : 's'} criada${n === 1 ? '' : 's'} para ${a.nome}.`
      this.msg.set({ ok: true, texto })
      this.toast.sucesso('Sequência aplicada')
    } catch (e) {
      this.msg.set({ ok: false, texto: mensagemDeErro(e, 'Não foi possível aplicar a sequência.') })
    }
  }
}
