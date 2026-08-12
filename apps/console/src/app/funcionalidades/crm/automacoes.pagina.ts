import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { DatePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

interface Automacao {
  readonly id: string; readonly nome: string; readonly ativa: boolean
  readonly gatilho: string; readonly gatilhoParam: Record<string, unknown>
  readonly acao: string; readonly acaoParam: Record<string, unknown>
  readonly ultimaExecucaoEm: string | null; readonly execucoes: number
}
interface Ref { readonly id: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const SEGMENTOS: Ref[] = [
  { id: 'campeao', nome: 'Campeão' }, { id: 'cliente-fiel', nome: 'Cliente Fiel' },
  { id: 'potencial-fiel', nome: 'Potencial Fiel' }, { id: 'cliente-promissor', nome: 'Cliente Promissor' },
  { id: 'cliente-recente', nome: 'Cliente Recente' }, { id: 'nao-perder', nome: 'Não Perder' },
  { id: 'em-risco', nome: 'Em Risco' }, { id: 'precisa-atencao', nome: 'Precisa de Atenção' },
  { id: 'semi-perdido', nome: 'Semi Perdido' }, { id: 'hibernando', nome: 'Hibernando' }, { id: 'perdido', nome: 'Perdido' },
]
const GAT_ROTULO: Record<string, string> = { rfv_segmento: 'Cruzou segmento RFV', dias_sem_comprar: 'Dias sem comprar', lead_frio: 'Lead frio', nps_detrator: 'NPS detrator' }
const ACAO_ROTULO: Record<string, string> = { criar_tarefa: 'Criar tarefa', aplicar_sequencia: 'Aplicar sequência', adicionar_lista: 'Adicionar à lista' }

/**
 * Automações — regras gatilho→ação (varredura agendada, ações internas; ver
 * docs/automacoes.md). Lista + criador de regra + "rodar agora".
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-automacoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <header class="cabecalho">
      <div>
        <h1 class="txt-titulo">Automações</h1>
        <p class="sub">Quando um cliente cruzar uma condição, o sistema cria a tarefa. Nada é enviado ao cliente sozinho.</p>
      </div>
      <div class="dir">
        <button class="sec" (click)="rodar()" [disabled]="rodando()">{{ rodando() ? 'Rodando…' : 'Rodar agora' }}</button>
        <button class="primario" (click)="mostrarNova.set(!mostrarNova())">{{ mostrarNova() ? 'Fechar' : '+ Nova regra' }}</button>
      </div>
    </header>

    @if (msg()) { <p class="ok">{{ msg() }}</p> }

    @if (mostrarNova()) {
      <form class="nova" (submit)="criar($event)">
        <label class="campo full">Nome<input [value]="nome()" (input)="nome.set($any($event.target).value)" placeholder="Ex.: Reativar quem virou Em Risco" /></label>

        <div class="dupla">
          <label class="campo">Gatilho (quando)
            <select [value]="gatilho()" (change)="gatilho.set($any($event.target).value)">
              @for (g of gatilhos; track g) { <option [value]="g">{{ rotuloGat(g) }}</option> }
            </select>
          </label>
          <div class="params">
            @switch (gatilho()) {
              @case ('rfv_segmento') {
                <label class="campo">Segmento<select [value]="segmento()" (change)="segmento.set($any($event.target).value)">
                  @for (s of segmentos; track s.id) { <option [value]="s.id">{{ s.nome }}</option> }</select></label>
              }
              @case ('dias_sem_comprar') { <label class="campo">Dias sem comprar ></label><input class="num" type="number" min="1" [value]="dias()" (input)="dias.set(+$any($event.target).value)" /> }
              @case ('lead_frio') { <label class="campo">Sem 1ª compra há > (dias)</label><input class="num" type="number" min="1" [value]="dias()" (input)="dias.set(+$any($event.target).value)" /> }
              @case ('nps_detrator') { <label class="campo">Nota ≤</label><input class="num" type="number" min="0" max="10" [value]="notaMax()" (input)="notaMax.set(+$any($event.target).value)" /> }
            }
          </div>
        </div>

        <div class="dupla">
          <label class="campo">Ação (faça)
            <select [value]="acao()" (change)="acao.set($any($event.target).value)">
              @for (a of acoes; track a) { <option [value]="a">{{ rotuloAcao(a) }}</option> }
            </select>
          </label>
          <div class="params">
            @switch (acao()) {
              @case ('criar_tarefa') {
                <input class="pt" [value]="titulo()" (input)="titulo.set($any($event.target).value)" placeholder="Título da tarefa" />
                <label class="chk"><input type="checkbox" [checked]="paraDono()" (change)="paraDono.set($any($event.target).checked)" /> para o dono da carteira</label>
              }
              @case ('aplicar_sequencia') {
                <label class="campo">Sequência<select [value]="sequenciaId()" (change)="sequenciaId.set($any($event.target).value)">
                  <option value="">Escolha…</option>@for (s of sequencias(); track s.id) { <option [value]="s.id">{{ s.nome }}</option> }</select></label>
              }
              @case ('adicionar_lista') {
                <label class="campo">Lista<select [value]="listaId()" (change)="listaId.set($any($event.target).value)">
                  <option value="">Escolha…</option>@for (l of listas(); track l.id) { <option [value]="l.id">{{ l.nome }}</option> }</select></label>
              }
            }
          </div>
        </div>

        <div class="acoes-form">
          <button class="primario" type="submit" [disabled]="salvando() || !nome().trim()">{{ salvando() ? 'Criando…' : 'Criar regra' }}</button>
          @if (erroForm()) { <span class="erro">{{ erroForm() }}</span> }
        </div>
      </form>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="lista"><div class="esq"></div><div class="esq"></div></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhuma automação ainda</h2><p>Crie a primeira regra acima.</p></div>
        } @else {
          <ul class="lista">
            @for (a of itens(); track a.id) {
              <li class="reg" [class.off]="!a.ativa">
                <label class="switch" [title]="a.ativa ? 'Ativa' : 'Pausada'">
                  <input type="checkbox" [checked]="a.ativa" (change)="alternar(a, $any($event.target).checked)" /><span class="track"></span>
                </label>
                <div class="col encolhe">
                  <span class="r-nome">{{ a.nome }}</span>
                  <span class="r-regra">{{ descreve(a) }}</span>
                </div>
                <div class="col-dir">
                  <span class="r-exec txt-dados">{{ a.execucoes }} exec.</span>
                  @if (a.ultimaExecucaoEm) { <span class="r-quando">último {{ a.ultimaExecucaoEm | date: 'dd/MM HH:mm' }}</span> }
                </div>
                <button class="x" (click)="excluir(a.id)" title="Excluir">×</button>
              </li>
            }
          </ul>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { display: flex; justify-content: space-between; align-items: start; gap: var(--espacamento-4); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; max-width: 60ch; }
    .dir { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .primario { padding: var(--espacamento-2) var(--espacamento-4); border: 1px solid var(--acao); border-radius: var(--raio-controle); background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 13px; cursor: pointer; }
    .primario:disabled { opacity: .6; cursor: default; }
    .sec { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .ok { color: var(--sucesso); font-size: 13px; margin: 0 0 var(--espacamento-3); }
    .nova { display: grid; gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); font-size: 13px; }
    .campo.full { }
    .campo input, .campo select, .nova input, .nova select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .dupla { display: grid; grid-template-columns: 200px 1fr; gap: var(--espacamento-3); align-items: end; }
    @media (max-width: 560px) { .dupla { grid-template-columns: 1fr; } }
    .params { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .num { width: 90px; }
    .pt { flex: 1; min-width: 160px; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto-secundario); font-size: 13px; }
    .acoes-form { display: flex; align-items: center; gap: var(--espacamento-3); }
    .erro { color: var(--erro); font-size: 13px; }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .esq { height: 56px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .reg { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); }
    .reg:last-child { border-bottom: none; }
    .reg.off { opacity: .6; }
    .switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
    .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .track { width: 34px; height: 20px; border-radius: var(--raio-completo); background: var(--borda-forte); position: relative; transition: background var(--movimento-estado-duracao); }
    .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: var(--raio-completo); background: var(--superficie-elevada); transition: transform var(--movimento-estado-duracao); }
    .switch input:checked + .track { background: var(--acao); }
    .switch input:checked + .track::after { transform: translateX(14px); }
    .col { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .r-nome { color: var(--texto); font-size: 14px; }
    .r-regra { color: var(--texto-suave); font-size: 12px; }
    .col-dir { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex: none; }
    .r-exec { color: var(--texto-secundario); font-size: 12px; }
    .r-quando { color: var(--texto-suave); font-size: 11px; }
    .x { border: 0; background: transparent; color: var(--texto-suave); font-size: 16px; padding: 0 4px; cursor: pointer; flex: none; }
    .x:hover { color: var(--erro); }
  `,
})
export class AutomacoesPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly gatilhos = ['rfv_segmento', 'dias_sem_comprar', 'lead_frio', 'nps_detrator']
  readonly acoes = ['criar_tarefa', 'aplicar_sequencia', 'adicionar_lista']
  readonly segmentos = SEGMENTOS
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Automacao[]>([])
  readonly sequencias = signal<readonly Ref[]>([]); readonly listas = signal<readonly Ref[]>([])
  readonly mostrarNova = signal(false); readonly rodando = signal(false); readonly msg = signal<string | null>(null)
  // form
  readonly nome = signal(''); readonly gatilho = signal('dias_sem_comprar'); readonly acao = signal('criar_tarefa')
  readonly segmento = signal('em-risco'); readonly dias = signal(60); readonly notaMax = signal(6)
  readonly titulo = signal(''); readonly paraDono = signal(true); readonly sequenciaId = signal(''); readonly listaId = signal('')
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)

  ngOnInit(): void { void this.carregar(); void this.carregarRefs() }
  rotuloGat(g: string): string { return GAT_ROTULO[g] ?? g }
  rotuloAcao(a: string): string { return ACAO_ROTULO[a] ?? a }

  descreve(a: Automacao): string {
    const g = a.gatilhoParam, ap = a.acaoParam
    const quando =
      a.gatilho === 'rfv_segmento' ? `virou ${this.segNome(String(g['segmento'] ?? ''))}`
      : a.gatilho === 'dias_sem_comprar' ? `passou de ${g['dias']} dias sem comprar`
      : a.gatilho === 'lead_frio' ? `lead sem compra há ${g['dias']} dias`
      : `NPS ≤ ${g['notaMax'] ?? 6}`
    const faz =
      a.acao === 'criar_tarefa' ? `criar tarefa “${ap['titulo'] ?? a.nome}”`
      : a.acao === 'aplicar_sequencia' ? `aplicar uma sequência`
      : `adicionar a uma lista`
    return `Quando ${quando} → ${faz}`
  }
  private segNome(c: string): string { return SEGMENTOS.find((s) => s.id === c)?.nome ?? c }

  async carregarRefs(): Promise<void> {
    try {
      const [seq, lis] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/sequencias')),
        firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/listas')),
      ])
      this.sequencias.set(seq.itens); this.listas.set(lis.itens)
    } catch { /* selects vazios */ }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Automacao[] }>('/v1/automacoes'))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  private montarGatilhoParam(): object {
    switch (this.gatilho()) {
      case 'rfv_segmento': return { segmento: this.segmento() }
      case 'dias_sem_comprar': return { dias: this.dias() }
      case 'lead_frio': return { dias: this.dias() }
      case 'nps_detrator': return { notaMax: this.notaMax(), janelaDias: 30 }
      default: return {}
    }
  }
  private montarAcaoParam(): object {
    switch (this.acao()) {
      case 'criar_tarefa': return { titulo: this.titulo().trim() || this.nome().trim(), offsetDias: 0, paraDono: this.paraDono() }
      case 'aplicar_sequencia': return { sequenciaId: this.sequenciaId() }
      case 'adicionar_lista': return { listaId: this.listaId() }
      default: return {}
    }
  }

  async criar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando() || !this.nome().trim()) return
    if (this.acao() === 'aplicar_sequencia' && !this.sequenciaId()) { this.erroForm.set('Escolha a sequência.'); return }
    if (this.acao() === 'adicionar_lista' && !this.listaId()) { this.erroForm.set('Escolha a lista.'); return }
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/automacoes', {
        nome: this.nome().trim(), gatilho: this.gatilho(), gatilhoParam: this.montarGatilhoParam(),
        acao: this.acao(), acaoParam: this.montarAcaoParam(),
      }))
      this.nome.set(''); this.titulo.set(''); this.mostrarNova.set(false)
      await this.carregar()
    } catch (e) {
      this.erroForm.set(e instanceof HttpErrorResponse && e.status === 422 ? 'Confira a sequência/lista escolhida.' : 'Não foi possível criar.')
    } finally { this.salvando.set(false) }
  }

  async alternar(a: Automacao, ativa: boolean): Promise<void> {
    try { await firstValueFrom(this.http.patch(`/v1/automacoes/${a.id}`, { ativa })); await this.carregar() } catch { /* ignore */ }
  }
  async excluir(id: string): Promise<void> {
    try { await firstValueFrom(this.http.delete(`/v1/automacoes/${id}`)); await this.carregar() } catch { /* ignore */ }
  }
  async rodar(): Promise<void> {
    this.rodando.set(true); this.msg.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ acoesExecutadas: number }>('/v1/automacoes/executar', {}))
      this.msg.set(`Varredura concluída: ${r.acoesExecutadas} ação(ões) executada(s).`)
      await this.carregar()
    } catch { this.msg.set('Não foi possível rodar agora.') } finally { this.rodando.set(false) }
  }
}
