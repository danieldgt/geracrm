import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../db/index.js'
import { enviarTextoNaConversa, type ClasseFalha, type ResultadoEnvioTexto } from '../atendimento/envio-conversa.js'
import { marcarResumoEnviado } from './confirmacao-pedido.js'
import { regrasPedidoDoTenant } from './montagem.js'
import { mensagemViolacao, validarRegrasPedido, type ViolacaoRegras } from './regras-pedido.js'
import { codigoReferencia, resumoPedidoTexto } from './resumo-pedido.js'

/**
 * PROPOR O PEDIDO AO CLIENTE (ADR-027) — o que o agente e o vendedor fazem
 * quando o carrinho está pronto.
 *
 * Reusa o fluxo que já existia e é bom: resumo → `aguardando_confirmacao` →
 * "sim" conservador → `confirmado`. O que nasce aqui é a `pedido_proposta`:
 * uma linha por resumo enviado, com a VERSÃO DO CONTEÚDO naquele instante.
 * O "sim" (confirmacao-pedido.ts) só confirma se a versão ainda for a atual.
 *
 * ⚠️ Duas transações, de propósito: a leitura/validação, o ENVIO (rede, fora de
 *    transação — regra da casa), e só então a mudança de estado + a proposta
 *    no MESMO commit. Se o envio é recusado (janela fechada, opt-out, canal
 *    sem credencial), o pedido não muda: continua rascunho, nada a desfazer.
 *
 * ⚠️ Marcador 'proposta' na mensagem: é como o sistema reconhece o que ELE
 *    mandou, sem comparar texto.
 */
export const HORAS_VALIDADE_PROPOSTA = 24
export const MARCADOR_PROPOSTA = 'proposta'

/** Estados de onde se pode propor: rascunho, ou reenviar enquanto espera o "sim". */
const PROPONIVEIS: readonly string[] = ['rascunho', 'aguardando_confirmacao']

export type FuncaoEnvio = (
  tenantId: string, conversaId: string, texto: string, remetenteNome: string | null,
  agora: Date, opcoes: { readonly marcador?: string },
) => Promise<ResultadoEnvioTexto>

export interface DepsProposta {
  /** Envio pelo gateway. Injetável para teste; o padrão é `enviarTextoNaConversa`. */
  readonly enviar?: FuncaoEnvio
  /** Cabeçalho de quem envia (vendedor). O agente não assina: `null`. */
  readonly remetenteNome?: string | null
}

export type ResultadoProposta =
  | {
      readonly tipo: 'ok'
      readonly propostaId: string
      readonly resumo: string
      readonly totalCentavos: number
      readonly expiraEm: Date
      readonly conversaId: string
      readonly mensagemId: string
    }
  | { readonly tipo: 'nao_encontrado' }
  | { readonly tipo: 'sem_conversa' }
  | { readonly tipo: 'vazio' }
  | { readonly tipo: 'nao_rascunho'; readonly estado: string }
  | { readonly tipo: 'regras'; readonly violacao: ViolacaoRegras; readonly mensagem: string }
  | { readonly tipo: 'envio_recusado'; readonly motivo: string; readonly classe: ClasseFalha; readonly conversaId: string }

interface Preparo {
  readonly conversaId: string
  readonly texto: string
  readonly totalCentavos: number
}

export async function proporPedido(
  tenantId: string, pedidoId: string, agora: Date, deps: DepsProposta = {},
): Promise<ResultadoProposta> {
  // Fase 1: ler, validar as regras comerciais e montar o texto.
  const preparo = await comTenantServico(tenantId, (tx) => preparar(tx, pedidoId))
  if (preparo.tipo !== 'preparado') return preparo

  // Fase 2: enviar pelo gateway único — FORA de transação.
  const enviar = deps.enviar ?? enviarTextoNaConversa
  const envio = await enviar(
    tenantId, preparo.conversaId, preparo.texto, deps.remetenteNome ?? null, agora, { marcador: MARCADOR_PROPOSTA },
  )
  if (!envio.ok) {
    return { tipo: 'envio_recusado', motivo: envio.motivo, classe: envio.classe, conversaId: preparo.conversaId }
  }

  // Fase 3: estado + proposta no MESMO commit.
  const expiraEm = new Date(agora.getTime() + HORAS_VALIDADE_PROPOSTA * 3_600_000)
  return comTenantServico(tenantId, async (tx) => {
    // ⚠️ Relê a versão AQUI, não da fase 1: entre ler e enviar o conteúdo pode
    //    ter mudado, e a proposta precisa carimbar a versão que o cliente viu
    //    (que é a de agora, pois o texto foi montado a partir dela há instantes).
    const [p] = await tx<{ estado: string; versao_conteudo: number }[]>`
      SELECT estado, versao_conteudo FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
    if (!p) return { tipo: 'nao_encontrado' as const }
    if (!PROPONIVEIS.includes(p.estado)) return { tipo: 'nao_rascunho' as const, estado: p.estado }

    await marcarResumoEnviado(tx, pedidoId, preparo.conversaId)
    // A proposta anterior deixa de valer: só a mais nova pode ser confirmada.
    await tx`UPDATE pedido_proposta SET vigente = false
              WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} AND vigente`
    const propostaId = randomUUID()
    await tx`
      INSERT INTO pedido_proposta (tenant_id, id, pedido_id, versao_conteudo, resumo, total_centavos,
                                   enviada_em, expira_em, mensagem_id, vigente)
      VALUES (tenant_atual(), ${propostaId}, ${pedidoId}, ${p.versao_conteudo}, ${preparo.texto},
              ${preparo.totalCentavos}, ${agora}, ${expiraEm}, ${envio.mensagemId}, true)`
    return {
      tipo: 'ok' as const, propostaId, resumo: preparo.texto, totalCentavos: preparo.totalCentavos,
      expiraEm, conversaId: preparo.conversaId, mensagemId: envio.mensagemId,
    }
  })
}

async function preparar(
  tx: Sql, pedidoId: string,
): Promise<({ tipo: 'preparado' } & Preparo) | Exclude<ResultadoProposta, { tipo: 'ok' | 'envio_recusado' }>> {
  const [p] = await tx<{
    estado: string; conversa_id: string | null; total_centavos: string; total_pecas: string
    forma_pagamento: string | null; observacao: string | null; contato: string | null
  }[]>`
    SELECT p.estado, p.conversa_id, p.total_centavos::text, p.total_pecas::text,
           p.forma_pagamento, p.observacao, c.nome AS contato
      FROM pedido p LEFT JOIN contato c ON c.tenant_id = p.tenant_id AND c.id = p.contato_id
     WHERE p.tenant_id = tenant_atual() AND p.id = ${pedidoId}`
  if (!p) return { tipo: 'nao_encontrado' }
  if (!p.conversa_id) return { tipo: 'sem_conversa' }
  if (!PROPONIVEIS.includes(p.estado)) return { tipo: 'nao_rascunho', estado: p.estado }

  const itens = await tx<{
    sku_snapshot: string; descricao_snapshot: string; grade_snapshot: Record<string, string> | null
    quantidade: string; valor_unitario_centavos: string
  }[]>`
    SELECT sku_snapshot, descricao_snapshot, grade_snapshot, quantidade::text, valor_unitario_centavos::text
      FROM pedido_item WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} ORDER BY seq`
  if (itens.length === 0) return { tipo: 'vazio' }

  const totalCentavos = Number(p.total_centavos)
  const regras = await regrasPedidoDoTenant(tx)
  const validacao = validarRegrasPedido(regras, {
    totalCentavos, totalPecas: Number(p.total_pecas),
    itens: itens.map((i) => ({ sku: i.descricao_snapshot, quantidade: Number(i.quantidade) })),
  })
  if (validacao.tipo !== 'ok') return { tipo: 'regras', violacao: validacao, mensagem: mensagemViolacao(validacao) }

  const texto = resumoPedidoTexto(
    itens.map((i) => ({
      descricao: i.descricao_snapshot, variacao: variacaoDaGrade(i.grade_snapshot),
      quantidade: Number(i.quantidade), valorUnitarioCentavos: Number(i.valor_unitario_centavos),
    })),
    totalCentavos,
    {
      contatoNome: p.contato, formaPagamento: p.forma_pagamento, observacao: p.observacao,
      pedidoCodigo: codigoReferencia(pedidoId), chatCodigo: codigoReferencia(p.conversa_id),
    },
  )
  return { tipo: 'preparado', conversaId: p.conversa_id, texto, totalCentavos }
}

/** Variação escolhida a partir do grade_snapshot: cor · tamanho · resto. */
export function variacaoDaGrade(grade: Record<string, string> | null | undefined): string | null {
  if (!grade) return null
  const ordem = ['cor', 'tamanho', 'subTamanho', 'sub_tamanho']
  const vistos = new Set<string>()
  const partes: string[] = []
  for (const k of ordem) {
    const v = grade[k]
    if (v) { partes.push(String(v)); vistos.add(k) }
  }
  for (const [k, v] of Object.entries(grade)) {
    if (!vistos.has(k) && v) partes.push(String(v))
  }
  return partes.length ? partes.join(' · ') : null
}
