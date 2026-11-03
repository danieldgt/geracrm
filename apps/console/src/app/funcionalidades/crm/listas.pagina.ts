import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, GradeFormComponente,
  IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente, ToastServico, mensagemDeErro,
  type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Lista { readonly id: string; readonly nome: string; readonly descricao: string | null; readonly membros: number }
interface Membro { readonly id: string; readonly nome: string }
interface AchadoContato { readonly id: string; readonly nome: string; readonly telefone: string | null }
interface PaginaListas { readonly itens: Lista[]; readonly proximoCursor?: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Listas (públicos salvos) — CRUD de público curado + gestão de membros, em
 * coluna dupla (listas | membros). Adicionar membro por busca de contato.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-listas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente,
    IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Listas"
      subtitulo="Públicos que você monta à mão e reusa — separados dos segmentos automáticos.">
      <button type="button" class="btn btn--primario" (click)="criarAberto.set(true)">
        <ui-icone nome="plus" />Nova lista
      </button>
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="grade">
          <ui-tabela [colunas]="colunasListas" [linhas]="[]" [carregando]="true" />
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso às listas" descricao="Peça acesso a um administrador." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as listas" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        <div class="grade">
          <section class="col">
            <ui-tabela [colunas]="colunasListas" [linhas]="linhasListas()" [selecionados]="marcadas()">
              <ng-template uiCelula="nome" let-l>
                <button type="button" class="nome" (click)="abrir(l)">{{ l.nome }}</button>
              </ng-template>
              <ng-template uiCelula="acoes" let-l>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="excluir(l.id, $event)">Excluir</button>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhuma lista ainda"
                  descricao="Crie uma lista para reunir os contatos que você usa em campanhas.">
                  <button type="button" class="btn btn--primario" (click)="criarAberto.set(true)">Nova lista</button>
                </ui-estado>
              </div>
            </ui-tabela>
            @if (listas().length > 0) {
              <ui-paginacao [mostrados]="listas().length" [temMais]="temMaisListas()" [carregando]="carregandoMais()"
                (mais)="carregarMaisListas()" />
            }
          </section>

          <section class="col">
            @if (selecionada(); as sel) {
              <div class="det-topo">
                <h2 class="txt-secao encolhe">{{ sel.nome }}</h2>
                <span class="txt-dados">{{ membros().length }}{{ temMais() ? '+' : '' }}</span>
              </div>

              <div class="busca">
                <ui-campo rotulo="Adicionar contato à lista" placeholder="Buscar por nome ou telefone"
                  [valor]="termo()" (valorChange)="buscar($event)" />
                @if (achados().length > 0) {
                  <ul class="achados">
                    @for (a of achados(); track a.id) {
                      <li>
                        <button type="button" class="achado" (click)="adicionar(a)">
                          <span class="encolhe">{{ a.nome }}</span>
                          @if (a.telefone) { <span class="tel">{{ a.telefone }}</span> }
                        </button>
                      </li>
                    }
                  </ul>
                }
              </div>

              @if (erroMembros(); as e) {
                <p class="erro" role="alert">
                  {{ e }} <button type="button" class="btn btn--secundario btn--pequeno" (click)="carregarMembros()">Tentar de novo</button>
                </p>
              }

              <ui-tabela [colunas]="colunasMembros" [linhas]="linhasMembros()">
                <ng-template uiCelula="acoes" let-m>
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="remover(m.id)">Remover</button>
                </ng-template>
                <div uiVazio>
                  <ui-estado titulo="Lista vazia" descricao="Busque um contato acima para adicionar." />
                </div>
              </ui-tabela>
              @if (membros().length > 0) {
                <ui-paginacao [mostrados]="membros().length" [temMais]="temMais()" (mais)="carregarMembros(true)" />
              }
            } @else {
              <ui-estado titulo="Escolha uma lista" descricao="Selecione uma lista ao lado para ver e adicionar contatos." />
            }
          </section>
        </div>
      }
    }

    <ui-modal [aberto]="criarAberto()" titulo="Nova lista" largura="p" (fechar)="fecharCriar()">
      <form id="form-lista" (submit)="criar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="Nome da lista" placeholder="Ex.: Feira 2026" [obrigatorio]="true"
            [(valor)]="novoNome" [erro]="erroNova()" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharCriar()">Cancelar</button>
        <button type="submit" form="form-lista" class="btn btn--primario" [disabled]="criando()">
          {{ criando() ? 'Criando…' : 'Criar lista' }}
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
    .det-topo { display: flex; align-items: baseline; justify-content: space-between; gap: var(--espacamento-3); }
    .det-topo h2 { margin: 0; min-width: 0; }
    .busca { position: relative; }
    .achados { position: absolute; z-index: 5; left: 0; right: 0; margin: var(--espacamento-1) 0 0; padding: 0; list-style: none;
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada);
      box-shadow: var(--elevacao-dropdown); max-height: 240px; overflow: auto; }
    .achado { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: var(--espacamento-2);
      padding: var(--espacamento-2) var(--espacamento-3); border: 0; background: transparent; color: var(--texto); font: inherit;
      text-align: left; cursor: pointer; }
    .achado:hover { background: var(--acao-suave); }
    .tel { font-size: 12px; color: var(--texto-suave); }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .encolhe { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class ListasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  protected readonly colunasListas: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Lista' },
    { chave: 'membros', rotulo: 'Membros', alinhamento: 'dir', mono: true, largura: '110px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '120px' },
  ]
  protected readonly colunasMembros: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Contato' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '120px' },
  ]

  readonly estado = signal<Estado>('carregando')
  readonly listas = signal<readonly Lista[]>([])
  protected readonly linhasListas = computed(() => this.listas() as unknown as readonly LinhaTabela[])
  readonly erroMembros = signal<string | null>(null)
  readonly selecionada = signal<Lista | null>(null)
  protected readonly marcadas = computed<ReadonlySet<string>>(() => {
    const s = this.selecionada()
    return new Set(s ? [s.id] : [])
  })
  readonly membros = signal<readonly Membro[]>([])
  protected readonly linhasMembros = computed(() => this.membros() as unknown as readonly LinhaTabela[])
  readonly temMais = signal(false)
  readonly temMaisListas = signal(false)
  readonly carregandoMais = signal(false)
  private cursorListas: string | null = null
  readonly criarAberto = signal(false)
  readonly novoNome = signal('')
  readonly criando = signal(false)
  readonly erroNova = signal<string | null>(null)
  readonly termo = signal('')
  readonly achados = signal<readonly AchadoContato[]>([])
  private cursor: string | null = null
  private buscaSeq = 0

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<PaginaListas>('/v1/listas'))
      this.listas.set(r.itens)
      this.cursorListas = r.proximoCursor ?? null
      this.temMaisListas.set(this.cursorListas !== null)
      this.estado.set('pronto')
      const sel = this.selecionada()
      if (sel) {
        // A lista aberta pode estar numa página ainda não carregada: só some se foi excluída.
        const atual = r.itens.find((l) => l.id === sel.id) ?? sel
        this.selecionada.set(atual)
        await this.carregarMembros()
      }
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async carregarMaisListas(): Promise<void> {
    if (!this.cursorListas || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<PaginaListas>(`/v1/listas?cursor=${encodeURIComponent(this.cursorListas)}`))
      this.listas.set([...this.listas(), ...r.itens])
      this.cursorListas = r.proximoCursor ?? null
      this.temMaisListas.set(this.cursorListas !== null)
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais listas.')) }
    finally { this.carregandoMais.set(false) }
  }

  abrir(l: Lista): void { this.selecionada.set(l); this.termo.set(''); this.achados.set([]); void this.carregarMembros() }

  async carregarMembros(anexar = false): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    if (!anexar) { this.cursor = null; this.membros.set([]) }
    const url = `/v1/listas/${l.id}/membros${this.cursor ? `?cursor=${encodeURIComponent(this.cursor)}` : ''}`
    this.erroMembros.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[]; proximoCursor: string | null }>(url))
      this.membros.set(anexar ? [...this.membros(), ...r.itens] : r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
    } catch (e) {
      // Parcial: a lista continua; só os membros não vieram — e a tela diz isso.
      this.erroMembros.set(mensagemDeErro(e, 'Não foi possível carregar os membros.'))
    }
  }

  fecharCriar(): void { if (!this.criando()) this.criarAberto.set(false) }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nome = this.novoNome().trim()
    if (this.criando()) return
    if (!nome) { this.erroNova.set('Informe o nome da lista.'); return }
    this.criando.set(true); this.erroNova.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/listas', { nome }))
      this.novoNome.set('')
      this.criarAberto.set(false)
      this.toast.sucesso('Lista criada')
      await this.carregar()
    } catch (e) {
      this.erroNova.set(e instanceof HttpErrorResponse && e.status === 409
        ? 'Já existe uma lista com esse nome.' : mensagemDeErro(e, 'Não foi possível criar a lista.'))
    } finally { this.criando.set(false) }
  }

  async excluir(id: string, ev: Event): Promise<void> {
    ev.stopPropagation()
    const l = this.listas().find((x) => x.id === id)
    const ok = await this.confirmacao.confirmar({
      titulo: 'Excluir lista?',
      mensagem: `"${l?.nome ?? 'Esta lista'}" some com os ${l?.membros ?? 0} membro(s). Os contatos continuam na base. Não dá para desfazer.`,
      acao: 'Excluir',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/listas/${id}`))
      if (this.selecionada()?.id === id) this.selecionada.set(null)
      this.toast.sucesso('Lista excluída')
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível excluir a lista.')) }
  }

  async buscar(q: string): Promise<void> {
    this.termo.set(q)
    const seq = ++this.buscaSeq
    if (q.trim().length < 2) { this.achados.set([]); return }
    try {
      const r = await firstValueFrom(this.http.get<{ itens: AchadoContato[] }>(`/v1/contatos/busca?q=${encodeURIComponent(q.trim())}`))
      if (seq === this.buscaSeq) this.achados.set(r.itens)
    } catch (e) {
      // Busca é digitação contínua: só a tentativa MAIS recente avisa, para não
      // empilhar um toast por tecla.
      if (seq === this.buscaSeq) { this.achados.set([]); this.toast.erro(mensagemDeErro(e, 'Não foi possível buscar contatos.')) }
    }
  }

  async adicionar(a: AchadoContato): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    try {
      await firstValueFrom(this.http.post(`/v1/listas/${l.id}/membros`, { contatoId: a.id }))
      this.termo.set(''); this.achados.set([])
      this.toast.sucesso(`${a.nome} adicionado à lista`)
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível adicionar o contato.')) }
  }

  async remover(contatoId: string): Promise<void> {
    const l = this.selecionada()
    if (!l) return
    const m = this.membros().find((x) => x.id === contatoId)
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover da lista?',
      mensagem: `${m?.nome ?? 'O contato'} sai de "${l.nome}". O cadastro dele continua na base.`,
      acao: 'Remover',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/listas/${l.id}/membros/${contatoId}`))
      this.toast.sucesso('Contato removido da lista')
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível remover o contato.')) }
  }
}
