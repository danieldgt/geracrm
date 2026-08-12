import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Webhook {
  readonly id: string
  readonly url: string
  readonly eventos: readonly string[]
  readonly ativo: boolean
  readonly entregueEm: string | null
  readonly ultimoErro: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Webhooks de saída (INT-07). Registra uma URL https e nós entregamos os eventos,
 * assinados (HMAC), com retry. ⚠️ O segredo aparece UMA vez, na criação — depois
 * não dá para revê-lo (guarde no seu sistema para validar a assinatura).
 */
@Component({
  selector: 'app-webhooks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <h1>Webhooks de saída</h1>
      <p class="sub">Receba nossos eventos no seu sistema. Cada entrega vem assinada e é reenviada se falhar.</p>
    </header>

    <form class="add" (submit)="adicionar($event)">
      <input [value]="url()" (input)="url.set($any($event.target).value)"
             placeholder="https://seu-sistema.com/webhook" inputmode="url" aria-label="URL do webhook" />
      <button class="primario" type="submit" [disabled]="salvando() || !url().trim()">
        {{ salvando() ? 'Criando…' : 'Adicionar' }}
      </button>
    </form>
    @if (erroAdd(); as e) { <p class="erro" role="alert">{{ e }}</p> }

    @if (segredoNovo(); as s) {
      <div class="segredo" role="status">
        <strong>Guarde este segredo agora</strong> — ele não será mostrado de novo. Use-o para validar o
        header <code>X-GeraCRM-Signature</code>.
        <code class="valor">{{ s }}</code>
      </div>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="bloco"><div class="esqueleto"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2>Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco aviso"><h2>Não foi possível carregar</h2>
        <button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco vazio"><h2>Nenhum webhook</h2>
            <p>Adicione uma URL https para começar a receber os eventos.</p></div>
        } @else {
          <ul class="lista">
            @for (w of itens(); track w.id) {
              <li class="item">
                <div class="col">
                  <span class="url">{{ w.url }}</span>
                  <span class="meta">
                    {{ w.eventos.length ? w.eventos.join(', ') : 'todos os eventos' }}
                    @if (w.entregueEm) { · última entrega {{ w.entregueEm | date: 'dd/MM HH:mm' }} }
                    @if (w.ultimoErro) { · <span class="ruim">⚠️ {{ w.ultimoErro }}</span> }
                  </span>
                </div>
                <button class="remover" (click)="remover(w.id)" [disabled]="removendo().has(w.id)">
                  {{ removendo().has(w.id) ? '…' : 'Remover' }}
                </button>
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .add { display: flex; gap: var(--espacamento-2); margin-bottom: var(--espacamento-2); }
    .add input { flex: 1; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    button { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto); font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: default; }
    .primario { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .erro { color: var(--erro); font-size: 13px; margin: 0 0 var(--espacamento-3); }
    .segredo { margin: 0 0 var(--espacamento-4); padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--ativo); border-radius: var(--raio-painel); background: var(--superficie-elevada); font-size: 13px; color: var(--texto-secundario); }
    .segredo .valor { display: block; margin-top: var(--espacamento-2); padding: var(--espacamento-2); background: var(--fundo); border-radius: var(--raio-controle); font-family: var(--tipografia-familia-dados, monospace); font-size: 12px; color: var(--texto); word-break: break-all; }
    code { font-family: var(--tipografia-familia-dados, monospace); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; margin-top: var(--espacamento-4); }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .esqueleto { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); }
    .lista { list-style: none; margin: var(--espacamento-4) 0 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    .item { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .item:last-child { border-bottom: none; }
    .col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .url { font-size: 13px; color: var(--texto); font-family: var(--tipografia-familia-dados, monospace); word-break: break-all; }
    .meta { font-size: 12px; color: var(--texto-suave); }
    .meta .ruim { color: var(--erro); }
    .remover { font-size: 12px; padding: 4px 10px; flex: none; }
  `,
})
export class WebhooksPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Webhook[]>([])
  readonly url = signal('')
  readonly salvando = signal(false)
  readonly erroAdd = signal<string | null>(null)
  readonly segredoNovo = signal<string | null>(null)
  readonly removendo = signal<ReadonlySet<string>>(new Set())

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Webhook[] }>('/v1/webhooks'))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async adicionar(ev: Event): Promise<void> {
    ev.preventDefault()
    const url = this.url().trim()
    if (!url || this.salvando()) return
    this.salvando.set(true)
    this.erroAdd.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ segredo: string }>('/v1/webhooks', { url }))
      this.segredoNovo.set(r.segredo)
      this.url.set('')
      await this.carregar()
    } catch (e) {
      this.erroAdd.set(e instanceof HttpErrorResponse && e.status === 422
        ? 'URL inválida. Use uma URL https.' : 'Não foi possível criar o webhook.')
    } finally { this.salvando.set(false) }
  }

  async remover(id: string): Promise<void> {
    this.removendo.update((s) => new Set(s).add(id))
    try {
      await firstValueFrom(this.http.delete(`/v1/webhooks/${id}`))
      this.itens.update((a) => a.filter((w) => w.id !== id))
    } catch { /* mantém */ } finally {
      this.removendo.update((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }
}
