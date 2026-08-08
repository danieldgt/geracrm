/**
 * The ERP port.
 *
 * ⚠️ Defined by OUR domain, never by a vendor's API (ADR-008). If a method here
 * is named after a GeraCloud endpoint, this stopped being a port and became a
 * copied SDK — and the second connector will prove it the hard way.
 *
 * There is a test that scans these method names and fails if a vendor name
 * appears.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a connector can do. The product DEGRADES according to this instead of
 * breaking — and the degradation is visible in the UI, never silent.
 *
 * ⚠️ If the product required the best case, it would only sell to customers who
 * happen to have the best ERP.
 */
export interface Capacidades {
  readonly ingestaoClientes: boolean
  readonly ingestaoProdutos: boolean
  readonly ingestaoPedidos: boolean
  readonly cargaHistorica: boolean
  /** Live stock during order assembly. Without it, the screen shows last-sync
   *  balance with a timestamp and moves validation to submission time. */
  readonly saldoSincrono: boolean
  readonly tabelaPrecoSincrona: boolean
  /** Without it the credit block does not appear — it does not appear disabled. */
  readonly creditoCliente: boolean
  /** Without it the order pad becomes an exportable draft. */
  readonly escritaPedido: boolean
  /** Without it, sync is scheduled and revenue attribution carries that lag —
   *  ⚠️ which must be declared on screen, not implied. */
  readonly webhookDeVenda: boolean
}

// ---------------------------------------------------------------------------
// Canonical model — ours, not the ERP's
// ---------------------------------------------------------------------------

export interface ClienteCanonico {
  readonly idExterno: string
  readonly nome: string
  readonly documento?: string
  readonly telefones: readonly string[]
  readonly email?: string
  /** Salesperson as the ERP knows them — plain text. Resolved against
   *  `usuario_identidade_externa` (migration 0007); unmatched values become
   *  `correspondencia_pendente` instead of being dropped. */
  readonly vendedorExterno?: string
  readonly filialExterna?: string
  readonly ativo: boolean
}

export interface SkuCanonico {
  readonly idExterno: string
  readonly referencia: string
  readonly descricao: string
  /**
   * Variant attributes. ⚠️ Deliberately open (ADR-004): the reference ERP has
   * colour, size AND sub-size. Fixed columns would already be broken.
   */
  readonly atributos: Readonly<Record<string, string>>
  readonly codigoBarras?: string
  readonly ativo: boolean
}

export interface SaldoCanonico {
  readonly skuExterno: string
  readonly quantidade: number
  readonly filialExterna?: string
  /** ⚠️ When the connector lacks `saldoSincrono`, this is when the number was
   *  last true — and the screen shows it. A balance without a timestamp reads
   *  as live when it is not. */
  readonly apuradoEm: Date
}

export interface PrecoCanonico {
  readonly skuExterno: string
  readonly tabela: string
  /** Integer cents, always. ⚠️ Never float. */
  readonly valorCentavos: number
}

export interface VendaCanonica {
  readonly idExterno: string
  readonly clienteExterno: string
  readonly ocorridaEm: Date
  readonly valorCentavos: number
  readonly vendedorExterno?: string
  readonly filialExterna?: string
  readonly itens: readonly {
    readonly skuExterno: string
    readonly quantidade: number
    readonly valorUnitarioCentavos: number
  }[]
}

// ---------------------------------------------------------------------------
// Results — business failure is a return value, not an exception
// ---------------------------------------------------------------------------

/** The five failures the order screen must tell apart (PED-08). */
export type FalhaEfetivacao =
  | { tipo: 'estoque_insuficiente'; skuExterno: string; disponivel: number }
  | { tipo: 'credito_bloqueado'; disponivelCentavos: number }
  | { tipo: 'item_inativo'; skuExterno: string }
  | { tipo: 'cliente_sem_cadastro_fiscal' }
  | { tipo: 'nao_chegou' }
  /**
   * ⚠️ The response was lost — the order MAY exist in the ERP.
   * Retrying here is what INV-53 exists to prevent. It goes to
   * `aguardando_conferencia` and is reconciled by querying the ERP.
   */
  | { tipo: 'resposta_perdida' }

export type Resultado<T, E> = { ok: true; valor: T } | { ok: false; falha: E }

export interface Pagina<T> {
  readonly itens: readonly T[]
  readonly cursor?: string
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface ConectorErp {
  readonly nome: string
  readonly capacidades: Capacidades

  listarClientes(cursor?: string): Promise<Pagina<ClienteCanonico>>
  listarSkus(cursor?: string): Promise<Pagina<SkuCanonico>>
  listarVendas(desde: Date, cursor?: string): Promise<Pagina<VendaCanonica>>

  /** Only when `saldoSincrono`. ⚠️ Short timeout — the screen blocks submission
   *  rather than letting the salesperson assemble blind. */
  consultarSaldo?(skusExternos: readonly string[], filialExterna?: string): Promise<readonly SaldoCanonico[]>
  consultarPrecos?(clienteExterno: string, skusExternos: readonly string[]): Promise<readonly PrecoCanonico[]>
  consultarCredito?(clienteExterno: string): Promise<{ disponivelCentavos: number }>

  /**
   * Only when `escritaPedido`.
   * @param chaveIdempotencia sent so a retry never creates a second order.
   */
  efetivarPedido?(
    pedido: {
      clienteExterno: string
      itens: readonly { skuExterno: string; quantidade: number; valorUnitarioCentavos: number }[]
      chaveIdempotencia: string
    },
  ): Promise<Resultado<{ numeroExterno: string }, FalhaEfetivacao>>

  /** Only when `escritaPedido`. Resolves `resposta_perdida` — asks the ERP
   *  whether the order exists, instead of retrying blind. */
  consultarPedidoPorChave?(chaveIdempotencia: string): Promise<{ numeroExterno: string } | null>
}
