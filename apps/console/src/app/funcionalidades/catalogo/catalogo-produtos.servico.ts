import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { OrigemCatalogo, PerfilPreco, ProdutoEntrada, SkuEntrada } from '@geracrm/shared'
import { ehStatus, mensagemDeErro, mesclarPagina, queryDeLista } from '../../compartilhado/ui/index.js'

/** Como a API lista/detalha um produto (busca.ts → montarDetalhe). */
export interface SkuLinha {
  readonly id: string
  readonly atributos: Record<string, string>
  readonly codigoBarras: string | null
  readonly origem: OrigemCatalogo
  readonly ativo: boolean
  /** Preço do PERFIL pedido na consulta (a lista usa o padrão: atacado). */
  readonly precoCentavos: number | null
  readonly saldo: number | null
  readonly saldoEm: string | null
}
export interface ProdutoLinha {
  readonly id: string
  readonly referencia: string
  readonly descricao: string
  readonly descricaoLonga: string | null
  readonly categoria: string | null
  readonly imagem: string | null
  readonly imagens: readonly string[]
  readonly origem: OrigemCatalogo
  readonly ativo: boolean
  readonly skus: readonly SkuLinha[]
}

export type EstadoLista = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
export type FiltroOrigem = '' | OrigemCatalogo

/** Resultado tipificado de uma escrita: a tela mostra a frase, nunca a exceção. */
export type ResultadoEscrita = { readonly ok: true } | { readonly ok: false; readonly mensagem: string; readonly campos?: readonly string[] }

interface Pagina { itens: ProdutoLinha[]; proximoCursor: string | null }

@Injectable({ providedIn: 'root' })
export class CatalogoProdutosServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('carregando')
  readonly erroLista = signal<string | null>(null)
  readonly itens = signal<readonly ProdutoLinha[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  /** Falha ao carregar mais — a lista já carregada continua (estado parcial). */
  readonly erroMais = signal<string | null>(null)

  readonly busca = signal('')
  readonly origem = signal<FiltroOrigem>('')
  readonly inativos = signal(false)

  private url(cursor: string | null): string {
    return '/v1/catalogo/produtos' + queryDeLista({
      cursor, busca: this.busca().trim(), origem: this.origem(), inativos: this.inativos() ? '1' : '',
    })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroLista.set(null); this.erroMais.set(null)
    try {
      const r = await firstValueFrom(this.http.get<Pagina>(this.url(null)))
      this.itens.set(r.itens); this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) { this.estado.set('sem_permissao'); return }
      this.erroLista.set(mensagemDeErro(e, 'Não foi possível carregar o catálogo.'))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true); this.erroMais.set(null)
    try {
      const r = await firstValueFrom(this.http.get<Pagina>(this.url(cursor)))
      this.itens.update((a) => mesclarPagina(a, r.itens, (p) => p.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch (e) {
      this.erroMais.set(mensagemDeErro(e, 'Não foi possível carregar mais produtos.'))
    } finally { this.carregandoMais.set(false) }
  }

  /** Detalhe com o preço de UM perfil (a API cota um perfil por chamada). */
  async detalhe(id: string, perfil: PerfilPreco): Promise<ProdutoLinha | null> {
    try {
      return await firstValueFrom(this.http.get<ProdutoLinha>(`/v1/catalogo/produtos/${id}?perfil=${perfil}&inativos=1`))
    } catch { return null }
  }

  /** Os dois preços de cada SKU do produto. `null` em ambos = não deu para ler. */
  async precosPorSku(id: string): Promise<Map<string, { varejo: number | null; atacado: number | null }> | null> {
    const [v, a] = await Promise.all([this.detalhe(id, 'varejo'), this.detalhe(id, 'atacado')])
    if (!v || !a) return null
    const mapa = new Map<string, { varejo: number | null; atacado: number | null }>()
    for (const s of v.skus) mapa.set(s.id, { varejo: s.precoCentavos, atacado: null })
    for (const s of a.skus) mapa.set(s.id, { varejo: mapa.get(s.id)?.varejo ?? null, atacado: s.precoCentavos })
    return mapa
  }

  criarProduto(corpo: ProdutoEntrada & { skus?: SkuEntrada[] }): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.post('/v1/catalogo/produtos', corpo)), 'Não foi possível criar o produto.')
  }
  editarProduto(id: string, corpo: Partial<ProdutoEntrada>): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.patch(`/v1/catalogo/produtos/${id}`, corpo)), 'Não foi possível salvar o produto.')
  }
  desativarProduto(id: string): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.delete(`/v1/catalogo/produtos/${id}`)), 'Não foi possível desativar o produto.')
  }
  adicionarSku(produtoId: string, corpo: SkuEntrada): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.post(`/v1/catalogo/produtos/${produtoId}/skus`, corpo)), 'Não foi possível adicionar a variação.')
  }
  editarSku(produtoId: string, skuId: string, corpo: SkuEntrada): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.patch(`/v1/catalogo/produtos/${produtoId}/skus/${skuId}`, corpo)), 'Não foi possível salvar a variação.')
  }
  desativarSku(produtoId: string, skuId: string): Promise<ResultadoEscrita> {
    return this.escrever(firstValueFrom(this.http.delete(`/v1/catalogo/produtos/${produtoId}/skus/${skuId}`)), 'Não foi possível desativar a variação.')
  }

  async reindexar(): Promise<{ ok: true; indexados: number; inalterados: number; ausentes: number } | { ok: false; mensagem: string }> {
    try {
      const r = await firstValueFrom(this.http.post<{ indexados: number; inalterados: number; ausentes: number }>('/v1/catalogo/reindexar', {}))
      return { ok: true, ...r }
    } catch (e) { return { ok: false, mensagem: mensagemDeErro(e, 'Não foi possível reindexar o catálogo.') } }
  }

  private async escrever(op: Promise<unknown>, padrao: string): Promise<ResultadoEscrita> {
    try { await op; return { ok: true } } catch (e) {
      // ⚠️ 409 `catalogo.origem_erp` e 422 `entrada_invalida` trazem `campos`;
      //    a tela aponta quais. A frase vem da API, com a ação corretiva.
      const campos = (e as { error?: { campos?: string[] } })?.error?.campos
      return { ok: false, mensagem: mensagemDeErro(e, padrao), ...(campos ? { campos } : {}) }
    }
  }
}
