import type {
  ConectorErp, Capacidades, ClienteCanonico, SkuCanonico, SaldoCanonico,
  PrecoCanonico, VendaCanonica, Pagina, Resultado, FalhaEfetivacao,
} from '../porta.js'

/**
 * GeraCloud adapter (pdv-core).
 *
 * Built by reading the source at ~/git/Gera3/pdv-core — there is no API
 * documentation. Findings in docs/conector-geracloud.md.
 *
 * ⚠️ Everything vendor-specific lives HERE. If a GeraCloud field name leaks
 * into the domain, the multi-ERP abstraction has already broken.
 */

/**
 * ⚠️ Two of these are UNCONFIRMED and are deliberately declared `false`:
 *
 *  - `creditoCliente`: no endpoint found while reading the code.
 *  - `escritaPedido`: `POST /vendas/...` exists, but idempotency is unconfirmed
 *    — and without it a network timeout duplicates an order in a real
 *    customer's ERP (INV-53).
 *
 * Declaring `false` degrades the product in a visible, honest way. Declaring
 * `true` on a hunch breaks it silently, in production, on someone's order.
 * Flip them only after checking against homologation.
 */
export const CAPACIDADES_GERACLOUD: Capacidades = {
  ingestaoClientes: true,
  ingestaoProdutos: true,
  ingestaoPedidos: true,
  cargaHistorica: true,
  saldoSincrono: true,
  tabelaPrecoSincrona: true,
  creditoCliente: false,
  escritaPedido: false,
  // No outbound webhook anywhere in the codebase. Sync is scheduled — and the
  // resulting lag in revenue attribution must be declared on screen.
  webhookDeVenda: false,
}

export interface OpcoesGeraCloud {
  readonly baseUrl: string
  /** Per-tenant, decrypted just before use. Never stored on the adapter. */
  readonly token: string
  readonly timeoutMs?: number
  readonly buscar?: typeof fetch
}

/** Only digits — the ERP stores phone as free text. */
function apenasDigitos(v: string | null | undefined): string | undefined {
  const d = (v ?? '').replace(/\D/g, '')
  return d.length > 0 ? d : undefined
}

/** The ERP stores money as decimal; the domain uses integer cents. */
function paraCentavos(valor: unknown): number {
  const n = typeof valor === 'number' ? valor : Number(valor ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export class ConectorGeraCloud implements ConectorErp {
  readonly nome = 'geracloud'
  readonly capacidades = CAPACIDADES_GERACLOUD

  readonly #base: string
  readonly #token: string
  readonly #timeout: number
  readonly #buscar: typeof fetch

  constructor(op: OpcoesGeraCloud) {
    this.#base = op.baseUrl.replace(/\/$/, '')
    this.#token = op.token
    // ⚠️ 2s by contract. Above that the order screen must warn and block
    // submission instead of letting the salesperson assemble blind.
    this.#timeout = op.timeoutMs ?? 2_000
    this.#buscar = op.buscar ?? fetch
  }

  async #pedir<T>(caminho: string, init?: RequestInit): Promise<T> {
    const abortar = new AbortController()
    const relogio = setTimeout(() => abortar.abort(), this.#timeout)
    try {
      const r = await this.#buscar(`${this.#base}${caminho}`, {
        ...init,
        signal: abortar.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
      if (!r.ok) throw new Error(`geracloud ${r.status} em ${caminho}`)
      return (await r.json()) as T
    } finally {
      clearTimeout(relogio)
    }
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  async listarClientes(cursor?: string): Promise<Pagina<ClienteCanonico>> {
    const pagina = Number(cursor ?? 0)
    const dados = await this.#pedir<{ content?: unknown[]; last?: boolean }>(
      `/clientespdv?page=${pagina}&size=200`,
    )
    const linhas = dados.content ?? []

    return {
      itens: linhas.map((linha) => {
        const c = linha as Record<string, unknown>
        const nome = [c.nome, c.sobrenome].filter(Boolean).join(' ').trim()
        const telefone = apenasDigitos(c.telefone as string)
        return {
          idExterno: String(c.id),
          nome: nome || String(c.nome ?? ''),
          // ⚠️ CNPJ wins over CPF: in wholesale the buyer is a company, and the
          // reconciliation key across ERPs is the company document.
          documento: apenasDigitos((c.cnpj as string) ?? (c.cpf as string)),
          // The ERP holds ONE phone. The others arrive via WhatsApp and import —
          // hence the array here even though the source gives at most one.
          telefones: telefone ? [telefone] : [],
          email: (c.email as string) || undefined,
          // ⚠️ Existing wallet assignment, as free text. Resolved against
          // usuario_identidade_externa (0007); unmatched becomes a pending
          // correspondence instead of being dropped.
          vendedorExterno: (c.usernameVendedor as string) || undefined,
          ativo: c.status === 0 || c.status === undefined,
        }
      }),
      cursor: dados.last === false ? String(pagina + 1) : undefined,
    }
  }

  async listarSkus(cursor?: string): Promise<Pagina<SkuCanonico>> {
    const pagina = Number(cursor ?? 0)
    const dados = await this.#pedir<{ content?: unknown[]; last?: boolean }>(
      `/estoques?page=${pagina}&size=200`,
    )
    const linhas = dados.content ?? []

    return {
      itens: linhas.map((linha) => {
        const e = linha as Record<string, unknown>
        const cb = (e.codigoBarra ?? {}) as Record<string, unknown>
        const produto = (cb.produto ?? {}) as Record<string, unknown>
        const cor = (cb.cor ?? {}) as Record<string, unknown>
        const tamanho = (cb.tamanho ?? {}) as Record<string, unknown>
        const subTamanho = (cb.subTamanho ?? {}) as Record<string, unknown>

        // ⚠️ The SKU is CodigoBarra, NOT Produto. Produto is the model
        // ("CONJUNTO LAILA"); CodigoBarra is what has stock and price.
        // Treating Produto as sellable gets balance, price and grid all wrong.
        const atributos: Record<string, string> = {}
        if (cor.descricao) atributos.cor = String(cor.descricao)
        if (tamanho.descricao) atributos.tamanho = String(tamanho.descricao)
        // The reference ERP has sub-size as well — fixed columns would already
        // be broken here (ADR-004).
        if (subTamanho.descricao) atributos.subTamanho = String(subTamanho.descricao)

        return {
          idExterno: String(cb.id ?? e.id),
          referencia: String(produto.referencia ?? ''),
          descricao: String(produto.descricao ?? ''),
          atributos,
          codigoBarras: (cb.valor as string) || undefined,
          ativo: true,
        }
      }),
      cursor: dados.last === false ? String(pagina + 1) : undefined,
    }
  }

  async listarVendas(desde: Date, cursor?: string): Promise<Pagina<VendaCanonica>> {
    const pagina = Number(cursor ?? 0)
    const dados = await this.#pedir<{ content?: unknown[]; last?: boolean }>(
      `/vendas?page=${pagina}&size=100&dataInicio=${desde.toISOString().slice(0, 10)}`,
    )
    const linhas = dados.content ?? []

    return {
      itens: linhas.map((linha) => {
        const v = linha as Record<string, unknown>
        const itens = (v.itens ?? []) as Record<string, unknown>[]
        return {
          idExterno: String(v.id),
          clienteExterno: String((v.cliente as Record<string, unknown>)?.id ?? ''),
          ocorridaEm: new Date(String(v.dataVenda ?? v.data)),
          valorCentavos: paraCentavos(v.valorTotal),
          vendedorExterno: (v.usernameVendedor as string) || undefined,
          filialExterna: String((v.loja as Record<string, unknown>)?.id ?? '') || undefined,
          itens: itens.map((i) => ({
            skuExterno: String((i.codigoBarra as Record<string, unknown>)?.id ?? i.idCodigoBarra),
            quantidade: Number(i.quantidade ?? 0),
            valorUnitarioCentavos: paraCentavos(i.valorUnitario),
          })),
        }
      }),
      cursor: dados.last === false ? String(pagina + 1) : undefined,
    }
  }

  // -------------------------------------------------------------------------
  // Live reads
  // -------------------------------------------------------------------------

  /**
   * ⚠️ `/estoques/tela-venda` returns balance ALREADY WITH the price for the
   * given table — the single most useful thing found in the source. One call
   * instead of two that can disagree with each other.
   */
  async consultarSaldo(
    skusExternos: readonly string[],
    filialExterna?: string,
  ): Promise<readonly SaldoCanonico[]> {
    const agora = new Date()
    const params = new URLSearchParams({ size: String(skusExternos.length || 50) })
    if (filialExterna) params.set('idLoja', filialExterna)

    const dados = await this.#pedir<{ content?: unknown[] }>(
      `/estoques/tela-venda?${params}`,
    )

    return (dados.content ?? [])
      .map((linha) => {
        const e = linha as Record<string, unknown>
        const cb = (e.codigoBarra ?? {}) as Record<string, unknown>
        return {
          skuExterno: String(cb.id ?? e.idCodigoBarra),
          // The ERP has both integer and decimal quantity; decimal wins when present.
          quantidade: Number(e.quantidadeDecimal ?? e.quantidade ?? 0),
          filialExterna,
          apuradoEm: agora,
        }
      })
      .filter((s) => skusExternos.length === 0 || skusExternos.includes(s.skuExterno))
  }

  async consultarPrecos(
    _clienteExterno: string,
    skusExternos: readonly string[],
  ): Promise<readonly PrecoCanonico[]> {
    // TODO: map customer → price table. The ERP exposes /tabela-preco/todas and
    // /estoques/tela-venda?filtroTabelaPreco=, but WHICH table belongs to a
    // customer was not found while reading the source (question 2 of §6).
    const dados = await this.#pedir<{ content?: unknown[] }>(`/estoques/tela-venda?size=200`)
    return (dados.content ?? [])
      .map((linha) => {
        const e = linha as Record<string, unknown>
        const cb = (e.codigoBarra ?? {}) as Record<string, unknown>
        return {
          skuExterno: String(cb.id ?? e.idCodigoBarra),
          tabela: String(e.idTabelaPreco ?? 'padrao'),
          valorCentavos: paraCentavos(e.valorVenda ?? e.preco),
        }
      })
      .filter((p) => skusExternos.length === 0 || skusExternos.includes(p.skuExterno))
  }

  // -------------------------------------------------------------------------
  // Writes — intentionally absent
  // -------------------------------------------------------------------------
  //
  // ⚠️ `efetivarPedido` and `consultarPedidoPorChave` are NOT implemented,
  // and `escritaPedido` is declared false.
  //
  // `POST /vendas/...` exists, but idempotency is unconfirmed. Shipping a write
  // without it means that one network timeout duplicates an order in a real
  // customer's ERP — exactly what INV-53 exists to prevent.
  //
  // Until homologation answers, the product degrades the honest way: the order
  // pad becomes an exportable draft (ADR-008), and the screen says why.
}

export type ResultadoEfetivacao = Resultado<{ numeroExterno: string }, FalhaEfetivacao>
