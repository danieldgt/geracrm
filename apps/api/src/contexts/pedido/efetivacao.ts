import type { ConectorErp, FalhaEfetivacao } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'

/**
 * Efetivação do pedido no ERP (ADR-005). ⚠️ As três coisas onde produtos deste
 * tipo morrem, todas cobertas aqui:
 *   1. **Idempotência**: a chave é `id:versao_conteudo` (INV-29) — reenviar a
 *      MESMA versão nunca duplica no ERP.
 *   2. **Falha nunca perde o rascunho**: falha de negócio vira estado 'falhou'
 *      com o motivo NOMEADO (PED-08); os itens continuam lá para reprocessar.
 *   3. **Resposta perdida (504)** vai para 'aguardando_conferencia' (INV-53) —
 *      NUNCA reenvia às cegas; concilia consultando o ERP pela chave.
 *
 * ⚠️ Degradação visível (ADR-008): conector sem `escritaPedido` NÃO efetiva — o
 * rascunho fica intacto e a tela oferece exportar/registrar manual.
 */
export type ResultadoEfetivacao =
  | { tipo: 'efetivado'; numeroExterno: string }
  | { tipo: 'degradado' }                 // ERP não escreve; exporte manual
  | { tipo: 'falha'; falha: FalhaEfetivacao }
  | { tipo: 'aguardando_conferencia' }
  | { tipo: 'vazio' }
  | { tipo: 'nao_rascunho' }
  | { tipo: 'nao_encontrado' }

export async function efetivarPedido(
  sql: Sql,
  conector: ConectorErp | null,
  sistema: string,
  pedidoId: string,
  agora: Date,
): Promise<ResultadoEfetivacao> {
  const [pedido] = await sql<{ estado: string; contato_id: string | null; versao: number }[]>`
    SELECT estado, contato_id, versao_conteudo AS versao
      FROM pedido WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
  if (!pedido) return { tipo: 'nao_encontrado' }
  // Rascunho (montando) ou 'falhou' (retentar) podem efetivar. Efetivado é imutável.
  if (pedido.estado !== 'rascunho' && pedido.estado !== 'falhou') return { tipo: 'nao_rascunho' }

  const itens = await sql<{ sku_snapshot: string; quantidade: string; valor_unitario_centavos: string }[]>`
    SELECT sku_snapshot, quantidade::text, valor_unitario_centavos::text
      FROM pedido_item WHERE tenant_id = tenant_atual() AND pedido_id = ${pedidoId} ORDER BY seq`
  if (itens.length === 0) return { tipo: 'vazio' }

  // ⚠️ Degradação: sem escrita no ERP, o rascunho fica como está (exportável).
  if (!conector?.efetivarPedido) return { tipo: 'degradado' }

  // Cliente externo (cadastro fiscal no ERP). Sem ele, falha NOMEADA.
  let clienteExterno: string | null = null
  if (pedido.contato_id) {
    const [ext] = await sql<{ id_externo: string }[]>`
      SELECT id_externo FROM contato_identidade_externa
       WHERE tenant_id = tenant_atual() AND contato_id = ${pedido.contato_id} AND sistema = ${sistema}
       LIMIT 1`
    clienteExterno = ext?.id_externo ?? null
  }
  if (!clienteExterno) {
    return persistirFalha(sql, pedidoId, { tipo: 'cliente_sem_cadastro_fiscal' })
  }

  // Chave idempotente estável por VERSÃO do conteúdo (INV-29).
  const chave = `${pedidoId}:${pedido.versao}`
  await sql`UPDATE pedido SET estado = 'enviando', atualizado_em = ${agora}
             WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`

  const r = await conector.efetivarPedido({
    clienteExterno,
    itens: itens.map((i) => ({
      skuExterno: i.sku_snapshot, quantidade: Number(i.quantidade),
      valorUnitarioCentavos: Number(i.valor_unitario_centavos),
    })),
    chaveIdempotencia: chave,
  })

  if (r.ok) {
    await sql`UPDATE pedido SET estado = 'efetivado', numero_externo = ${r.valor.numeroExterno},
                   efetivado_em = ${agora}, ultimo_erro = NULL, atualizado_em = ${agora}
               WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
    return { tipo: 'efetivado', numeroExterno: r.valor.numeroExterno }
  }

  // ⚠️ Resposta perdida: pode existir no ERP → conferência, nunca reenvio cego.
  if (r.falha.tipo === 'resposta_perdida') {
    await sql`UPDATE pedido SET estado = 'aguardando_conferencia',
                   ultimo_erro = ${JSON.stringify(r.falha)}::text::jsonb, atualizado_em = ${agora}
               WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
    return { tipo: 'aguardando_conferencia' }
  }

  return persistirFalha(sql, pedidoId, r.falha)
}

/** Falha de negócio: estado 'falhou' + motivo nomeado; itens PRESERVADOS. */
async function persistirFalha(sql: Sql, pedidoId: string, falha: FalhaEfetivacao): Promise<ResultadoEfetivacao> {
  await sql`UPDATE pedido SET estado = 'falhou', ultimo_erro = ${JSON.stringify(falha)}::text::jsonb, atualizado_em = now()
             WHERE tenant_id = tenant_atual() AND id = ${pedidoId}`
  return { tipo: 'falha', falha }
}
