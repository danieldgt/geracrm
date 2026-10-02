import { decidirAlcada, type AlcadaAgente, type DecisaoAlcada } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../db/index.js'
import { conectorDoTenant, type ConexaoDoTenant } from '../integracao/conector-do-tenant.js'
import { efetivarPedido, type ResultadoEfetivacao } from './efetivacao.js'

/**
 * ALÇADA DO AGENTE (ADR-027): com o cliente confirmado, o pedido vai sozinho
 * para o ERP ou espera um vendedor?
 *
 * A decisão é a regra pura `decidirAlcada()` de `packages/shared` — a mesma que
 * o console mostra. Dentro da alçada, a efetivação é a MESMA `efetivarPedido`
 * da rota (idempotente, falha nomeada, rascunho preservado): este módulo nunca
 * contorna o caso de uso. `pedido_efetivar` não é ferramenta do modelo; é o
 * domínio quem chama isto, depois do "sim".
 *
 * ⚠️ Fora da alçada, este módulo só DEVOLVE a decisão. Abrir o atendimento na
 *    fila com o resumo e o motivo é trabalho do agente (raia R1) — misturar
 *    isso aqui faria o contexto `pedido` conhecer a fila.
 */
export type DecisaoNaoAplicavel =
  | { readonly acao: 'nao_aplicavel'; readonly motivo: 'nao_encontrado' }
  /** Só pedido CONFIRMADO pelo cliente passa pela alçada. */
  | { readonly acao: 'nao_aplicavel'; readonly motivo: 'nao_confirmado'; readonly estado: string }

export interface ResultadoAlcada {
  readonly decisao: DecisaoAlcada | DecisaoNaoAplicavel
  /** Presente só quando a decisão foi `efetivar`. */
  readonly efetivacao?: ResultadoEfetivacao
}

export interface DepsAlcada {
  /** Conector do tenant. Injetável para teste; o padrão é `conectorDoTenant`. */
  readonly conector?: (tx: Sql) => Promise<ConexaoDoTenant>
}

export async function efetivarSeDentroDaAlcada(
  tenantId: string, pedidoId: string, alcada: AlcadaAgente, agora: Date, deps: DepsAlcada = {},
): Promise<ResultadoAlcada> {
  return comTenantServico(tenantId, async (tx) => {
    const [p] = await tx<{ estado: string; total_centavos: string; desconto_pct: string }[]>`
      SELECT estado, total_centavos::text, desconto_pct::text
        FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
    if (!p) return { decisao: { acao: 'nao_aplicavel', motivo: 'nao_encontrado' } }
    if (p.estado !== 'confirmado') {
      return { decisao: { acao: 'nao_aplicavel', motivo: 'nao_confirmado', estado: p.estado } }
    }
    const decisao = decidirAlcada(
      { totalCentavos: Number(p.total_centavos), descontoPct: Number(p.desconto_pct) }, alcada,
    )
    if (decisao.acao !== 'efetivar') return { decisao }

    // ⚠️ Mesmo caminho da rota POST /v1/pedidos/:id/efetivar: conector real do
    //    tenant (ou null → degradação visível, ADR-008) e o caso de uso único.
    const cx = await (deps.conector ?? conectorDoTenant)(tx)
    const efetivacao = await efetivarPedido(tx, cx.conector, cx.sistema, pedidoId, agora)
    return { decisao, efetivacao }
  })
}
