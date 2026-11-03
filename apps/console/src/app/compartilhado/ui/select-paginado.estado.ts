import { signal } from '@angular/core'

export interface OpcaoPaginada { valor: string; rotulo: string; dica?: string }
export interface PaginaOpcoes { itens: OpcaoPaginada[]; temMais: boolean }
export type CarregarOpcoes = (pagina: number, termo: string) => Promise<PaginaOpcoes>

/**
 * Estado da busca paginada do `ui-select-paginado` — sem DOM, testável.
 * Debounce na digitação, página seguinte sob demanda, e proteção contra
 * resposta atrasada (só a última busca vence).
 */
export class EstadoBuscaPaginada {
  readonly itens = signal<OpcaoPaginada[]>([])
  readonly carregando = signal(false)
  readonly temMais = signal(false)
  readonly falhou = signal(false)

  private termo = ''
  private pagina = 0
  private geracao = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly carregar: () => CarregarOpcoes | null, private readonly debounceMs = 300) {}

  /** Recomeça do zero (abrir a lista). */
  async iniciar(termo = ''): Promise<void> {
    this.cancelarTimer()
    this.termo = termo
    this.pagina = 0
    this.geracao += 1
    this.itens.set([])
    this.temMais.set(false)
    await this.buscarPagina(1, true)
  }

  /** Digitação: espera `debounceMs` sem novas teclas antes de ir ao servidor. */
  digitar(termo: string): void {
    this.cancelarTimer()
    this.timer = setTimeout(() => { this.timer = null; void this.iniciar(termo) }, this.debounceMs)
  }

  /** Rolagem até o fim: próxima página, se houver e se não estiver carregando. */
  async proximaPagina(): Promise<void> {
    if (!this.temMais() || this.carregando()) return
    await this.buscarPagina(this.pagina + 1, false)
  }

  destruir(): void { this.cancelarTimer(); this.geracao += 1 }

  private cancelarTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private async buscarPagina(pagina: number, substituir: boolean): Promise<void> {
    const fn = this.carregar()
    if (!fn) return
    const minha = ++this.geracao
    this.carregando.set(true)
    this.falhou.set(false)
    try {
      const r = await fn(pagina, this.termo)
      if (minha !== this.geracao) return
      this.pagina = pagina
      this.itens.update((atual) => (substituir ? r.itens : [...atual, ...r.itens]))
      this.temMais.set(r.temMais)
    } catch {
      if (minha !== this.geracao) return
      this.falhou.set(true)
      this.temMais.set(false)
    } finally {
      if (minha === this.geracao) this.carregando.set(false)
    }
  }
}

/** Índice ativo após uma seta, circular-limitado (não dá a volta). */
export function moverAtivo(atual: number, total: number, tecla: 'ArrowDown' | 'ArrowUp'): number {
  if (total === 0) return -1
  if (tecla === 'ArrowDown') return Math.min(atual + 1, total - 1)
  return atual <= 0 ? 0 : atual - 1
}

/** Rótulo a exibir para o valor salvo: da lista carregada, senão da opção injetada. */
export function rotuloDoValor(
  valor: string | null, itens: OpcaoPaginada[], injetada: OpcaoPaginada | null,
): string {
  if (!valor) return ''
  return itens.find((o) => o.valor === valor)?.rotulo
    ?? (injetada && injetada.valor === valor ? injetada.rotulo : '')
}
