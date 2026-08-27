import type { FalhaEfetivacao, Resultado } from '../porta.js'

/**
 * MONTAGEM DO ORÇAMENTO DO GERACLOUD — `POST /catalogos-publico/orcamento`.
 *
 * ⚠️ O contrato foi extraído do JavaScript do catálogo público (27/ago), não de
 * documentação: o ERP não expõe especificação. Os detalhes que mais custam estão
 * aqui, e cada um deles quebraria em silêncio se fosse chutado.
 *
 * ⚠️ **É ORÇAMENTO, não venda.** `status` é fixo em 'Orcamento' nesta via — foi
 * assim que o catálogo do próprio fornecedor foi construído. O pedido confirmado
 * na conversa vira orçamento no ERP e alguém converte em venda lá dentro. Isso
 * precisa estar VISÍVEL na tela: um operador que leia "efetivado" e ache que a
 * venda fechou é o defeito que este comentário existe para evitar.
 *
 * ⚠️ **NÃO confundir com `POST /vendas/pedidos-catalogo`**, que a nossa própria
 * documentação listava como caminho de escrita: aquilo é uma BUSCA paginada
 * (`buscarPedidosCatalogo`, com `inicio`/`limite`/`ordem`), e o corpo é o filtro.
 */

/** Valor monetário como o ERP quer: REAIS decimais, duas casas. */
export function paraReais(centavos: number): number {
  // ⚠️ O ERP trabalha em reais decimais (`Number(x.toFixed(2))` no catálogo).
  //    Nós guardamos centavos inteiros. Errar aqui é cobrar R$ 8.990,00 no lugar
  //    de R$ 89,90 — e o número chega bonito no orçamento do cliente.
  return Number((centavos / 100).toFixed(2))
}

/** `DD/MM/YYYY HH:mm:ss` — ⚠️ o ERP não aceita ISO nesta rota. */
export function dataBr(d: Date): string {
  const z = (n: number) => String(n).padStart(2, '0')
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} `
    + `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`
}

export interface ItemOrcamento {
  /** O objeto de estoque do ERP (traz `codigoBarra`), como o catálogo envia. */
  readonly estoque: Record<string, unknown>
  readonly quantidade: number
  readonly precoUnitarioCentavos: number
}

export interface DadosOrcamento {
  readonly clientePDV: Record<string, unknown>
  readonly itens: readonly ItemOrcamento[]
  readonly catalogo: Record<string, unknown>
  readonly tabelaPreco: Record<string, unknown> | null
  /** ⚠️ Vai em `observacao` — é o nosso gancho de idempotência. Ver abaixo. */
  readonly chaveIdempotencia: string
  readonly agora: Date
}

/**
 * Monta o corpo exatamente como o catálogo monta.
 *
 * ⚠️ `precoDoMomento` é o **TOTAL DA LINHA** (preço × quantidade), apesar de o
 * nome dizer o contrário. Está assim no `carregarDadosPedido` do catálogo, e
 * mandar o unitário faria o orçamento sair com o valor errado sem erro nenhum.
 */
export function montarOrcamento(d: DadosOrcamento): Record<string, unknown> {
  const itens = d.itens.map((i) => ({
    estoque: i.estoque,
    quantidade: i.quantidade,
    precoDoMomento: paraReais(i.precoUnitarioCentavos * i.quantidade),
    valorFinalDesconto: 0,
    valorFinalAcrescimo: 0,
    valorFinalDescontoPromocao: 0,
    frete: 0,
  }))

  const total = d.itens.reduce((s, i) => s + i.precoUnitarioCentavos * i.quantidade, 0)

  return {
    clientePDV: d.clientePDV,
    itens,
    // ⚠️ Fixo: esta via só cria orçamento (ver o topo do arquivo).
    status: 'Orcamento',
    valor: paraReais(total),
    // O catálogo manda 'catalogo' quando não há vendedor identificado.
    usernameVendedor: 'catalogo',
    isCatalogo: true,
    frete: 0,
    formasPagamento: [],
    catalogo: d.catalogo,
    tabelaPreco: d.tabelaPreco,
    dataAbertura: dataBr(d.agora),
    // ⚠️ **O GANCHO DE IDEMPOTÊNCIA.** O ERP não tem chave própria (§6.2), e
    //    `observacao` é o único campo de texto livre que atravessa. Com a chave
    //    aqui, reconciliar depois de um timeout é uma CONSULTA EXATA; sem ela,
    //    sobraria busca por cliente + valor + janela de minutos, que é ambígua
    //    por natureza e joga casos duvidosos para conferência humana (INV-53).
    observacao: `CRM ${d.chaveIdempotencia}`,
  }
}

/**
 * Traduz a resposta HTTP em resultado tipificado.
 *
 * ⚠️ **A resposta é um arquivo (`blob`), não JSON** — o catálogo pede
 * `responseType: 'blob'` e recebe o orçamento pronto. Ou seja, **o número do
 * pedido NÃO volta**. Devolvemos vazio e o número entra na sincronização
 * seguinte; inventar um id daria um `numeroExterno` que não existe no ERP.
 */
export function traduzirRespostaOrcamento(
  status: number, texto: string,
): Resultado<{ numeroExterno: string }, FalhaEfetivacao> {
  if (status >= 200 && status < 300) return { ok: true, valor: { numeroExterno: '' } }

  const t = texto.toLowerCase()
  // ⚠️ Falha de NEGÓCIO é resultado nomeado, com ação corretiva na tela (PED-08).
  //    Estoque insuficiente não é erro de sistema: é uma resposta esperada.
  if (/estoque|indispon/.test(t)) {
    return { ok: false, falha: { tipo: 'estoque_insuficiente', skuExterno: '', disponivel: 0 } }
  }
  if (/cpf|cnpj|cliente/.test(t)) return { ok: false, falha: { tipo: 'cliente_sem_cadastro_fiscal' } }
  // ⚠️ 408/504 e 5xx: a requisição PODE ter chegado. Nunca reenviar às cegas.
  if (status === 408 || status === 504 || status >= 500) {
    return { ok: false, falha: { tipo: 'resposta_perdida' } }
  }
  return { ok: false, falha: { tipo: 'nao_chegou' } }
}
