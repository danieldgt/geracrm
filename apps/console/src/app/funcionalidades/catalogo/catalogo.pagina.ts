import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { PERFIL_PRECO_PADRAO, type PerfilPreco } from '@geracrm/shared'

interface Sku { readonly id: string; readonly atributos: Record<string, string>; readonly precoCentavos: number | null; readonly saldo: number | null; readonly codigoBarras?: string | null }
interface ProdutoApi { readonly id: string; readonly referencia: string; readonly descricao: string; readonly skus: readonly Sku[] }

interface Cel { readonly saldo: number | null; readonly precoCentavos: number | null; readonly codigoBarras: string | null }
interface Cor { readonly nome: string; readonly hex: string | null }
interface Produto extends ProdutoApi {
  readonly temGrade: boolean
  readonly cores: readonly Cor[]
  readonly tamanhos: readonly string[]
  readonly cells: Record<string, Cel>          // chave `${cor}||${tam}`
  readonly totalCor: Record<string, number>
  readonly totalTam: Record<string, number>
  readonly total: number
  readonly precoRotulo: string
}
type Estado = 'pronto' | 'buscando' | 'sem_permissao' | 'erro'

// Cores comuns (PT) → hex para o swatch. É DADO (cor real do produto), não token
// de design; a tela mostra swatch + nome, nunca o hex (skill §12).
const CORES_HEX: Record<string, string> = {
  PRETO: '#1A1A1A', BRANCO: '#FFFFFF', OFFWHITE: '#F3EFE7', CINZA: '#9AA0A6', 'CINZA CLARO': '#C7CBD1', 'CINZA ESCURO': '#5A5F66', CHUMBO: '#4A4E57', GRAFITE: '#3A3D42', MESCLA: '#B9BdC4',
  VERMELHO: '#D32F2F', VINHO: '#7B1E28', BORDO: '#5E1B25', ROSA: '#E5679B', PINK: '#E5127D', CORAL: '#FF6F61', SALMAO: '#FF8C69',
  LARANJA: '#F27122', AMARELO: '#F5C518', MOSTARDA: '#D6A419', OURO: '#C9A227', BEGE: '#D8C3A5', NUDE: '#E7C6A5', AREIA: '#DAC7A0', MARROM: '#6B4A2B', CAFE: '#4B3621', CAQUI: '#94794B',
  VERDE: '#2E9E5B', 'VERDE MILITAR': '#4B5320', 'VERDE MUSGO': '#5A6B31', 'VERDE AGUA': '#88C9A1', 'VERDE BANDEIRA': '#0B7A3B', LIMAO: '#B5D33D',
  AZUL: '#2C6FBE', 'AZUL MARINHO': '#1B2A4A', MARINHO: '#1B2A4A', 'AZUL CLARO': '#7EA8D9', 'AZUL ROYAL': '#1E4EBF', JEANS: '#3B5A76', TURQUESA: '#0FB5AE',
  ROXO: '#7C5CD6', LILAS: '#B39DDB', VIOLETA: '#7C4DA0', LAVANDA: '#C3B2E0',
}
const TAM_LETRA: Record<string, number> = { PP: 1, P: 2, M: 3, G: 4, GG: 5, XG: 6, EG: 6, XGG: 7, EGG: 7, XXG: 8, EXG: 8, XXGG: 9 }

/**
 * Catálogo em GRADE (cor × tamanho) — skill grade-cor-tamanho. Cada produto vira
 * uma matriz: linhas = cores (swatch + nome), colunas = tamanhos ORDENADOS por
 * rank (nunca alfabético, §2), célula = saldo do ERP. Combinação inexistente é
 * `—`, não 0 (§3). Sem grade (perfil varejo), cai numa lista simples.
 *
 * A API devolve linhas planas por SKU; o pivot é no cliente (§11). Reusa a mesma
 * verdade do pedido assistido. Segue geracrm-layout-ui.
 */
@Component({
  selector: 'app-catalogo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="cabecalho">
      <h1 class="txt-titulo">Catálogo</h1>
      <p class="sub">Produtos em grade (cor × tamanho) com saldo do ERP.</p>
    </header>

    <div class="barra">
      <input class="busca" [value]="busca()" (input)="onBusca($any($event.target).value)" placeholder="Buscar por referência ou descrição" aria-label="Buscar" />
      <div class="perfil" role="group" aria-label="Perfil de preço">
        <button [class.on]="perfil() === 'atacado'" (click)="trocarPerfil('atacado')">Atacado</button>
        <button [class.on]="perfil() === 'varejo'" (click)="trocarPerfil('varejo')">Varejo</button>
      </div>
    </div>

    @switch (estado()) {
      @case ('buscando') { <p class="dica">Buscando…</p> }
      @case ('sem_permissao') { <div class="bloco"><h2 class="txt-secao">Sem acesso ao catálogo</h2></div> }
      @case ('erro') { <div class="bloco"><h2 class="txt-secao">Não foi possível carregar</h2><button class="btn btn--secundario" (click)="buscar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco"><h2 class="txt-secao">Nada encontrado</h2><p>Refine a busca ou sincronize o catálogo do ERP.</p></div>
        } @else {
          <ul class="lista">
            @for (p of itens(); track p.id) {
              <li class="prod">
                <div class="prod-topo">
                  <strong class="ref txt-dados">{{ p.referencia }}</strong>
                  <span class="desc encolhe">{{ p.descricao }}</span>
                  <span class="preco txt-dados">{{ p.precoRotulo }}</span>
                </div>

                @if (p.temGrade) {
                  <div class="rolagem-x">
                    <table class="grade">
                      <thead>
                        <tr>
                          <th class="canto">cor \\ tam</th>
                          @for (t of p.tamanhos; track t) { <th class="tcol">{{ t }}</th> }
                          <th class="ttot">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (c of p.cores; track c.nome) {
                          <tr>
                            <th class="crow">
                              <span class="sw" [class.borda]="c.hex === null || claro(c.hex)" [style.background]="c.hex ?? 'transparent'"></span>
                              <span class="encolhe">{{ c.nome }}</span>
                            </th>
                            @for (t of p.tamanhos; track t) {
                              @let cel = celula(p, c.nome, t);
                              @if (cel) {
                                <td class="cel" [class.zero]="(cel.saldo ?? 0) <= 0"
                                    [title]="c.nome + ' ' + t + saldoTitulo(cel) + precoTitulo(cel) + (cel.codigoBarras ? ' · ' + cel.codigoBarras : '')">
                                  {{ cel.saldo === null ? '?' : cel.saldo }}
                                </td>
                              } @else {
                                <td class="cel vazio" aria-label="sem esta combinação">—</td>
                              }
                            }
                            <td class="cel tot">{{ p.totalCor[c.nome] }}</td>
                          </tr>
                        }
                      </tbody>
                      <tfoot>
                        <tr>
                          <th class="crow">Total</th>
                          @for (t of p.tamanhos; track t) { <td class="cel tot">{{ p.totalTam[t] }}</td> }
                          <td class="cel tot geral">{{ p.total }}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                } @else {
                  <div class="skus">
                    @for (s of p.skus; track s.id) {
                      <span class="sku">
                        <span class="s-at">{{ atributos(s.atributos) }}</span>
                        <span class="s-saldo" [class.zero]="(s.saldo ?? 0) <= 0">{{ s.saldo ?? '?' }} un</span>
                      </span>
                    }
                  </div>
                }
              </li>
            }
          </ul>
          @if (temMais()) { <button class="btn btn--secundario btn--bloco mais" (click)="buscar(true)">Carregar mais</button> }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-4); }
    h1 { margin: 0; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .barra { display: flex; gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .busca { flex: 1; min-width: 200px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .perfil { display: flex; }
    .perfil button { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; font-size: 13px; cursor: pointer; }
    .perfil button:first-child { border-radius: var(--raio-controle) 0 0 var(--raio-controle); }
    .perfil button:last-child { border-radius: 0 var(--raio-controle) var(--raio-controle) 0; border-left: 0; }
    .perfil button.on { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .dica { font-size: 13px; color: var(--texto-suave); }
    .mais { margin-top: var(--espacamento-3); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; color: var(--texto-secundario); }
    .lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3); }
    .prod { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .prod-topo { display: flex; gap: var(--espacamento-3); align-items: baseline; margin-bottom: var(--espacamento-3); }
    .ref { color: var(--acao); flex: none; }
    .desc { color: var(--texto); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preco { color: var(--texto-secundario); flex: none; font-size: 13px; }
    table.grade { border-collapse: collapse; font-size: 13px; min-width: max-content; }
    table.grade th, table.grade td { border: 1px solid var(--borda); padding: var(--espacamento-1) var(--espacamento-3); text-align: center; }
    .canto { color: var(--texto-suave); font-weight: 500; font-size: 11px; text-align: left; white-space: nowrap; }
    .tcol { color: var(--texto-secundario); font-weight: 600; }
    .ttot, .tot { background: var(--superficie); color: var(--texto); font-weight: 600; }
    .crow { text-align: left; color: var(--texto); font-weight: 500; white-space: nowrap; }
    .crow > .encolhe { display: inline-block; vertical-align: middle; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
    .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
    .sw.borda { box-shadow: inset 0 0 0 1px var(--borda-forte); }
    .cel { color: var(--texto); font-variant-numeric: tabular-nums; }
    .cel.zero { color: var(--texto-suave); }
    .cel.vazio { color: var(--texto-suave); background: var(--superficie); }
    .cel.geral { color: var(--acao); }
    .skus { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .sku { display: inline-flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--fundo); font-size: 12px; }
    .s-at { color: var(--texto-secundario); }
    .s-saldo { color: var(--sucesso); }
    .s-saldo.zero { color: var(--erro); }
  `,
})
export class CatalogoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('buscando')
  readonly itens = signal<readonly Produto[]>([])
  readonly temMais = signal(false)
  readonly busca = signal('')
  readonly perfil = signal<PerfilPreco>(PERFIL_PRECO_PADRAO)
  private cursor: string | null = null
  private timer?: ReturnType<typeof setTimeout>

  ngOnInit(): void { void this.buscar() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  atributos(a: Record<string, string>): string { return Object.values(a).join(' · ') || '—' }
  celula(p: Produto, cor: string, tam: string): Cel | undefined { return p.cells[`${cor}||${tam}`] }
  saldoTitulo(c: Cel): string { return c.saldo === null ? ' · saldo não sincronizado' : ` · ${c.saldo} un` }
  precoTitulo(c: Cel): string { return c.precoCentavos === null ? '' : ` · ${this.reais(c.precoCentavos)}` }
  /** Cor muito clara ganha borda no swatch para não sumir no fundo. */
  claro(hex: string): boolean {
    const h = hex.replace('#', '')
    if (h.length < 6) return false
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.82
  }

  onBusca(v: string): void {
    this.busca.set(v)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.buscar(), 300)
  }
  trocarPerfil(p: PerfilPreco): void { this.perfil.set(p); void this.buscar() }

  /** Lista PAGINADA por cursor (regra do projeto: nada de top-N cru). `anexar`
   *  = "carregar mais"; sem ele, recomeça a lista. */
  async buscar(anexar = false): Promise<void> {
    if (!anexar) { this.estado.set('buscando'); this.cursor = null }
    try {
      const qs = new URLSearchParams({ perfil: this.perfil() })
      if (this.busca().trim()) qs.set('busca', this.busca().trim())
      if (anexar && this.cursor) qs.set('cursor', this.cursor)
      const r = await firstValueFrom(this.http.get<{ itens: ProdutoApi[]; proximoCursor: string | null }>(
        `/v1/catalogo/busca?${qs}`))
      const grades = r.itens.map((p) => this.montarGrade(p))
      this.itens.set(anexar ? [...this.itens(), ...grades] : grades)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  // Lê um atributo por chave, ignorando caixa ('cor'/'COR'/'Cor').
  private ler(a: Record<string, string>, chave: string): string {
    for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === chave) return (v ?? '').trim()
    return ''
  }
  private rankTam(t: string): [number, number, string] {
    const s = t.trim().toUpperCase()
    if (s === 'U' || s === 'UN' || s === 'UNICO' || s === 'ÚNICO') return [0, 0, s]
    if (TAM_LETRA[s] !== undefined) return [1, TAM_LETRA[s]!, s]
    const n = Number(s.replace(',', '.'))
    if (!Number.isNaN(n)) return [2, n, s]
    return [3, 0, s]
  }

  /** Pivot: linhas planas de SKU → matriz cor × tamanho (skill §11). */
  private montarGrade(p: ProdutoApi): Produto {
    const coresSet = new Map<string, boolean>()   // nome → visto
    const tamsSet = new Set<string>()
    const cells: Record<string, Cel> = {}
    for (const s of p.skus) {
      const cor = this.ler(s.atributos, 'cor')
      const tam = this.ler(s.atributos, 'tamanho')
      if (!cor || !tam) continue
      coresSet.set(cor, true); tamsSet.add(tam)
      cells[`${cor}||${tam}`] = { saldo: s.saldo, precoCentavos: s.precoCentavos, codigoBarras: s.codigoBarras ?? null }
    }
    const temGrade = coresSet.size > 0 && tamsSet.size > 0
    const cores: Cor[] = [...coresSet.keys()].sort((a, b) => a.localeCompare(b, 'pt'))
      .map((nome) => ({ nome, hex: CORES_HEX[nome.toUpperCase()] ?? null }))
    const tamanhos = [...tamsSet].sort((a, b) => {
      const ra = this.rankTam(a), rb = this.rankTam(b)
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2])
    })

    // Totais (skill §10). Combinação inexistente NÃO entra; saldo nulo conta 0.
    const totalCor: Record<string, number> = {}
    const totalTam: Record<string, number> = {}
    let total = 0
    for (const c of cores) {
      let linha = 0
      for (const t of tamanhos) {
        const cel = cells[`${c.nome}||${t}`]
        if (!cel) continue
        const q = cel.saldo ?? 0
        linha += q; totalTam[t] = (totalTam[t] ?? 0) + q
      }
      totalCor[c.nome] = linha; total += linha
    }

    // Preço: único, ou faixa min–max.
    const precos = [...new Set(p.skus.map((s) => s.precoCentavos).filter((x): x is number => x !== null))]
    const precoRotulo = precos.length === 0 ? 'sem preço'
      : precos.length === 1 ? this.reais(precos[0]!)
      : `${this.reais(Math.min(...precos))} – ${this.reais(Math.max(...precos))}`

    return { ...p, temGrade, cores, tamanhos, cells, totalCor, totalTam, total, precoRotulo }
  }
}
