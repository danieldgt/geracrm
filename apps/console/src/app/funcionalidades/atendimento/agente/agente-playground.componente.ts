import {
  Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked, viewChild, type ElementRef,
} from '@angular/core'
import {
  BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { AgenteServico, type Rastro, type ResultadoSimulacao } from './agente.servico.js'
import { badgeDesfecho, formatarReais, jsonLegivel, resumoDeUso, rotuloHandoff } from './agente.regras.js'

interface Turno {
  readonly id: number
  readonly pergunta: string
  readonly estado: 'pendente' | 'ok' | 'erro'
  readonly resultado: ResultadoSimulacao | null
  /** Custo vem da decisão gravada (a simulação não devolve preço). `null` = não deu para buscar. */
  readonly custoCentavos: number | null
  readonly erro: string | null
}

type Estado = 'pronto' | 'sem_permissao'

/**
 * Playground: conversar com o agente REAL — catálogo, políticas e ferramentas
 * deste número — sem WhatsApp no meio. Cada turno abre os "bastidores": o que
 * ele decidiu, quais ferramentas chamou, quanto custou.
 *
 * ⚠️ Um turno que falha NÃO apaga a conversa (estado parcial): o erro aparece
 * no lugar da resposta e a pessoa continua de onde estava.
 */
@Component({
  selector: 'app-agente-playground',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotaoComponente, BadgeComponente, PainelComponente, EsqueletoComponente, EstadoComponente],
  template: `
    @switch (estado()) {
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso ao playground"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('pronto') {
        <div class="chat">
          <div class="barra">
            <p class="dica encolhe">Conversa de teste com o agente deste número — nada sai para cliente. O custo é real e fica na auditoria como “simulação”.</p>
            <ui-botao variante="secundario" [desabilitado]="turnos().length === 0 || enviando()" [carregando]="reiniciando()"
                      (click)="reiniciar()">Reiniciar conversa</ui-botao>
          </div>

          <div class="mensagens" #lista>
            @if (turnos().length === 0) {
              <ui-estado titulo="Faça de cliente" icone="💬"
                descricao="Escreva como um cliente escreveria no WhatsApp — “tem camiseta verde G?”, “qual o prazo pra Recife?” — e veja o que o agente responde e por quê." />
            }
            @for (t of turnos(); track t.id) {
              <div class="bolha cliente">{{ t.pergunta }}</div>
              @switch (t.estado) {
                @case ('pendente') {
                  <div class="bolha agente digitando" aria-live="polite">
                    <ui-esqueleto largura="120px" altura="12px" /><span class="sr">digitando…</span>
                  </div>
                }
                @case ('erro') {
                  <div class="bolha falha" role="alert">{{ t.erro }}</div>
                }
                @case ('ok') {
                  @if (t.resultado; as r) {
                    @for (m of r.mensagens; track $index) { <div class="bolha agente">{{ m }}</div> }
                    @if (r.mensagens.length === 0) {
                      <div class="bolha sistema">{{ semMensagem(r) }}</div>
                    }
                    <details class="bastidores">
                      <summary>
                        <span class="sum">
                          <span>Bastidores</span>
                          <ui-badge [tom]="badge(r.desfecho).tom">{{ badge(r.desfecho).rotulo }}</ui-badge>
                          @if (r.rastro; as ra) {
                            <span class="txt-dados meta">{{ ra.latenciaMs }} ms</span>
                            <span class="txt-dados meta">{{ custo(t) }}</span>
                          }
                        </span>
                      </summary>
                      <dl class="detalhes">
                        @if (rotuloHandoff(r.handoff?.motivo); as h) {
                          <dt>Entregou porque</dt><dd>{{ h }}@if (r.handoff?.resumo) { — {{ r.handoff?.resumo }}}</dd>
                        }
                        @if (r.motivo && !r.handoff) { <dt>Motivo</dt><dd class="txt-dados">{{ r.motivo }}</dd> }
                        @if (r.detalhe) { <dt>Detalhe</dt><dd>{{ r.detalhe }}</dd> }
                        @if (r.rastro; as ra) {
                          <dt>Modelo</dt><dd class="txt-dados">{{ ra.modelo }}</dd>
                          <dt>Rodadas</dt><dd class="txt-dados">{{ ra.rodadas }}</dd>
                          <dt>Tokens</dt><dd class="txt-dados">{{ uso(ra.uso) }}</dd>
                          <dt>Custo</dt><dd class="txt-dados">{{ custo(t) }}</dd>
                          <dt>Ferramentas</dt>
                          <dd>
                            @if (ra.chamadas.length === 0) { <span class="dica">Nenhuma — respondeu só com o contexto.</span> }
                            @for (c of ra.chamadas; track $index) {
                              <details class="ferramenta">
                                <summary><span class="txt-dados">{{ c.nome }}</span>
                                  <span class="txt-dados meta">{{ c.ms }} ms</span>
                                  @if (c.erro) { <ui-badge tom="erro">erro</ui-badge> }</summary>
                                <p class="txt-rotulo">Entrada</p>
                                <pre class="rolagem-x">{{ json(c.entrada) }}</pre>
                                <p class="txt-rotulo">{{ c.erro ? 'Erro' : 'Saída' }}</p>
                                <pre class="rolagem-x">{{ c.erro ?? json(c.saida) }}</pre>
                              </details>
                            }
                          </dd>
                        }
                      </dl>
                    </details>
                  }
                }
              }
            }
          </div>

          @if (erroGeral(); as e) { <p class="erro-geral" role="alert">{{ e }}</p> }

          <form class="composer" (submit)="enviar($event)">
            <label class="sr" for="pg-texto">Mensagem do cliente</label>
            <textarea id="pg-texto" class="entrada" rows="1" [value]="texto()" (input)="texto.set($any($event.target).value)"
                      (keydown.enter)="aoEnter($event)" placeholder="Escreva como o cliente…" [disabled]="enviando()"
                      maxlength="2000"></textarea>
            <ui-botao tipo="submit" [desabilitado]="!podeEnviar()" [carregando]="enviando()">Enviar</ui-botao>
          </form>
        </div>
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .chat { display: flex; flex-direction: column; gap: var(--espacamento-3); min-width: 0;
      border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada);
      padding: var(--espacamento-4); }
    .barra { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); flex-wrap: wrap; }
    .dica { margin: 0; color: var(--texto-suave); font-size: 12px; }
    .mensagens { display: flex; flex-direction: column; gap: var(--espacamento-2); min-height: 280px; max-height: 60dvh;
      overflow-y: auto; padding: var(--espacamento-3); border-radius: var(--raio-controle); background: var(--fundo); }
    .bolha { flex: none; max-width: min(78%, 520px); padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-painel); font-size: 14px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere;
      color: var(--texto); border: 1px solid var(--borda); }
    .bolha.cliente { align-self: flex-end; background: var(--superficie-elevada); border-bottom-right-radius: 4px; }
    .bolha.agente { align-self: flex-start; background: var(--ia-suave); border-color: transparent; border-bottom-left-radius: 4px; }
    .bolha.digitando { display: flex; align-items: center; min-height: 36px; }
    .bolha.falha { align-self: flex-start; background: var(--erro-suave); color: var(--erro); border-color: transparent; }
    .bolha.sistema { align-self: center; background: transparent; color: var(--texto-suave); font-size: 12px; border-style: dashed; }
    .bastidores { align-self: flex-start; max-width: min(100%, 720px); width: 100%; font-size: 13px; color: var(--texto-secundario); }
    .bastidores > summary { cursor: pointer; list-style: none; display: inline-block; }
    .bastidores > summary::-webkit-details-marker { display: none; }
    .sum { display: inline-flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap;
      padding: var(--espacamento-1) var(--espacamento-2); border-radius: var(--raio-completo); border: 1px dashed var(--borda); }
    .bastidores[open] .sum { border-style: solid; }
    .meta { color: var(--texto-suave); }
    .detalhes { display: grid; grid-template-columns: max-content 1fr; gap: var(--espacamento-1) var(--espacamento-3);
      margin: var(--espacamento-2) 0 0; padding: var(--espacamento-3); border: 1px solid var(--borda);
      border-radius: var(--raio-controle); background: var(--superficie); min-width: 0; }
    .detalhes dt { color: var(--texto-suave); }
    .detalhes dd { margin: 0; min-width: 0; color: var(--texto); }
    .ferramenta { margin-top: var(--espacamento-1); min-width: 0; }
    .ferramenta summary { cursor: pointer; display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .ferramenta .txt-rotulo { margin: var(--espacamento-2) 0 var(--espacamento-1); }
    pre { margin: 0; padding: var(--espacamento-2); font-family: var(--tipografia-familia-dados); font-size: 12px;
      background: var(--fundo); border-radius: var(--raio-controle); max-height: 240px; overflow: auto; max-width: 100%; }
    .erro-geral { margin: 0; color: var(--erro); font-size: 13px; }
    .composer { display: flex; gap: var(--espacamento-2); align-items: flex-end; }
    .entrada { flex: 1; min-width: 0; resize: none; padding: var(--espacamento-2) var(--espacamento-3); font: inherit;
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto);
      min-height: var(--densidade-alvo-clique-console); }
    .entrada:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @media (max-width: 640px) {
      .chat { padding: var(--espacamento-3); }
      .bolha { max-width: 92%; }
      .detalhes { grid-template-columns: 1fr; }
    }
  `,
})
export class AgentePlaygroundComponente {
  readonly canalId = input.required<string>()

  private readonly api = inject(AgenteServico)
  private readonly toast = inject(ToastServico)
  private readonly lista = viewChild<ElementRef<HTMLElement>>('lista')

  readonly estado = signal<Estado>('pronto')
  readonly turnos = signal<readonly Turno[]>([])
  readonly texto = signal('')
  readonly enviando = signal(false)
  readonly reiniciando = signal(false)
  readonly erroGeral = signal<string | null>(null)
  /** Devolvido no primeiro turno; os seguintes continuam a MESMA conversa. */
  private readonly conversaId = signal<string | null>(null)
  private seq = 0

  readonly podeEnviar = computed(() => !this.enviando() && this.texto().trim().length > 0)

  constructor() {
    // Outro número = outra conversa de simulação. Zera a tela, não o servidor.
    effect(() => { this.canalId(); untracked(() => this.limpar()) })
  }

  badge(d: string) { return badgeDesfecho(d) }
  uso(u: Rastro['uso']): string { return resumoDeUso(u) }
  json(v: unknown): string { return jsonLegivel(v) }
  rotuloHandoff(m: string | null | undefined): string | null { return rotuloHandoff(m) }
  custo(t: Turno): string { return t.custoCentavos === null ? '— custo' : formatarReais(t.custoCentavos) }

  semMensagem(r: ResultadoSimulacao): string {
    switch (r.desfecho) {
      case 'silencio': return 'O agente ficou em silêncio — o portão barrou (veja o motivo nos bastidores).'
      case 'handoff': return 'Entregou ao humano sem responder.'
      case 'falha': return 'O turno falhou.'
      default: return 'Sem resposta neste turno.'
    }
  }

  aoEnter(ev: Event): void {
    const k = ev as KeyboardEvent
    if (k.shiftKey) return
    ev.preventDefault()
    void this.enviar()
  }

  async enviar(ev?: Event): Promise<void> {
    ev?.preventDefault()
    const pergunta = this.texto().trim()
    if (!pergunta || this.enviando()) return
    const id = ++this.seq
    this.turnos.update((ts) => [...ts, { id, pergunta, estado: 'pendente', resultado: null, custoCentavos: null, erro: null }])
    this.texto.set('')
    this.erroGeral.set(null)
    this.enviando.set(true)
    this.rolarParaFim()
    try {
      const r = await this.api.simular(this.canalId(), pergunta, this.conversaId())
      if (!r.ok) {
        if (r.status === 403) { this.estado.set('sem_permissao'); return }
        // ⚠️ 422 tem frase pronta e corretiva ("salve a configuração antes").
        const msg = r.erro.mensagem ?? 'Não foi possível simular.'
        this.turnos.update((ts) => ts.map((t) => (t.id === id ? { ...t, estado: 'erro', erro: msg } : t)))
        return
      }
      this.conversaId.set(r.resultado.conversaId)
      this.turnos.update((ts) => ts.map((t) => (t.id === id ? { ...t, estado: 'ok', resultado: r.resultado } : t)))
      void this.buscarCusto(id, r.resultado)
    } finally {
      this.enviando.set(false)
      this.rolarParaFim()
    }
  }

  /** O custo mora na decisão gravada. Se não vier, o painel mostra travessão — parcial, não erro. */
  private async buscarCusto(turnoId: number, r: ResultadoSimulacao): Promise<void> {
    if (!r.decisaoId) return
    try {
      const pagina = await this.api.listarDecisoes(this.canalId(), null)
      const d = pagina.itens.find((x) => x.id === r.decisaoId)
      if (!d) return
      this.turnos.update((ts) => ts.map((t) => (t.id === turnoId ? { ...t, custoCentavos: d.custoCentavos } : t)))
    } catch { /* parcial: fica sem custo */ }
  }

  async reiniciar(): Promise<void> {
    if (this.reiniciando()) return
    this.reiniciando.set(true)
    try {
      const r = await this.api.reiniciarSimulacao(this.canalId())
      if (!r.ok) {
        if (r.status === 403) { this.estado.set('sem_permissao'); return }
        this.erroGeral.set(r.erro.mensagem ?? 'Não foi possível reiniciar a conversa.')
        return
      }
      this.limpar()
      this.toast.sucesso('Conversa reiniciada.')
    } finally { this.reiniciando.set(false) }
  }

  private limpar(): void {
    this.turnos.set([]); this.conversaId.set(null); this.erroGeral.set(null); this.texto.set('')
  }

  private rolarParaFim(): void {
    setTimeout(() => {
      const el = this.lista()?.nativeElement
      if (el) el.scrollTop = el.scrollHeight
    }, 0)
  }
}
