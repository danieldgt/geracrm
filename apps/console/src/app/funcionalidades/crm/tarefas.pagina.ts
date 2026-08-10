import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

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
      <button class="primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Nova tarefa' }}</button>
    </header>

    @if (mostrarNova()) {
      <form class="nova" (submit)="criar($event)">
        <input class="titulo" [value]="titulo()" (input)="titulo.set($any($event.target).value)" placeholder="O que fazer? (ex.: ligar para o cliente)" />
        <input type="datetime-local" [value]="vence()" (input)="vence.set($any($event.target).value)" aria-label="Vencimento" />
        <button class="primario" type="submit" [disabled]="salvando() || !titulo().trim() || !vence()">
          {{ salvando() ? 'Criando…' : 'Criar' }}
        </button>
        @if (erroForm()) { <p class="erro">{{ erroForm() }}</p> }
      </form>
    }

    <div class="abas">
      @for (a of abas; track a.chave) {
        <button [class.on]="aba() === a.chave" (click)="trocar(a.chave)">{{ a.rotulo }}</button>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
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
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 760px; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .nova { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); align-items: center; margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .nova input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .nova .titulo { flex: 1; min-width: 200px; }
    .erro { width: 100%; margin: 0; color: var(--erro); font-size: 13px; }
    .abas { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .abas button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    button { cursor: pointer; }
    .primario { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; }
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
  `,
})
export class TarefasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly abas = ABAS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Tarefa[]>([])
  readonly aba = signal('hoje')
  readonly mostrarNova = signal(false)
  readonly titulo = signal(''); readonly vence = signal(''); readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  ngOnInit(): void { void this.carregar() }
  trocar(a: string): void { this.aba.set(a); void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Tarefa[] }>(`/v1/tarefas?situacao=${this.aba()}`))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
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
      await this.carregar()
    } catch { this.erroForm.set('Não foi possível criar a tarefa.') } finally { this.salvando.set(false) }
  }

  async concluir(id: string): Promise<void> {
    try { await firstValueFrom(this.http.post(`/v1/tarefas/${id}/concluir`, {})); await this.carregar() } catch { /* ignore */ }
  }
  async cancelar(id: string): Promise<void> {
    try { await firstValueFrom(this.http.post(`/v1/tarefas/${id}/cancelar`, {})); await this.carregar() } catch { /* ignore */ }
  }
}
