import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  GradeFormComponente, IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente, ToastServico, ehStatus,
  mensagemDeErro, mesclarPagina, queryDeLista, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Webhook {
  readonly id: string
  readonly url: string
  readonly eventos: readonly string[]
  readonly ativo: boolean
  readonly entregueEm: string | null
  readonly ultimoErro: string | null
}
interface Pagina { readonly itens: Webhook[]; readonly proximoCursor: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Webhooks de saída (INT-07). Registra uma URL https e nós entregamos os eventos,
 * assinados (HMAC), com retry. ⚠️ O segredo aparece UMA vez, na criação — depois
 * não dá para revê-lo (guarde no seu sistema para validar a assinatura).
 */
@Component({
  selector: 'app-webhooks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, DatePipe, EstadoComponente,
    GradeFormComponente, IconeComponente, ModalComponente, PaginacaoComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Webhooks de saída"
      subtitulo="Receba nossos eventos no seu sistema. Cada entrega vem assinada e é reenviada se falhar.">
      <button type="button" class="btn btn--primario" (click)="novoAberto.set(true)">
        <ui-icone nome="plus" />Novo webhook
      </button>
    </ui-cabecalho-tela>

    @if (segredoNovo(); as s) {
      <div class="segredo" role="status">
        <strong>Guarde este segredo agora</strong> — ele não será mostrado de novo. Use-o para validar o
        header <code>X-GeraCRM-Signature</code>.
        <code class="valor">{{ s }}</code>
      </div>
    }

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso aos webhooks" descricao="Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os webhooks" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()">
            <ng-template uiCelula="url" let-w>{{ w.url }}</ng-template>
            <ng-template uiCelula="eventos" let-w>{{ w.eventos.length ? w.eventos.join(', ') : 'todos os eventos' }}</ng-template>
            <ng-template uiCelula="entrega" let-w>
              @if (w.entregueEm) { {{ w.entregueEm | date: 'dd/MM HH:mm' }} } @else { — }
            </ng-template>
            <ng-template uiCelula="situacao" let-w>
              @if (w.ultimoErro) {
                <ui-badge tom="erro"><ui-icone nome="alert-triangle" [tamanho]="14" />{{ w.ultimoErro }}</ui-badge>
              }
            </ng-template>
            <ng-template uiCelula="acoes" let-w>
              <button type="button" class="btn btn--perigo btn--pequeno" (click)="remover(w)" [disabled]="removendo().has(w.id)">
                {{ removendo().has(w.id) ? 'Removendo…' : 'Remover' }}
              </button>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhum webhook"
                descricao="Adicione uma URL https para começar a receber os eventos.">
                <button type="button" class="btn btn--primario" (click)="novoAberto.set(true)">Novo webhook</button>
              </ui-estado>
            </div>
          </ui-tabela>
          <ui-paginacao [mostrados]="itens().length" [temMais]="proximoCursor() !== null"
            [carregando]="carregandoMais()" (mais)="carregarMais()" />
        }
      }
    </div>

    <ui-modal [aberto]="novoAberto()" titulo="Novo webhook" largura="p" (fechar)="fecharNovo()">
      <form id="form-webhook" (submit)="adicionar($event)">
        <ui-grade-form>
          <ui-campo class="largo" rotulo="URL do webhook" placeholder="https://seu-sistema.com/webhook" autocomplete="off"
            dica="Precisa ser https." [obrigatorio]="true" [(valor)]="url" [erro]="erroAdd()" />
        </ui-grade-form>
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharNovo()">Cancelar</button>
        <button type="submit" form="form-webhook" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Criando…' : 'Criar webhook' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .segredo { margin: var(--espacamento-4) 0 0; padding: var(--espacamento-3) var(--espacamento-4); border: 1px solid var(--ativo); border-radius: var(--raio-painel); background: var(--superficie-elevada); font-size: 13px; color: var(--texto-secundario); }
    .segredo .valor { display: block; margin-top: var(--espacamento-2); padding: var(--espacamento-2); background: var(--fundo); border-radius: var(--raio-controle); font-family: var(--tipografia-familia-dados); font-size: 12px; color: var(--texto); word-break: break-all; }
    code { font-family: var(--tipografia-familia-dados); }
  `,
})
export class WebhooksPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'url', rotulo: 'URL', mono: true },
    { chave: 'eventos', rotulo: 'Eventos' },
    { chave: 'entrega', rotulo: 'Última entrega', mono: true, largura: '140px' },
    { chave: 'situacao', rotulo: 'Situação' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '130px' },
  ]

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Webhook[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly novoAberto = signal(false)
  readonly url = signal('')
  readonly salvando = signal(false)
  readonly erroAdd = signal<string | null>(null)
  readonly segredoNovo = signal<string | null>(null)
  readonly removendo = signal<ReadonlySet<string>>(new Set())

  ngOnInit(): void { void this.carregar() }

  private pagina(cursor: string | null): Promise<Pagina> {
    return firstValueFrom(this.http.get<Pagina>(`/v1/webhooks${queryDeLista({ cursor })}`))
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await this.pagina(null)
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehStatus(e, 403) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.pagina(cursor)
      this.itens.update((a) => mesclarPagina(a, r.itens, (w) => w.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais webhooks.'))
    } finally { this.carregandoMais.set(false) }
  }

  fecharNovo(): void { if (!this.salvando()) this.novoAberto.set(false) }

  async adicionar(ev: Event): Promise<void> {
    ev.preventDefault()
    const url = this.url().trim()
    if (this.salvando()) return
    if (!url) { this.erroAdd.set('Informe a URL do webhook.'); return }
    this.salvando.set(true)
    this.erroAdd.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ segredo: string }>('/v1/webhooks', { url }))
      this.segredoNovo.set(r.segredo)
      this.url.set('')
      this.novoAberto.set(false)
      this.toast.sucesso('Webhook adicionado')
      await this.carregar()
    } catch (e) {
      this.erroAdd.set(ehStatus(e, 422)
        ? 'URL inválida. Use uma URL https.' : mensagemDeErro(e, 'Não foi possível criar o webhook.'))
    } finally { this.salvando.set(false) }
  }

  async remover(w: Webhook): Promise<void> {
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover este webhook?',
      mensagem: `${w.url} deixa de receber eventos. Para voltar, cadastre de novo (gera outro segredo).`,
      acao: 'Remover',
    })
    if (!ok) return
    this.removendo.update((s) => new Set(s).add(w.id))
    try {
      await firstValueFrom(this.http.delete(`/v1/webhooks/${w.id}`))
      this.itens.update((a) => a.filter((x) => x.id !== w.id))
      this.toast.sucesso('Webhook removido')
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível remover o webhook.'))
    } finally {
      this.removendo.update((s) => { const n = new Set(s); n.delete(w.id); return n })
    }
  }
}
