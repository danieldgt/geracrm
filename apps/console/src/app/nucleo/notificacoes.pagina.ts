import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { Router, RouterLink } from '@angular/router'
import {
  BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente,
  SelectComponente, TabelaComponente, ToastServico, type ColunaTabela,
} from '../compartilhado/ui/index.js'
import { InboxServico } from './inbox.servico.js'
import { NotificacoesListaServico } from './notificacoes-lista.servico.js'
import {
  FILTRO_NOTIFICACAO_VAZIO, OPCOES_LIDA, OPCOES_TIPO, alvoDaNotificacao, filtroNotificacaoAtivo, rotuloDoTipo,
  tituloDaNotificacao, type FiltroNotificacao, type NotificacaoItem,
} from './notificacoes.regras.js'

/**
 * Notificações — a página inteira do sino (D4), padrão Lista (L).
 *
 * ⚠️ SEMPRE as do usuário do token (a API não aceita outro). Lista por CURSOR; filtros (lida/não lida e
 * tipo) vão para o servidor. Abrir leva ao alvo: a conversa abre no chat da casca, as demais levam à
 * tela do assunto — e a notificação é marcada como lida no caminho.
 */
@Component({
  selector: 'app-notificacoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente,
    RouterLink, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Notificações" subtitulo="Os avisos que chegaram para você. Só você vê esta lista.">
      <a class="btn btn--secundario" routerLink="/perfil" fragment="preferencias">Preferências de aviso</a>
      <button type="button" class="btn btn--primario" [disabled]="servico.marcando() || servico.itens().length === 0"
              (click)="marcarTodas()">Marcar todas como lidas</button>
    </ui-cabecalho-tela>

    <form class="filtros" (submit)="$event.preventDefault()">
      <ui-select rotulo="Situação" placeholder="Todas" [opcoes]="opcoesLida" [valor]="filtro().lida"
                 (valorChange)="mudar({ lida: $any($event) })" />
      <ui-select rotulo="Tipo" placeholder="Todos os tipos" [opcoes]="opcoesTipo" [valor]="filtro().tipo"
                 (valorChange)="mudar({ tipo: $event })" />
      @if (temFiltro()) {
        <button type="button" class="btn btn--secundario btn--pequeno" (click)="limpar()">Limpar</button>
      }
    </form>

    @switch (servico.estado()) {
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as notificações" [descricao]="servico.erro() ?? ''">
          <button type="button" class="btn btn--secundario" (click)="recarregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="servico.estado() === 'carregando'">
          <ng-template uiCelula="aviso" let-linha>
            <span class="aviso" [class.nao-lida]="!linha.lida">
              <span class="ponto" [class.on]="!linha.lida" aria-hidden="true"></span>
              <span class="texto">{{ linha.aviso }}</span>
              @if (!linha.lida) { <span class="sr-only"> (não lida)</span> }
            </span>
          </ng-template>
          <ng-template uiCelula="tipo" let-linha>
            <ui-badge tom="neutro">{{ linha.tipo }}</ui-badge>
          </ng-template>
          <ng-template uiCelula="acoes" let-linha>
            <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrir(linha.id)">Abrir</button>
            @if (!linha.lida) {
              <button type="button" class="btn btn--fantasma btn--pequeno" (click)="servico.marcarLida(linha.id)">Marcar lida</button>
            }
          </ng-template>
          <div uiVazio>
            @if (temFiltro()) {
              <ui-estado titulo="Nenhum aviso com esse filtro" descricao="Tire um dos filtros para ver os outros avisos.">
                <button type="button" class="btn btn--secundario" (click)="limpar()">Limpar filtros</button>
              </ui-estado>
            } @else {
              <ui-estado titulo="Nada por aqui" descricao="Quando chegar mensagem, SLA estourado ou lembrete, aparece nesta lista." />
            }
          </div>
        </ui-tabela>
        <ui-paginacao [mostrados]="servico.itens().length" [temMais]="!!servico.proximoCursor()"
                      [carregando]="servico.carregandoMais()" (mais)="servico.carregarMais()" />
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; }
    .filtros { display: flex; flex-wrap: wrap; align-items: end; gap: var(--espacamento-3);
      padding: var(--espacamento-4); margin-bottom: var(--espacamento-4); background: var(--superficie);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); }
    .filtros ui-select { min-width: 200px; }
    .aviso { display: inline-flex; align-items: center; gap: var(--espacamento-2); min-width: 0; }
    .aviso.nao-lida .texto { font-weight: 600; }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); background: transparent; flex: none; }
    .ponto.on { background: var(--acao); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `,
})
export class NotificacoesPagina implements OnInit {
  protected readonly servico = inject(NotificacoesListaServico)
  private readonly router = inject(Router)
  private readonly inbox = inject(InboxServico)
  private readonly toast = inject(ToastServico)

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'aviso', rotulo: 'Aviso' },
    { chave: 'tipo', rotulo: 'Tipo', largura: '260px' },
    { chave: 'quando', rotulo: 'Quando', mono: true, largura: '140px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '200px' },
  ]
  protected readonly opcoesLida = [...OPCOES_LIDA]
  protected readonly opcoesTipo = [...OPCOES_TIPO]

  protected readonly filtro = signal<FiltroNotificacao>(FILTRO_NOTIFICACAO_VAZIO)
  protected readonly temFiltro = computed(() => filtroNotificacaoAtivo(this.filtro()))
  protected readonly linhas = computed(() => this.servico.itens().map((n) => ({
    id: n.id, lida: n.lida, aviso: tituloDaNotificacao(n), tipo: rotuloDoTipo(n.tipo), quando: quando(n.criadoEm),
  })))

  ngOnInit(): void { void this.servico.carregar(this.filtro()) }

  protected mudar(parcial: Partial<FiltroNotificacao>): void {
    this.filtro.update((f) => ({ ...f, ...parcial }))
    void this.servico.carregar(this.filtro())
  }

  protected limpar(): void {
    this.filtro.set(FILTRO_NOTIFICACAO_VAZIO)
    void this.servico.carregar(this.filtro())
  }

  protected recarregar(): void { void this.servico.carregar(this.filtro()) }

  protected async marcarTodas(): Promise<void> {
    const ok = await this.servico.marcarTodas()
    if (ok) this.toast.sucesso('Todas as notificações foram marcadas como lidas.')
    else this.toast.erro('Não foi possível marcar como lidas. Tente de novo.')
  }

  protected async abrir(id: string): Promise<void> {
    const n: NotificacaoItem | undefined = this.servico.itens().find((i) => i.id === id)
    if (!n) return
    if (!n.lida) void this.servico.marcarLida(n.id)
    const alvo = alvoDaNotificacao(n)
    if (alvo.tipo === 'conversa') await this.inbox.abrir(alvo.conversaId)
    else if (alvo.tipo === 'rota') await this.router.navigateByUrl(alvo.rota)
  }
}

/** dd/mm hh:mm no fuso local, para a coluna Quando. */
function quando(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const z = (v: number): string => String(v).padStart(2, '0')
  return `${z(d.getDate())}/${z(d.getMonth() + 1)} ${z(d.getHours())}:${z(d.getMinutes())}`
}
