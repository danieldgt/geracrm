import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { anonimizarContato, relatorioAnonimizacao } from './lgpd-anonimizacao.js'

/**
 * LGPD (raia H2):
 *
 *   POST /v1/contatos/:id/anonimizar[?somenteCanais=true]  — admin; pedido do titular. Anonimiza JÁ, sem
 *        esperar o prazo. Contato com compra é dado fiscal: sem `somenteCanais` recusa com 422
 *        `lgpd.contato_com_compra` (e diz a ação corretiva); com `somenteCanais=true` apaga só os canais
 *        de contato e o conteúdo das conversas e mantém o vínculo fiscal mínimo.
 *   GET  /v1/lgpd/relatorio?de&ate  — admin; quantos anonimizados por motivo/modo. Sem dado pessoal.
 *
 * ⚠️ O tenant sai do token (RLS), nunca de parâmetro.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PERIODO_DIAS = 366

/** `AAAA-MM-DD` (UTC) → Date; qualquer outra coisa → null. */
function dia(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function rotasLgpd(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Querystring: { somenteCanais?: string } }>(
    '/v1/contatos/:id/anonimizar',
    { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })
      const somenteCanais = req.query?.somenteCanais === 'true'
      const r = await req.comTenant(async (tx) => {
        const atorId = await garantirUsuarioId(tx, req)
        return anonimizarContato(tx, req.params.id, { motivo: 'titular', agora: new Date(), atorId, somenteCanais })
      })
      if (!r.ok && r.erro === 'contato_nao_encontrado') {
        return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })
      }
      if (!r.ok) {
        return reply.code(422).send({
          erro: 'lgpd.contato_com_compra',
          mensagem: 'Este contato tem compra registrada (dado fiscal) e não pode ser anonimizado por inteiro. '
            + 'Você pode apagar só os canais de contato e as conversas, mantendo o vínculo fiscal.',
          acao: { somenteCanais: true },
        })
      }
      return reply.send({ ok: true, modo: r.modo, jaAnonimizado: r.jaAnonimizado })
    },
  )

  app.get<{ Querystring: { de?: string; ate?: string } }>(
    '/v1/lgpd/relatorio',
    { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      const agora = new Date()
      const inicioDoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1))
      const de = req.query?.de === undefined ? inicioDoMes : dia(req.query.de)
      // `ate` é inclusivo para quem pede (dia): o limite exclusivo é o dia seguinte.
      const ateDia = req.query?.ate === undefined ? null : dia(req.query.ate)
      if (!de || (req.query?.ate !== undefined && !ateDia)) {
        return reply.code(422).send({ erro: 'lgpd.periodo_invalido', mensagem: 'Informe as datas no formato AAAA-MM-DD.' })
      }
      const ate = ateDia ? new Date(ateDia.getTime() + 86_400_000) : new Date(agora.getTime() + 1000)
      if (ate <= de || (ate.getTime() - de.getTime()) / 86_400_000 > MAX_PERIODO_DIAS) {
        return reply.code(422).send({ erro: 'lgpd.periodo_invalido', mensagem: 'O período deve ser positivo e ter no máximo 366 dias.' })
      }
      const rel = await req.comTenant((tx) => relatorioAnonimizacao(tx, { de, ate }))
      return reply.send(rel)
    },
  )
}
