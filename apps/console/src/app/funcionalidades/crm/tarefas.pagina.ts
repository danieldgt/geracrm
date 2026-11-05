import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  AbasComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  FiltrosComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ToastServico, mensagemDeErro, mesclarPagina, queryDeLista, type ColunaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { TarefaModalComponente } from './tarefa-modal.componente.js'
import {
  FILTROS_VAZIOS, OPCOES_TIPO_TAREFA, abaDaSituacao, abasComContador, parametrosDaLista, payloadConcluir, rotuloTipoTarefa,
  temFiltroAtivo, type ContadoresTarefa,
} from './tarefas.regras.js'

interface Tarefa {
  readonly id: string
  readonly titulo: string
  readonly venceEm: string
  readonly estado: string
  readonly tipo: string
  readonly resultado: string | null
  readonly vencida: boolean
  readonly contatoId: string | null
  readonly contato: string | null
  readonly responsavel: string | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Tarefas de follow-up — padrão Lista. Abas (com a contagem no rótulo) · filtros · tabela ·
 * paginação por cursor. "Atrasada" é derivada no servidor, no fuso do tenant. É a aba
 * "Tarefas" de Agenda e tarefas.
 */
@Component({
  selector: 'app-tarefas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe, RouterLink, AbasComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente,
    FiltrosComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
    TarefaModalComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Tarefas" subtitulo="Seu follow-up: com quem falar e quando.">
      <button type="button" class="btn btn--primario" (click)="modalNova.set(true)">+ Nova tarefa</button>
    </ui-cabecalho-tela>

    <ui-abas [abas]="abas()" [ativa]="abaAtiva()" (ativaChange)="trocarAba($event)" />

    @if (contatoId(); as cid) {
      <p class="chip-filtro">
        Tarefas de <a [routerLink]="['/contato', cid]">{{ contatoNome() ?? 'um contato' }}</a>
        · <a routerLink="/agenda-e-tarefas/lista" (click)="limparContato()">limpar</a>
      </p>
    }

    <ui-filtros placeholder="Buscar por título ou contato" rotuloBusca="Busca"
      (buscar)="buscar($event)" (aplicar)="carregar()" (limpar)="limparFiltros()">
      <ui-select rotulo="Tipo" placeholder="Todos" [opcoes]="tipos" [(valor)]="tipo" />
      <ui-select rotulo="Responsável" placeholder="Todos" [opcoes]="equipe()" [(valor)]="responsavelId" />
      <ui-campo rotulo="De" tipo="date" [(valor)]="de" />
      <ui-campo rotulo="Até" tipo="date" [(valor)]="ate" />
    </ui-filtros>

    @switch (estado()) {
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso" descricao="Peça a um administrador a permissão para ver tarefas." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as tarefas" descricao="Verifique a conexão e tente de novo.">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        <ui-tabela [colunas]="colunas" [linhas]="linhas()" [carregando]="estado() === 'carregando'">
          <ng-template uiCelula="contato" let-t>
            @if (t.contatoId) { <a class="link" [routerLink]="['/contato', t.contatoId]">{{ t.contato }}</a> }
            @else { <span class="suave">Avulsa</span> }
          </ng-template>
          <ng-template uiCelula="tipo" let-t>{{ rotulo(t.tipo) }}</ng-template>
          <ng-template uiCelula="titulo" let-t>
            <span class="tit">{{ t.titulo }}</span>
            @if (t.resultado) { <span class="res">{{ t.resultado }}</span> }
          </ng-template>
          <ng-template uiCelula="venceEm" let-t>
            <span [class.atrasada]="t.vencida">{{ t.venceEm | date: 'dd/MM/yyyy HH:mm' }}</span>
          </ng-template>
          <ng-template uiCelula="responsavel" let-t>{{ t.responsavel ?? '—' }}</ng-template>
          <ng-template uiCelula="acoes" let-t>
            @if (t.estado === 'aberta') {
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirConcluir(t.id)">Concluir</button>
                <button type="button" class="btn btn--fantasma btn--pequeno" (click)="cancelar(t.id)">Cancelar</button>
              </span>
            } @else {
              <span class="suave">{{ t.estado === 'concluida' ? 'Concluída' : 'Cancelada' }}</span>
            }
          </ng-template>
          <div uiVazio>
            <ui-estado titulo="Nada por aqui"
              [descricao]="temFiltro() ? 'Nenhuma tarefa com esses filtros. Ajuste a busca ou limpe os filtros.' : 'Sem tarefas nesta aba.'" />
          </div>
        </ui-tabela>
        @if (estado() === 'pronto') {
          <ui-paginacao [mostrados]="itens().length" [temMais]="!!proximoCursor()" [carregando]="carregandoMais()"
            (mais)="carregarMais()" />
        }
      }
    }

    <app-tarefa-modal [aberto]="modalNova()" [contatoId]="contatoId()" [contatoNome]="contatoNome()"
      (fechar)="modalNova.set(false)" (criada)="aoCriar()" />

    <ui-modal [aberto]="!!concluindoId()" titulo="Concluir tarefa" largura="p" (fechar)="concluindoId.set(null)">
      <form id="form-concluir" (submit)="concluir($event)">
        <ui-campo rotulo="Resultado" tipo="textarea" placeholder="O que aconteceu? (opcional)" [(valor)]="resultado" />
        @if (erroConcluir(); as e) { <p class="erro-modal" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="concluindoId.set(null)">Cancelar</button>
        <button type="submit" form="form-concluir" class="btn btn--primario" [disabled]="concluindo()">
          {{ concluindo() ? 'Concluindo…' : 'Concluir tarefa' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    ui-filtros { display: block; margin: var(--espacamento-3) 0; }
    ui-tabela { display: block; }
    .erro-modal { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
    .chip-filtro { display: inline-flex; align-items: center; gap: var(--espacamento-1); margin: 0 0 var(--espacamento-3); padding: var(--espacamento-1) var(--espacamento-3); border: 1px solid var(--acao); border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--texto); font-size: 12px; }
    .chip-filtro a, .link { color: var(--acao); text-decoration: none; }
    .chip-filtro a:hover, .link:hover { text-decoration: underline; }
    .suave { color: var(--texto-suave); }
    .tit { color: var(--texto); }
    .res { display: block; max-width: 36ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--texto-suave); font-size: 12px; }
    .atrasada { color: var(--erro); }
    .acoes { display: inline-flex; gap: var(--espacamento-1); }
  `,
})
export class TarefasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  protected readonly tipos: OpcaoSelect[] = OPCOES_TIPO_TAREFA.map((o) => ({ valor: o.valor, rotulo: o.rotulo }))
  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'contato', rotulo: 'Contato' },
    { chave: 'tipo', rotulo: 'Tipo' },
    { chave: 'titulo', rotulo: 'Título' },
    { chave: 'venceEm', rotulo: 'Vence em', mono: true },
    { chave: 'responsavel', rotulo: 'Responsável' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir' },
  ]

  protected readonly estado = signal<Estado>('carregando')
  protected readonly itens = signal<readonly Tarefa[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as Record<string, unknown>[])
  protected readonly proximoCursor = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  protected readonly contadores = signal<ContadoresTarefa | null>(null)
  protected readonly abas = computed(() => abasComContador(this.contadores()))
  protected readonly equipe = signal<OpcaoSelect[]>([])

  // Filtros (a aba mexe em `situacao`).
  protected readonly situacao = signal(FILTROS_VAZIOS.situacao)
  protected readonly busca = signal('')
  protected readonly tipo = signal('')
  protected readonly responsavelId = signal('')
  protected readonly de = signal('')
  protected readonly ate = signal('')
  /** Filtro por contato (`?contatoId=`), vindo da ficha. */
  protected readonly contatoId = signal<string | null>(null)
  protected readonly contatoNome = signal<string | null>(null)

  protected readonly abaAtiva = computed(() => abaDaSituacao(this.situacao()))
  private readonly filtros = computed(() => ({
    situacao: this.situacao(), busca: this.busca(), tipo: this.tipo(), responsavelId: this.responsavelId(),
    de: this.de(), ate: this.ate(), contatoId: this.contatoId(),
  }))
  protected readonly temFiltro = computed(() => temFiltroAtivo(this.filtros()))

  protected readonly modalNova = signal(false)
  protected readonly concluindoId = signal<string | null>(null)
  protected readonly concluindo = signal(false)
  /** Falha ao concluir fica no modal (o resultado digitado continua lá). */
  protected readonly erroConcluir = signal<string | null>(null)
  protected readonly resultado = signal('')

  ngOnInit(): void {
    this.contatoId.set(this.route.snapshot.queryParamMap.get('contatoId'))
    // Vindo da ficha, "Hoje" esconderia o histórico do cliente: abre em "Abertas".
    if (this.contatoId()) this.situacao.set('abertas')
    void this.carregarEquipe()
    void this.carregar()
  }

  protected rotulo = rotuloTipoTarefa

  protected trocarAba(id: string): void { this.situacao.set(id); void this.carregar() }
  protected buscar(texto: string): void { this.busca.set(texto); void this.carregar() }
  protected limparFiltros(): void {
    this.busca.set(''); this.tipo.set(''); this.responsavelId.set(''); this.de.set(''); this.ate.set('')
    void this.carregar()
  }
  protected limparContato(): void { this.contatoId.set(null); this.contatoNome.set(null); void this.carregar() }

  private url(cursor: string | null): string {
    return `/v1/tarefas${queryDeLista(parametrosDaLista(this.filtros(), cursor))}`
  }

  private async carregarEquipe(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/equipe'))
      this.equipe.set(r.itens.map((u) => ({ valor: u.id, rotulo: u.nome })))
    } catch { /* filtro por responsável some do alcance; a lista continua funcionando */ }
  }

  private async carregarContadores(): Promise<void> {
    try { this.contadores.set(await firstValueFrom(this.http.get<ContadoresTarefa>('/v1/tarefas/contadores'))) }
    catch { /* as abas ficam sem número; não derrubam a lista */ }
  }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    void this.carregarContadores()
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Tarefa[]; proximoCursor: string | null }>(this.url(null)))
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      // Nome do contato filtrado vem da própria lista (sem chamada extra).
      if (this.contatoId()) this.contatoNome.set(r.itens.find((t) => t.contato)?.contato ?? this.contatoNome())
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  protected async carregarMais(): Promise<void> {
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

  protected aoCriar(): void { this.modalNova.set(false); void this.carregar() }

  protected abrirConcluir(id: string): void { this.resultado.set(''); this.erroConcluir.set(null); this.concluindoId.set(id) }

  protected async concluir(ev: Event): Promise<void> {
    ev.preventDefault()
    const id = this.concluindoId()
    if (!id || this.concluindo()) return
    this.concluindo.set(true)
    this.erroConcluir.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/tarefas/${id}/concluir`, payloadConcluir(this.resultado())))
      this.toast.sucesso('Tarefa concluída')
      this.concluindoId.set(null)
      await this.carregar()
    } catch (e) { this.erroConcluir.set(mensagemDeErro(e, 'Não foi possível concluir a tarefa.')) }
    finally { this.concluindo.set(false) }
  }

  protected async cancelar(id: string): Promise<void> {
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
