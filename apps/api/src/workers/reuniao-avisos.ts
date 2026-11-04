import { randomUUID } from 'node:crypto'
import {
  ANTECEDENCIA_LEMBRETE_MS, NOSHOW_PRAZO_RESPOSTA_HORAS, NOSHOW_TOLERANCIA_MIN, calcularJanela, decidirAvisoReuniao, desfechoPendente,
  lembreteDevido, permiteTextoLivre, textoLembreteReuniao, textoReagendamento,
  type DecisaoAvisoReuniao, type TipoAvisoReuniao,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../db/index.js'
import { enviarTextoNaConversa } from '../contexts/atendimento/envio-conversa.js'
import { enviarTemplateNaConversa } from '../contexts/atendimento/envio-template.js'
import { partesLocais } from '../contexts/atendimento/expediente.js'
import { statusAquecimento } from '../contexts/atendimento/aquecimento.js'
import { lerTemplate } from '../contexts/atendimento/agente/ativas.js'
import { entregarParaHumano } from '../contexts/atendimento/agente/handoff.js'
import {
  avisarUsuario, diaLocal, lerExpedienteReuniao, noPeriodoUtil, ultimoMomentoUtilAte, type ExpedienteReuniao,
} from '../contexts/crm/reuniao.js'

/**
 * AVISOS DE REUNIÃO (raia C3, com a revisão) — agendado em `server.ts` (a cada 60 s, com guarda).
 *
 * Só para reuniões que NASCERAM NUMA CONVERSA (`evento_agenda.conversa_id`) de tenant com o módulo
 * Agenda ligado (filtrado no SQL). Quatro passos por passada:
 *
 *   1. LEMBRETES H-24 e H-2 ao CLIENTE pelo gateway — só no PERÍODO ÚTIL do número (expediente ∩
 *      08–20, M4); o H-24 adianta para o último momento útil antes de inicio−24h. Canal:
 *      `decidirAvisoReuniao` (texto na janela; template aprovado fora dela no oficial; não-oficial
 *      só texto dentro da cota de aquecimento).
 *   2. DESFECHO PENDENTE (M5): passou do fim + 2h ainda "agendada" → avisa o VENDEDOR (sino, com a
 *      preferência dele) UMA vez para marcar o desfecho. Nada vai ao cliente.
 *   3. NO-SHOW MARCADO: alguém marcou "não compareceu" → UM convite para remarcar ao cliente (no
 *      período útil); sem como convidar → direto para uma pessoa (handoff).
 *   4. PRAZO DO CONVITE: `NOSHOW_PRAZO_RESPOSTA_HORAS` depois, sem outra REUNIÃO do contato (nem o
 *      próprio evento reagendado) → handoff `reuniao_nao_compareceu`. Uma vez só.
 *   + limpeza das ofertas do agente vencidas há mais de 7 dias e não confirmadas (B6).
 *
 * ⚠️ IDEMPOTENTE por evento + tipo (+ início nos lembretes): reserva (`INSERT … ON CONFLICT DO
 *    NOTHING RETURNING`) no commit da decisão e só então envia. Os candidatos já excluem no SQL o
 *    que tem aviso (`NOT EXISTS`) e tenant sem módulo — o lote de 200 não é tomado por lixo (A4).
 * ⚠️ Transação curta: decide e reserva, envia fora dela, grava o fim.
 */
export const INTERVALO_AVISOS_REUNIAO_MS = 60_000
const LOTE = 200
/** Evento mais velho que isto não gera desfecho nem convite (ligar o módulo não acorda o passado). */
const JANELA_PASSADO_DIAS = 7
/** O H-24 pode adiantar até o período útil anterior (fim de semana + feriado): o SQL olha até aqui. */
const H24_ADIANTA_MAX_MS = 72 * 3_600_000
const MOTIVO_HANDOFF = 'reuniao_nao_compareceu'

export interface DepsAvisosReuniao {
  readonly somenteTenant?: string | undefined
  /** Restringe a uma lista de tenants (testes que provam o lote com vários tenants). */
  readonly tenants?: readonly string[] | undefined
  readonly enviarTexto?: typeof enviarTextoNaConversa | undefined
  readonly enviarTemplate?: typeof enviarTemplateNaConversa | undefined
}

export interface RelatorioAvisosReuniao {
  readonly lembretes: number
  readonly desfechos: number
  readonly noShows: number
  readonly handoffs: number
  readonly reagendados: number
}

interface Plano {
  readonly avisoId: string; readonly tenantId: string; readonly conversaId: string
  readonly decisao: Extract<DecisaoAvisoReuniao, { acao: 'texto' | 'template' }>; readonly texto: string
}

interface EventoLido {
  inicio: Date; fim: Date; criado_em: Date; status: string; conversa_id: string; canal_id: string; contato_id: string
  responsavel_id: string; contato: string | null; responsavel: string | null; tipo_canal: string; ultima_entrante_em: Date | null
  template_lembrete: string | null; template_reagendar: string | null
}

async function lerEvento(tx: Sql, id: string): Promise<EventoLido | null> {
  const [e] = await tx<EventoLido[]>`
    SELECT e.inicio, e.fim, e.criado_em, e.status, e.conversa_id, cv.canal_id, cv.contato_id, e.responsavel_id,
           c.nome AS contato, u.nome AS responsavel, cc.tipo AS tipo_canal, cv.ultima_entrante_em,
           ac.agenda_template_lembrete AS template_lembrete, ac.agenda_template_reagendar AS template_reagendar
      FROM evento_agenda e
      JOIN conversa cv ON cv.tenant_id = e.tenant_id AND cv.id = e.conversa_id
      JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
      LEFT JOIN contato c ON c.tenant_id = e.tenant_id AND c.id = e.contato_id
      LEFT JOIN usuario u ON u.tenant_id = e.tenant_id AND u.id = e.responsavel_id
      LEFT JOIN agente_config ac ON ac.tenant_id = cv.tenant_id AND ac.canal_id = cv.canal_id
     WHERE e.tenant_id = tenant_atual() AND e.id = ${id}
     FOR UPDATE OF e`
  return e ?? null
}

/** Como o aviso sai (texto/template/recusa) para ESTE evento agora. */
async function decidir(tx: Sql, e: EventoLido, templateId: string | null, agora: Date): Promise<DecisaoAvisoReuniao> {
  const tpl = templateId ? await lerTemplate(tx, templateId) : null
  const aq = e.tipo_canal === 'whatsapp_nao_oficial' ? await statusAquecimento(tx, e.canal_id, agora) : null
  return decidirAvisoReuniao({
    tipoCanal: e.tipo_canal,
    janelaAberta: permiteTextoLivre(calcularJanela(e.ultima_entrante_em, agora)),
    template: tpl ? { id: tpl.id, aprovado: tpl.status === 'APPROVED', compativel: tpl.compativel } : null,
    aquecimentoRestante: aq ? aq.restante : Infinity,
  })
}

/** Reserva o aviso (a idempotência). `null` = já existia — outra passada cuidou. */
async function reservar(tx: Sql, eventoId: string, tipo: TipoAvisoReuniao, inicio: Date, canalId: string): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO evento_agenda_aviso (tenant_id, id, evento_id, tipo, inicio_evento, canal_id)
    VALUES (tenant_atual(), ${randomUUID()}, ${eventoId}, ${tipo}, ${inicio}, ${canalId})
    ON CONFLICT DO NOTHING RETURNING id`
  return r?.id ?? null
}

/** B7: a via é gravada JÁ na reserva — o aviso 'pendente' em texto conta na cota de aquecimento. */
const marcarVia = (tx: Sql, avisoId: string, via: 'texto' | 'template') =>
  tx`UPDATE evento_agenda_aviso SET via = ${via} WHERE tenant_id = tenant_atual() AND id = ${avisoId}`

const horaLocal = (instante: Date, exp: ExpedienteReuniao): { dia: string; hora: string } => {
  const p = partesLocais(instante, exp.fuso)
  return { dia: p.data, hora: p.hora }
}
const ddmm = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`

async function sessaoAtiva(tx: Sql, conversaId: string): Promise<string | null> {
  const [s] = await tx<{ id: string }[]>`
    SELECT id FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'ativa' LIMIT 1`
  return s?.id ?? null
}

async function enviar(p: Plano, agora: Date, deps: DepsAvisosReuniao, marcador: string) {
  return p.decisao.acao === 'template'
    ? (deps.enviarTemplate ?? enviarTemplateNaConversa)(p.tenantId, p.conversaId, p.decisao.templateId, agora, { marcador, ehDisparo: true })
    : (deps.enviarTexto ?? enviarTextoNaConversa)(p.tenantId, p.conversaId, p.texto, null, agora, { marcador, ehDisparo: true })
}

async function concluirEnvio(tenantId: string, p: Plano, r: Awaited<ReturnType<typeof enviar>>, estadoOk: 'enviado' | 'aguardando', agora: Date): Promise<'ok' | 'opt_out' | 'falha'> {
  const optOut = !r.ok && r.motivo === 'bloqueado'
  const estado = r.ok ? estadoOk : optOut ? 'recusado' : estadoOk === 'aguardando' ? 'handoff' : 'recusado'
  await comTenantServico(tenantId, (tx) => tx`
    UPDATE evento_agenda_aviso SET estado = ${estado}, motivo = ${r.ok ? null : r.motivo},
           mensagem_id = ${r.ok ? r.mensagemId : r.mensagemId ?? null}, concluido_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${p.avisoId}`)
  return r.ok ? 'ok' : optOut ? 'opt_out' : 'falha'
}

export async function processarAvisosDeReuniao(
  dono: Sql, agora: Date = new Date(), deps: DepsAvisosReuniao = {},
): Promise<RelatorioAvisosReuniao> {
  const so = deps.somenteTenant
  const filtro = (col: ReturnType<Sql['unsafe']>) => so ? dono`${col} = ${so}` : deps.tenants ? dono`${col} = ANY(${[...deps.tenants]}::uuid[])` : dono`true`
  const moduloLigado = dono`EXISTS (SELECT 1 FROM tenant_modulo tm WHERE tm.tenant_id = e.tenant_id AND tm.modulo = 'agenda' AND tm.ativo)`
  const semAviso = (tipo: TipoAvisoReuniao, porInicio: boolean) => dono`NOT EXISTS (
    SELECT 1 FROM evento_agenda_aviso a WHERE a.tenant_id = e.tenant_id AND a.evento_id = e.id AND a.tipo = ${tipo}
       AND ${porInicio ? dono`a.inicio_evento = e.inicio` : dono`true`})`
  const h = (ms: number) => new Date(agora.getTime() + ms)
  let lembretes = 0; let desfechos = 0; let noShows = 0; let handoffs = 0; let reagendados = 0

  // ── 1. lembretes (A4: janela própria de cada tipo, sem aviso devido, módulo ligado) ──────
  const proximos = await dono<{ tenant_id: string; id: string }[]>`
    SELECT e.tenant_id, e.id FROM evento_agenda e
     WHERE e.conversa_id IS NOT NULL AND e.status = 'agendado' AND ${moduloLigado} AND ${filtro(dono.unsafe('e.tenant_id'))}
       AND ((e.inicio > ${h(ANTECEDENCIA_LEMBRETE_MS.h2)} AND e.inicio <= ${h(ANTECEDENCIA_LEMBRETE_MS.h24 + H24_ADIANTA_MAX_MS)}
             AND e.criado_em <= e.inicio - interval '24 hours' AND ${semAviso('h24', true)})
         OR (e.inicio > ${agora} AND e.inicio <= ${h(ANTECEDENCIA_LEMBRETE_MS.h2)}
             AND e.criado_em <= e.inicio - interval '2 hours' AND ${semAviso('h2', true)}))
     ORDER BY e.inicio LIMIT ${LOTE}`
  for (const c of proximos) {
    const plano = await comTenantServico(c.tenant_id, async (tx): Promise<Plano | null> => {
      const e = await lerEvento(tx, c.id)
      if (!e) return null
      const exp = await lerExpedienteReuniao(tx, e.canal_id)
      const tipo = lembreteDevido({ inicio: e.inicio, criadoEm: e.criado_em, status: e.status }, agora, {
        pontoH24: ultimoMomentoUtilAte(exp, new Date(e.inicio.getTime() - ANTECEDENCIA_LEMBRETE_MS.h24)),
        agoraUtil: noPeriodoUtil(exp, agora),
      })
      if (!tipo) return null
      const avisoId = await reservar(tx, c.id, tipo, e.inicio, e.canal_id)
      if (!avisoId) return null
      const decisao = await decidir(tx, e, e.template_lembrete, agora)
      if (decisao.acao === 'recusar') {
        await tx`UPDATE evento_agenda_aviso SET estado = 'recusado', motivo = ${decisao.motivo}, concluido_em = ${agora}
                  WHERE tenant_id = tenant_atual() AND id = ${avisoId}`
        return null
      }
      await marcarVia(tx, avisoId, decisao.acao)
      const { dia, hora } = horaLocal(e.inicio, exp)
      return {
        avisoId, tenantId: c.tenant_id, conversaId: e.conversa_id, decisao,
        texto: textoLembreteReuniao({ contato: e.contato, dia, hoje: diaLocal(agora, exp.fuso), hora, responsavel: e.responsavel }),
      }
    })
    if (!plano) continue
    if ((await concluirEnvio(c.tenant_id, plano, await enviar(plano, agora, deps, 'agenda_lembrete'), 'enviado', agora)) === 'ok') lembretes++
  }

  // ── 2. desfecho pendente: avisa o VENDEDOR, nunca o cliente (M5) ─────────────────────────
  const semDesfecho = await dono<{ tenant_id: string; id: string }[]>`
    SELECT e.tenant_id, e.id FROM evento_agenda e
     WHERE e.conversa_id IS NOT NULL AND e.status = 'agendado' AND ${moduloLigado} AND ${filtro(dono.unsafe('e.tenant_id'))}
       AND e.fim <= ${h(-NOSHOW_TOLERANCIA_MIN * 60_000)} AND e.fim > ${h(-JANELA_PASSADO_DIAS * 86_400_000)}
       AND ${semAviso('desfecho', true)}
     ORDER BY e.fim LIMIT ${LOTE}`
  for (const c of semDesfecho) {
    const ok = await comTenantServico(c.tenant_id, async (tx) => {
      const e = await lerEvento(tx, c.id)
      if (!e || !desfechoPendente({ fim: e.fim, status: e.status }, agora)) return false
      const avisoId = await reservar(tx, c.id, 'desfecho', e.inicio, e.canal_id)
      if (!avisoId) return false
      const exp = await lerExpedienteReuniao(tx, e.canal_id)
      const { dia, hora } = horaLocal(e.inicio, exp)
      await avisarUsuario(tx, e.responsavel_id, 'agenda.lembrete',
        `Como foi a reunião com ${e.contato ?? 'o cliente'} (${ddmm(dia)} às ${hora})? Marque se foi realizada ou se o cliente não compareceu.`)
      await tx`UPDATE evento_agenda_aviso SET estado = 'avisado', concluido_em = ${agora} WHERE tenant_id = tenant_atual() AND id = ${avisoId}`
      return true
    })
    if (ok) desfechos++
  }

  // ── 3. no-show MARCADO: um convite para remarcar ─────────────────────────────────────────
  const marcados = await dono<{ tenant_id: string; id: string }[]>`
    SELECT e.tenant_id, e.id FROM evento_agenda e
     WHERE e.conversa_id IS NOT NULL AND e.status = 'nao_compareceu' AND ${moduloLigado} AND ${filtro(dono.unsafe('e.tenant_id'))}
       AND e.fim > ${h(-JANELA_PASSADO_DIAS * 86_400_000)} AND ${semAviso('noshow', false)}
     ORDER BY e.fim LIMIT ${LOTE}`
  for (const c of marcados) {
    const plano = await comTenantServico(c.tenant_id, async (tx): Promise<Plano | null> => {
      const e = await lerEvento(tx, c.id)
      if (!e || e.status !== 'nao_compareceu') return null
      const exp = await lerExpedienteReuniao(tx, e.canal_id)
      const decisao = await decidir(tx, e, e.template_reagendar, agora)
      // M4: fala com o cliente só no período útil — fora dele, espera (sem reservar).
      if (decisao.acao !== 'recusar' && !noPeriodoUtil(exp, agora)) return null
      const avisoId = await reservar(tx, c.id, 'noshow', e.inicio, e.canal_id)
      if (!avisoId) return null
      noShows++
      const { dia, hora } = horaLocal(e.inicio, exp)
      if (decisao.acao === 'recusar') {
        // Sem como convidar: vai direto para uma pessoa (que liga ou manda template na mão).
        await tx`UPDATE evento_agenda_aviso SET estado = 'handoff', motivo = ${decisao.motivo}, concluido_em = ${agora}
                  WHERE tenant_id = tenant_atual() AND id = ${avisoId}`
        await entregarParaHumano(tx, {
          conversaId: e.conversa_id, canalId: e.canal_id, sessaoId: await sessaoAtiva(tx, e.conversa_id), motivo: MOTIVO_HANDOFF,
          resumo: `O cliente não compareceu à reunião de ${ddmm(dia)} às ${hora} e não deu para convidar a remarcar (${decisao.motivo}).`, agora,
        })
        handoffs++
        return null
      }
      await marcarVia(tx, avisoId, decisao.acao)
      return { avisoId, tenantId: c.tenant_id, conversaId: e.conversa_id, decisao, texto: textoReagendamento({ contato: e.contato, dia, hora }) }
    })
    if (!plano) continue
    const res = await concluirEnvio(c.tenant_id, plano, await enviar(plano, agora, deps, 'agenda_reagendamento'), 'aguardando', agora)
    if (res === 'falha') {
      await comTenantServico(c.tenant_id, async (tx) => {
        const [cv] = await tx<{ canal_id: string }[]>`SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${plano.conversaId}`
        await entregarParaHumano(tx, {
          conversaId: plano.conversaId, canalId: cv?.canal_id ?? '', sessaoId: await sessaoAtiva(tx, plano.conversaId),
          motivo: MOTIVO_HANDOFF, resumo: 'O cliente não compareceu à reunião e o convite para remarcar não saiu.', agora,
        })
      })
      handoffs++
    }
  }

  // ── 4. prazo do convite: remarcou (B1: só REUNIÃO, inclusive o próprio evento) ou vai a uma pessoa ──
  const vencidos = await dono<{ tenant_id: string; id: string }[]>`
    SELECT a.tenant_id, a.id FROM evento_agenda_aviso a
     WHERE a.tipo = 'noshow' AND a.estado = 'aguardando'
       AND a.criado_em <= ${h(-NOSHOW_PRAZO_RESPOSTA_HORAS * 3_600_000)} AND ${filtro(dono.unsafe('a.tenant_id'))}
     ORDER BY a.criado_em LIMIT ${LOTE}`
  for (const c of vencidos) {
    const r = await comTenantServico(c.tenant_id, async (tx) => {
      // ⚠️ Reserva do desfecho: só uma passada sai de 'aguardando' (UPDATE … RETURNING).
      const [a] = await tx<{ evento_id: string; criado_em: Date }[]>`
        UPDATE evento_agenda_aviso SET estado = 'handoff'
         WHERE tenant_id = tenant_atual() AND id = ${c.id} AND estado = 'aguardando'
        RETURNING evento_id, criado_em`
      if (!a) return null
      const [e] = await tx<{ contato_id: string | null; conversa_id: string | null; canal_id: string | null; inicio: Date }[]>`
        SELECT e.contato_id, e.conversa_id, e.canal_id, e.inicio FROM evento_agenda e
         WHERE e.tenant_id = tenant_atual() AND e.id = ${a.evento_id}`
      if (!e?.conversa_id) return null
      const [remarcou] = await tx`
        SELECT 1 FROM evento_agenda x
         WHERE x.tenant_id = tenant_atual() AND x.tipo = 'reuniao' AND x.status IN ('agendado', 'realizado')
           AND ((x.id = ${a.evento_id} AND x.inicio > ${a.criado_em})
                OR (x.id <> ${a.evento_id} AND x.contato_id = ${e.contato_id} AND x.criado_em > ${a.criado_em}))
         LIMIT 1`
      if (remarcou) {
        await tx`UPDATE evento_agenda_aviso SET estado = 'reagendado' WHERE tenant_id = tenant_atual() AND id = ${c.id}`
        return 'reagendado' as const
      }
      const exp = await lerExpedienteReuniao(tx, e.canal_id)
      const { dia, hora } = horaLocal(e.inicio, exp)
      const [cv] = await tx<{ canal_id: string }[]>`SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${e.conversa_id}`
      await entregarParaHumano(tx, {
        conversaId: e.conversa_id, canalId: cv?.canal_id ?? '', sessaoId: await sessaoAtiva(tx, e.conversa_id), motivo: MOTIVO_HANDOFF,
        resumo: `O cliente não compareceu à reunião de ${ddmm(dia)} às ${hora} e não remarcou em ${NOSHOW_PRAZO_RESPOSTA_HORAS} h depois do convite.`, agora,
      })
      return 'handoff' as const
    })
    if (r === 'reagendado') reagendados++
    if (r === 'handoff') handoffs++
  }

  // ── B6: ofertas do agente vencidas há mais de 7 dias e nunca confirmadas ──────────────────
  await dono`
    DELETE FROM reuniao_oferta WHERE ctid IN (
      SELECT ctid FROM reuniao_oferta
       WHERE confirmada_em IS NULL AND expira_em < ${h(-JANELA_PASSADO_DIAS * 86_400_000)} AND ${filtro(dono.unsafe('tenant_id'))}
       LIMIT ${LOTE})`
  return { lembretes, desfechos, noShows, handoffs, reagendados }
}
