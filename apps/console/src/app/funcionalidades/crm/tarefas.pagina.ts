import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ConfirmacaoServico, ToastServico, mensagemDeErro, mesclarPagina, queryDeLista } from '../../compartilhado/ui/index.js'

interface Tarefa {
  readonly id: string
  readonly titulo: string
  readonly venceEm: string
  readonly estado: string
  readonly vencida: boolean
  readonly contatoId: string | null
  readonly contato: string | null
  readonly responsavel: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const ABAS = [
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: 'vencidas', rotulo: 'Vencidas' },
  { chave: 'abertas', rotulo: 'Abertas' },
  { chave: 'concluidas', rotulo: 'Concluídas' },
]

/**
 * Tarefas de follow-up — agenda do vendedor. "Vencida" é derivada no servidor.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo).
 */
@Component({
  selector: 'app-tarefas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Tarefas</h1>
        <p class="sub">Seu follow-up: com quem falar e quando.</p>
      </div>
      <button class="btn btn--primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Nova tarefa' }}</button>
    </header>

    @if (mostrarNova()) {
      <form class="nova" (submit)="criar($event)">
        <label class="campo rotulado titulo">
          <span>O que fazer</span>
          <input [value]="titulo()" (input)="titulo.set($any($event.target).value)" placeholder="Ex.: ligar para o cliente" />
        </label>
        <label class="campo rotulado">
          <span>Vence em</span>
          <input type="datetime-local" [value]="vence()" (input)="vence.set($any($event.target).value)" />
        </label>
        <button class="btn btn--primario" type="submit" [disabled]="salvando() || !titulo().trim() || !vence()">
          {{ salvando() ? 'Criando…' : 'Criar' }}
        </button>
        @if (erroForm()) { <p class="erro">{{ erroForm() }}</p> }
      </form>
    }

    <div class="abas">
      @for (a of abas; track a.chave) {
        <button [class.on]="aba() === a.chave" (click)="trocar(a.chave)">{{ a.rotulo }}</button>
      }
      @if (contatoId(); as cid) {
        <!-- Vindo da ficha: a agenda mostra só este cliente, e diz isso. -->
        <span class="chip-filtro">
          Tarefas de <a [routerLink]="['/contato', cid]">{{ contatoNome() ?? 'um contato' }}</a>
          · <a routerLink="/tarefas" (click)="limparContato()">limpar</a>
        </span>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nada por aqui</h2><p>Sem tarefas nesta aba.</p></div>
        } @else {
          <ul class="lista">
            @for (t of itens(); track t.id) {
              <li class="tar" [class.venc]="t.vencida">
                <div class="col encolhe">
                  <span class="tit">{{ t.titulo }}</span>
                  <span class="meta">
                    @if (t.contato && t.contatoId) { <a [routerLink]="['/contato', t.contatoId]">{{ t.contato }}</a> · }
                    <span [class.ruim]="t.vencida">{{ t.venceEm | date: 'dd/MM HH:mm' }}</span>
                    @if (t.responsavel) { · {{ t.responsavel }} }
                  </span>
                </div>
                @if (t.estado === 'aberta') {
                  <button class="ok" (click)="concluir(t.id)">✓ Concluir</button>
                  <button class="x" (click)="cancelar(t.id)" title="Cancelar">×</button>
                } @else {
                  <span class="badge">{{ t.estado === 'concluida' ? 'Concluída' : 'Cancelada' }}</span>
                }
              </li>
            }
          </ul>
          @if (proximoCursor()) {
            <button class="btn btn--secundario mais" (click)="carregarMais()" [disabled]="carregandoMais()">
              {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .nova .campo.rotulado { display: flex; flex-direction: column; gap: 4px; }
    .nova .campo.rotulado > span { font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .nova .campo.rotulado input { width: 100%; }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: end; margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .nova input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .nova .titulo { flex: 1; min-width: 200px; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .abas { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .abas button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .chip-filtro { display: inline-flex; align-items: center; gap: 4px; padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--texto); font-size: 12px; }
    .chip-filtro a { color: var(--acao); text-decoration: none; }
    .chip-filtro a:hover { text-decoration: underline; }
    button { cursor: pointer; }
    .primario:disabled { opacity: .6; cursor: default; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .esq { height: 52px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .tar { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .tar:last-child { border-bottom: none; }
    .tar.venc { border-left: 3px solid var(--erro); }
    .col { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .tit { color: var(--texto); font-size: 14px; }
    .meta { font-size: 12px; color: var(--texto-suave); }
    .meta a { color: var(--acao); text-decoration: none; }
    .meta .ruim { color: var(--erro); }
    .ok { padding: 3px 10px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--sucesso); font: inherit; font-size: 12px; flex: none; }
    .x { border: 0; background: transparent; color: var(--texto-suave); font-size: 16px; padding: 0 4px; flex: none; }
    .x:hover { color: var(--erro); }
    .badge { font-size: 11px; color: var(--texto-suave); flex: none; }
    .mais { margin-top: var(--espacamento-4); }
  `,
})
export class TarefasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)
  /** Filtro por contato (`?contatoId=`), vindo da ficha. */
  readonly contatoId = signal<string | null>(null)
  readonly contatoNome = signal<string | null>(null)
  readonly abas = ABAS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Tarefa[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly aba = signal('hoje')
  readonly mostrarNova = signal(false)
  readonly titulo = signal(''); readonly vence = signal(''); readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  ngOnInit(): void {
    this.contatoId.set(this.route.snapshot.queryParamMap.get('contatoId'))
    // Vindo da ficha, "Hoje" esconderia o histórico do cliente: abre em "Abertas".
    if (this.contatoId()) this.aba.set('abertas')
    void this.carregar()
  }
  trocar(a: string): void { this.aba.set(a); void this.carregar() }
  limparContato(): void { this.contatoId.set(null); this.contatoNome.set(null); void this.carregar() }

  private url(cursor: string | null): string {
    return `/v1/tarefas${queryDeLista({ situacao: this.aba(), contatoId: this.contatoId(), cursor })}`
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Tarefa[]; proximoCursor: string | null }>(this.url(null)))
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      // Nome do contato filtrado vem da própria lista (sem chamada extra).
      if (this.contatoId()) this.contatoNome.set(r.itens.find((t) => t.contato)?.contato ?? this.contatoNome())
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Tarefa[]; proximoCursor: string | null }>(this.url(cursor)))
      this.itens.update((a) => mesclarPagina(a, r.itens, (t) => t.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais tarefas.')) }
    finally { this.carregandoMais.set(false) }
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/tarefas', {
        titulo: this.titulo().trim(), venceEm: new Date(this.vence()).toISOString(),
      }))
      this.titulo.set(''); this.vence.set(''); this.mostrarNova.set(false)
      this.toast.sucesso('Tarefa criada')
      await this.carregar()
    } catch (e) { this.erroForm.set(mensagemDeErro(e, 'Não foi possível criar a tarefa.')) }
    finally { this.salvando.set(false) }
  }

  async concluir(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/tarefas/${id}/concluir`, {}))
      this.toast.sucesso('Tarefa concluída')
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível concluir a tarefa.')) }
  }
  async cancelar(id: string): Promise<void> {
    const t = this.itens().find((x) => x.id === id)
    const ok = await this.confirmacao.confirmar({
      titulo: 'Cancelar tarefa?',
      mensagem: `"${t?.titulo ?? 'A tarefa'}" sai da agenda sem ser concluída. Não dá para desfazer.`,
      acao: 'Cancelar tarefa',
      cancelar: 'Manter',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.post(`/v1/tarefas/${id}/cancelar`, {}))
      this.toast.sucesso('Tarefa cancelada')
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível cancelar a tarefa.')) }
  }
}
