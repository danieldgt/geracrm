import { createHash } from 'node:crypto'
import { canalAceitaReativacao, detectarOptOut, lerConfigAtivas, type ConfigAtivas } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { qualificarContato } from '../../crm/qualificacao.js'
import { contatoBloqueado } from '../../crm/opt-out.js'

/**
 * DESCARTE APÓS A CADÊNCIA E REATIVAÇÃO (raia G5; AM: cadenciaReengajamento).
 *
 *   último retorno enviado, sem resposta ──(+descarteAposHoras, DESLIGADO por padrão)──▶
 *     contato → Descartado, motivo `sem_resposta` (ator = sistema, auditado, SEM mensagem)
 *       └─(+30 d, +90 d ±3 d, se ligada)──▶ reativação: template aprovado (oficial) ou texto (não-oficial)
 *   cliente escreveu a qualquer hora ──▶ pendentes canceladas e, se o descarte foi
 *     `sem_resposta`, o contato volta a "novo" (`reabrirContatoDescartadoSemResposta`)
 *
 * As duas etapas são linhas de `agente_retorno` (motivos `descarte_sem_resposta` e
 * `reativacao`): mesmo worker, mesma política das ativas (suspensão, expediente,
 * limites, janela/template), mesmo opt-out no gateway. Este módulo só tem o que é
 * específico delas e NÃO importa `retorno.ts` (o motor importa este).
 *
 * ⚠️ Descartar é regra de domínio do CRM (`qualificarContato`), nunca UPDATE aqui.
 * ⚠️ Só descarta quem ainda é "novo" (qualificado NULL) e NUNCA quem já comprou
 *    (`qtd_vendas > 0` ou pedido que passou da proposta): cliente não vira Perdido por silêncio.
 * ⚠️ CORRIDA com a resposta do cliente: o descarte e a ingestão travam as MESMAS
 *    linhas (conversa, depois contato) antes de ler/decidir — `travarConversaEContato`.
 *    Ou a ingestão vê o contato já descartado e reabre, ou o descarte vê a resposta e cancela.
 */

/** O descarte automático não é uma mensagem: roda sem expediente nem janela. */
export const MOTIVO_DESCARTE = 'descarte_sem_resposta' as const
export const MOTIVO_REATIVACAO = 'reativacao' as const
export const DIA_MS = 24 * 60 * 60 * 1000
/** Espalhamento dos marcos da reativação: ±3 dias, determinístico por contato (nada de rajada no dia 30). */
export const ESPALHAMENTO_REATIVACAO_MS = 3 * DIA_MS

export async function lerConfigAtivasDoCanal(tx: Sql, canalId: string): Promise<ConfigAtivas> {
  const [l] = await tx<{ ativas: unknown }[]>`
    SELECT coalesce(ativas, '{}'::jsonb) AS ativas FROM agente_config
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
  return lerConfigAtivas(l?.ativas ?? {})
}

/**
 * Trava a conversa e o contato dela (nesta ordem, sempre — a ingestão trava a
 * conversa no UPDATE do passo 5 e o contato aqui). Devolve o contato, ou `null`.
 * Chamar no INÍCIO de quem decide descartar ou reabrir, antes de qualquer leitura.
 */
export async function travarConversaEContato(tx: Sql, conversaId: string): Promise<{ contatoId: string } | null> {
  const [c] = await tx<{ contato_id: string }[]>`
    SELECT contato_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId} FOR UPDATE`
  if (!c) return null
  await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${c.contato_id} FOR UPDATE`
  return { contatoId: c.contato_id }
}

/** O contato já comprou? Venda registrada (contador do mesmo commit) ou pedido que passou da proposta. */
async function contatoComCompra(tx: Sql, contatoId: string): Promise<boolean> {
  const [l] = await tx<{ comprou: boolean }[]>`
    SELECT (SELECT qtd_vendas > 0 FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId})
        OR EXISTS (SELECT 1 FROM pedido p
                    WHERE p.tenant_id = tenant_atual() AND p.contato_id = ${contatoId}
                      AND (p.efetivado_em IS NOT NULL
                           OR p.estado IN ('confirmado', 'validando', 'enviando', 'efetivado', 'aguardando_conferencia'))) AS comprou`
  return l?.comprou ?? false
}

/** Quando descartar, depois do último retorno enviado agora. `null` = descarte desligado, contato já avaliado ou com compra. */
export async function prazoDoDescarte(tx: Sql, p: { conversaId: string; canalId: string; agora: Date }): Promise<Date | null> {
  const cfg = await lerConfigAtivasDoCanal(tx, p.canalId)
  if (cfg.descarteAposHoras <= 0) return null
  const [c] = await tx<{ contato_id: string; qualificado: boolean | null }[]>`
    SELECT ct.id AS contato_id, ct.qualificado FROM conversa c JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${p.conversaId}`
  if (!c || c.qualificado !== null) return null
  if (await contatoComCompra(tx, c.contato_id)) return null
  return new Date(p.agora.getTime() + cfg.descarteAposHoras * 3_600_000)
}

interface FatosDoContato {
  readonly contatoId: string
  readonly tipoCanal: string
  readonly qualificado: boolean | null
  readonly descarteMotivo: string | null
  readonly qualificadoEm: Date | null
  /** A última mensagem do cliente em QUALQUER conversa dele (todos os números). */
  readonly ultimaEntranteEm: Date | null
  /** Atendimento humano aberto em qualquer conversa do contato. */
  readonly humanoAtendendo: boolean
  readonly recebeCampanhas: boolean
  readonly recebeAutomacoes: boolean
}

async function lerFatos(tx: Sql, conversaId: string): Promise<FatosDoContato | null> {
  const [l] = await tx<{
    contato_id: string; tipo: string; qualificado: boolean | null; descarte_motivo: string | null; qualificado_em: Date | null
    ultima_entrante_em: Date | null; humano: boolean; recebe_campanhas: boolean; recebe_automacoes: boolean
  }[]>`
    SELECT c.contato_id, cc.tipo, ct.qualificado, ct.descarte_motivo, ct.qualificado_em,
           ct.recebe_campanhas, ct.recebe_automacoes,
           (SELECT max(o.ultima_entrante_em) FROM conversa o
             WHERE o.tenant_id = c.tenant_id AND o.contato_id = c.contato_id) AS ultima_entrante_em,
           EXISTS (SELECT 1 FROM atendimento a JOIN conversa o ON o.tenant_id = a.tenant_id AND o.id = a.conversa_id
                    WHERE a.tenant_id = c.tenant_id AND o.contato_id = c.contato_id AND a.estado <> 'encerrado') AS humano
      FROM conversa c
      JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
      JOIN canal_conectado cc ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
  if (!l) return null
  return {
    contatoId: l.contato_id, tipoCanal: l.tipo, qualificado: l.qualificado, descarteMotivo: l.descarte_motivo,
    qualificadoEm: l.qualificado_em, ultimaEntranteEm: l.ultima_entrante_em, humanoAtendendo: l.humano,
    recebeCampanhas: l.recebe_campanhas, recebeAutomacoes: l.recebe_automacoes,
  }
}

export type ResultadoDescarte =
  | { readonly tipo: 'descartado'; readonly contatoId: string; readonly config: ConfigAtivas; readonly tipoCanal: string }
  | { readonly tipo: 'cancelar'; readonly motivo: string }

/**
 * Executa o descarte vencido: TRAVA conversa e contato, confere que o motivo ainda
 * vale e descarta pelo domínio do CRM. O modo efetivo do agente é conferido pelo
 * motor (`retorno.ts`) antes — este módulo não conhece o pipeline.
 */
export async function executarDescarte(
  tx: Sql, v: { conversaId: string; canalId: string; criadoEm: Date }, agora: Date,
): Promise<ResultadoDescarte> {
  if (!(await travarConversaEContato(tx, v.conversaId))) return { tipo: 'cancelar', motivo: 'conversa_inexistente' }
  const f = await lerFatos(tx, v.conversaId)
  if (!f) return { tipo: 'cancelar', motivo: 'conversa_inexistente' }
  if (f.ultimaEntranteEm && f.ultimaEntranteEm > v.criadoEm) return { tipo: 'cancelar', motivo: 'cliente_escreveu' }
  if (f.humanoAtendendo) return { tipo: 'cancelar', motivo: 'humano_atendendo' }
  // ⚠️ Linha agendada por número que não LIGOU o descarte (o padrão é desligado): cancela.
  const config = await lerConfigAtivasDoCanal(tx, v.canalId)
  if (config.descarteAposHoras <= 0) return { tipo: 'cancelar', motivo: 'descarte_desligado' }
  if (f.qualificado !== null) return { tipo: 'cancelar', motivo: 'contato_ja_avaliado' }
  if (await contatoComCompra(tx, f.contatoId)) return { tipo: 'cancelar', motivo: 'contato_com_compra' }
  const r = await qualificarContato(tx, {
    contatoId: f.contatoId, estado: 'descartado', motivo: 'sem_resposta', atorId: null, em: agora,
    somenteSeEstava: 'novo', acao: 'contato.descartado_sem_resposta',
  })
  if (r.tipo !== 'ok') return { tipo: 'cancelar', motivo: 'contato_ja_avaliado' }
  return { tipo: 'descartado', contatoId: f.contatoId, config, tipoCanal: f.tipoCanal }
}

/**
 * Por que a reativação NÃO vale mais — ou `null` (vale). Lido sob RLS.
 * Os motivos PERMANENTES (o contato voltou, pediu para parar, a reativação foi
 * desligada…) também impedem agendar o próximo marco; ver `motivoTransitorio`.
 */
export async function motivoParaNaoReativar(
  tx: Sql, v: { conversaId: string; canalId: string; criadoEm: Date },
): Promise<string | null> {
  const f = await lerFatos(tx, v.conversaId)
  if (!f) return 'conversa_inexistente'
  if (!canalAceitaReativacao(f.tipoCanal)) return 'canal_sem_reativacao'
  if (f.ultimaEntranteEm && f.ultimaEntranteEm > v.criadoEm) return 'cliente_escreveu'
  if (f.qualificado !== false || f.descarteMotivo !== 'sem_resposta') return 'contato_nao_descartado_sem_resposta'
  // Opt-out: lista de bloqueio (telefone) OU consentimento recusado (contato sem telefone);
  // e as preferências do contato — a reativação é mensagem automática de reengajamento.
  if (await contatoBloqueado(tx, f.contatoId)) return 'opt_out'
  if (!f.recebeCampanhas || !f.recebeAutomacoes) return 'contato_nao_recebe'
  if (await contatoComCompra(tx, f.contatoId)) return 'contato_com_compra'
  const config = await lerConfigAtivasDoCanal(tx, v.canalId)
  if (!config.reativacao.ativa) return 'reativacao_desligada'
  if (f.humanoAtendendo) return 'humano_atendendo'
  return null
}

/** Motivos que não condenam os PRÓXIMOS marcos: o marco atual não sai, mas o seguinte pode. */
export function motivoTransitorio(motivo: string): boolean {
  return motivo === 'humano_atendendo'
}

/**
 * Deslocamento determinístico do marco `passo` de um contato, em [-3 d, +3 d]
 * (resolução de minuto): o mesmo contato cai sempre no mesmo instante, e um lote
 * descartado no mesmo dia se espalha por uma semana em vez de sair junto no dia 30.
 */
export function espalhamentoDaReativacao(contatoId: string, passo: number): number {
  const h = createHash('sha256').update(`${contatoId}:${passo}`).digest().readUInt32BE(0)
  const minutos = ESPALHAMENTO_REATIVACAO_MS / 60_000
  return ((h % (2 * minutos + 1)) - minutos) * 60_000
}

/** O instante do marco `passo` (1-based): descarte + dias[passo-1] ± espalhamento. `null` = não há esse marco. */
export function instanteDoMarco(
  p: { descartadoEm: Date; dias: readonly number[]; contatoId: string; passo: number },
): Date | null {
  const dias = p.dias[p.passo - 1]
  if (dias === undefined) return null
  return new Date(p.descartadoEm.getTime() + dias * DIA_MS + espalhamentoDaReativacao(p.contatoId, p.passo))
}

/**
 * Quando sai o marco `passo` (1-based) da reativação: dias contados do DESCARTE,
 * espalhados por contato. Nunca no passado (o marco anterior pode ter sido adiado
 * além deste): no mínimo um dia depois de `agora`. `null` = acabaram os marcos.
 */
export async function proximoMarcoDaReativacao(
  tx: Sql, p: { conversaId: string; canalId: string; passo: number; agora: Date },
): Promise<Date | null> {
  const config = await lerConfigAtivasDoCanal(tx, p.canalId)
  if (!config.reativacao.ativa) return null
  const f = await lerFatos(tx, p.conversaId)
  if (!f?.qualificadoEm || !canalAceitaReativacao(f.tipoCanal)) return null
  const quando = instanteDoMarco({ descartadoEm: f.qualificadoEm, dias: config.reativacao.dias, contatoId: f.contatoId, passo: p.passo })
  if (!quando) return null
  return quando.getTime() > p.agora.getTime() ? quando : new Date(p.agora.getTime() + DIA_MS)
}

/**
 * O cliente escreveu: se o contato estava Descartado por `sem_resposta` (o robô
 * o deu por perdido), ele está vivo — volta a "novo" pelo mesmo caminho de
 * domínio, com auditoria do sistema. Descarte manual NUNCA é reaberto aqui.
 * ⚠️ Pedido de parar ("PARE", "me tira da lista", inclusive o possível) ou contato
 *    já bloqueado NÃO reabre: quem pediu para sair não volta para a fila do robô.
 * Chamado na transação da ingestão (savepoint), DEPOIS do UPDATE da conversa:
 * trava conversa e contato e só então lê. Devolve se reabriu.
 */
export async function reabrirContatoDescartadoSemResposta(
  tx: Sql, conversaId: string, agora: Date, texto?: string | null,
): Promise<boolean> {
  if (!(await travarConversaEContato(tx, conversaId))) return false
  const f = await lerFatos(tx, conversaId)
  if (!f || f.qualificado !== false || f.descarteMotivo !== 'sem_resposta') return false
  if (texto && detectarOptOut(texto) !== null) return false
  if (await contatoBloqueado(tx, f.contatoId)) return false
  const r = await qualificarContato(tx, {
    contatoId: f.contatoId, estado: 'novo', atorId: null, em: agora,
    somenteSeEstava: 'descartado', acao: 'contato.reaberto_por_resposta',
  })
  return r.tipo === 'ok'
}

/**
 * O cliente escreveu em QUALQUER número: descarte e reativação pendentes do
 * contato (todas as conversas dele) perdem o motivo. Os retornos de cadência das
 * outras conversas seguem — são de outra negociação. Devolve quantos cancelou.
 */
export async function cancelarDescarteEReativacaoDoContato(tx: Sql, conversaId: string): Promise<number> {
  const linhas = await tx<{ id: string }[]>`
    UPDATE agente_retorno r SET estado = 'cancelado', detalhe = 'cliente_escreveu', concluido_em = now()
      FROM conversa c, conversa o
     WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}
       AND o.tenant_id = c.tenant_id AND o.contato_id = c.contato_id
       AND r.tenant_id = o.tenant_id AND r.conversa_id = o.id
       AND r.estado = 'pendente' AND r.motivo IN (${MOTIVO_DESCARTE}, ${MOTIVO_REATIVACAO})
     RETURNING r.id`
  return linhas.length
}
