import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  JANELA_AGENDA_MAX_DIAS, ehCorEvento, ehLembreteEvento, ehModalidadeEvento, ehStatusEvento, ehTipoEvento,
  type CorEvento, type LembreteEventoMin, type ModalidadeEvento, type StatusEvento, type TipoEvento,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { exigirModulo } from '../plataforma/modulos.js'
import {
  condicaoContato, condicaoEvento, contatoNoEscopo, escopoDaRequisicao, responsavelNoEscopo, type Escopo,
} from '../plataforma/escopo.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIA = /^\d{4}-\d{2}-\d{2}$/
const TEXTO_MAX = 2000
const CAMPO_MAX = 300
/** Teto de segurança da janela: 62 dias de um usuário muito cheio ainda cabe; acima disso avisamos `truncado`. */
const JANELA_LINHAS_MAX = 2000

interface Linha {
  id: string; titulo: string; descricao: string | null; contato_id: string | null; contato: string | null
  responsavel_id: string; responsavel: string | null; inicio: Date; fim: Date; tipo: string; modalidade: string
  local: string | null; link: string | null; lembrete_min: number | null; cor: string; status: string; versao: number
}

const evento = (l: Linha) => ({
  id: l.id, titulo: l.titulo, descricao: l.descricao, contatoId: l.contato_id, contato: l.contato,
  responsavelId: l.responsavel_id, responsavel: l.responsavel, inicio: l.inicio.toISOString(), fim: l.fim.toISOString(),
  tipo: l.tipo as TipoEvento, modalidade: l.modalidade as ModalidadeEvento, local: l.local, link: l.link,
  lembreteMin: l.lembrete_min as LembreteEventoMin | null, cor: l.cor as CorEvento, status: l.status as StatusEvento,
  versao: l.versao,
})

/** Contato fora do escopo de quem lê vira null (id e nome): o evento aparece, o cliente não. */
const COLUNAS = (tx: Sql, escopo: Escopo) => tx`
  e.id, e.titulo, e.descricao,
  CASE WHEN ${condicaoContato(tx, escopo, 'c')} THEN e.contato_id END AS contato_id,
  CASE WHEN ${condicaoContato(tx, escopo, 'c')} THEN c.nome END AS contato,
  e.responsavel_id, u.nome AS responsavel,
  e.inicio, e.fim, e.tipo, e.modalidade, e.local, e.link, e.lembrete_min, e.cor, e.status, e.versao`
const JUNCOES = (tx: Sql) => tx`
  FROM evento_agenda e
  LEFT JOIN contato c ON c.tenant_id = e.tenant_id AND c.id = e.contato_id
  LEFT JOIN usuario u ON u.tenant_id = e.tenant_id AND u.id = e.responsavel_id`

/** Quem chama (`eu`) e o que enxerga (escopo comum, `plataforma/escopo.ts`). Chamar DENTRO do `comTenant`. */
async function quemEVe(tx: Sql, req: FastifyRequest): Promise<{ eu: string; escopo: Escopo }> {
  const eu = await garantirUsuarioId(tx, req)
  return { eu, escopo: await escopoDaRequisicao(tx, req) }
}

/**
 * Contato existe NO TENANT e está no escopo de quem escreve. Fora do escopo responde
 * igual a inexistente (422 agenda.contato_invalido): não revela que o cliente existe.
 */
async function contatoAlcancavel(tx: Sql, escopo: Escopo, contatoId: string): Promise<boolean> {
  const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
  return Boolean(c) && (await contatoNoEscopo(tx, escopo, contatoId))
}

/** 403 de responsável fora do alcance de quem agenda (mesmo código para gestão e para quem só agenda para si). */
const RESPONSAVEL_PROIBIDO = { erro: 'agenda.responsavel_proibido', mensagem: 'Você só pode agendar para você ou para quem está no seu escopo.' }

interface Corpo {
  titulo?: unknown; descricao?: unknown; contatoId?: unknown; responsavelId?: unknown; inicio?: unknown; fim?: unknown
  tipo?: unknown; modalidade?: unknown; local?: unknown; link?: unknown; lembreteMin?: unknown; cor?: unknown; versao?: unknown
}
interface Valores {
  titulo: string; descricao: string | null; contatoId: string | null; responsavelId: string | null
  inicio: Date; fim: Date; tipo: TipoEvento; modalidade: ModalidadeEvento; local: string | null; link: string | null
  lembreteMin: LembreteEventoMin | null; cor: CorEvento
}
type Erro = { erro: string; mensagem: string }

const texto = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > max ? undefined : (t || null)
}

/** Valida o corpo de POST/PUT. Puro. Devolve o erro 422 ou os valores limpos. */
export function validarEvento(b: Corpo | undefined): { v: Valores } | { erro: Erro } {
  const titulo = typeof b?.titulo === 'string' ? b.titulo.trim() : ''
  if (!titulo || titulo.length > 120) return { erro: { erro: 'agenda.titulo_invalido', mensagem: 'Dê um título de até 120 caracteres.' } }
  const inicio = typeof b?.inicio === 'string' ? new Date(b.inicio) : null
  const fim = typeof b?.fim === 'string' ? new Date(b.fim) : null
  if (!inicio || !fim || Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    return { erro: { erro: 'agenda.horario_invalido', mensagem: 'Informe início e fim.' } }
  }
  if (fim.getTime() <= inicio.getTime()) return { erro: { erro: 'agenda.fim_antes_do_inicio', mensagem: 'O fim precisa ser depois do início.' } }
  const tipo = b?.tipo ?? 'reuniao'
  if (!ehTipoEvento(tipo)) return { erro: { erro: 'agenda.tipo_invalido', mensagem: 'Tipo de evento inválido.' } }
  const modalidade = b?.modalidade ?? 'presencial'
  if (!ehModalidadeEvento(modalidade)) return { erro: { erro: 'agenda.modalidade_invalida', mensagem: 'Modalidade inválida.' } }
  const lembreteMin = b?.lembreteMin ?? null
  if (lembreteMin !== null && !ehLembreteEvento(lembreteMin)) return { erro: { erro: 'agenda.lembrete_invalido', mensagem: 'Lembrete inválido.' } }
  const cor = b?.cor ?? 'acao'
  if (!ehCorEvento(cor)) return { erro: { erro: 'agenda.cor_invalida', mensagem: 'Cor inválida.' } }
  const descricao = texto(b?.descricao, TEXTO_MAX)
  const local = texto(b?.local, CAMPO_MAX)
  const link = texto(b?.link, CAMPO_MAX)
  if (descricao === undefined || local === undefined || link === undefined) {
    return { erro: { erro: 'agenda.texto_invalido', mensagem: 'Texto inválido ou longo demais.' } }
  }
  if (link && !/^https?:\/\/\S+$/i.test(link)) return { erro: { erro: 'agenda.link_invalido', mensagem: 'O link precisa começar com http:// ou https://.' } }
  const contatoId = b?.contatoId ?? null
  if (contatoId !== null && (typeof contatoId !== 'string' || !UUID.test(contatoId))) {
    return { erro: { erro: 'agenda.contato_invalido', mensagem: 'Contato inválido.' } }
  }
  const responsavelId = b?.responsavelId ?? null
  if (responsavelId !== null && (typeof responsavelId !== 'string' || !UUID.test(responsavelId))) {
    return { erro: { erro: 'agenda.responsavel_invalido', mensagem: 'Responsável inválido.' } }
  }
  return { v: { titulo, descricao, contatoId, responsavelId, inicio, fim, tipo, modalidade, local, link, lembreteMin, cor } }
}

/**
 * Outro evento AGENDADO do mesmo responsável que se sobrepõe a [inicio, fim)?
 * ⚠️ Trava transacional por (tenant, responsável): duas criações simultâneas no mesmo horário
 *    não passam as duas pela conferência.
 */
export async function acharConflito(
  tx: Sql, responsavelId: string, inicio: Date, fim: Date, ignorarId: string | null,
): Promise<{ id: string; titulo: string; inicio: string; fim: string } | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'agenda:' + responsavelId}))`
  const [c] = await tx<{ id: string; titulo: string; inicio: Date; fim: Date }[]>`
    SELECT id, titulo, inicio, fim FROM evento_agenda
     WHERE tenant_id = tenant_atual() AND responsavel_id = ${responsavelId} AND status = 'agendado'
       AND inicio < ${fim} AND fim > ${inicio}
       AND ${ignorarId ? tx`id <> ${ignorarId}` : tx`true`}
     ORDER BY inicio LIMIT 1`
  return c ? { id: c.id, titulo: c.titulo, inicio: c.inicio.toISOString(), fim: c.fim.toISOString() } : null
}

const conflito409 = (c: NonNullable<Awaited<ReturnType<typeof acharConflito>>>) => ({
  erro: 'agenda.horario_ocupado',
  mensagem: 'O responsável já tem um evento nesse horário.',
  conflito: c,
})

/**
 * AGENDA — módulo opcional por tenant (0116/0117). Todas as rotas passam por `exigirModulo('agenda')`
 * (404 com o módulo desligado). Escopo (D3, `condicaoEvento`): `tudo` vê todos; `filial`, os eventos
 * de responsáveis da filial; `carteira` (vendedor/atendente), só os próprios. Fora do escopo = 404.
 * Quem agenda para outra pessoa precisa de escopo `tudo` ou `filial` (`responsavelNoEscopo`).
 * Cancelar é status, nunca DELETE.
 *
 * ⚠️ `GET /v1/agenda/eventos` NÃO é lista ilimitada: é uma JANELA DE CALENDÁRIO — `de` e `ate`
 *    obrigatórios, no máximo 62 dias (um mês de 6 semanas cabe), ordenada por início, com teto
 *    de 2000 linhas e `truncado: true` se estourar. A tela pagina por janela (mês), não por cursor.
 */
export async function rotasAgenda(app: FastifyInstance): Promise<void> {
  const pre = [exigirTenant, exigirModulo('agenda')]

  app.get<{ Querystring: { de?: string; ate?: string; responsavelId?: string; contatoId?: string } }>(
    '/v1/agenda/eventos', { preHandler: pre },
    async (req, reply) => {
      const { de, ate, responsavelId, contatoId } = req.query
      if (!de || !ate || !DIA.test(de) || !DIA.test(ate) || Number.isNaN(Date.parse(de)) || Number.isNaN(Date.parse(ate))) {
        return reply.code(422).send({ erro: 'agenda.intervalo_obrigatorio', mensagem: 'Informe de e ate (AAAA-MM-DD).' })
      }
      const dias = (Date.parse(ate) - Date.parse(de)) / 86_400_000 + 1
      if (dias < 1) return reply.code(422).send({ erro: 'agenda.intervalo_invalido', mensagem: '"ate" não pode ser antes de "de".' })
      if (dias > JANELA_AGENDA_MAX_DIAS) {
        return reply.code(422).send({ erro: 'agenda.intervalo_grande', mensagem: `Máximo de ${JANELA_AGENDA_MAX_DIAS} dias por consulta.` })
      }
      if ((responsavelId && !UUID.test(responsavelId)) || (contatoId && !UUID.test(contatoId))) {
        return reply.code(422).send({ erro: 'agenda.id_invalido' })
      }
      const { linhas, tipoEscopo } = await req.comTenant(async (tx) => {
        const { escopo } = await quemEVe(tx, req)
        const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
        const fuso = fusoSeguro(t?.fuso)
        const linhas = await tx<Linha[]>`
          SELECT ${COLUNAS(tx, escopo)} ${JUNCOES(tx)}
           WHERE e.tenant_id = tenant_atual()
             AND e.inicio < ((${ate}::date + 1)::timestamp AT TIME ZONE ${fuso}::text)
             AND e.fim > (${de}::date::timestamp AT TIME ZONE ${fuso}::text)
             AND ${condicaoEvento(tx, escopo, 'e')}
             AND ${responsavelId ? tx`e.responsavel_id = ${responsavelId}` : tx`true`}
             AND ${contatoId ? tx`e.contato_id = ${contatoId}` : tx`true`}
           ORDER BY e.inicio, e.id LIMIT ${JANELA_LINHAS_MAX + 1}`
        return { linhas, tipoEscopo: escopo.tipo }
      })
      const truncado = linhas.length > JANELA_LINHAS_MAX
      // `escopo` diz à tela se o filtro de responsável faz sentido: 'proprio' só para carteira.
      return reply.send({
        itens: (truncado ? linhas.slice(0, JANELA_LINHAS_MAX) : linhas).map(evento), truncado,
        escopo: tipoEscopo === 'carteira' ? 'proprio' : 'todos',
      })
    },
  )

  app.get<{ Params: { id: string } }>('/v1/agenda/eventos/:id', { preHandler: pre }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
    const l = await req.comTenant(async (tx) => {
      const { escopo } = await quemEVe(tx, req)
      const [x] = await tx<Linha[]>`
        SELECT ${COLUNAS(tx, escopo)} ${JUNCOES(tx)}
         WHERE e.tenant_id = tenant_atual() AND e.id = ${req.params.id}
           AND ${condicaoEvento(tx, escopo, 'e')}`
      return x
    })
    return l ? reply.send(evento(l)) : reply.code(404).send({ erro: 'agenda.nao_encontrado' })
  })

  app.post<{ Body: Corpo }>('/v1/agenda/eventos', { preHandler: pre }, async (req, reply) => {
    const r = validarEvento(req.body)
    if (!('v' in r)) return reply.code(422).send(r.erro)
    const v = r.v
    const id = randomUUID()
    const res = await req.comTenant(async (tx) => {
      const { eu, escopo } = await quemEVe(tx, req)
      const responsavelId = v.responsavelId ?? eu
      if (!(await responsavelNoEscopo(tx, escopo, responsavelId))) return { tipo: 'proibido' as const }
      const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${responsavelId} AND ativo`
      if (!u) return { tipo: 'responsavel' as const }
      if (v.contatoId && !(await contatoAlcancavel(tx, escopo, v.contatoId))) return { tipo: 'contato' as const }
      const c = await acharConflito(tx, responsavelId, v.inicio, v.fim, null)
      if (c) return { tipo: 'conflito' as const, c }
      await tx`
        INSERT INTO evento_agenda (tenant_id, id, titulo, descricao, contato_id, responsavel_id, inicio, fim, tipo, modalidade,
                                   local, link, lembrete_min, cor, criado_por)
        VALUES (tenant_atual(), ${id}, ${v.titulo}, ${v.descricao}, ${v.contatoId}, ${responsavelId}, ${v.inicio}, ${v.fim},
                ${v.tipo}, ${v.modalidade}, ${v.local}, ${v.link}, ${v.lembreteMin}, ${v.cor}, ${eu})`
      return { tipo: 'ok' as const }
    })
    if (res.tipo === 'proibido') return reply.code(403).send(RESPONSAVEL_PROIBIDO)
    if (res.tipo === 'responsavel') return reply.code(422).send({ erro: 'agenda.responsavel_invalido', mensagem: 'Responsável não encontrado.' })
    if (res.tipo === 'contato') return reply.code(422).send({ erro: 'agenda.contato_invalido', mensagem: 'Contato não encontrado.' })
    if (res.tipo === 'conflito') return reply.code(409).send(conflito409(res.c))
    return reply.code(201).send({ id })
  })

  app.put<{ Params: { id: string }; Body: Corpo }>('/v1/agenda/eventos/:id', { preHandler: pre }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
    const r = validarEvento(req.body)
    if (!('v' in r)) return reply.code(422).send(r.erro)
    const versao = req.body?.versao
    if (typeof versao !== 'number' || !Number.isInteger(versao)) {
      return reply.code(422).send({ erro: 'agenda.versao_obrigatoria', mensagem: 'Informe a versão do evento.' })
    }
    const v = r.v
    const res = await req.comTenant(async (tx) => {
      const { escopo } = await quemEVe(tx, req)
      const [atual] = await tx<{ responsavel_id: string; inicio: Date; fim: Date; status: string; versao: number }[]>`
        SELECT responsavel_id, inicio, fim, status, versao FROM evento_agenda
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
           AND ${condicaoEvento(tx, escopo, 'evento_agenda')}
         FOR UPDATE`
      if (!atual) return { tipo: 'nao_encontrado' as const }
      if (atual.versao !== versao) return { tipo: 'versao' as const, atual: atual.versao }
      const responsavelId = v.responsavelId ?? atual.responsavel_id
      if (!(await responsavelNoEscopo(tx, escopo, responsavelId))) return { tipo: 'proibido' as const }
      if (responsavelId !== atual.responsavel_id) {
        const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${responsavelId} AND ativo`
        if (!u) return { tipo: 'responsavel' as const }
      }
      if (v.contatoId && !(await contatoAlcancavel(tx, escopo, v.contatoId))) return { tipo: 'contato' as const }
      // Reagendar (mudou início ou fim) volta para "agendado" e rearma o lembrete.
      const reagendou = atual.inicio.getTime() !== v.inicio.getTime() || atual.fim.getTime() !== v.fim.getTime()
      const status = reagendou ? 'agendado' : atual.status
      if (status === 'agendado') {
        const c = await acharConflito(tx, responsavelId, v.inicio, v.fim, req.params.id)
        if (c) return { tipo: 'conflito' as const, c }
      }
      await tx`
        UPDATE evento_agenda SET titulo = ${v.titulo}, descricao = ${v.descricao}, contato_id = ${v.contatoId},
               responsavel_id = ${responsavelId}, inicio = ${v.inicio}, fim = ${v.fim}, tipo = ${v.tipo},
               modalidade = ${v.modalidade}, local = ${v.local}, link = ${v.link}, lembrete_min = ${v.lembreteMin},
               cor = ${v.cor}, status = ${status},
               lembrete_enviado_em = ${reagendou || v.lembreteMin === null ? null : tx`lembrete_enviado_em`},
               atualizado_em = now(), versao = versao + 1
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      return { tipo: 'ok' as const, versao: versao + 1 }
    })
    if (res.tipo === 'nao_encontrado') return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
    if (res.tipo === 'versao') {
      return reply.code(409).send({ erro: 'agenda.versao_desatualizada', mensagem: 'Alguém alterou este evento. Recarregue.', versaoAtual: res.atual })
    }
    if (res.tipo === 'proibido') return reply.code(403).send(RESPONSAVEL_PROIBIDO)
    if (res.tipo === 'responsavel') return reply.code(422).send({ erro: 'agenda.responsavel_invalido', mensagem: 'Responsável não encontrado.' })
    if (res.tipo === 'contato') return reply.code(422).send({ erro: 'agenda.contato_invalido', mensagem: 'Contato não encontrado.' })
    if (res.tipo === 'conflito') return reply.code(409).send(conflito409(res.c))
    return reply.send({ ok: true, versao: res.versao })
  })

  /** Muda o status. Voltar a "agendado" (desfazer) confere conflito de novo. */
  const mudarStatus = async (
    req: FastifyRequest & { comTenant: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T> },
    id: string, status: StatusEvento,
  ) => req.comTenant(async (tx) => {
    const { escopo } = await quemEVe(tx, req)
    const [atual] = await tx<{ responsavel_id: string; inicio: Date; fim: Date; status: string }[]>`
      SELECT responsavel_id, inicio, fim, status FROM evento_agenda
       WHERE tenant_id = tenant_atual() AND id = ${id} AND ${condicaoEvento(tx, escopo, 'evento_agenda')}
       FOR UPDATE`
    if (!atual) return { tipo: 'nao_encontrado' as const }
    if (atual.status === status) return { tipo: 'ok' as const }
    if (status === 'agendado') {
      const c = await acharConflito(tx, atual.responsavel_id, atual.inicio, atual.fim, id)
      if (c) return { tipo: 'conflito' as const, c }
    }
    await tx`
      UPDATE evento_agenda SET status = ${status}, atualizado_em = now(), versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${id}`
    return { tipo: 'ok' as const }
  })

  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>(
    '/v1/agenda/eventos/:id/status', { preHandler: pre },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
      const status = req.body?.status
      if (!ehStatusEvento(status)) return reply.code(422).send({ erro: 'agenda.status_invalido', mensagem: 'Status inválido.' })
      const res = await mudarStatus(req, req.params.id, status)
      if (res.tipo === 'nao_encontrado') return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
      if (res.tipo === 'conflito') return reply.code(409).send(conflito409(res.c))
      return reply.send({ ok: true })
    },
  )

  // Cancelar: o evento continua existindo (histórico do contato), com status "cancelado".
  app.delete<{ Params: { id: string } }>('/v1/agenda/eventos/:id', { preHandler: pre }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
    const res = await mudarStatus(req, req.params.id, 'cancelado')
    if (res.tipo === 'nao_encontrado') return reply.code(404).send({ erro: 'agenda.nao_encontrado' })
    return reply.send({ ok: true })
  })
}
