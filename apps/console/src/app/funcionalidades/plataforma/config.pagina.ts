import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  HorarioAtendimentoComponente, somenteDiasAbertos, type HorarioAtendimento,
} from '../../compartilhado/ui/index.js'

interface Empresa { readonly nome: string; readonly fuso: string; readonly plano: string }
interface CanalResumo { readonly id: string; readonly nomeAmigavel: string }
interface ConfigCanal { readonly horarioAtendimento: HorarioAtendimento; readonly mensagemAusencia: string | null }
interface Membro { readonly id: string; readonly nome: string; readonly email: string | null; readonly ativo: boolean; readonly papeis: { papel: string; filial: string }[] }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
const FUSOS = ['America/Sao_Paulo', 'America/Recife', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Rio_Branco']
const PAPEL_ROTULO: Record<string, string> = { admin: 'Admin', gestor: 'Gestor', supervisor: 'Supervisor', vendedor: 'Vendedor', atendente: 'Atendente' }

/**
 * Configurações Gerais — a empresa (nome, fuso, plano) e a equipe com papéis.
 * ⚠️ Papel é POR FILIAL (mostrado como está). Gestão de usuários/acesso não é
 * daqui. Segue geracrm-layout-ui (5 estados, tokens, responsivo).
 */
@Component({
  selector: 'app-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HorarioAtendimentoComponente],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Configurações Gerais</h1>
      <p class="sub">Dados da empresa, horário de atendimento e a equipe com seus papéis.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="bloco esq"></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        <section class="painel">
          <h2 class="txt-secao">Empresa</h2>
          <form class="form" (submit)="salvar($event)">
            <label class="campo">Nome
              <input [value]="nome()" (input)="nome.set($any($event.target).value)" placeholder="Nome da empresa" />
            </label>
            <label class="campo">Fuso horário
              <select [value]="fuso()" (change)="fuso.set($any($event.target).value)">
                @for (f of fusos; track f) { <option [value]="f">{{ f }}</option> }
              </select>
            </label>
            <div class="linha-plano"><span class="txt-rotulo">Plano</span><span class="plano">{{ empresa()?.plano }}</span></div>
            <div class="acoes">
              <button class="btn btn--primario" type="submit" [disabled]="salvando() || !nome().trim()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</button>
              @if (msg()) { <span class="ok">{{ msg() }}</span> }
            </div>
          </form>
        </section>

        <!-- ⚠️ ESPELHO, não segunda fonte da verdade: a configuração continua
             sendo por NÚMERO (canal_configuracao). Está aqui porque é onde as
             pessoas procuram — "horário de atendimento" se lê como fato da
             empresa, não do canal. Com mais de um número, esta tela não tenta
             adivinhar qual: manda para a tela que sabe. -->
        <section class="painel">
          <h2 class="txt-secao">Atendimento</h2>
          @switch (situacaoCanais()) {
            @case ('carregando') { <div class="bloco esq"></div> }
            @case ('erro') {
              <p class="vazio">Não foi possível carregar seus números.
                <a routerLink="/canal-config">Abrir Config. do Canal</a></p>
            }
            @case ('nenhum') {
              <p class="vazio">Nenhum número conectado ainda.
                Conecte um em <a routerLink="/numeros">Meus Números</a>.</p>
            }
            @case ('varios') {
              <p class="dica">Você tem {{ canais().length }} números, e o horário é de cada um.</p>
              <ul class="nums">
                @for (c of canais(); track c.id) { <li>{{ c.nomeAmigavel }}</li> }
              </ul>
              <a class="btn btn--secundario" routerLink="/canal-config">Configurar por número</a>
            }
            @case ('um') {
              <p class="dica">Do número <strong>{{ canais()[0]?.nomeAmigavel }}</strong>.</p>
              <form class="form" (submit)="salvarHorario($event)">
                <label class="campo">Mensagem de ausência
                  <textarea rows="2" [value]="ausencia()"
                            (input)="ausencia.set($any($event.target).value)"
                            placeholder="Enviada a quem escreve fora do horário."></textarea>
                </label>
                <ui-horario-atendimento [(horario)]="horario" />
                <div class="acoes">
                  <button class="btn btn--primario" type="submit" [disabled]="salvandoHorario()">
                    {{ salvandoHorario() ? 'Salvando…' : 'Salvar atendimento' }}</button>
                  @if (msgHorario()) { <span class="ok">{{ msgHorario() }}</span> }
                </div>
              </form>
            }
          }
        </section>

        <section class="painel">
          <h2 class="txt-secao">Equipe <span class="cont">({{ equipe().length }})</span></h2>
          @if (equipe().length === 0) {
            <p class="vazio">Nenhum usuário ainda.</p>
          } @else {
            <ul class="equipe">
              @for (u of equipe(); track u.id) {
                <li class="u" [class.inativo]="!u.ativo">
                  <span class="ava">{{ inicial(u.nome) }}</span>
                  <div class="u-col encolhe">
                    <span class="u-nome">{{ u.nome }} @if (!u.ativo) { <span class="tag-inativo">inativo</span> }</span>
                    @if (u.email) { <span class="u-email">{{ u.email }}</span> }
                  </div>
                  <div class="papeis">
                    @for (p of u.papeis; track p.papel + p.filial) {
                      <span class="papel" [title]="p.filial">{{ rotuloPapel(p.papel) }}</span>
                    }
                    @if (u.papeis.length === 0) { <span class="sem-papel">sem papel</span> }
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: var(--largura-forma); margin: 0 auto; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 220px; }
    .painel { padding: var(--espacamento-4) var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); margin-bottom: var(--espacamento-4); }
    .painel h2 { margin: 0 0 var(--espacamento-3); }
    .cont { color: var(--texto-suave); font-weight: 400; }
    .form { display: grid; gap: var(--espacamento-3); max-width: 420px; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); font-size: 13px; }
    .campo input, .campo select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .linha-plano { display: flex; align-items: baseline; gap: var(--espacamento-2); }
    .plano { color: var(--texto); font-size: 14px; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); margin-top: var(--espacamento-1); }
    .ok { color: var(--sucesso); font-size: 13px; }
    .vazio { color: var(--texto-suave); font-size: 13px; margin: 0; }
    .equipe { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .u { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-2) 0; border-bottom: 1px solid var(--borda); }
    .u:last-child { border-bottom: none; }
    .u.inativo { opacity: .6; }
    .ava { width: 30px; height: 30px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--acao); font-size: 12px; font-weight: 600; display: grid; place-items: center; flex: none; }
    .u-col { display: flex; flex-direction: column; gap: 1px; flex: 1; }
    .u-nome { color: var(--texto); font-size: 14px; }
    .tag-inativo { font-size: 11px; color: var(--texto-suave); }
    .u-email { color: var(--texto-suave); font-size: 12px; }
    .papeis { display: flex; gap: 4px; flex-wrap: wrap; flex: none; justify-content: flex-end; }
    .papel { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--superficie); color: var(--texto-secundario); border: 1px solid var(--borda); }
    .sem-papel { font-size: 11px; color: var(--texto-suave); }
    .dica { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .nums { list-style: none; margin: 0 0 var(--espacamento-3); padding: 0; display: grid; gap: var(--espacamento-1); }
    .nums li { color: var(--texto); font-size: 13px; }
  `,
})
export class ConfigPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly fusos = FUSOS
  readonly estado = signal<Estado>('carregando')
  readonly empresa = signal<Empresa | null>(null)
  readonly equipe = signal<readonly Membro[]>([])
  readonly nome = signal(''); readonly fuso = signal('America/Sao_Paulo')
  readonly salvando = signal(false); readonly msg = signal<string | null>(null)

  readonly canais = signal<readonly CanalResumo[]>([])
  readonly canaisFalharam = signal(false)
  readonly horario = signal<HorarioAtendimento>({})
  readonly ausencia = signal('')
  readonly salvandoHorario = signal(false)
  readonly msgHorario = signal<string | null>(null)

  /**
   * ⚠️ Estado PRÓPRIO da seção. Se a lista de números falhar, esta tela não
   * quebra inteira — o quinto estado da skill de layout: o principal carrega, o
   * secundário avisa no lugar dele.
   */
  readonly situacaoCanais = computed<'carregando' | 'erro' | 'nenhum' | 'um' | 'varios'>(() => {
    if (this.canaisFalharam()) return 'erro'
    if (this.estado() !== 'pronto') return 'carregando'
    const n = this.canais().length
    return n === 0 ? 'nenhum' : n === 1 ? 'um' : 'varios'
  })

  ngOnInit(): void { void this.carregar() }
  inicial(n: string): string { return (n.trim()[0] ?? '?').toUpperCase() }
  rotuloPapel(p: string): string { return PAPEL_ROTULO[p] ?? p }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [emp, eq] = await Promise.all([
        firstValueFrom(this.http.get<Empresa>('/v1/config/empresa')),
        firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/config/equipe')),
      ])
      this.empresa.set(emp); this.nome.set(emp.nome); this.fuso.set(emp.fuso)
      this.equipe.set(eq.itens)
      this.estado.set('pronto')
      void this.carregarAtendimento()
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || !this.nome().trim()) return
    this.salvando.set(true); this.msg.set(null)
    try {
      await firstValueFrom(this.http.patch('/v1/config/empresa', { nome: this.nome().trim(), fuso: this.fuso() }))
      this.msg.set('Salvo.')
      const emp = this.empresa()
      if (emp) this.empresa.set({ ...emp, nome: this.nome().trim(), fuso: this.fuso() })
    } catch { this.msg.set('Não foi possível salvar.') } finally { this.salvando.set(false) }
  }

  /** ⚠️ Pós-carga e tolerante a falha: nunca derruba a tela principal. */
  private async carregarAtendimento(): Promise<void> {
    this.canaisFalharam.set(false)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: CanalResumo[] }>('/v1/canais'))
      this.canais.set(r.itens)
      const unico = r.itens.length === 1 ? r.itens[0] : null
      if (!unico) return
      const cf = await firstValueFrom(this.http.get<ConfigCanal>(`/v1/canais/${unico.id}/config`))
      this.horario.set({ ...cf.horarioAtendimento })
      this.ausencia.set(cf.mensagemAusencia ?? '')
    } catch { this.canaisFalharam.set(true) }
  }

  async salvarHorario(ev: Event): Promise<void> {
    ev.preventDefault()
    const unico = this.canais().length === 1 ? this.canais()[0] : null
    if (!unico || this.salvandoHorario()) return
    this.salvandoHorario.set(true); this.msgHorario.set(null)
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${unico.id}/config`, {
        horarioAtendimento: somenteDiasAbertos(this.horario()),
        mensagemAusencia: this.ausencia(),
      }))
      this.msgHorario.set('Atendimento salvo.')
    } catch { this.msgHorario.set('Não foi possível salvar.') } finally { this.salvandoHorario.set(false) }
  }
}
