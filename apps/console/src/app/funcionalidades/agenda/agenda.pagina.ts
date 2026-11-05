import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { EventoAgenda } from '@geracrm/shared'
import {
  BadgeComponente, CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente, SelectComponente, queryDeLista,
  type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { ModulosServico } from '../../nucleo/modulos.servico.js'
import { AgendaDetalheModalComponente } from './agenda-detalhe-modal.componente.js'
import { AgendaEventoModalComponente } from './agenda-evento-modal.componente.js'
import {
  DIAS_DA_SEMANA, cabeNoDia, diaIso, eventosPorDia, horaLocal, janelaDaGrade, montarGradeMes, mudarMes, rotuloMes,
  rotuloStatusEvento, rotuloTipoEvento, tomDoStatus,
} from './agenda.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Agenda — visão Mês + "Eventos do dia". Módulo opcional: com o módulo desligado a rota mostra um
 * estado explicando onde ligar (e a API responderia 404). A API recebe a JANELA da grade (≤ 42 dias);
 * o filtro de responsável só aparece para quem vê a agenda de todos (`escopo: 'todos'`).
 */
@Component({
  selector: 'app-agenda',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe, RouterLink, BadgeComponente, CabecalhoTelaComponente, EsqueletoComponente, EstadoComponente, SelectComponente,
    AgendaDetalheModalComponente, AgendaEventoModalComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Agenda" subtitulo="Reuniões, ligações e visitas com seus clientes.">
      @if (modulos.agendaAtiva()) {
        <button type="button" class="btn btn--primario" (click)="abrirNovo(diaSelecionado())">+ Novo evento</button>
      }
    </ui-cabecalho-tela>

    @if (!modulos.carregado()) {
      <ui-esqueleto altura="320px" />
    } @else if (!modulos.agendaAtiva()) {
      <ui-estado titulo="Agenda desligada"
        descricao="Um administrador liga a Agenda em Configurações › Módulos.">
        <a class="btn btn--secundario" routerLink="/config">Abrir Configurações</a>
      </ui-estado>
    } @else {
      <div class="barra">
        <div class="nav" role="group" aria-label="Navegar entre meses">
          <button type="button" class="btn btn--secundario btn--pequeno" aria-label="Mês anterior" (click)="mover(-1)">‹</button>
          <button type="button" class="btn btn--secundario btn--pequeno" (click)="irParaHoje()">Hoje</button>
          <button type="button" class="btn btn--secundario btn--pequeno" aria-label="Próximo mês" (click)="mover(1)">›</button>
        </div>
        <h2 class="mes">{{ rotuloDoMes() }}</h2>
        @if (escopo() === 'todos') {
          <ui-select class="filtro" rotulo="Responsável" placeholder="Todos" [opcoes]="equipe()" [(valor)]="responsavelId"
            (valorChange)="carregar()" />
        }
      </div>

      @switch (estado()) {
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso" descricao="Peça a um administrador a permissão para ver a agenda." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a agenda" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @default {
          <div class="corpo" [class.carregando]="estado() === 'carregando'">
            <div class="calendario" role="grid" [attr.aria-label]="rotuloDoMes()" [attr.aria-busy]="estado() === 'carregando'">
              <div class="cabecalho-semana" role="row">
                @for (d of diasDaSemana; track d) { <span role="columnheader">{{ d }}</span> }
              </div>
              @for (semana of grade(); track $index) {
                <div class="semana" role="row">
                  @for (dia of semana; track dia.iso) {
                    <div class="dia" role="gridcell" [class.fora]="!dia.doMes" [class.hoje]="dia.hoje"
                      [class.selecionado]="dia.iso === diaSelecionado()" [attr.aria-selected]="dia.iso === diaSelecionado()">
                      <button type="button" class="num" [attr.aria-label]="'Dia ' + dia.dia + ' de ' + rotuloDoMes()" (click)="selecionar(dia.iso)">{{ dia.dia }}</button>
                      @let c = cabe(dia.iso);
                      @for (e of c.visiveis; track e.id) {
                        <button type="button" class="chip" [class.apagado]="e.status !== 'agendado'" [attr.data-cor]="e.cor"
                          [title]="e.titulo" (click)="abrirDetalhe(e)">
                          <span class="hora">{{ hora(e.inicio) }}</span> {{ e.titulo }}
                        </button>
                      }
                      @if (c.restantes > 0) {
                        <button type="button" class="mais" (click)="selecionar(dia.iso)">+{{ c.restantes }}</button>
                      }
                    </div>
                  }
                </div>
              }
            </div>

            <aside class="painel-dia" aria-label="Eventos do dia">
              <h3>Eventos do dia</h3>
              <p class="data-dia">{{ dataSelecionada() | date: "EEEE, dd 'de' MMMM" }}</p>
              @for (e of eventosDoDia(); track e.id) {
                <button type="button" class="item" [attr.data-cor]="e.cor" (click)="abrirDetalhe(e)">
                  <span class="item-hora">{{ hora(e.inicio) }}–{{ hora(e.fim) }}</span>
                  <span class="item-titulo">{{ e.titulo }}</span>
                  <span class="item-meta">
                    {{ tipo(e.tipo) }}@if (e.contato) { · {{ e.contato }} }
                  </span>
                  @if (e.status !== 'agendado') { <ui-badge [tom]="tom(e.status)">{{ status(e.status) }}</ui-badge> }
                </button>
              } @empty {
                <p class="vazio">Nada marcado para este dia.</p>
              }
              <button type="button" class="btn btn--secundario" (click)="abrirNovo(diaSelecionado())">+ Agendar neste dia</button>
              @if (truncado()) {
                <p class="aviso">Há mais eventos do que a tela mostra. Filtre por responsável.</p>
              }
            </aside>
          </div>
        }
      }

      <app-agenda-evento-modal [aberto]="modalNovo()" [dataInicial]="dataNovo()" [equipe]="equipeModal()"
        (fechar)="modalNovo.set(false)" (criado)="aoMudar()" />
      <app-agenda-detalhe-modal [evento]="aberto()" (fechar)="aberto.set(null)" (alterado)="aoMudar()" />
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .barra { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); }
    .nav { display: inline-flex; gap: var(--espacamento-1); }
    .mes { margin: 0; font-size: 18px; color: var(--texto); min-width: 0; flex: 1 1 auto; }
    .filtro { width: 220px; max-width: 100%; }
    .corpo { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--espacamento-4); transition: opacity 120ms; }
    .corpo.carregando { opacity: 0.6; }
    @media (min-width: 1100px) { .corpo { grid-template-columns: minmax(0, 1fr) 300px; align-items: start; } }
    .calendario { border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    .cabecalho-semana, .semana { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .cabecalho-semana span { padding: var(--espacamento-2); text-align: center; font-size: 12px; font-weight: 600; color: var(--texto-secundario); background: var(--superficie); border-bottom: 1px solid var(--borda); }
    .dia { display: flex; flex-direction: column; gap: 2px; min-width: 0; min-height: 104px; padding: var(--espacamento-1); border-right: 1px solid var(--borda); border-bottom: 1px solid var(--borda); }
    .dia:nth-child(7n) { border-right: 0; }
    .semana:last-child .dia { border-bottom: 0; }
    .dia.fora { background: var(--superficie); }
    .dia.fora .num { color: var(--texto-suave); }
    .dia.selecionado { background: var(--acao-suave); }
    .num { align-self: flex-start; min-width: 24px; height: 24px; padding: 0 var(--espacamento-1); border: 0; border-radius: var(--raio-completo); background: transparent; color: var(--texto); font: inherit; font-size: 12px; cursor: pointer; }
    .dia.hoje .num { background: var(--acao); color: var(--texto-invertido); font-weight: 600; }
    .chip { display: block; width: 100%; padding: 1px var(--espacamento-1); border: 0; border-left: 3px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto); font: inherit; font-size: 11px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .chip .hora { color: var(--texto-secundario); }
    .chip.apagado { opacity: 0.55; text-decoration: line-through; }
    .chip[data-cor='sucesso'], .item[data-cor='sucesso'] { border-left-color: var(--sucesso); }
    .chip[data-cor='atencao'], .item[data-cor='atencao'] { border-left-color: var(--atencao); }
    .chip[data-cor='erro'], .item[data-cor='erro'] { border-left-color: var(--erro); }
    .chip[data-cor='ia'], .item[data-cor='ia'] { border-left-color: var(--ia); }
    .chip[data-cor='neutro'], .item[data-cor='neutro'] { border-left-color: var(--texto-suave); }
    .mais { align-self: flex-start; padding: 0 var(--espacamento-1); border: 0; background: transparent; color: var(--acao); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
    .painel-dia { display: flex; flex-direction: column; gap: var(--espacamento-2); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); min-width: 0; }
    .painel-dia h3 { margin: 0; font-size: 14px; color: var(--texto); }
    .data-dia { margin: 0; color: var(--texto-secundario); font-size: 13px; text-transform: capitalize; }
    .item { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda); border-left: 3px solid var(--acao); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); font: inherit; text-align: left; cursor: pointer; min-width: 0; }
    .item:hover { background: var(--superficie-hover); }
    .item-hora { font-size: 12px; color: var(--texto-secundario); }
    .item-titulo { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
    .item-meta { font-size: 12px; color: var(--texto-suave); overflow-wrap: anywhere; }
    .vazio, .aviso { margin: 0; color: var(--texto-suave); font-size: 13px; }
    @media (max-width: 719px) {
      :host { padding: var(--espacamento-3); }
      .dia { min-height: 64px; }
      .chip .hora { display: none; }
    }
  `,
})
export class AgendaPagina implements OnInit {
  protected readonly modulos = inject(ModulosServico)
  private readonly http = inject(HttpClient)

  protected readonly diasDaSemana = DIAS_DA_SEMANA
  private readonly hojeIso = diaIso(new Date())
  protected readonly ref = signal({ ano: new Date().getFullYear(), mes: new Date().getMonth() })
  protected readonly diaSelecionado = signal(this.hojeIso)
  protected readonly grade = computed(() => montarGradeMes(this.ref(), this.hojeIso))
  protected readonly rotuloDoMes = computed(() => rotuloMes(this.ref().ano, this.ref().mes))
  protected readonly dataSelecionada = computed(() => new Date(`${this.diaSelecionado()}T12:00:00`))

  protected readonly estado = signal<Estado>('carregando')
  protected readonly eventos = signal<readonly EventoAgenda[]>([])
  protected readonly truncado = signal(false)
  protected readonly escopo = signal<'todos' | 'proprio'>('proprio')
  protected readonly equipe = signal<OpcaoSelect[]>([])
  protected readonly responsavelId = signal('')
  private readonly porDia = computed(() => eventosPorDia(this.eventos()))
  protected readonly eventosDoDia = computed(() => this.porDia().get(this.diaSelecionado()) ?? [])
  /** Opções do modal de novo evento: sem "Eu (padrão)" duplicado, só a equipe. */
  protected readonly equipeModal = computed(() => (this.escopo() === 'todos' ? this.equipe() : []))

  protected readonly aberto = signal<EventoAgenda | null>(null)
  protected readonly modalNovo = signal(false)
  protected readonly dataNovo = signal('')

  protected readonly cabe = (iso: string) => cabeNoDia(this.porDia().get(iso) ?? [])
  protected readonly hora = (iso: string): string => horaLocal(new Date(iso))
  protected readonly tipo = rotuloTipoEvento
  protected readonly status = rotuloStatusEvento
  protected readonly tom = tomDoStatus

  ngOnInit(): void {
    void this.modulos.carregar().then(() => {
      if (this.modulos.agendaAtiva()) { void this.carregarEquipe(); void this.carregar() }
    })
  }

  private async carregarEquipe(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/equipe'))
      this.equipe.set(r.itens.map((u) => ({ valor: u.id, rotulo: u.nome })))
    } catch { /* o filtro some do alcance; o calendário continua funcionando */ }
  }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    const { de, ate } = janelaDaGrade(this.grade())
    try {
      const r = await firstValueFrom(this.http.get<{ itens: EventoAgenda[]; truncado: boolean; escopo: 'todos' | 'proprio' }>(
        `/v1/agenda/eventos${queryDeLista({ de, ate, responsavelId: this.responsavelId() || null })}`))
      this.eventos.set(r.itens); this.truncado.set(r.truncado); this.escopo.set(r.escopo)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  protected mover(delta: number): void {
    this.ref.update((r) => mudarMes(r, delta))
    this.diaSelecionado.set(`${this.ref().ano}-${String(this.ref().mes + 1).padStart(2, '0')}-01`)
    void this.carregar()
  }
  protected irParaHoje(): void {
    const h = new Date()
    this.ref.set({ ano: h.getFullYear(), mes: h.getMonth() })
    this.diaSelecionado.set(diaIso(h))
    void this.carregar()
  }
  protected selecionar(iso: string): void { this.diaSelecionado.set(iso) }

  protected abrirDetalhe(e: EventoAgenda): void { this.aberto.set(e) }
  protected abrirNovo(iso: string): void { this.dataNovo.set(iso); this.modalNovo.set(true) }
  protected aoMudar(): void { this.modalNovo.set(false); this.aberto.set(null); void this.carregar() }
}
