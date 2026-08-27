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
 * ⚠️ Por quanto tempo o "sim" ainda vale, contado do envio do RESUMO.
 *
 * Decisão de produto de 2026-08-27, depois do incidente: 24h. Cliente que vê o
 * resumo à noite e responde de manhã continua funcionando — isso é comércio
 * normal — e casa com a janela de 24h do WhatsApp: passou dela, a conversa já
 * mudou de contexto de qualquer forma.
 */
const HORAS_PARA_CONFIRMAR = 24

/**
 * Desfecho NOMEADO, e não `string | null`.
 *
 * ⚠️ Quem chama precisa distinguir "o cliente não disse sim" de "disse sim e não
 * havia o que confirmar" — a segunda avisa o atendente, e com um `null` para os
 * dois casos ela era invisível.
 */
export type ResultadoConfirmacao =
  | { readonly tipo: 'confirmado'; readonly pedidoId: string }
  | { readonly tipo: 'nao_afirmativo' }
  | { readonly tipo: 'sem_pendente' }
  | { readonly tipo: 'fora_da_janela'; readonly pedidoId: string }

/**
 * Confirma o pedido pendente da conversa se o texto for afirmativo. Idempotente
 * (só age sobre 'aguardando_confirmacao'). Emite o evento no MESMO commit.
 */
export async function confirmarPedidoPorResposta(
  tx: Sql, conversaId: string, texto: string, quando: Date,
): Promise<ResultadoConfirmacao> {
  if (!ehAfirmativo(texto)) return { tipo: 'nao_afirmativo' }
  // O pedido pendente mais recente desta conversa.
  const [ped] = await tx<{ id: string; contato_id: string | null; fresco: boolean }[]>`
    SELECT id, contato_id,
           -- ⚠️ Resumo sem carimbo (pedido anterior ao 0073) NÃO é fresco: sem
           --    saber quando o cliente viu aquilo, confirmar é chute. Foi
           --    exatamente assim que um resumo de três dias antes virou pedido.
           (resumo_enviado_em IS NOT NULL
            AND resumo_enviado_em > ${quando}::timestamptz
                - make_interval(hours => ${HORAS_PARA_CONFIRMAR})) AS fresco
      FROM pedido
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'aguardando_confirmacao'
     ORDER BY atualizado_em DESC LIMIT 1`
  if (!ped) return { tipo: 'sem_pendente' }
  // ⚠️ Fora da janela quem confirma é uma PESSOA: o cliente não está mais
  //    olhando aquele resumo, e o preço provavelmente mudou.
  if (!ped.fresco) return { tipo: 'fora_da_janela', pedidoId: ped.id }
  const [conf] = await tx<{ id: string }[]>`
    UPDATE pedido SET estado = 'confirmado', confirmado_em = ${quando}, atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${ped.id} AND estado = 'aguardando_confirmacao'
     RETURNING id`
  if (!conf) return { tipo: 'sem_pendente' }
  // Evento no mesmo commit (INV-40) — a tela e as próximas etapas reagem a isto.
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'pedido.confirmado', 'pedido', ${conf.id},
            ${JSON.stringify({ pedidoId: conf.id, conversaId, contatoId: ped.contato_id })}::text::jsonb)`
  return { tipo: 'confirmado', pedidoId: conf.id }
}

/**
 * O resumo foi enviado: o pedido passa a esperar o SIM, e qualquer OUTRO
 * pendente da mesma conversa é superado.
 *
 * ⚠️ **Um pedido pendente por conversa.** Sem esta regra a conversa acumula
 * pendentes e o "sim" caminha para trás na pilha: em 2026-08-27 o cliente
 * confirmou, além do pedido certo, um de três dias antes que nunca tinha visto
 * ali. É a reclamação clássica — "confirmei um e vieram dois".
 *
 * ⚠️ O superado é CANCELADO com motivo, não apagado: o vendedor precisa poder
 * abrir, entender e reaproveitar o conteúdo num rascunho novo (decisão do dono
 * do produto, 27/08).
 *
 * Devolve quantos foram superados.
 */
export async function marcarResumoEnviado(
  tx: Sql, pedidoId: string, conversaId: string,
): Promise<number> {
  await tx`
    UPDATE pedido
       SET estado = 'aguardando_confirmacao',
           -- ⚠️ Carimbo PRÓPRIO do envio: é o relógio da janela de 24h do "sim".
           --    A coluna atualizado_em seria esticada por qualquer edição que o
           --    cliente nem viu.
           resumo_enviado_em = now(), atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${pedidoId} AND estado = 'rascunho'`

  const superados = await tx<{ id: string }[]>`
    UPDATE pedido
       SET estado = 'cancelado', cancelado_em = now(), atualizado_em = now(),
           cancelado_motivo = 'substituído por um resumo novo nesta conversa'
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId}
       AND id <> ${pedidoId} AND estado = 'aguardando_confirmacao'
    RETURNING id`
  return superados.length
}
