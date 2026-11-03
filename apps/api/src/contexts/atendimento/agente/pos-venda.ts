import { randomUUID } from 'node:crypto'
import { DIAS_ROTEIRO_POS_VENDA, ehRoteiroPosVenda, type RoteiroPosVenda } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { patchEstado } from './estado-agente.js'

/**
 * O ROTEIRO DO PÓS-VENDA NA SESSÃO DO AGENTE (raia G3).
 *
 * Quando a ativa de pós-venda SAI (motivo `pos_venda`, `retorno.ts`), o roteiro é
 * gravado em `agente_sessao.estado_agente.posVenda` da sessão ATIVA da conversa
 * (criada, sem turnos, se não houver — mesmo desenho do recado de "Devolver ao
 * agente"). É o que:
 *   - a etapa `pos-venda` do pipeline lê para dizer ao modelo o que foi perguntado;
 *   - a ferramenta `registrar_nps` exige: sem roteiro NPS aberto, a nota é recusada
 *     com erro tipificado `nps.nao_perguntado` — o modelo não "acha" uma nota num
 *     "nota 10 o atendimento de vocês" solto, nem registra duas vezes.
 * O roteiro vale por `DIAS_ROTEIRO_POS_VENDA` dias depois do envio.
 * ⚠️ Nada de PII aqui: só roteiro, id do pedido e carimbos.
 */

export const CHAVE_POS_VENDA = 'posVenda'

export interface RoteiroNaSessao {
  readonly roteiro: RoteiroPosVenda
  readonly pedidoId: string
  /** ISO do envio. */
  readonly em: string
  /** ISO de quando a nota foi registrada (só NPS). */
  readonly npsRegistradoEm?: string | undefined
}

/** Leitura tolerante: fora do formato = sem roteiro. */
export function lerRoteiroPosVenda(v: unknown): RoteiroNaSessao | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!ehRoteiroPosVenda(o['roteiro'])) return null
  if (typeof o['pedidoId'] !== 'string' || typeof o['em'] !== 'string' || !Number.isFinite(Date.parse(o['em']))) return null
  const reg = typeof o['npsRegistradoEm'] === 'string' ? o['npsRegistradoEm'] : undefined
  return { roteiro: o['roteiro'], pedidoId: o['pedidoId'], em: o['em'], ...(reg ? { npsRegistradoEm: reg } : {}) }
}

/** O roteiro ainda vale (dentro do prazo, contado do envio)? */
export function roteiroVigente(r: RoteiroNaSessao | null, agora: Date): r is RoteiroNaSessao {
  if (!r) return false
  const idade = agora.getTime() - Date.parse(r.em)
  return idade >= 0 && idade <= DIAS_ROTEIRO_POS_VENDA * 86_400_000
}

/** Roteiro NPS aberto: vigente, do tipo nps e sem nota registrada. */
export function npsAberto(r: RoteiroNaSessao | null, agora: Date): r is RoteiroNaSessao {
  return roteiroVigente(r, agora) && r.roteiro === 'nps' && !r.npsRegistradoEm
}

/** A instrução do turno para o roteiro vigente (vai como operador, nunca no system). */
export function instrucaoDoRoteiro(r: RoteiroNaSessao): string | null {
  switch (r.roteiro) {
    case 'nps':
      if (r.npsRegistradoEm) return 'A nota do pós-venda deste cliente já foi registrada: agradeça se ele comentar, não pergunte de novo.'
      return 'No pós-venda, a loja perguntou a este cliente que nota de 0 a 10 ele dá para a experiência de compra. '
        + 'Se a mensagem dele trouxer essa nota, chame registrar_nps com a nota (e o comentário, se houver) e agradeça. '
        + 'Se não trouxer, siga a conversa normalmente — não insista na nota.'
    case 'indicacao':
      return 'No pós-venda, a loja pediu a este cliente indicações de pessoas que possam comprar também. '
        + 'Se ele indicar alguém com nome e telefone, chame registrar_indicacoes (no máximo 5) e agradeça. Não peça dados além de nome e telefone.'
    case 'agradecimento':
      return null
  }
}

/**
 * Grava o roteiro na sessão ATIVA da conversa (cria uma, sem turnos, se não houver).
 * Chamar sob tenant, na transação que registra o envio.
 */
export async function abrirRoteiroNaSessao(tx: Sql, p: {
  conversaId: string; canalId: string; modo: string; roteiro: RoteiroPosVenda; pedidoId: string; agora: Date
}): Promise<void> {
  const [criada] = await tx<{ id: string }[]>`
    INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.conversaId}, ${p.canalId}, ${p.agora}, 'pos_venda', ${p.modo})
    ON CONFLICT (tenant_id, conversa_id) WHERE estado = 'ativa' DO NOTHING
    RETURNING id`
  const sessaoId = criada?.id ?? (await tx<{ id: string }[]>`
    SELECT id FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND estado = 'ativa'`)[0]?.id
  const valor: RoteiroNaSessao = { roteiro: p.roteiro, pedidoId: p.pedidoId, em: p.agora.toISOString() }
  await patchEstado(tx, sessaoId ?? null, { [CHAVE_POS_VENDA]: valor })
}

/**
 * Marca a nota como registrada — só se o roteiro ainda é o mesmo (carimbo `em`):
 * um pós-venda NOVO gravado no meio não é fechado por engano. Devolve se marcou.
 */
export async function marcarNpsRegistrado(tx: Sql, sessaoId: string, em: string, agora: Date): Promise<boolean> {
  const linhas = await tx<{ id: string }[]>`
    UPDATE agente_sessao
       SET estado_agente = jsonb_set(estado_agente, ${['posVenda', 'npsRegistradoEm']}::text[], to_jsonb(${agora.toISOString()}::text))
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId}
       AND estado_agente -> 'posVenda' ->> 'em' = ${em}
       AND NOT (estado_agente -> 'posVenda' ? 'npsRegistradoEm')
    RETURNING id`
  return linhas.length > 0
}
