import { randomUUID } from 'node:crypto'
import {
  ANTECEDENCIA_MIN_REUNIAO, candidatosDoDia, faixaDeReuniao, normalizarFeriados, periodosSobrepoem,
  type HorarioLivre, type HorarioSemanal, type ModalidadeEvento, type RespostaHorariosLivres, type VendedorParaReuniao,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { ehFeriado, instanteLocal, partesLocais } from '../atendimento/expediente.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { naoEhLinhaDeStaff } from '../identidade/linha-staff.js'
import { acharConflito } from './rotas-agenda.js'
import { algumCanal, canaisDosUsuarios } from '../plataforma/preferencia-notificacao.js'

/**
 * REUNIÃO MARCADA PELO CRM E PELO AGENTE (raia C3) — o lado com banco. As regras são puras
 * (shared `agenda-reuniao.ts`); aqui só se lê o que elas precisam e se grava o resultado.
 * Tudo sob `tenant_atual()` (ADR-001). Quem chama já conferiu o módulo Agenda e, na
 * requisição humana, o escopo — o agente (máquina) não passa pelo escopo (`escopo.ts`).
 *
 * Um caso de uso só para os dois caminhos (`agendarReuniao`): o botão do inbox e a ferramenta
 * do agente gravam a MESMA coisa — evento, troca de responsável, feed e aviso ao vendedor.
 */

export interface ExpedienteReuniao {
  readonly horario: HorarioSemanal | null
  readonly feriados: readonly string[]
  readonly fuso: string
  readonly origem: 'numero' | 'padrao'
}

/** Expediente do número (ou o padrão comercial), feriados do número e fuso do tenant. */
export async function lerExpedienteReuniao(tx: Sql, canalId: string | null): Promise<ExpedienteReuniao> {
  const [l] = await tx<{ fuso: string | null; horario: unknown; feriados: unknown }[]>`
    SELECT t.fuso,
           ${canalId ? tx`(SELECT cfg.horario_atendimento FROM canal_configuracao cfg WHERE cfg.tenant_id = t.id AND cfg.canal_id = ${canalId})` : tx`NULL::jsonb`} AS horario,
           ${canalId ? tx`(SELECT cfg.feriados FROM canal_configuracao cfg WHERE cfg.tenant_id = t.id AND cfg.canal_id = ${canalId})` : tx`NULL::jsonb`} AS feriados
      FROM tenant t WHERE t.id = tenant_atual()`
  // ⚠️ jsonb gravado como string (duplo encode) não é horário — mesma defesa do SLA.
  const h = l?.horario
  const horario = h && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length > 0 ? (h as HorarioSemanal) : null
  return { horario, feriados: normalizarFeriados(l?.feriados ?? []), fuso: fusoSeguro(l?.fuso), origem: horario ? 'numero' : 'padrao' }
}

/** O dia local de hoje no fuso do tenant ("AAAA-MM-DD"). */
export const diaLocal = (instante: Date, fuso: string): string => partesLocais(instante, fuso).data

function somarDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * O PERÍODO ÚTIL de um dia local: expediente do número ∩ 08–20 (`faixaDeReuniao`), sem feriado.
 * É a mesma régua da grade de horários (M6) e da hora em que se fala com o cliente (M4).
 */
export function periodoUtil(exp: ExpedienteReuniao, dia: string): { ini: Date; fim: Date } | null {
  if (ehFeriado(exp.feriados, dia)) return null
  const diaIso = partesLocais(instanteLocal(dia, '12:00', exp.fuso), exp.fuso).diaIso
  const f = faixaDeReuniao(exp.horario, diaIso)
  return f ? { ini: instanteLocal(dia, f.de, exp.fuso), fim: instanteLocal(dia, f.ate, exp.fuso) } : null
}

/** O instante cai no período útil do seu dia local? */
export function noPeriodoUtil(exp: ExpedienteReuniao, instante: Date): boolean {
  const p = periodoUtil(exp, diaLocal(instante, exp.fuso))
  return !!p && instante.getTime() >= p.ini.getTime() && instante.getTime() < p.fim.getTime()
}

/** [inicio, fim) cabe inteiro no período útil do dia do início? (o POST do botão recusa fora da grade) */
export function cabeNoPeriodoUtil(exp: ExpedienteReuniao, inicio: Date, fim: Date): boolean {
  const p = periodoUtil(exp, diaLocal(inicio, exp.fuso))
  return !!p && inicio.getTime() >= p.ini.getTime() && fim.getTime() <= p.fim.getTime()
}

/**
 * O ÚLTIMO momento útil até `instante` (inclusive), procurando até 7 dias para trás: o próprio
 * instante se for útil; senão o último minuto do período útil anterior. É o ponto do H-24 — o de
 * segunda 10h, com domingo fechado, adianta para o fim do expediente de sexta (ou sábado).
 */
export function ultimoMomentoUtilAte(exp: ExpedienteReuniao, instante: Date): Date | null {
  const hoje = diaLocal(instante, exp.fuso)
  for (let n = 0; n <= 7; n++) {
    const p = periodoUtil(exp, somarDias(hoje, -n))
    if (!p) continue
    if (instante.getTime() >= p.fim.getTime()) return new Date(p.fim.getTime() - 60_000)
    if (instante.getTime() >= p.ini.getTime()) return instante
  }
  return null
}

/**
 * Horários LIVRES de uma pessoa num dia: a grade do expediente menos os eventos AGENDADOS dela,
 * sem o que já passou (nem o que começa em menos de `ANTECEDENCIA_MIN_REUNIAO`).
 */
export async function horariosLivresDoDia(
  tx: Sql, p: { usuarioId: string; dia: string; canalId: string | null; duracaoMin: number; agora: Date },
): Promise<RespostaHorariosLivres> {
  const exp = await lerExpedienteReuniao(tx, p.canalId)
  const base = { usuarioId: p.usuarioId, dia: p.dia, duracaoMin: p.duracaoMin, origemExpediente: exp.origem }
  const diaIso = partesLocais(instanteLocal(p.dia, '12:00', exp.fuso), exp.fuso).diaIso
  const faixa = faixaDeReuniao(exp.horario, diaIso)
  if (!faixa || ehFeriado(exp.feriados, p.dia)) return { ...base, fechado: true, horarios: [] }

  const candidatos = candidatosDoDia(faixa, p.duracaoMin).map((c) => ({
    inicio: instanteLocal(p.dia, c.de, exp.fuso), fim: instanteLocal(p.dia, c.ate, exp.fuso),
  }))
  if (candidatos.length === 0) return { ...base, fechado: false, horarios: [] }
  const ocupados = await tx<{ inicio: Date; fim: Date }[]>`
    SELECT inicio, fim FROM evento_agenda
     WHERE tenant_id = tenant_atual() AND responsavel_id = ${p.usuarioId} AND status = 'agendado'
       AND inicio < ${candidatos[candidatos.length - 1]!.fim} AND fim > ${candidatos[0]!.inicio}
     ORDER BY inicio LIMIT 200`
  const minimo = p.agora.getTime() + ANTECEDENCIA_MIN_REUNIAO * 60_000
  const horarios: HorarioLivre[] = candidatos
    .filter((c) => c.inicio.getTime() >= minimo && !ocupados.some((o) => periodosSobrepoem(c, o)))
    .map((c) => ({ inicio: c.inicio.toISOString(), fim: c.fim.toISOString() }))
  return { ...base, fechado: false, horarios }
}

/**
 * O dono VIGENTE (ativo) da carteira do contato, ou null. `ausente` diz se ele está fora agora:
 * quem OFERTA horário pula o ausente (M3, cai para a filial); quem decide CARTEIRA não pula —
 * ausência não solta o cliente.
 */
export async function donoDoContato(tx: Sql, contatoId: string): Promise<{ id: string; nome: string; ausente: boolean } | null> {
  const [d] = await tx<{ id: string; nome: string; ausente: boolean }[]>`
    SELECT u.id, u.nome, coalesce(u.ausente, false) AS ausente FROM carteira_atribuicao ca
      JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
     WHERE ca.tenant_id = tenant_atual() AND ca.contato_id = ${contatoId} AND ca.ate IS NULL AND u.ativo`
  return d ?? null
}

/** Teto de segurança da lista de vendedores (é um seletor, não grid; acima disto, `truncado`). */
const VENDEDORES_MAX = 20

/**
 * Quem pode receber a reunião, NA ORDEM: o responsável do contato primeiro, depois os outros
 * VENDEDORES da mesma filial (filial do contato, as do dono e a do número). Sem filial
 * nenhuma, "a mesma filial" é a empresa: vendedores com vínculo em todas (`filial_id NULL`).
 *
 * ⚠️ Não aplica escopo: a rota humana filtra com `responsavelNoEscopo` (o dono sempre fica — o
 *    contato já está no escopo de quem pede); o agente é máquina e não tem escopo.
 */
export async function vendedoresParaReuniao(
  tx: Sql, p: { contatoId: string; canalId: string | null; eu?: { id: string; nome: string } | null },
): Promise<{ itens: VendedorParaReuniao[]; truncado: boolean }> {
  const donoReal = await donoDoContato(tx, p.contatoId)
  // M3: dono ausente não recebe reunião agora — a lista cai para a filial dele.
  const dono = donoReal && !donoReal.ausente ? donoReal : null
  const [f] = await tx<{ filiais: string[] }[]>`
    SELECT coalesce(array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}') AS filiais FROM (
      SELECT c.filial_id AS x FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${p.contatoId}
      UNION ALL
      SELECT uf.filial_id FROM usuario_filial uf WHERE uf.tenant_id = tenant_atual() AND uf.usuario_id = ${donoReal?.id ?? null}::uuid
      UNION ALL
      SELECT cc.filial_id FROM canal_conectado cc WHERE cc.tenant_id = tenant_atual() AND cc.id = ${p.canalId}::uuid
    ) s`
  const filiais = f?.filiais ?? []
  const outros = await tx<{ id: string; nome: string }[]>`
    SELECT u.id, u.nome FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND u.ativo AND NOT coalesce(u.ausente, false) AND ${naoEhLinhaDeStaff(tx, 'u')}
       AND u.id IS DISTINCT FROM ${donoReal?.id ?? null}::uuid
       AND EXISTS (SELECT 1 FROM usuario_filial uf
                    WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.papel = 'vendedor'
                      AND ${filiais.length > 0 ? tx`uf.filial_id = ANY(${filiais}::uuid[])` : tx`uf.filial_id IS NULL`})
     ORDER BY u.nome, u.id LIMIT ${VENDEDORES_MAX + 1}`
  const itens: VendedorParaReuniao[] = []
  if (dono) itens.push({ usuarioId: dono.id, nome: dono.nome, responsavelDoContato: true })
  if (p.eu && p.eu.id !== dono?.id) itens.push({ usuarioId: p.eu.id, nome: p.eu.nome, responsavelDoContato: false })
  for (const o of outros.slice(0, VENDEDORES_MAX)) {
    if (!itens.some((i) => i.usuarioId === o.id)) itens.push({ usuarioId: o.id, nome: o.nome, responsavelDoContato: false })
  }
  return { itens, truncado: outros.length > VENDEDORES_MAX }
}

export type ResultadoAgendar =
  | { readonly tipo: 'ok'; readonly eventoId: string; readonly responsavelAlterado: boolean }
  | { readonly tipo: 'conflito'; readonly conflito: { id: string; titulo: string; inicio: string; fim: string } }
  | { readonly tipo: 'responsavel_invalido' }
  | { readonly tipo: 'passado' }
  | { readonly tipo: 'sem_conversa' }

/**
 * MARCA a reunião — o caso de uso único do botão e do agente. Na transação de quem chama:
 *   1. confere que o horário não passou e que a pessoa existe e está ativa;
 *   2. ⚠️ confere conflito SOB TRAVA por responsável (`acharConflito`): duas marcações
 *      simultâneas no mesmo horário não passam as duas — a segunda recebe `conflito` (409);
 *   3. grava o evento com a conversa de origem (é por ela que o cliente recebe os avisos);
 *   4. se quem recebe NÃO é o dono atual E quem chama permitiu (`transferirCarteira`: só o botão,
 *      com papel de gestão ou contato sem dono — M2), ele vira o responsável do contato
 *      (`transferir_carteira`). ⚠️ O AGENTE NUNCA transfere carteira (decisão do orquestrador): a
 *      reunião fica com quem a recebe e o feed diz que o responsável continua o mesmo. Atendente
 *      sem papel de venda também nunca vira dono;
 *   5. registra no feed do contato (auditoria `agenda.reuniao_agendada`) e avisa o vendedor
 *      pelo sino (outbox sem conteúdo, ADR-007).
 */
export async function agendarReuniao(tx: Sql, p: {
  conversaId: string; usuarioId: string; inicio: Date; fim: Date; titulo: string
  modalidade: ModalidadeEvento; local: string | null; link: string | null; descricao: string | null
  criadoPor: string | null; origem: 'conversa' | 'agente'; agora: Date; transferirCarteira: boolean
}): Promise<ResultadoAgendar> {
  if (p.inicio.getTime() < p.agora.getTime()) return { tipo: 'passado' }
  const [cv] = await tx<{ contato_id: string; canal_id: string; contato: string }[]>`
    SELECT cv.contato_id, cv.canal_id, c.nome AS contato FROM conversa cv
      JOIN contato c ON c.tenant_id = cv.tenant_id AND c.id = cv.contato_id
     WHERE cv.tenant_id = tenant_atual() AND cv.id = ${p.conversaId}`
  if (!cv) return { tipo: 'sem_conversa' }
  const [u] = await tx<{ nome: string }[]>`
    SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${p.usuarioId} AND ativo`
  if (!u) return { tipo: 'responsavel_invalido' }
  const conflito = await acharConflito(tx, p.usuarioId, p.inicio, p.fim, null)
  if (conflito) return { tipo: 'conflito', conflito }

  const eventoId = randomUUID()
  await tx`
    INSERT INTO evento_agenda (tenant_id, id, titulo, descricao, contato_id, responsavel_id, inicio, fim, tipo, modalidade,
                               local, link, lembrete_min, cor, criado_por, conversa_id, canal_id, origem)
    VALUES (tenant_atual(), ${eventoId}, ${p.titulo}, ${p.descricao}, ${cv.contato_id}, ${p.usuarioId}, ${p.inicio}, ${p.fim},
            'reuniao', ${p.modalidade}, ${p.local}, ${p.link}, 60, 'acao', ${p.criadoPor}, ${p.conversaId}, ${cv.canal_id}, ${p.origem})`

  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const local = partesLocais(p.inicio, fuso)
  const quando = `${local.data.slice(8, 10)}/${local.data.slice(5, 7)} às ${local.hora}`

  const dono = await donoDoContato(tx, cv.contato_id)
  const [vende] = await tx`
    SELECT 1 FROM usuario_filial WHERE tenant_id = tenant_atual() AND usuario_id = ${p.usuarioId}
       AND papel IN ('vendedor', 'gestor', 'supervisor', 'admin') LIMIT 1`
  const assumiu = p.transferirCarteira && p.origem !== 'agente' && !!vende && dono?.id !== p.usuarioId
  const mantido = !assumiu && dono && dono.id !== p.usuarioId ? dono.nome : null
  if (assumiu) {
    await tx`SELECT transferir_carteira(tenant_atual(), ${cv.contato_id}, ${p.usuarioId}, ${p.criadoPor}::uuid,
                                        ${p.origem === 'agente' ? 'automatica' : 'manual'}, 'Reunião agendada')`
  }
  await auditar(tx, {
    atorId: p.criadoPor, acao: 'agenda.reuniao_agendada', entidade: 'contato', entidadeId: cv.contato_id,
    dados: {
      eventoId, inicio: p.inicio.toISOString(), quando, responsavelId: p.usuarioId, responsavel: u.nome,
      assumiu, anterior: dono?.nome ?? null, mantido, origem: p.origem,
    },
  })

  if (p.usuarioId !== p.criadoPor) {
    await avisarUsuario(tx, p.usuarioId, 'agenda.reuniao', `Reunião marcada com ${cv.contato} — ${quando}`)
  }
  return { tipo: 'ok', eventoId, responsavelAlterado: assumiu }
}

/**
 * Sino de UMA pessoa, respeitando a preferência dela (D4/B3): sem canal ligado nem grava; app
 * desligado = só push, sem evento no outbox. O evento de tempo real não carrega conteúdo (ADR-007).
 */
export async function avisarUsuario(tx: Sql, usuarioId: string, tipo: string, titulo: string): Promise<boolean> {
  const c = (await canaisDosUsuarios(tx, [usuarioId], tipo)).get(usuarioId)
  if (!c || !algumCanal(c)) return false
  await tx`
    INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, no_app, email_pendente)
    VALUES (tenant_atual(), ${randomUUID()}, ${usuarioId}, ${tipo}, ${titulo.slice(0, 200)}, ${c.app}, ${c.email})`
  if (c.app) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${usuarioId}, ${JSON.stringify({ usuarioId })}::text::jsonb)`
  }
  return true
}
