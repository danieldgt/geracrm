import { randomUUID } from 'node:crypto'
import {
  ANTECEDENCIA_LEMBRETE_MS, NOSHOW_PRAZO_RESPOSTA_HORAS, calcularJanela, decidirAvisoReuniao, lembreteDevido, noShowDevido,
  permiteTextoLivre, textoLembreteReuniao, textoReagendamento,
  type DecisaoAvisoReuniao, type TipoAvisoReuniao,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../db/index.js'
import { enviarTextoNaConversa } from '../contexts/atendimento/envio-conversa.js'
import { enviarTemplateNaConversa } from '../contexts/atendimento/envio-template.js'
import { partesLocais } from '../contexts/atendimento/expediente.js'
import { statusAquecimento } from '../contexts/atendimento/aquecimento.js'
import { lerTemplate } from '../contexts/atendimento/agente/ativas.js'
import { entregarParaHumano } from '../contexts/atendimento/agente/handoff.js'
import { moduloAtivo } from '../contexts/plataforma/modulos.js'
import { fusoSeguro } from '../contexts/plataforma/fuso.js'

/**
 * AVISOS DE REUNIÃO AO CLIENTE (raia C3) — agendado em `server.ts` (a cada 60 s, com guarda).
 *
 * Só para reuniões que NASCERAM NUMA CONVERSA (`evento_agenda.conversa_id`: botão do inbox ou
 * agente) e só com o módulo Agenda ligado. Três passos por passada:
 *
 *   1. LEMBRETES H-24 e H-2 (`lembreteDevido`, puro) pelo GATEWAY: no oficial dentro da janela
 *      e no não-oficial, texto com data e hora; no oficial fora da janela, SÓ o template aprovado
 *      do número (`agente_config.agenda_template_lembrete`), senão recusa nomeada; no não-oficial,
 *      só dentro da cota de aquecimento do dia (`decidirAvisoReuniao`).
 *   2. NO-SHOW (`noShowDevido`): o evento passou sem "realizado" → vira "não compareceu" e o
 *      cliente recebe UM convite para remarcar (mesma régua de canal; template próprio). Sem
 *      como convidar (sem template, janela, cota, falha), vai direto para uma pessoa.
 *   3. PRAZO DO NO-SHOW: `NOSHOW_PRAZO_RESPOSTA_HORAS` depois do convite, se o contato não ganhou
 *      outra reunião → handoff (`entregarParaHumano`, motivo `reuniao_nao_compareceu`).
 *
 * ⚠️ IDEMPOTENTE por evento + tipo: o aviso é RESERVADO (`INSERT … ON CONFLICT DO NOTHING
 *    RETURNING`, chaves únicas da 0137) no mesmo commit da decisão e só então enviado. Duas
 *    passadas (ou duas instâncias) nunca mandam duas vezes; um processo que cai entre a reserva
 *    e o envio deixa 'pendente' — nunca repete. Lembrete por (evento, tipo, início): reagendar
 *    rearma. No-show UMA vez por evento.
 * ⚠️ Transação curta: nada de rede com transação aberta — decide e reserva, envia, grava o fim.
 */
export const INTERVALO_AVISOS_REUNIAO_MS = 60_000
const LOTE = 200
/** No-show de evento mais velho que isto não é tratado (ex.: ligar o módulo não acorda o passado). */
const NOSHOW_JANELA_DIAS = 7
const MOTIVO_HANDOFF = 'reuniao_nao_compareceu'

export interface DepsAvisosReuniao {
  readonly somenteTenant?: string | undefined
  readonly enviarTexto?: typeof enviarTextoNaConversa | undefined
  readonly enviarTemplate?: typeof enviarTemplateNaConversa | undefined
}

export interface RelatorioAvisosReuniao {
  readonly lembretes: number
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
  contato: string | null; responsavel: string | null; tipo_canal: string; ultima_entrante_em: Date | null; fuso: string | null
  template_lembrete: string | null; template_reagendar: string | null
}

async function lerEvento(tx: Sql, id: string): Promise<EventoLido | null> {
  const [e] = await tx<EventoLido[]>`
    SELECT e.inicio, e.fim, e.criado_em, e.status, e.conversa_id, cv.canal_id, cv.contato_id, c.nome AS contato, u.nome AS responsavel,
           cc.tipo AS tipo_canal, cv.ultima_entrante_em, t.fuso,
           ac.agenda_template_lembrete AS template_lembrete, ac.agenda_template_reagendar AS template_reagendar
      FROM evento_agenda e
      JOIN conversa cv ON cv.tenant_id = e.tenant_id AND cv.id = e.conversa_id
      JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
      JOIN tenant t ON t.id = e.tenant_id
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

const dataHora = (instante: Date, fuso: string | null): { data: string; hora: string } => {
  const p = partesLocais(instante, fusoSeguro(fuso))
  return { data: `${p.data.slice(8, 10)}/${p.data.slice(5, 7)}`, hora: p.hora }
}

/** A sessão ativa do agente na conversa (o handoff a encerra). */
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

export async function processarAvisosDeReuniao(
  dono: Sql, agora: Date = new Date(), deps: DepsAvisosReuniao = {},
): Promise<RelatorioAvisosReuniao> {
  const so = deps.somenteTenant
  const filtro = so ? dono`e.tenant_id = ${so}` : dono`true`
  let lembretes = 0; let noShows = 0; let handoffs = 0; let reagendados = 0

  // ── 1. lembretes ───────────────────────────────────────────────────────────
  const proximos = await dono<{ tenant_id: string; id: string }[]>`
    SELECT e.tenant_id, e.id FROM evento_agenda e
     WHERE e.conversa_id IS NOT NULL AND e.status = 'agendado'
       AND e.inicio > ${agora} AND e.inicio <= ${new Date(agora.getTime() + ANTECEDENCIA_LEMBRETE_MS.h24)}
       AND ${filtro}
     ORDER BY e.inicio LIMIT ${LOTE}`
  for (const c of proximos) {
    const plano = await comTenantServico(c.tenant_id, async (tx): Promise<Plano | null> => {
      if (!(await moduloAtivo(tx, 'agenda'))) return null
      const e = await lerEvento(tx, c.id)
      if (!e) return null
      const tipo = lembreteDevido({ inicio: e.inicio, criadoEm: e.criado_em, status: e.status }, agora)
      if (!tipo) return null
      const avisoId = await reservar(tx, c.id, tipo, e.inicio, e.canal_id)
      if (!avisoId) return null
      const decisao = await decidir(tx, e, e.template_lembrete, agora)
      if (decisao.acao === 'recusar') {
        await tx`UPDATE evento_agenda_aviso SET estado = 'recusado', motivo = ${decisao.motivo}, concluido_em = ${agora}
                  WHERE tenant_id = tenant_atual() AND id = ${avisoId}`
        return null
      }
      const { data, hora } = dataHora(e.inicio, e.fuso)
      return { avisoId, tenantId: c.tenant_id, conversaId: e.conversa_id, decisao, texto: textoLembreteReuniao({ tipo, contato: e.contato, data, hora, responsavel: e.responsavel }) }
    })
    if (!plano) continue
    const r = await enviar(plano, agora, deps, 'agenda_lembrete')
    await comTenantServico(c.tenant_id, (tx) => tx`
      UPDATE evento_agenda_aviso SET estado = ${r.ok ? 'enviado' : 'recusado'}, via = ${plano.decisao.acao},
             motivo = ${r.ok ? null : r.motivo}, mensagem_id = ${r.ok ? r.mensagemId : r.mensagemId ?? null}, concluido_em = ${agora}
       WHERE tenant_id = tenant_atual() AND id = ${plano.avisoId}`)
    if (r.ok) lembretes++
  }

  // ── 2. no-show: um convite para remarcar ──────────────────────────────────
  const passados = await dono<{ tenant_id: string; id: string }[]>`
    SELECT e.tenant_id, e.id FROM evento_agenda e
     WHERE e.conversa_id IS NOT NULL AND e.status IN ('agendado', 'nao_compareceu')
       AND e.fim <= ${agora} AND e.fim > ${new Date(agora.getTime() - NOSHOW_JANELA_DIAS * 86_400_000)}
       AND NOT EXISTS (SELECT 1 FROM evento_agenda_aviso a WHERE a.tenant_id = e.tenant_id AND a.evento_id = e.id AND a.tipo = 'noshow')
       AND ${filtro}
     ORDER BY e.fim LIMIT ${LOTE}`
  for (const c of passados) {
    const plano = await comTenantServico(c.tenant_id, async (tx): Promise<Plano | null> => {
      if (!(await moduloAtivo(tx, 'agenda'))) return null
      const e = await lerEvento(tx, c.id)
      if (!e || !noShowDevido({ fim: e.fim, status: e.status }, agora)) return null
      const avisoId = await reservar(tx, c.id, 'noshow', e.inicio, e.canal_id)
      if (!avisoId) return null
      noShows++
      if (e.status === 'agendado') {
        await tx`UPDATE evento_agenda SET status = 'nao_compareceu', atualizado_em = now(), versao = versao + 1
                  WHERE tenant_id = tenant_atual() AND id = ${c.id}`
      }
      const { data, hora } = dataHora(e.inicio, e.fuso)
      const decisao = await decidir(tx, e, e.template_reagendar, agora)
      if (decisao.acao === 'recusar') {
        // Sem como convidar: vai direto para uma pessoa (que liga ou manda template na mão).
        await tx`UPDATE evento_agenda_aviso SET estado = 'handoff', motivo = ${decisao.motivo}, concluido_em = ${agora}
                  WHERE tenant_id = tenant_atual() AND id = ${avisoId}`
        await entregarParaHumano(tx, {
          conversaId: e.conversa_id, canalId: e.canal_id, sessaoId: await sessaoAtiva(tx, e.conversa_id), motivo: MOTIVO_HANDOFF,
          resumo: `O cliente não compareceu à reunião de ${data} às ${hora} e não deu para convidar a remarcar (${decisao.motivo}).`, agora,
        })
        handoffs++
        return null
      }
      return { avisoId, tenantId: c.tenant_id, conversaId: e.conversa_id, decisao, texto: textoReagendamento({ contato: e.contato, data, hora }) }
    })
    if (!plano) continue
    const r = await enviar(plano, agora, deps, 'agenda_reagendamento')
    const foiHandoff = await comTenantServico(c.tenant_id, async (tx) => {
      // Opt-out: não insiste nem passa adiante como "remarcar" — o cliente pediu para não receber.
      const optOut = !r.ok && r.motivo === 'bloqueado'
      const estado = r.ok ? 'aguardando' : optOut ? 'recusado' : 'handoff'
      await tx`UPDATE evento_agenda_aviso SET estado = ${estado}, via = ${plano.decisao.acao}, motivo = ${r.ok ? null : r.motivo},
                      mensagem_id = ${r.ok ? r.mensagemId : r.mensagemId ?? null}, concluido_em = ${agora}
                WHERE tenant_id = tenant_atual() AND id = ${plano.avisoId}`
      if (estado !== 'handoff') return false
      await entregarParaHumano(tx, {
        conversaId: plano.conversaId, canalId: (await canalDaConversa(tx, plano.conversaId)) ?? '', sessaoId: await sessaoAtiva(tx, plano.conversaId),
        motivo: MOTIVO_HANDOFF, resumo: `O cliente não compareceu à reunião e o convite para remarcar não saiu (${r.ok ? '' : r.motivo}).`, agora,
      })
      return true
    })
    if (foiHandoff) handoffs++
  }

  // ── 3. prazo do no-show: remarcou ou vai para uma pessoa ─────────────────
  const vencidos = await dono<{ tenant_id: string; id: string }[]>`
    SELECT a.tenant_id, a.id FROM evento_agenda_aviso a
     WHERE a.tipo = 'noshow' AND a.estado = 'aguardando'
       AND a.criado_em <= ${new Date(agora.getTime() - NOSHOW_PRAZO_RESPOSTA_HORAS * 3_600_000)}
       AND ${so ? dono`a.tenant_id = ${so}` : dono`true`}
     ORDER BY a.criado_em LIMIT ${LOTE}`
  for (const c of vencidos) {
    const r = await comTenantServico(c.tenant_id, async (tx) => {
      // ⚠️ Reserva do desfecho: só uma passada sai de 'aguardando' (UPDATE … RETURNING).
      const [a] = await tx<{ evento_id: string; criado_em: Date }[]>`
        UPDATE evento_agenda_aviso SET estado = 'handoff'
         WHERE tenant_id = tenant_atual() AND id = ${c.id} AND estado = 'aguardando'
        RETURNING evento_id, criado_em`
      if (!a) return null
      const [e] = await tx<{ contato_id: string | null; conversa_id: string | null; inicio: Date; fuso: string | null }[]>`
        SELECT e.contato_id, e.conversa_id, e.inicio, t.fuso FROM evento_agenda e JOIN tenant t ON t.id = e.tenant_id
         WHERE e.tenant_id = tenant_atual() AND e.id = ${a.evento_id}`
      if (!e?.conversa_id) return null
      const [novo] = await tx`
        SELECT 1 FROM evento_agenda WHERE tenant_id = tenant_atual() AND contato_id = ${e.contato_id}
           AND id <> ${a.evento_id} AND status IN ('agendado', 'realizado') AND criado_em > ${a.criado_em} LIMIT 1`
      if (novo) {
        await tx`UPDATE evento_agenda_aviso SET estado = 'reagendado' WHERE tenant_id = tenant_atual() AND id = ${c.id}`
        return 'reagendado' as const
      }
      const { data, hora } = dataHora(e.inicio, e.fuso)
      await entregarParaHumano(tx, {
        conversaId: e.conversa_id, canalId: (await canalDaConversa(tx, e.conversa_id)) ?? '', sessaoId: await sessaoAtiva(tx, e.conversa_id),
        motivo: MOTIVO_HANDOFF,
        resumo: `O cliente não compareceu à reunião de ${data} às ${hora} e não remarcou em ${NOSHOW_PRAZO_RESPOSTA_HORAS} h depois do convite.`, agora,
      })
      return 'handoff' as const
    })
    if (r === 'reagendado') reagendados++
    if (r === 'handoff') handoffs++
  }
  return { lembretes, noShows, handoffs, reagendados }
}

async function canalDaConversa(tx: Sql, conversaId: string): Promise<string | null> {
  const [c] = await tx<{ canal_id: string }[]>`SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
  return c?.canal_id ?? null
}
