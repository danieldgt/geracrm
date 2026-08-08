import type {
  ConectorErp, Capacidades, ClienteCanonico, SkuCanonico, SaldoCanonico,
  PrecoCanonico, VendaCanonica, SaldoFidelidadeCanonico, Pagina, Resultado,
  FalhaEfetivacao,
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
 * ⚠️ Two are `false` for different reasons, and the difference matters:
 *
 *  - `creditoCliente`: **definitive, and out of scope.** The pdv-core has no
 *    credit limit — every sale is paid on the spot. And term/credit management
 *    stays in the ERP, which already has it (ADR-019). This is not a gap to
 *    fill later; the credit block simply does not render.
 *
 *  - `escritaPedido`: **conditional.** `POST /vendas/...` exists but almost
 *    certainly has no idempotency key. Writing without one means a single
 *    network timeout duplicates an order in a real customer's ERP (INV-53).
 *    Enabled once the reconciliation path below is implemented and verified
 *    against homologation.
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
  // ✅ The pdv-core already has CartaoCashback, MovimentacaoCartaoCashback and
  // ConfiguracaoCartaoCashback — including dataExpiracao, which is what makes
  // FID-04 possible. We read it; we never manage it (ADR-020).
  fidelidade: true,
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
          // CNPJ first, CPF next — but ⚠️ in retail (the primary case, ADR-019)
          // most customers have NEITHER. Reconciliation cannot rely on this
          // field; the normalised phone is the primary key.
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

  /**
   * ⚠️ Read-only, by design (ADR-020). Redemption happens at the till, and the
   * ERP is the single source of truth for the customer's money.
   *
   * `expiraEm` is the field that makes FID-04 work: the ERP already computes
   * the deadline and nobody tells the customer before the money is gone.
   */
  async consultarSaldoFidelidade(clienteExterno: string): Promise<SaldoFidelidadeCanonico | null> {
    const dados = await this.#pedir<{ content?: unknown[] }>(
      `/movimentacoes-cartao-cashback?idClientePdv=${encodeURIComponent(clienteExterno)}&size=200`,
    ).catch(() => ({ content: [] }))

    const movs = (dados.content ?? []) as Record<string, unknown>[]
    if (movs.length === 0) return null

    let disponivel = 0
    let expiraEm: Date | undefined
    for (const m of movs) {
      const valor = paraCentavos((m.valor as Record<string, unknown>)?.amount ?? m.valor)
      // The ERP records credits and debits as operations; only live credits count.
      const credito = String(m.operacao ?? '').toUpperCase().includes('CREDITO')
      const vencimento = m.dataExpiracao ? new Date(String(m.dataExpiracao)) : undefined
      const vencido = vencimento ? vencimento.getTime() < Date.now() : false
      if (credito && !vencido) {
        disponivel += valor
        // Earliest upcoming expiry drives the campaign — that is the urgency.
        if (vencimento && (!expiraEm || vencimento < expiraEm)) expiraEm = vencimento
      } else if (!credito) {
        disponivel -= valor
      }
    }

    return {
      clienteExterno,
      disponivelCentavos: Math.max(0, disponivel),
      expiraEm,
      apuradoEm: new Date(),
    }
  }

  // -------------------------------------------------------------------------
  // Writes — intentionally absent, and the plan for when they arrive
  // -------------------------------------------------------------------------
  //
  // ⚠️ `escritaPedido` is false, so `efetivarPedido` is absent. The conformance
  // suite enforces that pairing.
  //
  // The ERP has no idempotency key. That makes reconciliation the MAIN path,
  // not the exception, and it works like this:
  //
  //   1. Persist the key in `chave_idempotencia` BEFORE calling the ERP.
  //      ⚠️ Before, not after — persisting after means a timeout erases the
  //      only trace that the call ever happened.
  //   2. Call the ERP.
  //   3a. Answered  → store the order number, done.
  //   3b. Timed out → ⚠️ the order MAY exist there. Do NOT retry.
  //       Move to `aguardando_conferencia` and reconcile by querying.
  //
  // Reconciliation without a key can only be a heuristic: same customer, same
  // total, within a few minutes. ⚠️ That is ambiguous by nature — two identical
  // orders from the same customer in the same minute are rare but real, and the
  // heuristic cannot tell "found mine" from "found a similar one".
  //
  // So: the heuristic resolves the clear case; ambiguity goes to a human.
  // An order awaiting confirmation is an annoyance. A duplicated order in the
  // customer's ERP is a problem with THEIR customer.
}

export type ResultadoEfetivacao = Resultado<{ numeroExterno: string }, FalhaEfetivacao>
