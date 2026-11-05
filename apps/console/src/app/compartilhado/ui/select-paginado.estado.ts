import { signal } from '@angular/core'

export interface OpcaoPaginada { valor: string; rotulo: string; dica?: string }
/** Página por CURSOR (nunca offset): `proximoCursor` nulo = acabou. */
export interface PaginaOpcoes { itens: OpcaoPaginada[]; proximoCursor: string | null }
/** `cursor` nulo pede a primeira página. */
export type CarregarOpcoes = (cursor: string | null, termo: string) => Promise<PaginaOpcoes>

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
  /** A busca do termo atual já respondeu — só então "Nada encontrado." é verdade (e não um debounce em curso). */
  readonly buscou = signal(false)

  private termo = ''
  private cursor: string | null = null
  private geracao = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly carregar: () => CarregarOpcoes | null, private readonly debounceMs = 300) {}

  /** Recomeça do zero (abrir a lista). */
  async iniciar(termo = ''): Promise<void> {
    this.cancelarTimer()
    this.termo = termo
    this.cursor = null
    this.geracao += 1
    this.itens.set([])
    this.temMais.set(false)
    this.buscou.set(false)
    await this.buscarPagina(true)
  }

  /** Digitação: espera `debounceMs` sem novas teclas antes de ir ao servidor. */
  digitar(termo: string): void {
    this.cancelarTimer()
    this.buscou.set(false)
    this.timer = setTimeout(() => { this.timer = null; void this.iniciar(termo) }, this.debounceMs)
  }

  /**
   * Rolagem até o fim: próxima página, se houver, se não estiver carregando e se a última
   * não falhou (repetir é decisão do usuário, em `tentarNovamente`). Falha numa página seguinte NÃO zera `temMais` — o cursor continua válido.
   */
  async proximaPagina(): Promise<void> {
    if (!this.temMais() || this.carregando() || this.falhou()) return
    await this.buscarPagina(false)
  }

  /** "Tentar novamente": refaz a página que falhou (a seguinte, ou a primeira). */
  async tentarNovamente(): Promise<void> {
    if (this.carregando()) return
    this.falhou.set(false)
    if (this.temMais()) await this.buscarPagina(false)
    else await this.iniciar(this.termo)
  }

  destruir(): void { this.cancelarTimer(); this.geracao += 1 }

  private cancelarTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private async buscarPagina(substituir: boolean): Promise<void> {
    const fn = this.carregar()
    if (!fn) return
    const minha = ++this.geracao
    this.carregando.set(true)
    this.falhou.set(false)
    try {
      const r = await fn(this.cursor, this.termo)
      if (minha !== this.geracao) return
      this.cursor = r.proximoCursor
      this.itens.update((atual) => (substituir ? r.itens : [...atual, ...r.itens]))
      this.temMais.set(r.proximoCursor !== null)
    } catch {
      if (minha !== this.geracao) return
      this.falhou.set(true)
      if (substituir) this.temMais.set(false)
    } finally {
      if (minha === this.geracao) { this.carregando.set(false); this.buscou.set(true) }
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

/** Mínimo de caracteres para a lista abrir sozinha ao digitar (abrir pela seta ignora o mínimo). */
export const MINIMO_BUSCA = 2

/**
 * A lista abre ao digitar só com o mínimo de caracteres. Focar ou clicar no campo NÃO abre:
 * uma lista vazia ("Nada encontrado.") ao focar cobre o campo seguinte e não diz nada.
 */
export function abreAoDigitar(termo: string, minimo = MINIMO_BUSCA): boolean {
  return termo.trim().length >= Math.max(0, minimo)
}
