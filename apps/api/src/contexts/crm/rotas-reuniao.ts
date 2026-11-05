import type { FastifyInstance } from 'fastify'
import {
  DIAS_MAX_REUNIAO, DURACAO_REUNIAO_PADRAO, ERROS_REUNIAO, ehDuracaoReuniao, ehModalidadeEvento,
  type ModalidadeEvento,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { atorDaRequisicao } from '../atendimento/rotas-fila.js'
import { exigirModulo } from '../plataforma/modulos.js'
import { temPapel } from '../plataforma/papel.js'
import { conversaNoEscopo, escopoDaRequisicao, responsavelNoEscopo, type Escopo } from '../plataforma/escopo.js'
import {
  agendarReuniao, cabeNoPeriodoUtil, diaLocal, donoDoContato, horariosLivresDoDia, lerExpedienteReuniao, vendedoresParaReuniao,
} from './reuniao.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/
const CAMPO_MAX = 300

const RESPONSAVEL_PROIBIDO = {
  erro: ERROS_REUNIAO.responsavelProibido,
  mensagem: 'Você só pode marcar com o responsável do cliente, com você ou com quem está no seu escopo.',
}
const CONVERSA_NAO_ENCONTRADA = { erro: 'conversa.nao_encontrada' }

interface Conversa { contatoId: string; canalId: string; contato: string }

/** A conversa (sob RLS) e se está no escopo de quem pede. Fora do escopo = inexistente (404). */
async function conversaVisivel(tx: Sql, escopo: Escopo, conversaId: string): Promise<Conversa | null> {
  if (!UUID.test(conversaId) || !(await conversaNoEscopo(tx, escopo, conversaId))) return null
  const [c] = await tx<{ contato_id: string; canal_id: string; contato: string }[]>`
    SELECT cv.contato_id, cv.canal_id, c.nome AS contato FROM conversa cv
      JOIN contato c ON c.tenant_id = cv.tenant_id AND c.id = cv.contato_id
     WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId}`
  return c ? { contatoId: c.contato_id, canalId: c.canal_id, contato: c.contato } : null
}

/**
 * Quem pede pode marcar com `usuarioId`? Ele mesmo; o RESPONSÁVEL do contato (o contato já está
 * no escopo de quem pede — é o "vendedor da carteira" do botão); ou alguém no escopo
 * (`responsavelNoEscopo`: gestor da filial → os da filial; vendedor → só ele).
 */
async function podeMarcarCom(tx: Sql, escopo: Escopo, eu: string | null, usuarioId: string, contatoId: string | null): Promise<boolean> {
  if (!UUID.test(usuarioId)) return false
  if (eu && usuarioId === eu) return true
  if (contatoId && (await donoDoContato(tx, contatoId))?.id === usuarioId) return true
  return responsavelNoEscopo(tx, escopo, usuarioId)
}

/** O dia pedido está entre hoje (no fuso do tenant) e `DIAS_MAX_REUNIAO` à frente? */
function diaNaJanela(dia: string, hoje: string): boolean {
  if (!DIA.test(dia) || Number.isNaN(Date.parse(dia))) return false
  const dias = (Date.parse(dia) - Date.parse(hoje)) / 86_400_000
  return dias >= 0 && dias <= DIAS_MAX_REUNIAO
}

const texto = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > max ? undefined : (t || null)
}

interface CorpoReuniao {
  conversaId?: unknown; usuarioId?: unknown; inicio?: unknown; duracaoMin?: unknown; titulo?: unknown
  modalidade?: unknown; local?: unknown; link?: unknown; descricao?: unknown
}

/**
 * REUNIÃO PELA CONVERSA (raia C3) — o botão "Agendar reunião" do inbox. Atrás do módulo Agenda
 * (`/v1/agenda/*` responde 404 com ele desligado) e INDEPENDENTE da chave do agente: a pessoa
 * marca mesmo com o agente proibido de marcar.
 *
 *   GET  /v1/agenda/reuniao/vendedores?conversaId     — responsável do contato primeiro, depois a filial
 *   GET  /v1/agenda/horarios-livres?usuarioId&dia[&conversaId][&duracao]
 *   POST /v1/agenda/reunioes                          — 201 | 409 agenda.horario_ocupado (tipificado)
 *
 * Escopo: a conversa precisa estar no escopo de quem pede (senão 404, como inexistente); a pessoa
 * da reunião, em `podeMarcarCom` (senão 403 `agenda.responsavel_proibido`, o mesmo código da C2).
 * Carteira (M2): marcar com quem NÃO é o dono vigente transfere o cliente — só para quem tem papel
 * de gestão; os demais recebem 403 `agenda.transferencia_proibida`. Contato sem dono: quem recebe
 * a reunião vira dono (atendente sem papel de venda, nunca). Horário fora do período útil do
 * número (expediente ∩ 08–20) → 422 `agenda.fora_do_expediente`.
 */
export async function rotasReuniao(app: FastifyInstance): Promise<void> {
  const pre = [exigirTenant, exigirModulo('agenda')]

  app.get<{ Querystring: { conversaId?: string } }>('/v1/agenda/reuniao/vendedores', { preHandler: pre }, async (req, reply) => {
    const conversaId = req.query.conversaId ?? ''
    const r = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      const cv = await conversaVisivel(tx, escopo, conversaId)
      if (!cv) return null
      const euId = await atorDaRequisicao(tx, req)
      const [eu] = euId ? await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${euId} AND ativo` : []
      const todos = await vendedoresParaReuniao(tx, { contatoId: cv.contatoId, canalId: cv.canalId, eu: eu ?? null })
      const itens = []
      for (const v of todos.itens) {
        if (v.responsavelDoContato || v.usuarioId === euId || await responsavelNoEscopo(tx, escopo, v.usuarioId)) itens.push(v)
      }
      return { itens, truncado: todos.truncado }
    })
    return r ? reply.send(r) : reply.code(404).send(CONVERSA_NAO_ENCONTRADA)
  })

  app.get<{ Querystring: { usuarioId?: string; dia?: string; conversaId?: string; duracao?: string } }>(
    '/v1/agenda/horarios-livres', { preHandler: pre },
    async (req, reply) => {
      const { usuarioId = '', dia = '', conversaId } = req.query
      const duracaoMin = req.query.duracao === undefined ? DURACAO_REUNIAO_PADRAO : Number(req.query.duracao)
      if (!UUID.test(usuarioId)) return reply.code(422).send({ erro: 'agenda.responsavel_invalido', mensagem: 'Informe a pessoa (usuarioId).' })
      if (!ehDuracaoReuniao(duracaoMin)) return reply.code(422).send({ erro: 'agenda.duracao_invalida', mensagem: 'Duração inválida.' })
      const agora = new Date()
      const r = await req.comTenant(async (tx) => {
        const escopo = await escopoDaRequisicao(tx, req)
        const cv = conversaId ? await conversaVisivel(tx, escopo, conversaId) : null
        if (conversaId && !cv) return { tipo: 'conversa' as const }
        const { fuso } = await lerExpedienteReuniao(tx, null)
        if (!diaNaJanela(dia, diaLocal(agora, fuso))) return { tipo: 'dia' as const }
        if (!(await podeMarcarCom(tx, escopo, await atorDaRequisicao(tx, req), usuarioId, cv?.contatoId ?? null))) return { tipo: 'proibido' as const }
        const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${usuarioId} AND ativo`
        if (!u) return { tipo: 'responsavel' as const }
        return { tipo: 'ok' as const, r: await horariosLivresDoDia(tx, { usuarioId, dia, canalId: cv?.canalId ?? null, duracaoMin, agora }) }
      })
      if (r.tipo === 'conversa') return reply.code(404).send(CONVERSA_NAO_ENCONTRADA)
      if (r.tipo === 'dia') {
        return reply.code(422).send({ erro: 'agenda.dia_invalido', mensagem: `Escolha um dia entre hoje e ${DIAS_MAX_REUNIAO} dias à frente (AAAA-MM-DD).` })
      }
      if (r.tipo === 'proibido') return reply.code(403).send(RESPONSAVEL_PROIBIDO)
      if (r.tipo === 'responsavel') return reply.code(422).send({ erro: ERROS_REUNIAO.responsavelInvalido, mensagem: 'Pessoa não encontrada ou inativa.' })
      return reply.send(r.r)
    },
  )

  app.post<{ Body: CorpoReuniao }>('/v1/agenda/reunioes', { preHandler: pre }, async (req, reply) => {
    const b = req.body ?? {}
    const conversaId = typeof b.conversaId === 'string' ? b.conversaId : ''
    const usuarioId = typeof b.usuarioId === 'string' ? b.usuarioId : ''
    const inicio = typeof b.inicio === 'string' ? new Date(b.inicio) : null
    const duracaoMin = b.duracaoMin ?? DURACAO_REUNIAO_PADRAO
    if (!UUID.test(usuarioId)) return reply.code(422).send({ erro: 'agenda.responsavel_invalido', mensagem: 'Escolha com quem é a reunião.' })
    if (!inicio || Number.isNaN(inicio.getTime())) return reply.code(422).send({ erro: 'agenda.horario_invalido', mensagem: 'Escolha um horário.' })
    if (!ehDuracaoReuniao(duracaoMin)) return reply.code(422).send({ erro: 'agenda.duracao_invalida', mensagem: 'Duração inválida.' })
    const modalidade = b.modalidade ?? 'online'
    if (!ehModalidadeEvento(modalidade)) return reply.code(422).send({ erro: 'agenda.modalidade_invalida', mensagem: 'Modalidade inválida.' })
    const titulo = texto(b.titulo, 120); const local = texto(b.local, CAMPO_MAX)
    const link = texto(b.link, CAMPO_MAX); const descricao = texto(b.descricao, 2000)
    if (titulo === undefined || local === undefined || link === undefined || descricao === undefined) {
      return reply.code(422).send({ erro: 'agenda.texto_invalido', mensagem: 'Texto inválido ou longo demais.' })
    }
    if (link && !/^https?:\/\/\S+$/i.test(link)) return reply.code(422).send({ erro: 'agenda.link_invalido', mensagem: 'O link precisa começar com http:// ou https://.' })
    const fim = new Date(inicio.getTime() + duracaoMin * 60_000)
    // M2: só a gestão transfere carteira pela reunião (ou o contato sem dono vigente).
    const gestao = await temPapel(req, 'gestor', 'supervisor')

    const r = await req.comTenant(async (tx) => {
      const escopo = await escopoDaRequisicao(tx, req)
      const cv = await conversaVisivel(tx, escopo, conversaId)
      if (!cv) return { tipo: 'conversa' as const }
      const eu = await atorDaRequisicao(tx, req)
      if (!(await podeMarcarCom(tx, escopo, eu, usuarioId, cv.contatoId))) return { tipo: 'proibido' as const }
      if (inicio.getTime() < Date.now()) return { tipo: 'passado' as const }
      // M4/M6: a reunião cabe no período útil do número (expediente ∩ 08–20, sem feriado).
      if (!cabeNoPeriodoUtil(await lerExpedienteReuniao(tx, cv.canalId), inicio, fim)) return { tipo: 'fora_da_grade' as const }
      const dono = await donoDoContato(tx, cv.contatoId)
      if (dono && dono.id !== usuarioId && !gestao) return { tipo: 'transferencia' as const }
      return agendarReuniao(tx, {
        conversaId, usuarioId, inicio, fim, titulo: titulo ?? `Reunião com ${cv.contato}`.slice(0, 120),
        modalidade: modalidade as ModalidadeEvento, local, link, descricao, criadoPor: eu, origem: 'conversa', agora: new Date(),
        transferirCarteira: gestao || !dono,
      })
    })
    switch (r.tipo) {
      case 'fora_da_grade': return reply.code(422).send({
        erro: ERROS_REUNIAO.foraDoExpediente, mensagem: 'Esse horário está fora do expediente do número. Escolha um horário livre da grade.',
      })
      case 'transferencia': return reply.code(403).send({
        erro: ERROS_REUNIAO.transferenciaProibida,
        mensagem: 'Marcar com outra pessoa passa o cliente para ela, e só a gestão transfere carteira. Marque com o responsável do cliente.',
      })
      case 'conversa': case 'sem_conversa': return reply.code(404).send(CONVERSA_NAO_ENCONTRADA)
      case 'proibido': return reply.code(403).send(RESPONSAVEL_PROIBIDO)
      case 'responsavel_invalido': return reply.code(422).send({ erro: ERROS_REUNIAO.responsavelInvalido, mensagem: 'Pessoa não encontrada ou inativa.' })
      case 'passado': return reply.code(422).send({ erro: ERROS_REUNIAO.horarioPassado, mensagem: 'Esse horário já passou. Escolha outro.' })
      // ⚠️ O 409 da corrida: alguém ocupou o horário entre a grade e o clique. A tela recarrega a grade.
      case 'conflito': return reply.code(409).send({
        erro: ERROS_REUNIAO.horarioOcupado, mensagem: 'Esse horário acabou de ser ocupado. Escolha outro.', conflito: r.conflito,
      })
      case 'ok': return reply.code(201).send({ eventoId: r.eventoId, responsavelAlterado: r.responsavelAlterado })
    }
  })
}
