import type { Sql } from '../../db/index.js'

/**
 * Confirmação do pedido pelo cliente no chat. Quando o resumo foi enviado (pedido
 * em 'aguardando_confirmacao') e o cliente responde SIM, o pedido vira
 * 'confirmado' — vinculado ao cliente, pronto para os próximos passos
 * (orçamento/cobrança/GeraCloud/nota, no futuro).
 *
 * ⚠️ CONSERVADOR de propósito: só confirma em resposta CURTA e claramente
 * afirmativa. "sim, mas troca a cor" NÃO confirma (é pedido de mudança) — some a
 * dúvida do lado seguro; o vendedor confirma à mão nesses casos.
 */
const AFIRMATIVOS = new Set([
  'sim', 'ok', 'okay', 'confirmo', 'confirmado', 'confirmar', 'confirma',
  'isso', 'isso mesmo', 'pode', 'pode confirmar', 'pode sim', 'fechado', 'fechou',
  'beleza', 'blz', 'perfeito', 'positivo', 'aceito', 'aprovado', 'sim senhor',
])

/** Normaliza para comparação: sem acento, minúsculo, só letras/espaço. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ehAfirmativo(texto: string): boolean {
  const bruto = (texto ?? '').trim()
  if (!bruto) return false
  // Só 👍 (com ou sem espaços) já conta.
  if (/^[\s👍👌✅🆗]+$/u.test(bruto)) return true
  const n = normalizar(bruto)
  if (!n) return false
  if (AFIRMATIVOS.has(n)) return true
  // Resposta curta que COMEÇA com afirmativo (ex.: "sim!", "ok pode mandar").
  // ⚠️ Curta: acima disso pode ser "sim, mas..." — não arrisca.
  if (n.length <= 18 && /^(sim|ok|okay|confirmo|confirma|pode|isso|fechad|beleza|blz|perfeito|positivo|aceito|aprovad)\b/.test(n)) return true
  return false
}

/**
 * Confirma o pedido pendente da conversa se o texto for afirmativo. Idempotente
 * (só age sobre 'aguardando_confirmacao'). Emite o evento no MESMO commit.
 * Devolve o id do pedido confirmado, ou null.
 */
export async function confirmarPedidoPorResposta(
  tx: Sql, conversaId: string, texto: string, quando: Date,
): Promise<string | null> {
  if (!ehAfirmativo(texto)) return null
  // O pedido pendente mais recente desta conversa.
  const [ped] = await tx<{ id: string; contato_id: string | null }[]>`
    SELECT id, contato_id FROM pedido
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'aguardando_confirmacao'
     ORDER BY atualizado_em DESC LIMIT 1`
  if (!ped) return null
  const [conf] = await tx<{ id: string }[]>`
    UPDATE pedido SET estado = 'confirmado', confirmado_em = ${quando}, atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${ped.id} AND estado = 'aguardando_confirmacao'
     RETURNING id`
  if (!conf) return null
  // Evento no mesmo commit (INV-40) — a tela e as próximas etapas reagem a isto.
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'pedido.confirmado', 'pedido', ${conf.id},
            ${JSON.stringify({ pedidoId: conf.id, conversaId, contatoId: ped.contato_id })}::text::jsonb)`
  return conf.id
}
