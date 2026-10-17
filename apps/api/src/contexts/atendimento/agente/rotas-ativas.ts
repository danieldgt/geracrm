import type { FastifyInstance } from 'fastify'
import {
  ATIVAS_PADRAO, contarVariaveis, corpoAtivas, lerConfigAtivas, normalizarFeriados,
  type EstadoAtivas, type TemplateAprovadoResumo,
} from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { proximaAbertura, situacaoDoExpediente, type HorarioAtendimento } from '../expediente.js'
import { liberarAtivas } from '../qualidade-numero.js'

/**
 * MENSAGENS ATIVAS DO AGENTE (raia P11) — limites por dia/semana, feriados do
 * número, template de retorno fora de 24h (só oficial) e a suspensão por
 * qualidade do número.
 *
 *   GET  /v1/canais/:id/agente/ativas            → EstadoAtivas
 *   PUT  /v1/canais/:id/agente/ativas            → admin; auditado
 *   POST /v1/canais/:id/agente/ativas/liberar    → admin; auditado (tira a suspensão)
 *   GET  /v1/canais/:id/agente/ativas/templates  → aprovados, por cursor (nome)
 *
 * ⚠️ A tela só ACRESCENTA restrição (ADR-029): os limites têm teto e mínimo 1,
 *    e escolher template não desliga a janela — fora de 24h sem template
 *    aprovado a ativa continua recusada.
 */
const PAGINA_TEMPLATES = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function rotasAtivas(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/ativas', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const agora = new Date()
      const estado = await req.comTenant(async (tx): Promise<EstadoAtivas | null> => {
        const [l] = await tx<{
          tipo: string; suspensa: Date | null; motivo: string | null; ativas: unknown
          horario: HorarioAtendimento | null; feriados: unknown; fuso: string | null
        }[]>`
          SELECT cc.tipo, cc.ativas_suspensas_em AS suspensa, cc.ativas_suspensas_motivo AS motivo,
                 coalesce(ac.ativas, '{}'::jsonb) AS ativas, cfg.horario_atendimento AS horario,
                 coalesce(cfg.feriados, '[]'::jsonb) AS feriados, t.fuso
            FROM canal_conectado cc
            JOIN tenant t ON t.id = cc.tenant_id
            LEFT JOIN agente_config ac ON ac.tenant_id = cc.tenant_id AND ac.canal_id = cc.id
            LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
           WHERE cc.tenant_id = tenant_atual() AND cc.id = ${req.params.id}`
        if (!l) return null
        const config = lerConfigAtivas(l.ativas)
        const feriados = normalizarFeriados(l.feriados)
        const fuso = l.fuso ?? 'America/Sao_Paulo'
        const abre = proximaAbertura(l.horario, feriados, agora, fuso)
        let template: EstadoAtivas['template'] = null
        if (config.templateRetorno) {
          const [tpl] = await tx<{ id: string; nome: string; idioma: string; categoria: string; status: string; corpo: { body?: { texto?: string } } }[]>`
            SELECT t.id, t.nome, t.idioma, t.categoria, tv.status_meta AS status, tv.corpo
              FROM template t
              JOIN template_versao tv ON tv.tenant_id = t.tenant_id AND tv.template_id = t.id
             WHERE t.tenant_id = tenant_atual() AND t.id = ${config.templateRetorno}
             ORDER BY (tv.status_meta = 'APPROVED') DESC, tv.versao DESC LIMIT 1`
          if (tpl) template = { ...resumoTemplate(tpl), status: tpl.status }
        }
        return {
          config,
          padroes: ATIVAS_PADRAO,
          feriados,
          tipoCanal: l.tipo,
          exigeTemplateForaDaJanela: l.tipo === 'whatsapp_oficial',
          horarioConfigurado: !!l.horario && Object.keys(l.horario).length > 0,
          expediente: {
            aberto: situacaoDoExpediente(l.horario, feriados, agora, fuso) === 'aberto',
            proximaAbertura: abre ? abre.toISOString() : null,
          },
          suspensao: l.suspensa ? { desde: l.suspensa.toISOString(), motivo: l.motivo ?? '' } : null,
          template,
        }
      })
      if (!estado) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return estado
    },
  )

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/agente/ativas', { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const p = corpoAtivas.safeParse(req.body)
      if (!p.success) {
        return reply.code(422).send({
          erro: 'ativas.invalido',
          mensagem: p.error.issues[0]?.message ?? 'Confira os limites e as datas.',
          campos: [...new Set(p.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean),
        })
      }
      const corpo = p.data
      const r = await req.comTenant(async (tx) => {
        const [cfg] = await tx<{ ativas: unknown; feriados: unknown; tipo: string }[]>`
          SELECT coalesce(ac.ativas, '{}'::jsonb) AS ativas, coalesce(cfg.feriados, '[]'::jsonb) AS feriados, cc.tipo
            FROM canal_conectado cc
            LEFT JOIN agente_config ac ON ac.tenant_id = cc.tenant_id AND ac.canal_id = cc.id
            LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
           WHERE cc.tenant_id = tenant_atual() AND cc.id = ${req.params.id}`
        if (!cfg) return { tipo: 'nao_encontrado' as const }
        const [existe] = await tx<{ ok: boolean }[]>`
          SELECT true AS ok FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        if (!existe) return { tipo: 'sem_agente' as const }

        if (corpo.templateRetorno) {
          const [tpl] = await tx<{ corpo: { body?: { texto?: string } } }[]>`
            SELECT tv.corpo FROM template_versao tv
             WHERE tv.tenant_id = tenant_atual() AND tv.template_id = ${corpo.templateRetorno} AND tv.status_meta = 'APPROVED'`
          if (!tpl) return { tipo: 'template_indisponivel' as const }
          if (contarVariaveis(tpl.corpo?.body?.texto ?? '') > 1) return { tipo: 'template_incompativel' as const }
        }

        const antes = { ...lerConfigAtivas(cfg.ativas), feriados: normalizarFeriados(cfg.feriados) }
        const ativas = { limiteDia: corpo.limiteDia, limiteSemana: corpo.limiteSemana, templateRetorno: corpo.templateRetorno }
        const feriados = normalizarFeriados(corpo.feriados)
        await tx`
          UPDATE agente_config SET ativas = ${JSON.stringify(ativas)}::text::jsonb
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        await tx`
          INSERT INTO canal_configuracao (tenant_id, canal_id, feriados)
          VALUES (tenant_atual(), ${req.params.id}, ${JSON.stringify(feriados)}::text::jsonb)
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET feriados = EXCLUDED.feriados`
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff === true, acao: 'agente.ativas_alteradas', entidade: 'canal_conectado',
          entidadeId: req.params.id, dados: { antes, depois: { ...ativas, feriados } },
        })
        return { tipo: 'ok' as const }
      })
      if (r.tipo === 'nao_encontrado') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      if (r.tipo === 'sem_agente') {
        return reply.code(409).send({ erro: 'agente.nao_configurado', mensagem: 'Configure o agente deste número antes de definir as mensagens ativas.' })
      }
      if (r.tipo === 'template_indisponivel') {
        return reply.code(422).send({ erro: 'ativas.template_indisponivel', mensagem: 'Escolha um template aprovado pela Meta.', campos: ['templateRetorno'] })
      }
      if (r.tipo === 'template_incompativel') {
        return reply.code(422).send({
          erro: 'ativas.template_incompativel', campos: ['templateRetorno'],
          mensagem: 'O template de retorno só pode ter a variável {{1}} (primeiro nome do cliente).',
        })
      }
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/ativas/liberar', { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx<{ motivo: string | null }[]>`
          SELECT ativas_suspensas_motivo AS motivo FROM canal_conectado
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return 'nao_encontrado' as const
        if (!(await liberarAtivas(tx, req.params.id, new Date()))) return 'nao_suspensa' as const
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff === true, acao: 'agente.ativas_liberadas', entidade: 'canal_conectado',
          entidadeId: req.params.id, dados: { motivoDaSuspensao: c.motivo },
        })
        return 'ok' as const
      })
      if (r === 'nao_encontrado') return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      if (r === 'nao_suspensa') return reply.code(409).send({ erro: 'ativas.nao_suspensas', mensagem: 'As ativas deste número já estão liberadas.' })
      return { ok: true }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/canais/:id/agente/ativas/templates', { preHandler: exigirTenant },
    async (req) => {
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 600) : null
      const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; idioma: string; categoria: string; corpo: { body?: { texto?: string } }; chave: string }[]>`
        SELECT t.id, t.nome, t.idioma, t.categoria, tv.corpo, (t.nome || '|' || t.idioma) AS chave
          FROM template t
          JOIN template_versao tv ON tv.tenant_id = t.tenant_id AND tv.template_id = t.id AND tv.status_meta = 'APPROVED'
         WHERE t.tenant_id = tenant_atual()
           ${cursor ? tx`AND (t.nome || '|' || t.idioma) COLLATE "C" > ${cursor}` : tx``}
         ORDER BY (t.nome || '|' || t.idioma) COLLATE "C"
         LIMIT ${PAGINA_TEMPLATES + 1}`)
      const temMais = linhas.length > PAGINA_TEMPLATES
      const itens = linhas.slice(0, PAGINA_TEMPLATES)
      return {
        itens: itens.map(resumoTemplate),
        proximoCursor: temMais ? itens[itens.length - 1]!.chave : null,
      }
    },
  )
}

function resumoTemplate(t: { id: string; nome: string; idioma: string; categoria: string; corpo: { body?: { texto?: string } } }): TemplateAprovadoResumo {
  const corpo = t.corpo?.body?.texto ?? ''
  return { id: t.id, nome: t.nome, idioma: t.idioma, categoria: t.categoria, corpo, variaveis: contarVariaveis(corpo) }
}
