import { lerConfigAtivas, type ConfigAtivas } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { qualificarContato } from '../../crm/qualificacao.js'

/**
 * DESCARTE APÓS A CADÊNCIA E REATIVAÇÃO (raia G5; AM: cadenciaReengajamento).
 *
 *   último retorno enviado, sem resposta ──(+descarteAposHoras, padrão 72 h)──▶
 *     contato → Descartado, motivo `sem_resposta` (ator = sistema, auditado, SEM mensagem)
 *       └─(+30 d, +90 d, se ligada)──▶ reativação: template aprovado (oficial) ou texto (não-oficial)
 *   cliente escreveu a qualquer hora ──▶ pendentes canceladas e, se o descarte foi
 *     `sem_resposta`, o contato volta a "novo" (`reabrirContatoDescartadoSemResposta`)
 *
 * As duas etapas são linhas de `agente_retorno` (motivos `descarte_sem_resposta` e
 * `reativacao`): mesmo worker, mesma política das ativas (suspensão, expediente,
 * limites, janela/template), mesmo opt-out no gateway. Este módulo só tem o que é
 * específico delas e NÃO importa `retorno.ts` (o motor importa este).
 *
 * ⚠️ Descartar é regra de domínio do CRM (`qualificarContato`), nunca UPDATE aqui.
 * ⚠️ Só descarta quem ainda é "novo" (qualificado NULL): lead que alguém — ou o
 *    agente — já qualificou não vira Perdido por silêncio.
 */

/** O descarte automático não é uma mensagem: roda sem expediente nem janela. */
export const MOTIVO_DESCARTE = 'descarte_sem_resposta' as const
export const MOTIVO_REATIVACAO = 'reativacao' as const
export const DIA_MS = 24 * 60 * 60 * 1000

export async function lerConfigAtivasDoCanal(tx: Sql, canalId: string): Promise<ConfigAtivas> {
  const [l] = await tx<{ ativas: unknown }[]>`
    SELECT coalesce(ativas, '{}'::jsonb) AS ativas FROM agente_config
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
  return lerConfigAtivas(l?.ativas ?? {})
}

/** Quando descartar, depois do último retorno enviado agora. `null` = descarte desligado ou contato já qualificado. */
export async function prazoDoDescarte(tx: Sql, p: { conversaId: string; canalId: string; agora: Date }): Promise<Date | null> {
  const cfg = await lerConfigAtivasDoCanal(tx, p.canalId)
  if (cfg.descarteAposHoras <= 0) return null
  const [c] = await tx<{ qualificado: boolean | null }[]>`
    SELECT ct.qualificado FROM conversa c JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${p.conversaId}`
  if (!c || c.qualificado !== null) return null
  return new Date(p.agora.getTime() + cfg.descarteAposHoras * 3_600_000)
}

interface FatosDaConversa {
  readonly contatoId: string
  readonly qualificado: boolean | null
  readonly descarteMotivo: string | null
  readonly qualificadoEm: Date | null
  readonly ultimaEntranteEm: Date | null
  readonly humanoAtendendo: boolean
  readonly optOut: boolean
}

async function lerFatos(tx: Sql, conversaId: string): Promise<FatosDaConversa | null> {
  const [l] = await tx<{
    contato_id: string; qualificado: boolean | null; descarte_motivo: string | null; qualificado_em: Date | null
    ultima_entrante_em: Date | null; humano: boolean; bloqueado: boolean
  }[]>`
    SELECT c.contato_id, ct.qualificado, ct.descarte_motivo, ct.qualificado_em, c.ultima_entrante_em,
           EXISTS (SELECT 1 FROM atendimento a
                    WHERE a.tenant_id = c.tenant_id AND a.conversa_id = c.id AND a.estado <> 'encerrado') AS humano,
           EXISTS (SELECT 1 FROM contato_telefone t
                     JOIN lista_bloqueio lb ON lb.tenant_id = t.tenant_id AND lb.chave_bloqueio = t.chave_bloqueio
                    WHERE t.tenant_id = c.tenant_id AND t.contato_id = c.contato_id) AS bloqueado
      FROM conversa c JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
  if (!l) return null
  return {
    contatoId: l.contato_id, qualificado: l.qualificado, descarteMotivo: l.descarte_motivo, qualificadoEm: l.qualificado_em,
    ultimaEntranteEm: l.ultima_entrante_em, humanoAtendendo: l.humano, optOut: l.bloqueado,
  }
}

export type ResultadoDescarte =
  | { readonly tipo: 'descartado'; readonly contatoId: string; readonly config: ConfigAtivas }
  | { readonly tipo: 'cancelar'; readonly motivo: string }

/** Executa o descarte vencido: confere que o motivo ainda vale e descarta pelo domínio do CRM. */
export async function executarDescarte(
  tx: Sql, v: { conversaId: string; canalId: string; criadoEm: Date }, agora: Date,
): Promise<ResultadoDescarte> {
  const f = await lerFatos(tx, v.conversaId)
  if (!f) return { tipo: 'cancelar', motivo: 'conversa_inexistente' }
  if (f.ultimaEntranteEm && f.ultimaEntranteEm > v.criadoEm) return { tipo: 'cancelar', motivo: 'cliente_escreveu' }
  if (f.humanoAtendendo) return { tipo: 'cancelar', motivo: 'humano_atendendo' }
  const config = await lerConfigAtivasDoCanal(tx, v.canalId)
  if (config.descarteAposHoras <= 0) return { tipo: 'cancelar', motivo: 'descarte_desligado' }
  if (f.qualificado !== null) return { tipo: 'cancelar', motivo: 'contato_ja_avaliado' }
  const r = await qualificarContato(tx, {
    contatoId: f.contatoId, estado: 'descartado', motivo: 'sem_resposta', atorId: null, em: agora,
    somenteSeEstava: 'novo', acao: 'contato.descartado_sem_resposta',
  })
  if (r.tipo !== 'ok') return { tipo: 'cancelar', motivo: 'contato_ja_avaliado' }
  return { tipo: 'descartado', contatoId: f.contatoId, config }
}

/** Por que a reativação NÃO vale mais — ou `null` (vale). Lido sob RLS. */
export async function motivoParaNaoReativar(
  tx: Sql, v: { conversaId: string; canalId: string; criadoEm: Date },
): Promise<string | null> {
  const f = await lerFatos(tx, v.conversaId)
  if (!f) return 'conversa_inexistente'
  if (f.ultimaEntranteEm && f.ultimaEntranteEm > v.criadoEm) return 'cliente_escreveu'
  if (f.humanoAtendendo) return 'humano_atendendo'
  if (f.qualificado !== false || f.descarteMotivo !== 'sem_resposta') return 'contato_nao_descartado_sem_resposta'
  if (f.optOut) return 'opt_out'
  const config = await lerConfigAtivasDoCanal(tx, v.canalId)
  if (!config.reativacao.ativa) return 'reativacao_desligada'
  return null
}

/** Quando sai o marco `passo` (1-based) da reativação: dias contados do DESCARTE. `null` = acabaram os marcos. */
export async function proximoMarcoDaReativacao(
  tx: Sql, p: { conversaId: string; canalId: string; passo: number },
): Promise<Date | null> {
  const config = await lerConfigAtivasDoCanal(tx, p.canalId)
  const dias = config.reativacao.dias[p.passo - 1]
  if (!config.reativacao.ativa || dias === undefined) return null
  const f = await lerFatos(tx, p.conversaId)
  if (!f?.qualificadoEm) return null
  return new Date(f.qualificadoEm.getTime() + dias * DIA_MS)
}

/**
 * O cliente escreveu: se o contato estava Descartado por `sem_resposta` (o robô
 * o deu por perdido), ele está vivo — volta a "novo" pelo mesmo caminho de
 * domínio, com auditoria do sistema. Descarte manual NUNCA é reaberto aqui.
 * Chamado na transação da ingestão (savepoint). Devolve se reabriu.
 */
export async function reabrirContatoDescartadoSemResposta(tx: Sql, conversaId: string, agora: Date): Promise<boolean> {
  const f = await lerFatos(tx, conversaId)
  if (!f || f.qualificado !== false || f.descarteMotivo !== 'sem_resposta') return false
  const r = await qualificarContato(tx, {
    contatoId: f.contatoId, estado: 'novo', atorId: null, em: agora,
    somenteSeEstava: 'descartado', acao: 'contato.reaberto_por_resposta',
  })
  return r.tipo === 'ok'
}
