import type { FastifyInstance } from 'fastify'
import {
  AGRUPAMENTOS_COCKPIT, DIAS_ESQUECIDO_MAX, DIAS_ESQUECIDO_PADRAO, cardDeAgenda, ehAgrupamentoCockpit, ehCardCockpit,
  type CardCockpit, type FaixaAguardando, type RespostaItensCockpit,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { PAGINA, lerCursor, paginar } from '../crm/cursor-criado-em.js'
import { janelaDoDia, listarItens, montarCockpit, paraItem, type ContextoCockpit } from './cockpit.js'
import { escopoDaRequisicao } from './escopo.js'
import { moduloAtivo } from './modulos.js'
import { exigirPapel } from './papel.js'

/**
 * COCKPIT DO GESTOR (D1) — só leitura.
 *
 *   GET /v1/gestao/cockpit?agrupar=filial|vendedor&dias=7   → os cards + a tabela por grupo
 *   GET /v1/gestao/cockpit/itens?card=…&agrupar=…&grupo=…&dias=…&faixa=…&cursor=…   → a lista do card, por cursor
 *
 * ⚠️ gestor/supervisor/admin (vendedor → 403) e SEMPRE dentro do escopo da D3. Tenant do token.
 * ⚠️ Cards de agenda só existem com o módulo ligado: `null` no cockpit, 404 `modulo.desligado` na lista.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FAIXAS: readonly FaixaAguardando[] = ['ok', 'atencao', 'estourado']

type Consulta = Record<string, unknown>
const um = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function lerDias(bruto: unknown): number | null {
  const s = um(bruto)
  if (s === undefined) return DIAS_ESQUECIDO_PADRAO
  if (!/^\d{1,3}$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= DIAS_ESQUECIDO_MAX ? n : null
}

async function contexto(tx: Sql, req: Parameters<typeof escopoDaRequisicao>[1], dias: number): Promise<ContextoCockpit> {
  const agora = new Date()
  const escopo = await escopoDaRequisicao(tx, req)
  const janela = await janelaDoDia(tx, agora)
  const agendaAtiva = await moduloAtivo(tx, 'agenda')
  return { escopo, agora, ...janela, dias, agendaAtiva }
}

export async function rotasCockpit(app: FastifyInstance): Promise<void> {
  const pre = [exigirTenant, exigirPapel('gestor', 'supervisor')]

  app.get<{ Querystring: Consulta }>('/v1/gestao/cockpit', { preHandler: pre }, async (req, reply) => {
    const agrupar = um(req.query.agrupar) ?? 'vendedor'
    if (!ehAgrupamentoCockpit(agrupar)) {
      return reply.code(422).send({ erro: 'cockpit.agrupamento_invalido', mensagem: `Agrupe por: ${AGRUPAMENTOS_COCKPIT.join(' ou ')}.`, campos: ['agrupar'] })
    }
    const dias = lerDias(req.query.dias)
    if (dias === null) {
      return reply.code(422).send({ erro: 'cockpit.dias_invalido', mensagem: `Informe de 1 a ${DIAS_ESQUECIDO_MAX} dias.`, campos: ['dias'] })
    }
    return req.comTenant(async (tx) => montarCockpit(tx, await contexto(tx, req, dias), agrupar))
  })

  app.get<{ Querystring: Consulta }>('/v1/gestao/cockpit/itens', { preHandler: pre }, async (req, reply) => {
    const card = um(req.query.card)
    if (!ehCardCockpit(card)) return reply.code(422).send({ erro: 'cockpit.card_invalido', mensagem: 'Card desconhecido.', campos: ['card'] })
    const agrupar = um(req.query.agrupar) ?? 'vendedor'
    if (!ehAgrupamentoCockpit(agrupar)) return reply.code(422).send({ erro: 'cockpit.agrupamento_invalido', campos: ['agrupar'] })
    const dias = lerDias(req.query.dias)
    if (dias === null) return reply.code(422).send({ erro: 'cockpit.dias_invalido', campos: ['dias'] })
    const grupo = um(req.query.grupo)
    if (grupo !== undefined && grupo !== 'sem' && !UUID.test(grupo)) {
      return reply.code(422).send({ erro: 'cockpit.grupo_invalido', mensagem: 'Grupo inválido.', campos: ['grupo'] })
    }
    const faixa = um(req.query.faixa)
    if (faixa !== undefined && !(FAIXAS as readonly string[]).includes(faixa)) {
      return reply.code(422).send({ erro: 'cockpit.faixa_invalida', campos: ['faixa'] })
    }
    const cursor = lerCursor(um(req.query.cursor))
    if (cursor === 'invalido') return reply.code(422).send({ erro: 'cursor_invalido', campos: ['cursor'] })

    const r = await req.comTenant(async (tx): Promise<RespostaItensCockpit | 'modulo_desligado'> => {
      const ctx = await contexto(tx, req, dias)
      if (cardDeAgenda(card as CardCockpit) && !ctx.agendaAtiva) return 'modulo_desligado'
      const { linhas } = await listarItens(tx, ctx, {
        card, agrupar, grupo, faixa: faixa as FaixaAguardando | undefined, cursor, limite: PAGINA,
      })
      const { pagina, proximoCursor } = paginar(linhas.map((l) => ({ ...l, criado_em_txt: l.desde_txt })))
      return { itens: pagina.map(paraItem), proximoCursor }
    })
    if (r === 'modulo_desligado') {
      return reply.code(404).send({ erro: 'modulo.desligado', mensagem: 'Este módulo não está ligado para a sua empresa.' })
    }
    return r
  })
}
