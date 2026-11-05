import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  AbasComponente, type Aba, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente,
  TabelaComponente, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Msg {
  readonly id: string; readonly criadoEm: string; readonly tipo: string; readonly status: string | null
  readonly preview: string; readonly contatoId: string | null; readonly contato: string | null; readonly enviadaPor: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
type TomBadge = 'neutro' | 'sucesso' | 'atencao' | 'erro'

const ABAS: Aba[] = [
  { id: 'todas', rotulo: 'Todas' },
  { id: 'enviada', rotulo: 'Enviadas' },
  { id: 'entregue', rotulo: 'Entregues' },
  { id: 'falhou', rotulo: 'Falhas' },
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
  imports: [
    AbasComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, DatePipe, EstadoComponente,
    PaginacaoComponente, RouterLink, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Mensagens enviadas"
      subtitulo="Tudo o que saiu: individual e em massa, com status de entrega." />

    <ui-abas [abas]="abas" [ativa]="aba()" (ativaChange)="trocar($event)" />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às mensagens enviadas" descricao="Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as mensagens" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()">
            <ng-template uiCelula="preview" let-m>
              <span class="prev">{{ m.preview }}</span>
            </ng-template>
            <ng-template uiCelula="contato" let-m>
              @if (m.contato && m.contatoId) {
                <a class="contato" [routerLink]="['/contato', m.contatoId]">{{ m.contato }}</a>
              } @else {
                <span class="sem">sem contato</span>
              }
            </ng-template>
            <ng-template uiCelula="criadoEm" let-m>{{ m.criadoEm | date: 'dd/MM HH:mm' }}</ng-template>
            <ng-template uiCelula="status" let-m>
              @if (m.status) {
                <ui-badge [tom]="tomDoStatus(m.status)">{{ rotulo(m.status) }}</ui-badge>
              } @else {
                —
              }
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nada por aqui" descricao="Nenhuma mensagem enviada com esse filtro." />
            </div>
          </ui-tabela>
          <ui-paginacao [mostrados]="itens().length" [temMais]="temMais()" [carregando]="carregandoMais()"
            (mais)="carregarMais()" />
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .prev { display: block; max-width: 48ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .contato { color: var(--acao); text-decoration: none; }
    .contato:hover { text-decoration: underline; }
    .sem { color: var(--texto-suave); }
  `,
})
export class MensagensEnviadasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly abas = ABAS
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'preview', rotulo: 'Mensagem' },
    { chave: 'contato', rotulo: 'Para' },
    { chave: 'criadoEm', rotulo: 'Enviada em', mono: true, largura: '130px' },
    { chave: 'status', rotulo: 'Status', largura: '120px' },
  ]
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Msg[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  readonly temMais = signal(false)
  readonly carregandoMais = signal(false)
  readonly aba = signal('todas')
  private cursor: string | null = null

  ngOnInit(): void { void this.carregar() }
  trocar(a: string): void { this.aba.set(a); void this.carregar() }
  rotulo(s: string): string { return STATUS_ROTULO[s] ?? s }

  protected tomDoStatus(s: string): TomBadge {
    if (s === 'falhou') return 'erro'
    if (s === 'pendente') return 'atencao'
    if (s === 'enviada' || s === 'entregue' || s === 'lida') return 'sucesso'
    return 'neutro'
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.cursor = null
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Msg[]; proximoCursor: string | null }>(`/v1/mensagens-enviadas?${this.qs()}`))
      this.itens.set(r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async carregarMais(): Promise<void> {
    if (!this.cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Msg[]; proximoCursor: string | null }>(`/v1/mensagens-enviadas?${this.qs(this.cursor)}`))
      this.itens.set([...this.itens(), ...r.itens])
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
    finally { this.carregandoMais.set(false) }
  }

  private qs(cursor: string | null = null): URLSearchParams {
    const qs = new URLSearchParams()
    if (this.aba() !== 'todas') qs.set('status', this.aba())
    if (cursor) qs.set('cursor', cursor)
    return qs
  }
}
