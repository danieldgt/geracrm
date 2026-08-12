/**
 * As próximas etapas de um pedido DEPOIS de confirmado pelo cliente (ADR-005).
 *
 * A jornada: pedido.confirmado → orçamento no GeraCloud → cobrança PIX → venda
 * paga → romaneio → cupom fiscal de volta ao cliente. Cada etapa é uma operação
 * do ERP (GeraCloud), e o ERP ainda NÃO está ligado para elas.
 *
 * ⚠️ A porta é definida pelo NOSSO domínio, não pela API do fornecedor (ADR-008):
 * as etapas existem e aparecem na interface, mas DEGRADAM de forma VISÍVEL enquanto
 * o conector não existe — nunca fingem sucesso. `disponivel:false` + motivo é o
 * retorno tipificado (falha de negócio é resultado, não exceção). Quando o conector
 * for ligado, é só virar `disponivel:true` e implementar a ação — o ponto de
 * costura já está aqui e na interface.
 */
export type EtapaPos = 'orcamento' | 'cobranca_pix' | 'romaneio' | 'cupom_fiscal'

export interface EtapaDef {
  readonly etapa: EtapaPos
  readonly rotulo: string
  readonly descricao: string
  /** Se a ação está ligada. Hoje tudo false — GeraCloud não conectado. */
  readonly disponivel: boolean
  /** Por que não dá para acionar ainda (mostrado na interface). */
  readonly motivoIndisponivel?: string
}

const PENDENTE_GERACLOUD = 'Integração com o GeraCloud ainda não está ligada — entra quando o conector for conectado.'

/**
 * As etapas que se penduram no evento `pedido.confirmado`, na ordem da jornada.
 * ⚠️ Tudo `disponivel:false` hoje; a interface mostra os botões e a degradação.
 */
export const ETAPAS_POS_CONFIRMACAO: readonly EtapaDef[] = [
  {
    etapa: 'orcamento',
    rotulo: 'Gerar orçamento no GeraCloud',
    descricao: 'Cria o orçamento no GeraCloud a partir deste pedido.',
    disponivel: false,
    motivoIndisponivel: PENDENTE_GERACLOUD,
  },
  {
    etapa: 'cobranca_pix',
    rotulo: 'Gerar cobrança PIX',
    descricao: 'Emite a cobrança PIX no GeraCloud para o cliente pagar.',
    disponivel: false,
    motivoIndisponivel: PENDENTE_GERACLOUD,
  },
  {
    etapa: 'romaneio',
    rotulo: 'Acompanhar romaneio / venda',
    descricao: 'Acompanha a venda no GeraCloud até o romaneio.',
    disponivel: false,
    motivoIndisponivel: PENDENTE_GERACLOUD,
  },
  {
    etapa: 'cupom_fiscal',
    rotulo: 'Enviar cupom fiscal ao cliente',
    descricao: 'Devolve o cupom fiscal ao cliente pela conversa.',
    disponivel: false,
    motivoIndisponivel: PENDENTE_GERACLOUD,
  },
]

export function etapaPos(etapa: string): EtapaDef | undefined {
  return ETAPAS_POS_CONFIRMACAO.find((e) => e.etapa === etapa)
}
