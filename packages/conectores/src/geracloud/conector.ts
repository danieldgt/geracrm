import type {
  ConectorErp, Capacidades, ClienteCanonico, SkuCanonico, SaldoCanonico,
  PrecoCanonico, TabelaPrecoCanonica, VendaCanonica, SaldoFidelidadeCanonico,
  Pagina, Resultado, FalhaEfetivacao,
} from '../porta.js'
import { montarOrcamento, traduzirRespostaOrcamento } from './orcamento.js'

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
  // ⚠️ Só ORÇAMENTO (POST /catalogos-publico/orcamento). O ERP não expõe criação
  //    de VENDA por esta via — `status` é fixo em 'Orcamento' no próprio catálogo
  //    do fornecedor. O produto precisa dizer isso na tela: quem lê "efetivado" e
  //    entende "venda fechada" vai se surpreender no fim do mês.
  escritaPedido: true,
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
  readonly token?: string
  /**
   * ⚠️ Alternativa ao `token` fixo, para carga longa. O token do Keycloak
   * expira em ~5 min, e uma carga histórica de anos passa disso — um token
   * fixo falharia no meio, com metade da base dentro. Quando presente, o
   * adaptador pede um token fresco a cada chamada; quem fornece decide se
   * reusa o cacheado ou renova.
   */
  readonly obterToken?: () => Promise<string>
  readonly timeoutMs?: number
  readonly buscar?: typeof fetch
}

const TAMANHO_PAGINA = 200

/**
 * ⚠️ A paginação do GeraCloud é por OFFSET (`inicio` = setFirstResult em LINHAS,
 * `limite` = setMaxResults), NÃO por página estilo Spring. Confirmado no fonte e
 * ao vivo: com `page`/`size` vinham 5 vendas; com `inicio`/`limite`, 200 por
 * página, paginando de verdade. O cursor deste adaptador é o offset em linhas.
 */
function paramsPagina(offset: number): string {
  return `inicio=${offset}&limite=${TAMANHO_PAGINA}`
}
function cursorPorOffset(qtdRecebida: number, offsetAtual: number): string | undefined {
  return qtdRecebida >= TAMANHO_PAGINA ? String(offsetAtual + TAMANHO_PAGINA) : undefined
}

/**
 * Data no formato do GeraCloud: `DD/MM/YYYY`. ⚠️ Confirmado ao vivo — ISO
 * (`2026-01-01`) é ignorado silenciosamente no filtro; só o formato brasileiro
 * realmente filtra. Enviar ISO faria a carga trazer o histórico inteiro achando
 * que filtrou por período.
 */
function dataBR(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getUTCFullYear()}`
}

interface ItemVendaCanonico {
  readonly skuExterno: string
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}

/**
 * Um item do detalhe da venda.
 *
 * ⚠️ Caminhos CONFIRMADOS na sonda, e diferentes do que presumi: o SKU é
 * `produtoPreco.codigoBarra.id` (não `codigoBarra.id` no item), e o preço
 * unitário é `precoDoMomento` (não `valorUnitario`) — o preço no momento da
 * venda, que é o que interessa, e não o de tabela de hoje.
 */
function itemDeVenda(i: Record<string, unknown>): ItemVendaCanonico {
  const produtoPreco = (i.produtoPreco ?? {}) as Record<string, unknown>
  const codigoBarra = (produtoPreco.codigoBarra ?? {}) as Record<string, unknown>
  return {
    skuExterno: String(codigoBarra.id ?? ''),
    quantidade: Number(i.quantidade ?? 0),
    valorUnitarioCentavos: paraCentavos(i.precoDoMomento),
  }
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

/**
 * ⚠️ O GeraCloud devolve data como `DD/MM/YYYY HH:mm:ss.SSSSSS` — confirmado na
 * sonda (`"03/08/2021 09:11:33.788328"`), NÃO ISO. `new Date()` sobre esse texto
 * interpreta `03/08` como 3 de agosto ou 8 de março conforme o locale, ou dá
 * Invalid Date — e a venda seria rejeitada por "data inválida". Aqui o parse é
 * explícito, campo a campo.
 */
function parseDataGeraCloud(valor: unknown): Date | null {
  if (typeof valor !== 'string') return null
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(valor.trim())
  if (!m) return null
  const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * ⚠️ As listagens devolvem ARRAY CRU, não o envelope `{content, last}` do Spring
 * Data que eu havia presumido — confirmado na sonda. Parsear como envelope daria
 * `content = undefined` e importaria ZERO, sem erro. Este helper aceita os dois
 * formatos para o dia em que algum endpoint use o envelope.
 */
function linhasDe(corpo: unknown): unknown[] {
  if (Array.isArray(corpo)) return corpo
  if (corpo && typeof corpo === 'object' && Array.isArray((corpo as { content?: unknown }).content)) {
    return (corpo as { content: unknown[] }).content
  }
  return []
}

export class ConectorGeraCloud implements ConectorErp {
  readonly nome = 'geracloud'
  readonly capacidades = CAPACIDADES_GERACLOUD

  readonly #base: string
  readonly #obterToken: () => Promise<string>
  readonly #timeout: number
  readonly #buscar: typeof fetch

  constructor(op: OpcoesGeraCloud) {
    this.#base = op.baseUrl.replace(/\/$/, '')
    // ⚠️ Token fixo OU provedor. Um dos dois é obrigatório: sem token o
    //    adaptador não fala com o ERP, e falhar no boot é melhor que na
    //    primeira chamada, no meio de uma carga.
    if (op.obterToken) {
      this.#obterToken = op.obterToken
    } else if (op.token !== undefined) {
      const fixo = op.token
      this.#obterToken = () => Promise.resolve(fixo)
    } else {
      throw new Error('ConectorGeraCloud exige token ou obterToken')
    }
    // ⚠️ 2s by contract. Above that the order screen must warn and block
    // submission instead of letting the salesperson assemble blind.
    this.#timeout = op.timeoutMs ?? 2_000
    this.#buscar = op.buscar ?? fetch
  }

  /**
   * POST cru — para `catalogos-publico/*`, que é ROTA PÚBLICA e devolve ARQUIVO.
   *
   * ⚠️ Não passa pelo `#pedir` de propósito: aquele exige token e faz
   * `.json()` na resposta. Aqui não há token (confirmado ao vivo: a rota
   * responde 200 sem `Authorization`), e a resposta do orçamento é um blob —
   * `.json()` estouraria em cima de um pedido que FOI criado, e o erro pareceria
   * falha de envio.
   */
  async #buscarCru(caminho: string, corpo: string): Promise<{ status: number; texto: string }> {
    const abortar = new AbortController()
    const relogio = setTimeout(() => abortar.abort(), this.#timeout)
    try {
      const r = await this.#buscar(`${this.#base}${caminho}`, {
        method: 'POST',
        signal: abortar.signal,
        headers: { 'Content-Type': 'application/json' },
        body: corpo,
      })
      // ⚠️ Lê como TEXTO: em erro o ERP manda mensagem, em sucesso manda o
      //    arquivo. Só a mensagem de erro interessa, e ela cabe em texto.
      const texto = r.ok ? '' : await r.text().catch(() => '')
      return { status: r.status, texto }
    } finally {
      clearTimeout(relogio)
    }
  }

  async #pedir<T>(caminho: string, init?: RequestInit): Promise<T> {
    const abortar = new AbortController()
    const relogio = setTimeout(() => abortar.abort(), this.#timeout)
    const token = await this.#obterToken()
    try {
      const r = await this.#buscar(`${this.#base}${caminho}`, {
        ...init,
        signal: abortar.signal,
        headers: {
          Authorization: `Bearer ${token}`,
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
    const offset = Number(cursor ?? 0)
    const linhas = linhasDe(await this.#pedir(`/clientespdv?${paramsPagina(offset)}`))

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
          // ⚠️ O cliente NÃO carrega username de vendedor (confirmado na sonda:
          //    tem `corretor` — objeto por CPF — e `usernameCadastro`, que é quem
          //    cadastrou, não o dono da carteira). A carteira é atribuída pela
          //    VENDA, que traz `usernameVendedor`. Deixar undefined é honesto;
          //    inventar a partir de `usernameCadastro` daria dono errado.
          vendedorExterno: undefined,
          // status 0 = ativo no pdv-core.
          ativo: c.status === 0 || c.status === undefined,
        }
      }),
      cursor: cursorPorOffset(linhas.length, offset),
    }
  }

  async listarSkus(cursor?: string): Promise<Pagina<SkuCanonico>> {
    const offset = Number(cursor ?? 0)
    const linhas = linhasDe(await this.#pedir(`/estoques?${paramsPagina(offset)}`))

    return {
      itens: linhas.map((linha) => {
        const e = linha as Record<string, unknown>
        const cb = (e.codigoBarra ?? {}) as Record<string, unknown>
        const produto = (cb.produto ?? {}) as Record<string, unknown>
        const cor = (cb.cor ?? {}) as Record<string, unknown>
        const tamanho = (cb.tamanho ?? {}) as Record<string, unknown>
        const subTamanho = (cb.subTamanho ?? {}) as Record<string, unknown>

        // ⚠️ The SKU is CodigoBarra, NOT Produto. Produto is the model
        // ("T SHIRTS CORES"); CodigoBarra is what has stock and price.
        // Treating Produto as sellable gets balance, price and grid all wrong.
        // Confirmado na sonda: `codigoBarra.{cor,tamanho,produto,valor}`.
        const atributos: Record<string, string> = {}
        if (cor.descricao) atributos.cor = String(cor.descricao)
        if (tamanho.descricao) atributos.tamanho = String(tamanho.descricao)
        // ⚠️ subTamanho é OPCIONAL — este ERP tem produtos sem ele (a sonda
        //    mostrou T-shirt só com cor+tamanho). Por isso atributos abertos
        //    (ADR-004): coluna fixa de subTamanho ficaria nula na maioria.
        if (subTamanho.descricao) atributos.subTamanho = String(subTamanho.descricao)

        return {
          idExterno: String(cb.id ?? e.id),
          referencia: String(produto.referencia ?? ''),
          descricao: String(produto.descricao ?? ''),
          atributos,
          codigoBarras: (cb.valor as string) || undefined,
          // status 0 = ativo. A mesma CodigoBarra aparece em várias linhas de
          // estoque (uma por loja); a ingestão deduplica por identidade externa.
          ativo: produto.status === 0 || produto.status === undefined,
        }
      }),
      cursor: cursorPorOffset(linhas.length, offset),
    }
  }

  async listarVendas(desde: Date, cursor?: string): Promise<Pagina<VendaCanonica>> {
    const offset = Number(cursor ?? 0)
    // ⚠️ `dataInicial` em DD/MM/YYYY (ISO é ignorado). `dataFinal` bem no futuro
    //    = "de `desde` em diante"; a janela fina fica por conta de quem concilia,
    //    que filtra por período no SQL.
    const linhas = linhasDe(await this.#pedir(
      `/vendas?${paramsPagina(offset)}&dataInicial=${dataBR(desde)}&dataFinal=31/12/2099`,
    ))

    // ⚠️ Rascunho NÃO é venda — é um pedido não finalizado. A sonda mostrou
    //    `isRascunho`; importar rascunho infla o faturamento com o que ainda
    //    não aconteceu. Filtrado ANTES de virar VendaCanonica.
    const efetivas = linhas.filter((linha) => (linha as Record<string, unknown>).isRascunho !== true)

    return {
      itens: efetivas.map((linha) => {
        const v = linha as Record<string, unknown>
        // ⚠️ Todos os nomes abaixo foram CORRIGIDOS contra a sonda:
        //    `valor` (não valorTotal), `clientePDV` (não cliente),
        //    `dataVenda` no formato DD/MM/YYYY, `status: "CANCELADA"`.
        const cliente = (v.clientePDV ?? {}) as Record<string, unknown>
        const ocorridaEm = parseDataGeraCloud(v.dataVenda) ?? new Date(NaN)
        const cancelada = String(v.status ?? '').toUpperCase() === 'CANCELADA'
        const itens = (v.itens ?? []) as Record<string, unknown>[]

        return {
          idExterno: String(v.id),
          clienteExterno: String(cliente.id ?? ''),
          ocorridaEm,
          valorCentavos: paraCentavos(v.valor),
          vendedorExterno: (v.usernameVendedor as string) || undefined,
          filialExterna: String((v.loja as Record<string, unknown>)?.id ?? '') || undefined,
          // ⚠️ Cancelada entra com a data preenchida (para conciliar), o RFV a
          //    exclui por ela. `ocorridaEm` como aproximação da data de
          //    cancelamento: a listagem não traz a data exata do cancelamento.
          ...(cancelada ? { canceladaEm: ocorridaEm } : {}),
          // ⚠️ A listagem de vendas NÃO traz itens (confirmado na sonda) — eles
          //    ficam no detalhe `/vendas/{id}`, via `detalharVenda()`. O RFV usa
          //    o total da venda, então a carga funciona sem eles.
          itens: itens.map(itemDeVenda),
        }
      }),
      cursor: cursorPorOffset(linhas.length, offset),
    }
  }

  /**
   * Itens de uma venda — só o detalhe `/vendas/{id}` os traz.
   *
   * ⚠️ Endpoint INSTÁVEL na instância de apresentação: 500 em algumas vendas
   * (canceladas) e 400 em outras. Por isso é chamada SEPARADA, tolerante a
   * falha: a carga principal (RFV, que usa o total) não pode ser refém do
   * detalhe. Devolve `null` quando o ERP falha, para o chamador registrar a
   * pendência em vez de derrubar a carga inteira.
   */
  async detalharVenda(idExterno: string): Promise<readonly ItemVendaCanonico[] | null> {
    try {
      const v = await this.#pedir<Record<string, unknown>>(`/vendas/${idExterno}`)
      // ⚠️ No detalhe o campo é `itens` (o Java chama `itemVendas`, mas serializa
      //    como `itens` — confirmado na sonda). O SKU é `produtoPreco.codigoBarra.id`
      //    e o preço unitário é `precoDoMomento`, não `valorUnitario`.
      const itens = (v.itens ?? []) as Record<string, unknown>[]
      return itens.map(itemDeVenda)
    } catch {
      return null
    }
  }

  /**
   * Saldo por SKU vindo do `/estoques` (paginado, offset). ⚠️ Cada linha é o
   * estoque de UMA loja para uma CodigoBarra; quem chama agrega por SKU. Devolve
   * a página crua para a carga somar entre lojas.
   */
  async listarSaldosEstoque(cursor?: string): Promise<Pagina<{ skuExterno: string; quantidade: number }>> {
    const offset = Number(cursor ?? 0)
    const linhas = linhasDe(await this.#pedir(`/estoques?${paramsPagina(offset)}`))
    return {
      itens: linhas.map((linha) => {
        const e = linha as Record<string, unknown>
        const cb = (e.codigoBarra ?? {}) as Record<string, unknown>
        return {
          skuExterno: String(cb.id ?? e.id),
          quantidade: Number(e.quantidadeDecimal ?? e.quantidade ?? 0),
        }
      }),
      cursor: cursorPorOffset(linhas.length, offset),
    }
  }

  /**
   * Tabelas de preço do ERP. ⚠️ São muitas (79 na instância de referência); uma
   * é `padrao`. `GET /tabela-preco/todas` agrupa por loja — achatamos.
   */
  async listarTabelasPreco(): Promise<readonly TabelaPrecoCanonica[]> {
    const grupos = await this.#pedir<{ tabelasPreco?: Record<string, unknown>[] }[]>('/tabela-preco/todas')
    const vistos = new Set<string>()
    const out: TabelaPrecoCanonica[] = []
    for (const g of Array.isArray(grupos) ? grupos : []) {
      for (const t of g.tabelasPreco ?? []) {
        const id = String(t.id)
        if (vistos.has(id)) continue // mesma tabela repete entre lojas
        vistos.add(id)
        out.push({
          idExterno: id, descricao: String(t.descricao ?? ''), padrao: t.padrao === true,
          // ⚠️ Medido ao vivo (27/08): `tipo` 0 = CUSTO, 1 = venda. As tabelas
          //    "CUSTO", "Custo Padrão" e "FORMA DE FABRICACAO" vêm com 0.
          proposito: t.tipo === 0 ? 'custo' : 'venda',
          // ⚠️ E `status` 0 = ativa, 1 = inativa — o mesmo do cliente no pdv-core.
          //    Sem isto, tabelas antigas e desativadas competem pela escolha.
          ativa: t.status === 0 || t.status === undefined,
        })
      }
    }
    return out
  }

  /**
   * Preço de vários SKUs numa tabela — em LOTE.
   *
   * ⚠️ Endpoint confirmado no fonte e ao vivo:
   * `POST /produtos-precos/{tabela}/busca-preco-por-codigos-barra` com a lista de
   * ids de `codigoBarra` (o SKU). Devolve `{ codigoBarra.id, preco }`. Em lote
   * porque o painel de pedido precisa do preço de uma grade inteira de uma vez.
   */
  async listarPrecos(
    tabelaExterna: string,
    skusExternos: readonly string[],
  ): Promise<readonly PrecoCanonico[]> {
    if (skusExternos.length === 0) return []
    const ids = skusExternos.map((s) => Number(s)).filter((n) => Number.isFinite(n))
    const linhas = linhasDe(await this.#pedir(
      `/produtos-precos/${encodeURIComponent(tabelaExterna)}/busca-preco-por-codigos-barra`,
      { method: 'POST', body: JSON.stringify(ids) },
    ))
    return linhas.map((linha) => {
      const l = linha as Record<string, unknown>
      const cb = (l.codigoBarra ?? {}) as Record<string, unknown>
      return {
        skuExterno: String(cb.id ?? ''),
        tabela: tabelaExterna,
        valorCentavos: paraCentavos(l.preco),
      }
    })
  }

  /**
   * Faturamento que o ERP considera verdade — a fonte da conciliação (§8.3).
   *
   * ⚠️ `POST /dashboards/faturamento-geral` com `[idLojas]` ([] = todas). Devolve
   * `{ hoje, semanal, mensal, anual }`; `anual` é do ANO CORRENTE (jan→hoje).
   * ⚠️ É de propósito uma fonte DIFERENTE de `/vendas`: conciliar a importação
   * contra o mesmo endpoint que a alimentou só prova que sabemos copiar.
   */
  async consultarFaturamentoAnualCentavos(idLojas: readonly number[] = []): Promise<number> {
    const d = await this.#pedir<{ anual?: number }>('/dashboards/faturamento-geral', {
      method: 'POST',
      body: JSON.stringify(idLojas),
    })
    return paraCentavos(d.anual)
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
  /**
   * Cria o ORÇAMENTO no ERP a partir do pedido confirmado (ADR-005).
   *
   * ⚠️ Contrato extraído do JS do catálogo público — o ERP não tem especificação.
   * Detalhes em `orcamento.ts`; os que mais custam: valores em REAIS decimais,
   * `precoDoMomento` é o total da linha, e a resposta é um ARQUIVO (o número do
   * pedido não volta).
   *
   * ⚠️ A nossa porta passa IDs (`clienteExterno`, `skuExterno`); o ERP quer os
   * OBJETOS. Buscar isso é trabalho do adaptador — o domínio não deve conhecer a
   * forma do fornecedor (ADR-008).
   */
  async efetivarPedido(pedido: {
    clienteExterno: string
    itens: readonly { skuExterno: string; quantidade: number; valorUnitarioCentavos: number }[]
    chaveIdempotencia: string
  }): Promise<Resultado<{ numeroExterno: string }, FalhaEfetivacao>> {
    let clientePDV: Record<string, unknown>
    const estoques: Record<string, Record<string, unknown>> = {}
    try {
      clientePDV = await this.#pedir<Record<string, unknown>>(`/clientespdv/${pedido.clienteExterno}`)
      // ⚠️ Um a um de propósito: o lote desta rota devolve a TELA DE VENDA, com
      //    preço e saldo — e nós precisamos do registro de estoque cru, que é o
      //    que o catálogo manda dentro do item.
      for (const i of pedido.itens) {
        estoques[i.skuExterno] = await this.#pedir<Record<string, unknown>>(`/estoques/${i.skuExterno}`)
      }
    } catch {
      // ⚠️ Falhar aqui é ANTES de escrever: nada foi criado no ERP, então é
      //    `nao_chegou` e pode retentar sem risco de duplicar.
      return { ok: false, falha: { tipo: 'nao_chegou' } }
    }

    const corpo = montarOrcamento({
      clientePDV,
      itens: pedido.itens.map((i) => ({
        estoque: estoques[i.skuExterno]!,
        quantidade: i.quantidade,
        precoUnitarioCentavos: i.valorUnitarioCentavos,
      })),
      catalogo: {},
      tabelaPreco: null,
      chaveIdempotencia: pedido.chaveIdempotencia,
      agora: new Date(),
    })

    let status: number, texto: string
    try {
      const r = await this.#buscarCru('/catalogos-publico/orcamento', JSON.stringify(corpo))
      status = r.status
      texto = r.texto
    } catch {
      // ⚠️ Timeout ou queda DEPOIS de enviar: o orçamento PODE existir lá.
      //    Reenviar é o que o INV-53 existe para impedir.
      return { ok: false, falha: { tipo: 'resposta_perdida' } }
    }
    return traduzirRespostaOrcamento(status, texto)
  }

  /**
   * RECONCILIAÇÃO — "este pedido já existe lá?" (INV-53).
   *
   * ⚠️ É o que torna `resposta_perdida` recuperável. Sem isto, um timeout deixa
   * o pedido preso em conferência para sempre, e a única saída seria reenviar às
   * cegas — que é exatamente o que duplica pedido no ERP do cliente.
   *
   * ⚠️ Funciona por **consulta exata** porque gravamos a chave em `observacao`
   * (ver `orcamento.ts`). O ERP não tem idempotência própria; sem esse gancho
   * sobraria busca heurística por cliente + valor + janela de minutos, que não
   * sabe distinguir "achei o meu" de "achei um parecido" — e casos ambíguos
   * teriam de ir para conferência humana de qualquer forma.
   */
  async consultarPedidoPorChave(chaveIdempotencia: string): Promise<{ numeroExterno: string } | null> {
    try {
      // `POST /vendas/pedidos-catalogo` é BUSCA paginada (o corpo é o filtro).
      const r = await this.#pedir<unknown>('/vendas/pedidos-catalogo?inicio=0&limite=50&ordem=id', {
        method: 'POST',
        body: JSON.stringify({ observacao: `CRM ${chaveIdempotencia}` }),
      })
      const achado = linhasDe(r).find((linha) => {
        const v = linha as Record<string, unknown>
        return String(v['observacao'] ?? '').includes(chaveIdempotencia)
      }) as Record<string, unknown> | undefined
      // ⚠️ Filtramos pelo conteúdo mesmo mandando o filtro: se o ERP ignorar o
      //    campo, a busca voltaria tudo e o primeiro item seria um pedido de
      //    outra pessoa. Confiar no filtro do fornecedor sem conferir é como
      //    duplica-se pedido em silêncio.
      return achado ? { numeroExterno: String(achado['id'] ?? '') } : null
    } catch {
      // ⚠️ Não deu para perguntar: devolve `null`, e o pedido SEGUE em
      //    conferência. Fingir que não existe mandaria reenviar.
      return null
    }
  }

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
