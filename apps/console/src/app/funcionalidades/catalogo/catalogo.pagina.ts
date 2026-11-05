import { Component, ChangeDetectionStrategy, computed, inject, signal, OnInit } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { PERFIL_PRECO_PADRAO, type PerfilPreco } from '@geracrm/shared'
import {
  CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, FiltrosComponente, IconeComponente, ModalComponente,
  PaginacaoComponente, SelectComponente, TabelaComponente, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'

interface Sku { readonly id: string; readonly atributos: Record<string, string>; readonly precoCentavos: number | null; readonly saldo: number | null; readonly codigoBarras?: string | null }
interface ProdutoApi { readonly id: string; readonly referencia: string; readonly descricao: string; readonly skus: readonly Sku[]; readonly origem?: 'erp' | 'manual' }

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
const OPCOES_PERFIL: OpcaoSelect[] = [{ valor: 'atacado', rotulo: 'Atacado' }, { valor: 'varejo', rotulo: 'Varejo' }]

/**
 * Catálogo em GRADE (cor × tamanho) — skill grade-cor-tamanho. Lista L: cada produto
 * é uma linha com saldo e ação; a matriz (linhas = cores, colunas = tamanhos ORDENADOS
 * por rank, célula = saldo do ERP) abre no modal "Ver grade". Combinação inexistente é
 * `—`, não 0 (§3). Sem grade, o modal mostra a lista de SKUs.
 *
 * A API devolve linhas planas por SKU; o pivot é no cliente (§11). Reusa a mesma
 * verdade do pedido assistido. Paginação por cursor.
 */
@Component({
  selector: 'app-catalogo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, FiltrosComponente, IconeComponente, ModalComponente,
    PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Catálogo" subtitulo="Produtos em grade (cor × tamanho) com saldo do ERP." />

    <ui-filtros placeholder="Buscar por referência ou descrição" rotuloBusca="Busca"
      (buscar)="aoBuscar($event)" (aplicar)="buscar()">
      <ui-select rotulo="Perfil de preço" [opcoes]="opcoesPerfil" [valor]="perfil()" (valorChange)="trocarPerfil($event)" />
    </ui-filtros>

    <div class="corpo">
      @switch (estado()) {
        @case ('buscando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso ao catálogo" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o catálogo" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="buscar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <!-- ⚠️ "Adicionar ao pedido" precisa de um cliente: o pedido nasce
               para alguém. Sem ?contato= na URL, o botão fica visível e
               explicado (não some) — e a dica diz por onde ir. -->
          @if (!contatoId()) {
            <p class="dica-pedido txt-denso" role="status"><ui-icone nome="info" />Para adicionar ao pedido, venha pela ficha do cliente — o pedido precisa de um cliente.</p>
          }
          <ui-tabela [colunas]="colunas" [linhas]="linhas()">
            <ng-template uiCelula="origem" let-p>
              @if (p.origem) { <span class="origem" [class.erp]="p.origem === 'erp'">{{ p.origem === 'erp' ? 'ERP' : 'Manual' }}</span> }
            </ng-template>
            <ng-template uiCelula="preco" let-p><span class="txt-dados">{{ p.precoRotulo }}</span></ng-template>
            <ng-template uiCelula="saldo" let-p><span class="txt-dados">{{ saldoDe(p) }}</span></ng-template>
            <ng-template uiCelula="acoes" let-p>
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirGrade(p)">
                  {{ p.temGrade ? 'Ver grade' : 'Ver SKUs' }}
                </button>
                <button type="button" class="btn btn--primario btn--pequeno" [disabled]="!contatoId()" (click)="adicionarAoPedido(p)"
                        [title]="contatoId() ? 'Abrir o pedido deste cliente com este produto' : 'Escolha o cliente primeiro: abra a ficha do contato e clique em Novo pedido'">
                  <ui-icone nome="shopping-cart" [tamanho]="14" />Adicionar ao pedido
                </button>
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nada encontrado" descricao="Refine a busca ou sincronize o catálogo do ERP." />
            </div>
          </ui-tabela>
          <ui-paginacao [mostrados]="itens().length" [temMais]="temMais()" [carregando]="carregandoMais()" (mais)="buscar(true)" />
        }
      }
    </div>

    <!-- Grade do produto: matriz cor × tamanho (ou SKUs, sem grade). Leitura; a ação é a da linha. -->
    <ui-modal [aberto]="grade() !== null" [titulo]="tituloGrade()" largura="g" (fechar)="fecharGrade()">
      @if (grade(); as p) {
        <p class="sub-modal">{{ p.descricao }} · {{ p.precoRotulo }}</p>
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
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharGrade()">Fechar</button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    ui-filtros { display: block; }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .origem { font-size: 11px; font-weight: 600; line-height: 1; padding: 3px 8px; border-radius: var(--raio-completo); border: 1px solid var(--borda); color: var(--texto-secundario); white-space: nowrap; }
    .origem.erp { color: var(--acao); border-color: var(--acao); }
    .acoes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--espacamento-2); }
    .dica-pedido { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0; padding: var(--espacamento-2) var(--espacamento-3);
      border-radius: var(--raio-controle); background: var(--acao-suave); color: var(--texto); font-size: 13px; }
    .sub-modal { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); }
    .rolagem-x { overflow-x: auto; max-width: 100%; }
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
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  /** Cliente de contexto (?contato=<id>) — vem da ficha. Sem ele, não há pedido a abrir. */
  readonly contatoId = signal<string | null>(null)
  readonly estado = signal<Estado>('buscando')
  readonly itens = signal<readonly Produto[]>([])
  readonly temMais = signal(false)
  readonly carregandoMais = signal(false)
  readonly busca = signal('')
  readonly perfil = signal<PerfilPreco>(PERFIL_PRECO_PADRAO)
  readonly opcoesPerfil = OPCOES_PERFIL
  /** Produto com a grade aberta no modal; `null` = fechado. */
  readonly gradeId = signal<string | null>(null)
  readonly grade = computed(() => {
    const id = this.gradeId()
    return id ? (this.itens().find((p) => p.id === id) ?? null) : null
  })
  protected readonly colunas: ColunaTabela[] = [
    { chave: 'referencia', rotulo: 'Referência', mono: true, largura: '140px' },
    { chave: 'descricao', rotulo: 'Descrição' },
    { chave: 'origem', rotulo: 'Origem', largura: '100px' },
    { chave: 'preco', rotulo: 'Preço', alinhamento: 'dir', largura: '150px' },
    { chave: 'saldo', rotulo: 'Saldo', alinhamento: 'dir', largura: '100px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '330px' },
  ]
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  private cursor: string | null = null

  ngOnInit(): void {
    this.contatoId.set(this.route.snapshot.queryParamMap.get('contato'))
    void this.buscar()
  }

  tituloGrade(): string { return this.grade()?.referencia ?? 'Grade' }
  abrirGrade(p: Produto): void { this.gradeId.set(p.id) }
  fecharGrade(): void { this.gradeId.set(null) }

  /** Saldo na linha: a soma da grade, ou a soma dos SKUs quando não há grade. `?` se algum SKU não sincronizou. */
  saldoDe(p: Produto): string {
    if (p.temGrade) return String(p.total)
    if (p.skus.some((s) => s.saldo === null)) return '?'
    return String(p.skus.reduce((soma, s) => soma + (s.saldo ?? 0), 0))
  }

  /** Abre o pedido do cliente já com a busca no produto escolhido. */
  adicionarAoPedido(p: Produto): void {
    const contato = this.contatoId()
    if (!contato) return
    void this.router.navigate(['/pedido'], { queryParams: { contato, busca: p.referencia } })
  }
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

  /** O filtro de busca já espera 300 ms (ui-filtros); aqui só guarda o termo e busca do começo. */
  aoBuscar(termo: string): void {
    this.busca.set(termo)
    void this.buscar()
  }
  trocarPerfil(p: string): void { this.perfil.set(p as PerfilPreco); void this.buscar() }

  /** Lista PAGINADA por cursor (regra do projeto: nada de top-N cru). `anexar`
   *  = "carregar mais"; sem ele, recomeça a lista. */
  async buscar(anexar = false): Promise<void> {
    if (anexar) {
      if (!this.cursor || this.carregandoMais()) return
      this.carregandoMais.set(true)
    } else {
      this.estado.set('buscando'); this.cursor = null
    }
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
    } catch (e) {
      if (anexar) this.carregandoMais.set(false)
      else this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    } finally { if (anexar) this.carregandoMais.set(false) }
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
