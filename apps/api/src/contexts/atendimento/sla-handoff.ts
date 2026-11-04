import { SLA_PADRAO, normalizarFeriados, rotearHandoff, type ConfigSla, type PessoaRoteavel, type Roteamento } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import type { HorarioAtendimento } from './expediente.js'
import { somarMinutosUteis } from './minutos-uteis.js'
import { elegiveisDaFilial, filialDoContato, gestoresDaFilial, gravarRodizio, travarRodizio } from './roteamento.js'

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

/**
 * Monta a entrada de `rotearHandoff` e decide (P18 + G4):
 *   dono da carteira → vendedores da FILIAL roteada do contato em rodízio (que
 *   atendem o número) → pool do número em rodízio → gestor da filial → gestor.
 *
 * ⚠️ Com filial e vendedores, o ponteiro do rodízio da filial fica TRAVADO até o
 *    fim da transação (`travarRodizio`); quem grava o escolhido é
 *    `armarSlaDoHandoff`, SÓ se o SLA armou — handoff repetido não gasta a vez.
 */
export async function rotearHandoffDaConversa(tx: Sql, conversaId: string, canalId: string): Promise<Roteamento> {
  const [conv] = await tx<{ contato_id: string }[]>`
    SELECT contato_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
  const [dono] = await tx<PessoaRoteavel[]>`
    SELECT u.id, u.ativo, u.ausente
      FROM carteira_atribuicao ca
      JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
     WHERE ca.tenant_id = tenant_atual() AND ca.contato_id = ${conv?.contato_id ?? null}::uuid AND ca.ate IS NULL
     LIMIT 1`
  // Dono disponível decide sozinho: nada de filial, pool ou trava.
  if (dono && dono.ativo && !dono.ausente) {
    return rotearHandoff({ donoCarteira: dono, pool: [], ultimoDoRodizio: null, gestores: [] })
  }

  const filial = conv ? await filialDoContato(tx, conv.contato_id, canalId) : null
  let daFilial: NonNullable<EntradaFilial> | null = null
  if (filial?.filialId) {
    const vendedores = await elegiveisDaFilial(tx, filial.filialId, canalId, 'handoff')
    daFilial = {
      id: filial.filialId,
      vendedores,
      ultimoDoRodizio: vendedores.length > 0 ? await travarRodizio(tx, filial.filialId, 'handoff') : null,
      gestores: await gestoresDaFilial(tx, filial.filialId),
    }
  }

  const pool = await poolDoNumero(tx, canalId)
  const ids = pool.map((p) => p.id)
  const [ultimo] = ids.length === 0 ? [] : await tx<{ responsavel_id: string }[]>`
    SELECT responsavel_id FROM atendimento
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND responsavel_id IS NOT NULL
       AND responsavel_id IN ${tx(ids)}
     ORDER BY sla_inicio_em DESC NULLS LAST LIMIT 1`
  const gestores = await gestoresDoTenant(tx)
  return rotearHandoff({
    donoCarteira: dono ?? null, filial: daFilial, pool, ultimoDoRodizio: ultimo?.responsavel_id ?? null, gestores,
  })
}
type EntradaFilial = Parameters<typeof rotearHandoff>[0]['filial']

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
           responsavel_id = ${rota.usuarioId},
           responsavel_origem = ${rota.destino === 'ninguem' ? null : rota.destino},
           responsavel_filial_id = ${rota.filialId ?? null}
     WHERE tenant_id = tenant_atual() AND id = ${p.atendimentoId}
       AND sla_vence_em IS NULL AND estado <> 'encerrado' AND atendente_id IS NULL
    RETURNING id`
  // G4: a vez da filial só é gasta quando o handoff de fato armou para ela.
  if (armado && rota.destino === 'filial' && rota.filialId && rota.usuarioId) {
    await gravarRodizio(tx, rota.filialId, 'handoff', rota.usuarioId)
  }
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
 * A conversa NÃO é a do playground (alias `cv` = conversa). O playground conversa
 * com o "Cliente de simulação" (`contato.origem_carga = 'simulacao'`, um por
 * canal — rotas-agente `/simular`) num canal real: sem este corte, o teste do
 * admin aparecia para a operação no trilho, no inbox, no kanban e nos contadores.
 * Mesmo marcador que o painel de fase (go-live) usa para medir a homologação.
 */
export function fragmentoForaDaSimulacao(sql: Sql) {
  return sql`NOT EXISTS (
    SELECT 1 FROM contato sim
     WHERE sim.tenant_id = cv.tenant_id AND sim.id = cv.contato_id AND sim.origem_carga = 'simulacao')`
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
 *      ⚠️ Só enquanto ESPERA: o cliente falou por último, ou o SLA está armado e
 *      ninguém respondeu. Handoff legado (sem SLA) já respondido e handoff
 *      respondido direto pelo inbox, sem Assumir, saem da fila.
 */
export function fragmentoNaFila(sql: Sql) {
  return sql`${fragmentoForaDaSimulacao(sql)} AND (
    (cv.ultima_direcao = 'entrante' AND NOT EXISTS (
       SELECT 1 FROM atendimento a
        WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado'))
    OR EXISTS (
       SELECT 1 FROM atendimento a
        WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado = 'na_fila' AND a.atendente_id IS NULL
          AND (cv.ultima_direcao = 'entrante' OR (a.sla_vence_em IS NOT NULL AND a.sla_respondido_em IS NULL))))`
}

/**
 * Quem o handoff ainda esperando deve avisar, pela MESMA regra do roteamento
 * (P18): rota 'gestor' avisa TODOS os gestores, 'gestor_filial' os gestores da
 * filial (G4); dono da carteira / filial / pool avisam o responsável — se ele
 * ainda estiver ativo e disponível. `null` = sem regra (sem handoff roteado,
 * reatribuição já liberada ou responsável fora): quem chama cai na fila do
 * número, como antes.
 */
export async function alvosDoHandoff(tx: Sql, conversaId: string): Promise<string[] | null> {
  const [a] = await tx<{ responsavel_id: string; origem: string | null; filial_id: string | null; disponivel: boolean }[]>`
    SELECT a.responsavel_id, a.responsavel_origem AS origem, a.responsavel_filial_id AS filial_id,
           (u.ativo AND NOT u.ausente) AS disponivel
      FROM atendimento a
      JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.responsavel_id
     WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId} AND a.estado = 'na_fila'
       AND a.atendente_id IS NULL AND a.reatribuicao_liberada_em IS NULL
     LIMIT 1`
  if (!a) return null
  if (a.origem === 'gestor') {
    const gestores = (await gestoresDoTenant(tx)).filter((g) => !g.ausente).map((g) => g.id)
    return gestores.length > 0 ? gestores : null
  }
  // G4: rota 'gestor_filial' avisa os gestores DA FILIAL (disponíveis), como a 'gestor' avisa todos.
  if (a.origem === 'gestor_filial' && a.filial_id) {
    const daFilial = (await gestoresDaFilial(tx, a.filial_id)).filter((g) => !g.ausente).map((g) => g.id)
    if (daFilial.length > 0) return daFilial
  }
  return a.disponivel ? [a.responsavel_id] : null
}
