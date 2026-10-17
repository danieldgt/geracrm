import { SLA_PADRAO, normalizarFeriados, rotearHandoff, type ConfigSla, type PessoaRoteavel, type Roteamento } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import type { HorarioAtendimento } from './expediente.js'
import { somarMinutosUteis } from './minutos-uteis.js'

/**
 * SLA DO HANDOFF — o lado com banco (raia P18, ADR-034). As decisões são puras
 * (`somarMinutosUteis`, `rotearHandoff`, shared `faixaDoCronometro`); aqui só se
 * lê o que elas precisam e se grava o resultado. Tudo sob `tenant_atual()`.
 */

export interface ContextoSlaNumero {
  readonly config: ConfigSla
  readonly padrao: boolean
  readonly horario: HorarioAtendimento | null
  readonly feriados: readonly string[]
  readonly fuso: string
  readonly tipoCanal: string
}

/** Configuração do número (ou o padrão), expediente, feriados e fuso do tenant. */
export async function lerContextoSla(tx: Sql, canalId: string): Promise<ContextoSlaNumero | null> {
  const [l] = await tx<{
    sla_minutos: number | null; reatribuicao_minutos: number | null; aviso_espera: boolean | null
    horario: HorarioAtendimento | null; feriados: unknown; fuso: string | null; tipo: string
  }[]>`
    SELECT s.sla_minutos, s.reatribuicao_minutos, s.aviso_espera,
           cfg.horario_atendimento AS horario, coalesce(cfg.feriados, '[]'::jsonb) AS feriados, t.fuso, cc.tipo
      FROM canal_conectado cc
      JOIN tenant t ON t.id = cc.tenant_id
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
      LEFT JOIN atendimento_sla_config s ON s.tenant_id = cc.tenant_id AND s.canal_id = cc.id
     WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
  if (!l) return null
  const padrao = l.sla_minutos === null
  return {
    config: padrao ? SLA_PADRAO : {
      slaMinutos: l.sla_minutos!, reatribuicaoMinutos: l.reatribuicao_minutos ?? SLA_PADRAO.reatribuicaoMinutos,
      avisoEspera: l.aviso_espera ?? SLA_PADRAO.avisoEspera,
    },
    padrao,
    // ⚠️ jsonb gravado como STRING (duplo encode) não é horário: tratar como objeto
    //    fecharia todos os dias e o SLA cairia no relógio de parede sem avisar.
    horario: l.horario && typeof l.horario === 'object' && !Array.isArray(l.horario) ? l.horario : null,
    feriados: normalizarFeriados(l.feriados),
    fuso: fusoSeguro(l.fuso),
    tipoCanal: l.tipo,
  }
}

/** Os prazos de um handoff que começa em `inicio`. Sem abertura no horizonte: relógio de parede. */
export function prazosDoSla(ctx: ContextoSlaNumero, inicio: Date): {
  venceEm: Date; reatribuicaoVenceEm: Date; avisoPrevistoEm: Date
} {
  const parede = (min: number) => new Date(inicio.getTime() + min * 60_000)
  const venceEm = somarMinutosUteis(inicio, ctx.config.slaMinutos, ctx.horario, ctx.feriados, ctx.fuso) ?? parede(ctx.config.slaMinutos)
  const reatribuicaoVenceEm = somarMinutosUteis(inicio, ctx.config.reatribuicaoMinutos, ctx.horario, ctx.feriados, ctx.fuso)
    ?? parede(ctx.config.reatribuicaoMinutos)
  // ⚠️ A espera é devida no MENOR entre o SLA e N minutos de parede: o cliente
  //    que escreveu às 17:50 não passa a noite sem resposta — às 18:20 ele
  //    recebe "no próximo horário de atendimento" (o texto é escolhido no envio).
  const avisoPrevistoEm = new Date(Math.min(venceEm.getTime(), parede(ctx.config.slaMinutos).getTime()))
  return { venceEm, reatribuicaoVenceEm, avisoPrevistoEm }
}

const PAPEIS_GESTAO = ['gestor', 'supervisor', 'admin'] as const

/** Admin/gestor/supervisor ATIVOS do tenant, gestor primeiro. Teto de 20. */
export async function gestoresDoTenant(tx: Sql): Promise<PessoaRoteavel[]> {
  return tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND u.ativo
       AND EXISTS (SELECT 1 FROM usuario_filial uf
                    WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.papel IN ${tx(PAPEIS_GESTAO)})
     ORDER BY (SELECT min(array_position(${PAPEIS_GESTAO as unknown as string[]}::text[], uf.papel))
                 FROM usuario_filial uf WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id), u.id
     LIMIT 20`
}

/** Quem tem permissão no número (`usuario_canal`). Teto de 50. */
export async function poolDoNumero(tx: Sql, canalId: string): Promise<PessoaRoteavel[]> {
  return tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM usuario_canal uc
      JOIN usuario u ON u.tenant_id = uc.tenant_id AND u.id = uc.usuario_id
     WHERE uc.tenant_id = tenant_atual() AND uc.canal_id = ${canalId}
     ORDER BY u.id
     LIMIT 50`
}

/** Monta a entrada de `rotearHandoff` e decide. */
export async function rotearHandoffDaConversa(tx: Sql, conversaId: string, canalId: string): Promise<Roteamento> {
  const [dono] = await tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM conversa c
      JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.contato_id AND ca.ate IS NULL
      JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
     WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}
     LIMIT 1`
  const pool = await poolDoNumero(tx, canalId)
  const ids = pool.map((p) => p.id)
  const [ultimo] = ids.length === 0 ? [] : await tx<{ responsavel_id: string }[]>`
    SELECT responsavel_id FROM atendimento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND responsavel_id IS NOT NULL
       AND responsavel_id IN ${tx(ids)}
     ORDER BY sla_inicio_em DESC NULLS LAST LIMIT 1`
  const gestores = await gestoresDoTenant(tx)
  return rotearHandoff({ donoCarteira: dono ?? null, pool, ultimoDoRodizio: ultimo?.responsavel_id ?? null, gestores })
}

/**
 * ARMA o SLA de um atendimento recém-transferido: prazos em minutos úteis e o
 * responsável roteado. Só arma uma vez (`sla_vence_em IS NULL`) e só se
 * ninguém assumiu ainda — atendimento com atendente não está esperando na fila.
 * Devolve o roteamento (para a notificação) ou null quando não armou.
 */
export async function armarSlaDoHandoff(
  tx: Sql, p: { atendimentoId: string; conversaId: string; canalId: string; agora: Date },
): Promise<Roteamento | null> {
  const ctx = await lerContextoSla(tx, p.canalId)
  if (!ctx) return null
  const prazos = prazosDoSla(ctx, p.agora)
  const rota = await rotearHandoffDaConversa(tx, p.conversaId, p.canalId)
  const [armado] = await tx<{ id: string }[]>`
    UPDATE atendimento
       SET sla_inicio_em = ${p.agora}, sla_vence_em = ${prazos.venceEm},
           reatribuicao_vence_em = ${prazos.reatribuicaoVenceEm}, aviso_espera_previsto_em = ${prazos.avisoPrevistoEm},
           responsavel_id = ${rota.usuarioId}
     WHERE tenant_id = tenant_atual() AND id = ${p.atendimentoId}
       AND sla_vence_em IS NULL AND estado <> 'encerrado' AND atendente_id IS NULL
    RETURNING id`
  return armado ? rota : null
}

/**
 * Fragmento SQL (alias `a` = atendimento): a 1ª resposta de GENTE na conversa
 * desde o início do SLA, ou NULL.
 * ⚠️ `enviada_por_id` separa pessoa de sistema (mesma régua de
 * `presenca-atendente.ts`): o próprio aviso de espera, o agente e a campanha
 * não têm autor e não contam como "alguém respondeu".
 */
export function respostaHumanaDoAtendimento(sql: Sql) {
  return sql`(SELECT min(m.criado_em) FROM mensagem m
               WHERE m.tenant_id = a.tenant_id AND m.conversa_id = a.conversa_id
                 AND m.direcao = 'saliente' AND m.enviada_por_id IS NOT NULL
                 AND m.criado_em >= a.sla_inicio_em)`
}

/**
 * A conversa está NA FILA? (alias `cv` = conversa) — UMA régua para o contador,
 * o filtro "Fila" do inbox e a coluna "Aguardando" do kanban.
 *
 * ⚠️ Duas formas de estar na fila:
 *   1. entrante sem atendimento aberto (a fila derivada de sempre, 0055);
 *   2. HANDOFF do agente (P18): atendimento 'na_fila' sem atendente. Antes ele
 *      sumia das duas telas — tinha atendimento aberto, então não era "fila", e
 *      não tinha etapa, então não era coluna — e o "Assumir" respondia "em
 *      atendimento por outro atendente". O SLA mede justamente esse cliente.
 */
export function fragmentoNaFila(sql: Sql) {
  return sql`(
    (cv.ultima_direcao = 'entrante' AND NOT EXISTS (
       SELECT 1 FROM atendimento a
        WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado'))
    OR EXISTS (
       SELECT 1 FROM atendimento a
        WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado = 'na_fila' AND a.atendente_id IS NULL))`
}
