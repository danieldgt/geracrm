import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Msg {
  readonly id: string; readonly criadoEm: string; readonly tipo: string; readonly status: string | null
  readonly preview: string; readonly contatoId: string | null; readonly contato: string | null; readonly enviadaPor: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const ABAS = [
  { chave: '', rotulo: 'Todas' },
  { chave: 'enviada', rotulo: 'Enviadas' },
  { chave: 'entregue', rotulo: 'Entregues' },
  { chave: 'falhou', rotulo: 'Falhas' },
]
const STATUS_ROTULO: Record<string, string> = { pendente: 'pendente', enviada: 'enviada', entregue: 'entregue', lida: 'lida', falhou: 'falhou' }

/**
 * Mensagens Enviadas — log das salientes: para quem, o quê (preview), quando,
 * quem enviou e o status. ⚠️ Mídia mostra rótulo, nunca o blob. Cursor.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-mensagens-enviadas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Mensagens Enviadas</h1>
      <p class="sub">Tudo o que saiu: individual e em massa, com status de entrega.</p>
    </header>

    <div class="abas">
      @for (a of abas; track a.chave) {
        <button [class.on]="aba() === a.chave" (click)="trocar(a.chave)">{{ a.rotulo }}</button>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nada por aqui</h2><p>Nenhuma mensagem enviada com esse filtro.</p></div>
        } @else {
          <ul class="lista">
            @for (m of itens(); track m.id) {
              <li class="msg">
                <div class="col encolhe">
                  <span class="prev encolhe">{{ m.preview }}</span>
                  <span class="meta">
                    @if (m.contato && m.contatoId) { <a [routerLink]="['/contato', m.contatoId]">{{ m.contato }}</a> }
                    @else { <span class="sem">sem contato</span> }
                    · {{ m.criadoEm | date: 'dd/MM HH:mm' }}
                    @if (m.enviadaPor) { · {{ m.enviadaPor }} }
                  </span>
                </div>
                <span class="status" [attr.data-s]="m.status">{{ m.status ? rotulo(m.status) : '—' }}</span>
              </li>
            }
          </ul>
          @if (temMais()) { <button class="mais" (click)="carregar(true)">Carregar mais</button> }
        }
      }
    }
  `,
  styles: `
    :host { display: block; max-width: 800px; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .abas { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .abas button { padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-completo); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .abas button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 48px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .msg { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .msg:last-child { border-bottom: none; }
    .col { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .prev { color: var(--texto); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 12px; color: var(--texto-suave); }
    .meta a { color: var(--acao); text-decoration: none; }
    .sem { color: var(--texto-suave); }
    .status { flex: none; font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto-secundario); }
    .status[data-s="enviada"], .status[data-s="entregue"], .status[data-s="lida"] { background: var(--sucesso-suave); color: var(--sucesso); }
    .status[data-s="falhou"] { background: var(--erro-suave); color: var(--erro); }
    .status[data-s="pendente"] { background: var(--atencao-suave); color: var(--atencao); }
    .mais { display: block; width: 100%; margin-top: var(--espacamento-2); padding: var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; cursor: pointer; }
  `,
})
export class MensagensEnviadasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly abas = ABAS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Msg[]>([])
  readonly temMais = signal(false)
  readonly aba = signal('')
  private cursor: string | null = null

  ngOnInit(): void { void this.carregar() }
  trocar(a: string): void { this.aba.set(a); void this.carregar() }
  rotulo(s: string): string { return STATUS_ROTULO[s] ?? s }

  async carregar(anexar = false): Promise<void> {
    if (!anexar) { this.estado.set('carregando'); this.cursor = null }
    try {
      const qs = new URLSearchParams()
      if (this.aba()) qs.set('status', this.aba())
      if (anexar && this.cursor) qs.set('cursor', this.cursor)
      const r = await firstValueFrom(this.http.get<{ itens: Msg[]; proximoCursor: string | null }>(`/v1/mensagens-enviadas?${qs}`))
      this.itens.set(anexar ? [...this.itens(), ...r.itens] : r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }
}
