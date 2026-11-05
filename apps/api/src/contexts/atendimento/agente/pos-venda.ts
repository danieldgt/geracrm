import { randomUUID } from 'node:crypto'
import { DIAS_ROTEIRO_POS_VENDA, MAX_INDICACOES, ehRoteiroPosVenda, type RoteiroPosVenda } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'

/**
 * OS ROTEIROS DO PÓS-VENDA NA SESSÃO DO AGENTE (raia G3).
 *
 * Quando a ativa de pós-venda SAI (motivo `pos_venda`, `retorno.ts`), o roteiro é
 * gravado em `agente_sessao.estado_agente.posVenda.<roteiro>` da sessão ATIVA da
 * conversa (criada, sem turnos, se não houver — mesmo desenho do recado de
 * "Devolver ao agente"). É o que:
 *   - a etapa `pos-venda` do pipeline lê para dizer ao modelo o que foi perguntado;
 *   - as ferramentas exigem: sem roteiro NPS aberto, `registrar_nps` recusa
 *     (`nps.nao_perguntado`); sem pedido de indicação aberto, `registrar_indicacoes`
 *     recusa (`indicacoes.nao_pedido`) — e conta o TETO de indicações do roteiro;
 *   - o portão deixa entrar mesmo com a equipe disponível (a resposta à pergunta
 *     que NÓS fizemos precisa chegar a quem a registra; `atendentePresente` e humano
 *     assumido continuam vencendo).
 *
 * ⚠️ Um sub-objeto POR ROTEIRO (revisão G3, B3): abrir a indicação nunca apaga um
 *    NPS ainda pendente, e vice-versa. Formato antigo (`{roteiro, pedidoId, em}`)
 *    é lido como o roteiro que diz ser.
 * ⚠️ Cada roteiro vale `DIAS_ROTEIRO_POS_VENDA` dias depois do envio.
 * ⚠️ Nada de PII aqui: só roteiro, id do pedido, carimbos e contagem.
 */

export const CHAVE_POS_VENDA = 'posVenda'

export interface RoteiroNps {
  readonly pedidoId: string
  /** ISO do envio — também é a chave das escritas condicionais. */
  readonly em: string
  readonly npsRegistradoEm?: string | undefined
}

export interface RoteiroIndicacao {
  readonly pedidoId: string
  readonly em: string
  /** Quantas indicações já foram registradas neste pedido de indicação (teto `MAX_INDICACOES`). */
  readonly registradas: number
}

export interface PosVendaNaSessao {
  readonly nps: RoteiroNps | null
  readonly indicacao: RoteiroIndicacao | null
}

const VAZIO: PosVendaNaSessao = { nps: null, indicacao: null }

function base(v: unknown): { pedidoId: string; em: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o['pedidoId'] !== 'string' || typeof o['em'] !== 'string' || !Number.isFinite(Date.parse(o['em']))) return null
  return { pedidoId: o['pedidoId'], em: o['em'] }
}
function lerNps(v: unknown): RoteiroNps | null {
  const b = base(v)
  if (!b) return null
  const reg = (v as Record<string, unknown>)['npsRegistradoEm']
  return { ...b, ...(typeof reg === 'string' ? { npsRegistradoEm: reg } : {}) }
}
function lerIndicacao(v: unknown): RoteiroIndicacao | null {
  const b = base(v)
  if (!b) return null
  const n = Number((v as Record<string, unknown>)['registradas'] ?? 0)
  return { ...b, registradas: Number.isInteger(n) && n >= 0 ? n : MAX_INDICACOES }
}

/** Leitura tolerante: fora do formato = sem roteiro. */
export function lerPosVenda(v: unknown): PosVendaNaSessao {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return VAZIO
  const o = v as Record<string, unknown>
  // Formato antigo (um roteiro só, achatado).
  if (ehRoteiroPosVenda(o['roteiro'])) {
    if (o['roteiro'] === 'nps') return { nps: lerNps(o), indicacao: null }
    if (o['roteiro'] === 'indicacao') return { nps: null, indicacao: lerIndicacao(o) }
    return VAZIO
  }
  return { nps: lerNps(o['nps']), indicacao: lerIndicacao(o['indicacao']) }
}

/** O roteiro ainda vale (dentro do prazo, contado do envio)? */
export function roteiroVigente(r: { readonly em: string } | null, agora: Date): boolean {
  if (!r) return false
  const idade = agora.getTime() - Date.parse(r.em)
  return idade >= 0 && idade <= DIAS_ROTEIRO_POS_VENDA * 86_400_000
}

/** Roteiro NPS aberto: vigente e sem nota registrada. */
export function npsAberto(pv: PosVendaNaSessao, agora: Date): boolean {
  return !!pv.nps && roteiroVigente(pv.nps, agora) && !pv.nps.npsRegistradoEm
}

/** Pedido de indicação aberto: vigente e com teto sobrando. */
export function indicacaoAberta(pv: PosVendaNaSessao, agora: Date): boolean {
  return !!pv.indicacao && roteiroVigente(pv.indicacao, agora) && pv.indicacao.registradas < MAX_INDICACOES
}

/** Há pergunta do pós-venda esperando resposta (o portão deixa o agente entrar). */
export function posVendaPendente(pv: PosVendaNaSessao, agora: Date): boolean {
  return npsAberto(pv, agora) || indicacaoAberta(pv, agora)
}

/** As instruções do turno para os roteiros vigentes (vão como operador, nunca no system). */
export function instrucoesDoPosVenda(pv: PosVendaNaSessao, agora: Date): string[] {
  const out: string[] = []
  if (pv.nps && roteiroVigente(pv.nps, agora)) {
    out.push(pv.nps.npsRegistradoEm
      ? 'A nota do pós-venda deste cliente já foi registrada: agradeça se ele comentar, não pergunte de novo.'
      : 'No pós-venda, a loja perguntou a este cliente que nota de 0 a 10 ele dá para a experiência de compra. '
        + 'Se a mensagem dele trouxer essa nota, chame registrar_nps com a nota (e o comentário, se houver) e agradeça. '
        + 'Se não trouxer, siga a conversa normalmente — não insista na nota.')
  }
  if (pv.indicacao && roteiroVigente(pv.indicacao, agora)) {
    out.push(indicacaoAberta(pv, agora)
      ? 'No pós-venda, a loja pediu a este cliente indicações de pessoas que possam comprar também. '
        + `Se ele indicar alguém com nome e telefone, chame registrar_indicacoes (no máximo ${MAX_INDICACOES - pv.indicacao.registradas} ainda) e agradeça. `
        + 'Não peça dados além de nome e telefone, e não diga se a pessoa indicada já é cliente.'
      : 'As indicações deste pedido já chegaram ao limite: agradeça e não registre mais.')
  }
  return out
}

/**
 * Grava o roteiro na sessão ATIVA da conversa (cria uma, sem turnos, se não houver),
 * só no sub-objeto dele — o outro roteiro fica intacto. Chamar sob tenant.
 */
export async function abrirRoteiroNaSessao(tx: Sql, p: {
  conversaId: string; canalId: string; modo: string; roteiro: RoteiroPosVenda; pedidoId: string; agora: Date
}): Promise<void> {
  if (p.roteiro === 'agradecimento') return
  const [criada] = await tx<{ id: string }[]>`
    INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.conversaId}, ${p.canalId}, ${p.agora}, 'pos_venda', ${p.modo})
    ON CONFLICT (tenant_id, conversa_id) WHERE estado = 'ativa' DO NOTHING
    RETURNING id`
  const sessaoId = criada?.id ?? (await tx<{ id: string }[]>`
    SELECT id FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${p.conversaId} AND estado = 'ativa'`)[0]?.id
  if (!sessaoId) return
  const valor = p.roteiro === 'nps'
    ? { pedidoId: p.pedidoId, em: p.agora.toISOString() }
    : { pedidoId: p.pedidoId, em: p.agora.toISOString(), registradas: 0 }
  // Formato antigo achatado é descartado ao escrever o novo (só existiu em desenvolvimento).
  await tx`
    UPDATE agente_sessao
       SET estado_agente = estado_agente || jsonb_build_object('posVenda',
             (CASE WHEN jsonb_typeof(estado_agente -> 'posVenda') = 'object' AND NOT (estado_agente -> 'posVenda' ? 'roteiro')
                   THEN estado_agente -> 'posVenda' ELSE '{}'::jsonb END)
             || jsonb_build_object(${p.roteiro}::text, ${JSON.stringify(valor)}::text::jsonb))
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
}

/**
 * Marca a nota como registrada — só se o roteiro NPS ainda é o mesmo (carimbo `em`)
 * e ainda não tem nota: um pós-venda NOVO gravado no meio não é fechado por engano,
 * e duas chamadas no mesmo turno não registram duas notas. Devolve se marcou.
 */
export async function marcarNpsRegistrado(tx: Sql, sessaoId: string, em: string, agora: Date): Promise<boolean> {
  const linhas = await tx<{ id: string }[]>`
    UPDATE agente_sessao
       SET estado_agente = jsonb_set(estado_agente, ${['posVenda', 'nps', 'npsRegistradoEm']}::text[], to_jsonb(${agora.toISOString()}::text))
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId}
       AND estado_agente #>> ${['posVenda', 'nps', 'em']}::text[] = ${em}
       AND estado_agente #> ${['posVenda', 'nps', 'npsRegistradoEm']}::text[] IS NULL
    RETURNING id`
  return linhas.length > 0
}

/**
 * Reserva `n` indicações no teto do roteiro, atômica: só passa se o roteiro é o
 * mesmo (carimbo `em`) e cabe (`registradas + n <= MAX_INDICACOES`). Devolve o
 * total depois da reserva, ou `null` (não coube / roteiro trocou).
 */
export async function reservarIndicacoes(tx: Sql, sessaoId: string, em: string, n: number): Promise<number | null> {
  const [l] = await tx<{ total: number }[]>`
    UPDATE agente_sessao
       SET estado_agente = jsonb_set(estado_agente, ${['posVenda', 'indicacao', 'registradas']}::text[],
             to_jsonb(coalesce((estado_agente #>> ${['posVenda', 'indicacao', 'registradas']}::text[])::int, 0) + ${n}::int))
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId}
       AND estado_agente #>> ${['posVenda', 'indicacao', 'em']}::text[] = ${em}
       AND coalesce((estado_agente #>> ${['posVenda', 'indicacao', 'registradas']}::text[])::int, 0) + ${n}::int <= ${MAX_INDICACOES}::int
    RETURNING (estado_agente #>> ${['posVenda', 'indicacao', 'registradas']}::text[])::int AS total`
  return l ? l.total : null
}

/**
 * Para o PORTÃO: a sessão ativa desta conversa tem pergunta do pós-venda pendente?
 * Leitura própria (curta), sob o tenant.
 */
export async function posVendaPendenteNaConversa(tenantId: string, conversaId: string, agora: Date): Promise<boolean> {
  return comTenantServico(tenantId, async (tx) => {
    const [s] = await tx<{ pv: unknown }[]>`
      SELECT estado_agente -> 'posVenda' AS pv FROM agente_sessao
       WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'ativa'`
    return s ? posVendaPendente(lerPosVenda(s.pv), agora) : false
  })
}
