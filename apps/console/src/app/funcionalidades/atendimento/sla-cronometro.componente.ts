import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ROTULO_AVISO_ESPERA, duracaoCurta, faixaDoCronometro, type CronometroSla, type ResultadoAvisoEspera } from '@geracrm/shared'
import { EventosServico } from '../../nucleo/eventos.servico.js'

type Estado = 'carregando' | 'pronto' | 'vazio' | 'erro' | 'sem_permissao'

/** O relógio local avança a cada 15 s: é cor e "faltam N min", não cronômetro de prova. */
const TIQUE_MS = 15_000
/** Eventos que mudam o SLA de uma conversa. Sem conteúdo (ADR-007): só dizem "busque de novo". */
const EVENTOS = ['atendimento.mudou', 'agente.handoff', 'mensagem.enviada'] as const

/**
 * CRONÔMETRO DO SLA DO HANDOFF (raia P18, ADR-034) — verde → amarelo →
 * vermelho, no fuso do tenant.
 *
 * Dois modos:
 *   - `[sla]` — o dado já veio na lista (card da fila no kanban): só o relógio;
 *   - `[conversaId]` — busca `GET /v1/conversas/:id/sla` (inbox) e busca de
 *     novo quando chega um evento DESTA conversa.
 *
 * ⚠️ Sem polling: o tempo anda no relógio LOCAL a partir de `venceEm` (um
 *    `setInterval` de cor, sem rede). O que muda no servidor (estourou,
 *    alguém assumiu/respondeu) chega pelo SSE que a tela já tem.
 * Sem SLA armado (conversa que não veio de handoff) o componente não ocupa espaço.
 */
@Component({
  selector: 'app-sla-cronometro',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (estado()) {
      @case ('carregando') { <span class="sla esqueleto" aria-busy="true" aria-label="Carregando o SLA"></span> }
      @case ('erro') {
        <span class="sla erro" role="status">SLA indisponível
          @if (conversaId()) { <button type="button" (click)="carregar()">tentar de novo</button> }
        </span>
      }
      @case ('pronto') {
        @if (dado(); as c) {
          <span class="sla" [attr.data-faixa]="faixa()" role="timer" [attr.aria-label]="rotulo()" [attr.title]="dica()">
            <span class="ponto" aria-hidden="true"></span>
            <span class="txt">{{ texto() }}</span>
            @if (!compacto()) {
              @if (!c.respondidoEm) { <span class="extra">vence {{ hora(c.venceEm) }}</span> }
              @if (c.reatribuicaoLiberadaEm && !c.respondidoEm) { <span class="selo">reatribuição liberada</span> }
              @if (c.responsavel && !c.respondidoEm) { <span class="extra">para {{ c.responsavel }}</span> }
            }
          </span>
        }
      }
    }
  `,
  styles: [`
    :host { display: inline-flex; min-width: 0; max-width: 100%; }
    .sla { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px var(--espacamento-2); min-width: 0;
      font-size: 11.5px; line-height: 1.3; padding: 2px 8px; border-radius: var(--raio-completo);
      border: 1px solid var(--borda); background: var(--superficie); color: var(--texto); }
    .ponto { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--texto-suave); }
    .txt { font-weight: 600; white-space: nowrap; }
    .extra { color: var(--texto-secundario); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 18ch; }
    .selo { font-size: 10.5px; font-weight: 600; padding: 0 6px; border-radius: var(--raio-completo);
      border: 1px solid var(--atencao); color: var(--texto); background: var(--atencao-suave); white-space: nowrap; }
    .sla[data-faixa='verde'] { border-color: var(--sucesso); background: var(--sucesso-suave); }
    .sla[data-faixa='verde'] .ponto { background: var(--sucesso); }
    .sla[data-faixa='amarelo'] { border-color: var(--atencao); background: var(--atencao-suave); }
    .sla[data-faixa='amarelo'] .ponto { background: var(--atencao); }
    .sla[data-faixa='vermelho'] { border-color: var(--erro); background: var(--erro-suave); }
    .sla[data-faixa='vermelho'] .ponto { background: var(--erro); }
    .sla[data-faixa='respondido'] .ponto { background: var(--sucesso); }
    .esqueleto { width: 120px; height: 20px; background: var(--superficie-hover); border-color: transparent; }
    .erro { color: var(--erro); border-color: var(--erro); background: var(--erro-suave); }
    .erro button { font: inherit; font-size: 11px; color: var(--acao); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .erro button:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
  `],
})
export class SlaCronometroComponente {
  /** Modo lista: o SLA já veio com o card. `null` = sem SLA (não renderiza). */
  readonly sla = input<CronometroSla | null | undefined>(undefined)
  /** Modo conversa: busca pela API e reage aos eventos desta conversa. */
  readonly conversaId = input<string | null>(null)
  /** Só a pílula (card estreito). */
  readonly compacto = input(false)

  readonly #http = inject(HttpClient)
  readonly #eventos = inject(EventosServico)
  readonly #buscado = signal<CronometroSla | null>(null)
  readonly #estadoBusca = signal<Estado>('carregando')
  readonly agora = signal(new Date())

  readonly dado = computed<CronometroSla | null>(() => {
    const s = this.sla()
    return s !== undefined ? s : this.#buscado()
  })
  readonly estado = computed<Estado>(() => {
    if (this.sla() !== undefined) return this.sla() ? 'pronto' : 'vazio'
    const e = this.#estadoBusca()
    return e === 'pronto' && !this.#buscado() ? 'vazio' : e
  })
  readonly faixa = computed(() => {
    const c = this.dado()
    return c ? faixaDoCronometro(c, this.agora()) : null
  })
  readonly texto = computed(() => {
    const c = this.dado()
    if (!c) return ''
    const agora = this.agora().getTime()
    if (c.respondidoEm) return Date.parse(c.respondidoEm) <= Date.parse(c.venceEm) ? 'Respondido no SLA' : 'Respondido fora do SLA'
    const falta = Date.parse(c.venceEm) - agora
    return falta > 0 ? `SLA: faltam ${duracaoCurta(falta)}` : `SLA estourado há ${duracaoCurta(-falta)}`
  })
  readonly rotulo = computed(() => {
    const c = this.dado()
    if (!c) return ''
    const partes = [this.texto()]
    if (!c.respondidoEm) partes.push(`vence às ${this.hora(c.venceEm)}`)
    if (c.responsavel) partes.push(`direcionado a ${c.responsavel}`)
    return partes.join(', ')
  })
  readonly dica = computed(() => {
    const c = this.dado()
    if (!c) return ''
    const linhas = [`Transferido pelo agente às ${this.hora(c.inicioEm)}. SLA em minutos úteis (expediente do número).`]
    if (c.reatribuicaoVenceEm && !c.reatribuicaoLiberadaEm) linhas.push(`A reatribuição é liberada às ${this.hora(c.reatribuicaoVenceEm)}.`)
    if (c.avisoEspera?.resultado) {
      linhas.push(`${ROTULO_AVISO_ESPERA[c.avisoEspera.resultado as ResultadoAvisoEspera] ?? c.avisoEspera.resultado} (${this.hora(c.avisoEspera.em)}).`)
    }
    return linhas.join(' ')
  })

  #pedido = 0

  constructor() {
    const destroi = inject(DestroyRef)
    const tique = setInterval(() => this.agora.set(new Date()), TIQUE_MS)
    const cancelar = EVENTOS.map((tipo) => this.#eventos.escutar(tipo, (ev) => {
      const id = this.conversaId()
      if (id && ev.conversaId === id && this.sla() === undefined) void this.carregar(true)
    }))
    destroi.onDestroy(() => { clearInterval(tique); for (const c of cancelar) c() })
    effect(() => {
      const id = this.conversaId()
      if (this.sla() !== undefined || !id) return
      untracked(() => void this.carregar())
    })
  }

  async carregar(silencioso = false): Promise<void> {
    const id = this.conversaId()
    if (!id) return
    const pedido = ++this.#pedido
    if (!silencioso) this.#estadoBusca.set('carregando')
    try {
      const r = await firstValueFrom(this.#http.get<{ cronometro: CronometroSla | null }>(`/v1/conversas/${id}/sla`))
      if (pedido !== this.#pedido) return
      this.#buscado.set(r.cronometro)
      this.agora.set(new Date())
      this.#estadoBusca.set('pronto')
    } catch (e) {
      if (pedido !== this.#pedido) return
      // 403/404 não são falha do SLA: a conversa não é minha ou sumiu — não ocupa espaço.
      const status = e instanceof HttpErrorResponse ? e.status : 0
      if (status === 403 || status === 404) { this.#buscado.set(null); this.#estadoBusca.set('sem_permissao'); return }
      if (!silencioso) this.#estadoBusca.set('erro')
    }
  }

  hora(iso: string): string {
    const c = this.dado()
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: c?.fuso, hour: '2-digit', minute: '2-digit', weekday: this.#outroDia(iso) ? 'short' : undefined })
        .format(new Date(iso))
    } catch {
      return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    }
  }

  #outroDia(iso: string): boolean {
    return Math.abs(Date.parse(iso) - this.agora().getTime()) > 20 * 3_600_000
  }
}
