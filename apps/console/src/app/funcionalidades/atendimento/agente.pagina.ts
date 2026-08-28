import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { DatePipe } from '@angular/common'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import {
  FAIXAS_REGRAS_AGENTE, REGRAS_AGENTE_PADRAO, avisosDasRegras, type RegrasDoAgente,
} from '@geracrm/shared'

interface Canal { readonly id: string; readonly nomeAmigavel: string }
interface ConfigAgente {
  readonly ativo: boolean; readonly politicas: string
  readonly regras: RegrasDoAgente; readonly padroes: RegrasDoAgente
  readonly faltaConfigurar: readonly string[]
}
interface Sessao {
  readonly id: string; readonly conversaId: string; readonly contato: string | null
  readonly estado: string; readonly turnos: number; readonly motivoSaida: string | null
  readonly iniciadaEm: string; readonly encerradaEm: string | null
  readonly extraido: Record<string, unknown>; readonly descartados: readonly { campo: string; motivo: string }[]
  readonly tokens: number
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Agente SDR — ligar, escrever as políticas, e VER o que o robô falou.
 *
 * ⚠️ A lista de sessões não é relatório: é o invariante de auditoria do escopo.
 * Sem ela, "o que o robô disse para o meu cliente?" só teria resposta no log do
 * fornecedor de IA — que ninguém do time do cliente vai abrir.
 */
@Component({
  selector: 'app-agente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Agente SDR</h1>
      <p class="sub">Atende fora do expediente, coleta o que falta e entrega ao humano.</p>
    </header>

    @switch (estado()) {
      @case ('carregando') { <div class="bloco esq"></div> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso</h2></div> }
      @case ('erro') {
        <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2>
          <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div>
      }
      @case ('pronto') {
        @if (canais().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nenhum número conectado</h2>
            <p>Conecte um número em <a routerLink="/numeros">Meus Números</a> primeiro.</p></div>
        } @else {
          <section class="painel">
            <h2 class="txt-secao">Configuração</h2>

            @if (canais().length > 1) {
              <label class="campo">Número
                <select [value]="canalId()" (change)="trocarCanal($any($event.target).value)">
                  @for (c of canais(); track c.id) { <option [value]="c.id">{{ c.nomeAmigavel }}</option> }
                </select>
              </label>
            }

            @if (cfg(); as c) {
              <!-- ⚠️ O que falta aparece com o NOME da variável: erro genérico
                   manda abrir chamado, nome manda resolver. -->
              @if (c.faltaConfigurar.length > 0) {
                <p class="aviso">Falta configurar no servidor: <strong>{{ c.faltaConfigurar.join(', ') }}</strong>.
                  Até lá o agente não pode ser ligado.</p>
              }

              <form class="form" (submit)="salvar($event)">
                <label class="campo">Políticas da loja
                  <textarea rows="5" [value]="politicas()"
                            (input)="politicas.set($any($event.target).value)"
                            placeholder="Prazo de entrega, formas de pagamento, troca, o que você vende."></textarea>
                  <!-- ⚠️ Agente ligado sem base responde "não sei" a tudo. -->
                  <span class="dica">O agente só responde o que estiver aqui. Sem isso, ele não pode ser ligado.</span>
                </label>

                <fieldset class="grupo">
                  <legend>Quando o agente entra</legend>

                  <label class="chk">
                    <input type="checkbox" [checked]="r().soQuandoNinguemDisponivel"
                           (change)="mudar('soQuandoNinguemDisponivel', $any($event.target).checked)" />
                    Só quando ninguém está disponível
                  </label>
                  <span class="dica">Desligado, ele responde junto com a equipe, em horário comercial.</span>

                  <label class="chk">
                    <input type="checkbox" [checked]="r().exigirAusenciaAntes"
                           (change)="mudar('exigirAusenciaAntes', $any($event.target).checked)" />
                    Esperar o cliente insistir depois da mensagem de ausência
                  </label>
                  <span class="dica">É o filtro que separa quem tem interesse de quem mandou “oi” e sumiu.</span>

                  <label class="chk">
                    <input type="checkbox" [checked]="r().reabrirAposEncerrada"
                           (change)="mudar('reabrirAposEncerrada', $any($event.target).checked)" />
                    Voltar a falar em conversa que ele já encerrou
                  </label>
                  <span class="dica">Desligado, ele nunca ressuscita depois de entregar ao humano.</span>

                  <div class="numeros">
                    <label class="campo curto">Validade da ausência (horas)
                      <input type="number" [min]="faixas.horasDesdeAusencia.min" [max]="faixas.horasDesdeAusencia.max"
                             [value]="r().horasDesdeAusencia"
                             (input)="mudar('horasDesdeAusencia', +$any($event.target).value)" />
                    </label>
                    <label class="campo curto">Silêncio após um atendente (min)
                      <input type="number" [min]="faixas.minutosPresenca.min" [max]="faixas.minutosPresenca.max"
                             [value]="r().minutosPresenca"
                             (input)="mudar('minutosPresenca', +$any($event.target).value)" />
                    </label>
                  </div>
                </fieldset>

                <fieldset class="grupo">
                  <legend>Como ele responde</legend>
                  <div class="numeros">
                    <label class="campo curto">Máximo de idas e vindas
                      <input type="number" [min]="faixas.maxTurnos.min" [max]="faixas.maxTurnos.max"
                             [value]="r().maxTurnos" (input)="mudar('maxTurnos', +$any($event.target).value)" />
                      <span class="dica">Ao bater o teto, entrega ao humano.</span>
                    </label>
                    <label class="campo curto">Tamanho da resposta
                      <input type="number" [min]="faixas.maxCaracteres.min" [max]="faixas.maxCaracteres.max"
                             [value]="r().maxCaracteres" (input)="mudar('maxCaracteres', +$any($event.target).value)" />
                      <span class="dica">Caracteres. Parágrafo longo não é lido no celular.</span>
                    </label>
                    <label class="campo curto">Falas de contexto
                      <input type="number" [min]="faixas.falasDeContexto.min" [max]="faixas.falasDeContexto.max"
                             [value]="r().falasDeContexto"
                             (input)="mudar('falasDeContexto', +$any($event.target).value)" />
                      <span class="dica">Quanto da conversa vai ao modelo. Mais falas, mais custo por turno.</span>
                    </label>
                  </div>
                </fieldset>

                <!-- ⚠️ Duas destas regras mudam QUEM fala com o cliente. A tela
                     não pode deixar isso implícito num checkbox: sem o aviso, o
                     dono liga a opção e descobre o efeito pelo cliente. -->
                @if (avisos().length > 0) {
                  <div class="aviso">
                    <strong>O que muda com esta configuração</strong>
                    <ul>@for (a of avisos(); track a) { <li>{{ a }}</li> }</ul>
                  </div>
                }

                <label class="chk">
                  <input type="checkbox" [checked]="ativo()" (change)="ativo.set($any($event.target).checked)"
                         [disabled]="c.faltaConfigurar.length > 0" />
                  Agente ligado neste número
                </label>

                <div class="acoes">
                  <button class="btn btn--primario" type="submit" [disabled]="salvando()">
                    {{ salvando() ? 'Salvando…' : 'Salvar' }}</button>
                  @if (mudouDoPadrao()) {
                    <button class="btn btn--secundario" type="button" (click)="voltarAoPadrao()">
                      Voltar ao padrão</button>
                  }
                  @if (msg()) { <span [class]="erro() ? 'err' : 'ok'">{{ msg() }}</span> }
                </div>
              </form>
            }
          </section>

          <section class="painel">
            <h2 class="txt-secao">Conversas conduzidas <span class="cont">({{ sessoes().length }})</span></h2>
            @if (sessoes().length === 0) {
              <p class="vazio">O agente ainda não conduziu nenhuma conversa.
                Ele entra depois da resposta de ausência, fora do expediente.</p>
            } @else {
              <ul class="sessoes">
                @for (s of sessoes(); track s.id) {
                  <li class="ss">
                    <div class="linha">
                      <span class="ss-nome encolhe">{{ s.contato ?? 'Contato' }}</span>
                      <span class="selo" [attr.data-e]="s.estado">{{ rotuloEstado(s.estado) }}</span>
                    </div>
                    <div class="meta">
                      <span>{{ s.iniciadaEm | date: 'dd/MM HH:mm' }}</span>
                      <span>· {{ s.turnos }} {{ s.turnos === 1 ? 'turno' : 'turnos' }}</span>
                      <span class="txt-dados">· {{ s.tokens }} tokens</span>
                    </div>
                    @if (s.motivoSaida) { <p class="motivo">Saiu porque: {{ s.motivoSaida }}</p> }
                    @if (resumo(s); as r) { <p class="extraido">{{ r }}</p> }
                    <!-- ⚠️ O que o modelo afirmou e foi RECUSADO. É a medida da
                         alucinação, e some se ninguém mostrar. -->
                    @if (s.descartados.length > 0) {
                      <p class="descartado">
                        Recusado: @for (d of s.descartados; track $index) {<span>{{ d.campo }} ({{ d.motivo }})</span>}
                      </p>
                    }
                  </li>
                }
              </ul>
              @if (proximoCursor()) {
                <button class="btn btn--secundario" (click)="carregarMais()" [disabled]="carregandoMais()">
                  {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</button>
              }
            }
          </section>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .painel { background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      padding: var(--espacamento-4); margin-bottom: var(--espacamento-4); max-width: 960px; }
    .bloco { background: var(--superficie); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      padding: var(--espacamento-4); }
    .esq { min-height: 160px; }
    .form { display: grid; gap: var(--espacamento-3); margin-top: var(--espacamento-3); }
    .campo { display: grid; gap: var(--espacamento-1); color: var(--texto-secundario); font-size: 13px; }
    .campo.curto { max-width: 220px; }
    textarea, input, select { padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .dica { color: var(--texto-suave); font-size: 12px; }
    .grupo { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-3);
      display: grid; gap: var(--espacamento-2); margin: 0; min-width: 0; }
    .grupo legend { padding: 0 var(--espacamento-2); color: var(--texto-secundario); font-size: 13px; }
    /* ⚠️ auto-fit + minmax: em telas estreitas os campos empilham em vez de
       espremer o input a ponto de esconder o número (regra de layout da casa). */
    .numeros { display: grid; gap: var(--espacamento-3); margin-top: var(--espacamento-1);
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .numeros .campo.curto { max-width: none; }
    .aviso ul { margin: var(--espacamento-1) 0 0; padding-left: var(--espacamento-4); display: grid; gap: 2px; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); font-size: 14px; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .ok { color: var(--sucesso); font-size: 13px; }
    .err { color: var(--erro); font-size: 13px; }
    .aviso { margin: var(--espacamento-3) 0 0; padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .vazio { color: var(--texto-secundario); font-size: 14px; }
    .cont { color: var(--texto-suave); font-size: 12px; }
    .sessoes { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .ss { border-bottom: 1px solid var(--borda); padding-bottom: var(--espacamento-3); }
    .ss:last-child { border-bottom: none; }
    .linha { display: flex; align-items: center; gap: var(--espacamento-3); }
    .ss-nome { color: var(--texto); font-size: 14px; }
    .encolhe { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selo { font-size: 12px; color: var(--texto-secundario); white-space: nowrap; }
    .selo[data-e='entregue'] { color: var(--sucesso); }
    .meta { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; color: var(--texto-suave); font-size: 12px;
      margin-top: 2px; }
    .motivo { margin: var(--espacamento-2) 0 0; color: var(--texto-secundario); font-size: 13px; }
    .extraido { margin: 2px 0 0; color: var(--texto); font-size: 13px; }
    .descartado { margin: 2px 0 0; color: var(--atencao); font-size: 12px; display: flex; gap: var(--espacamento-2);
      flex-wrap: wrap; }
    @media (max-width: 640px) { :host { padding: var(--espacamento-3); } }
  `,
})
export class AgentePagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly Canal[]>([])
  readonly canalId = signal('')
  readonly cfg = signal<ConfigAgente | null>(null)
  readonly politicas = signal(''); readonly ativo = signal(false)
  /** ⚠️ Um signal com o objeto inteiro, não oito soltos: eles são salvos juntos
   *    e comparados juntos com o padrão. Oito signals divergem no primeiro campo
   *    novo que alguém esquecer de incluir no salvar. */
  readonly r = signal<RegrasDoAgente>(REGRAS_AGENTE_PADRAO)
  readonly faixas = FAIXAS_REGRAS_AGENTE
  readonly salvando = signal(false); readonly msg = signal<string | null>(null); readonly erro = signal(false)
  readonly sessoes = signal<readonly Sessao[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)

  /** O que esta configuração muda, em português de gente. Regra do domínio. */
  readonly avisos = computed(() => avisosDasRegras(this.r()))
  /** Só oferece "voltar ao padrão" quando há o que voltar. */
  readonly mudouDoPadrao = computed(() => {
    const padrao = this.cfg()?.padroes ?? REGRAS_AGENTE_PADRAO
    return (Object.keys(padrao) as (keyof RegrasDoAgente)[]).some((k) => this.r()[k] !== padrao[k])
  })

  ngOnInit(): void { void this.carregar() }

  mudar<K extends keyof RegrasDoAgente>(campo: K, valor: RegrasDoAgente[K]): void {
    this.r.update((atual) => ({ ...atual, [campo]: valor }))
  }

  voltarAoPadrao(): void { this.r.set(this.cfg()?.padroes ?? REGRAS_AGENTE_PADRAO) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Canal[] }>('/v1/canais'))
      this.canais.set(r.itens)
      if (r.itens.length > 0) {
        this.canalId.set(r.itens[0]!.id)
        await this.abrirCanal(r.itens[0]!.id)
      }
      await this.carregarSessoes()
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async trocarCanal(id: string): Promise<void> { this.canalId.set(id); await this.abrirCanal(id) }

  private async abrirCanal(id: string): Promise<void> {
    const c = await firstValueFrom(this.http.get<ConfigAgente>(`/v1/canais/${id}/agente`))
    this.cfg.set(c)
    this.politicas.set(c.politicas); this.ativo.set(c.ativo); this.r.set(c.regras)
    this.msg.set(null)
  }

  private async carregarSessoes(cursor?: string): Promise<void> {
    const url = cursor ? `/v1/agente/sessoes?cursor=${encodeURIComponent(cursor)}` : '/v1/agente/sessoes'
    const r = await firstValueFrom(this.http.get<{ itens: Sessao[]; proximoCursor: string | null }>(url))
    this.sessoes.update((atual) => (cursor ? [...atual, ...r.itens] : r.itens))
    this.proximoCursor.set(r.proximoCursor)
  }

  async carregarMais(): Promise<void> {
    const c = this.proximoCursor()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try { await this.carregarSessoes(c) } finally { this.carregandoMais.set(false) }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.salvando.set(true); this.msg.set(null); this.erro.set(false)
    try {
      await firstValueFrom(this.http.put(`/v1/canais/${this.canalId()}/agente`, {
        ativo: this.ativo(), politicas: this.politicas(), ...this.r(),
      }))
      this.msg.set('Salvo.')
      await this.abrirCanal(this.canalId())
    } catch (e) {
      // ⚠️ Falha de negócio tem texto próprio com a ação corretiva — nunca
      //    "erro genérico". A API já devolve a frase pronta.
      this.erro.set(true)
      this.msg.set(e instanceof HttpErrorResponse && typeof e.error?.mensagem === 'string'
        ? e.error.mensagem : 'Não foi possível salvar.')
    } finally { this.salvando.set(false) }
  }

  rotuloEstado(e: string): string {
    return e === 'ativa' ? 'Em conversa' : e === 'entregue' ? 'Entregue ao humano' : 'Encerrada'
  }

  /** O que foi colhido, em uma linha legível. */
  resumo(s: Sessao): string | null {
    const partes = Object.entries(s.extraido)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
    return partes.length > 0 ? `Colheu — ${partes.join(' · ')}` : null
  }
}
