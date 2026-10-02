import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ConfirmacaoServico, ToastServico, ehStatus, mensagemDeErro, mesclarPagina, queryDeLista } from '../../compartilhado/ui/index.js'

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
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Sequências</h1>
      <p class="sub">Réguas de relacionamento: um playbook de toques que você aplica a um cliente e vira tarefas.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="grade"><div class="col"><div class="esq"></div><div class="esq"></div></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <div class="grade">
          <section class="col">
            <form class="nova" (submit)="criar($event)">
              <label class="campo rotulado">
                <span>Nome da sequência</span>
                <input [value]="novoNome()" (input)="novoNome.set($any($event.target).value)" placeholder="Ex.: Pós-venda" />
              </label>
              <button class="btn btn--primario" type="submit" [disabled]="criando() || !novoNome().trim()">+</button>
              @if (erroNova()) { <p class="erro" role="alert">{{ erroNova() }}</p> }
            </form>
            <ul class="seqs">
              @for (s of seqs(); track s.id) {
                <li class="sq" [class.on]="sel()?.id === s.id" (click)="abrir(s)">
                  <span class="sq-nome encolhe">{{ s.nome }}</span>
                  <span class="sq-qtd txt-dados">{{ s.passos }} passo{{ s.passos === 1 ? '' : 's' }}</span>
                  <button class="x" (click)="excluir(s, $event)" title="Excluir" aria-label="Excluir sequência">×</button>
                </li>
              }
              @if (seqs().length === 0) { <li class="vazio">Nenhuma sequência ainda.</li> }
            </ul>
            @if (proximoCursor()) {
              <button class="btn btn--secundario btn--bloco mais" (click)="carregarMais()" [disabled]="carregandoMais()">
                {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
              </button>
            }
          </section>

          <section class="col detalhe">
            @if (sel() === null) {
              <div class="bloco"><h2 class="txt-secao">Escolha uma sequência</h2><p>Selecione à esquerda para montar os passos e aplicar a um cliente.</p></div>
            } @else {
              <div class="det-topo">
                <h2 class="txt-secao encolhe">{{ sel()!.nome }}</h2>
              </div>

              @if (erroPassos()) { <p class="erro" role="alert">{{ erroPassos() }}</p> }
              <ol class="passos">
                @for (p of passos(); track p.seq) {
                  <li class="ps">
                    <span class="dn txt-dados">D+{{ p.offsetDias }}</span>
                    <div class="ps-txt encolhe">
                      <span class="ps-tit">{{ p.titulo }}</span>
                      @if (p.descricao) { <span class="ps-desc">{{ p.descricao }}</span> }
                    </div>
                    <button class="x" (click)="removerPasso(p)" title="Remover passo" aria-label="Remover passo">×</button>
                  </li>
                }
                @if (passos().length === 0) { <li class="vazio">Sem passos. Adicione o primeiro abaixo.</li> }
              </ol>

              <form class="novo-passo" (submit)="addPasso($event)">
                <span class="dp">D+</span>
                <input class="off" type="number" min="0" [value]="pOffset()" (input)="pOffset.set(+$any($event.target).value)" aria-label="Dias" />
                <input class="pt" [value]="pTitulo()" (input)="pTitulo.set($any($event.target).value)" placeholder="O que fazer neste toque" aria-label="Título do passo" />
                <button class="btn btn--primario" type="submit" [disabled]="addP() || !pTitulo().trim()">Adicionar</button>
                @if (erroPasso()) { <p class="erro" role="alert">{{ erroPasso() }}</p> }
              </form>

              <div class="aplicar">
                <h3 class="txt-secao">Aplicar a um cliente</h3>
                <p class="ap-sub">Cria uma tarefa por passo, com vencimento em D+N a partir de hoje.</p>
                <div class="busca">
                  <input [value]="termo()" (input)="buscar($any($event.target).value)" placeholder="Buscar contato…" aria-label="Buscar contato" [disabled]="passos().length === 0" />
                  @if (achados().length > 0) {
                    <ul class="achados">
                      @for (a of achados(); track a.id) { <li (click)="aplicar(a)">{{ a.nome }}</li> }
                    </ul>
                  }
                </div>
                @if (erroBusca()) { <p class="erro" role="alert">{{ erroBusca() }}</p> }
                @if (msg(); as m) { <p [class.ok]="m.ok" [class.erro]="!m.ok" [attr.role]="m.ok ? 'status' : 'alert'">{{ m.texto }}</p> }
              </div>
            }
          </section>
        </div>
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; max-width: 60ch; }
    .grade { display: grid; grid-template-columns: 300px 1fr; gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: 1fr; } }
    .col { min-width: 0; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .nova { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-3); flex-wrap: wrap; align-items: end; }
    .nova .campo { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 4px; }
    .nova .campo > span { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .nova input { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .seqs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .sq { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .sq:last-child { border-bottom: none; }
    .sq:hover { background: var(--superficie); }
    .sq.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    .sq-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .sq-qtd { color: var(--texto-secundario); font-size: 12px; }
    .vazio { padding: var(--espacamento-6); text-align: center; color: var(--texto-suave); font-size: 13px; }
    .mais { margin-top: var(--espacamento-2); }
    .det-topo { margin-bottom: var(--espacamento-3); }
    .det-topo h2 { margin: 0; }
    .passos { list-style: none; margin: 0 0 var(--espacamento-3); padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .ps { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .ps:last-child { border-bottom: none; }
    .dn { flex: none; min-width: 42px; color: var(--acao); font-weight: 600; font-size: 12px; }
    .ps-txt { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .ps-tit { color: var(--texto); font-size: 14px; }
    .ps-desc { color: var(--texto-suave); font-size: 12px; }
    .x { border: 0; background: transparent; color: var(--texto-suave); font-size: 16px; padding: 0 4px; cursor: pointer; flex: none; }
    .x:hover { color: var(--erro); }
    .novo-passo { display: flex; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-6); flex-wrap: wrap; padding: var(--espacamento-3); border: 1px dashed var(--borda-forte); border-radius: var(--raio-painel); }
    .dp { color: var(--texto-secundario); font-size: 13px; }
    .off { width: 60px; padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; text-align: center; }
    .pt { flex: 1; min-width: 160px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .aplicar { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie); }
    .aplicar h3 { margin: 0; }
    .ap-sub { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .busca { position: relative; }
    .busca input { width: 100%; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; }
    .busca input:disabled { opacity: .6; }
    .achados { position: absolute; z-index: 5; left: 0; right: 0; margin: var(--espacamento-1) 0 0; padding: 0; list-style: none; border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie-elevada); box-shadow: var(--elevacao-dropdown); max-height: 220px; overflow: auto; }
    .achados li { padding: var(--espacamento-2) var(--espacamento-3); cursor: pointer; }
    .achados li:hover { background: var(--acao-suave); }
    .ok { margin: var(--espacamento-3) 0 0; color: var(--sucesso); font-size: 13px; }
    .aplicar .erro { margin-top: var(--espacamento-3); }
  `,
})
export class SequenciasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  readonly estado = signal<Estado>('carregando')
  readonly seqs = signal<readonly Sequencia[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly sel = signal<Sequencia | null>(null)
  readonly passos = signal<readonly Passo[]>([])
  readonly erroPassos = signal<string | null>(null)
  readonly novoNome = signal(''); readonly criando = signal(false); readonly erroNova = signal<string | null>(null)
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

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    const nome = this.novoNome().trim()
    if (this.criando() || !nome) return
    this.criando.set(true); this.erroNova.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/sequencias', { nome }))
      this.novoNome.set('')
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

  async addPasso(ev: Event): Promise<void> {
    ev.preventDefault()
    const s = this.sel(); const titulo = this.pTitulo().trim()
    if (!s || this.addP() || !titulo) return
    this.addP.set(true); this.erroPasso.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/sequencias/${s.id}/passos`, { offsetDias: this.pOffset(), titulo }))
      this.pTitulo.set('')
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
