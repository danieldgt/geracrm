import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { fusoSeguro } from '../../plataforma/fuso.js'
import { cambioBrl, situacaoMensal, tetoSessaoDoAmbiente, tetoSessaoEfetivo, limiarAtingido } from './custo.js'
import { travarPlaybookDoTenant } from './playbook/repositorio.js'

/**
 * CUSTO E TETOS DO AGENTE (ADR-032, raia P6).
 *
 *   GET/PUT /v1/agente/orcamento        — orçamento MENSAL do tenant: só alerta
 *                                         (80% e 100%, uma vez por mês cada).
 *   GET/PUT /v1/canais/:id/agente/custo — teto por SESSÃO do número (+ leitura
 *                                         do teto diário e do gasto de hoje).
 *
 * ⚠️ Escrita exige admin (`exigirPapel`) e deixa auditoria com antes/depois.
 * ⚠️ Dinheiro em centavos inteiros, sempre; o câmbio só aparece para a tela
 *    explicar de onde vem a estimativa.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** R$ 1 milhão: acima disso é erro de digitação, não orçamento. */
const MAX_CENTAVOS = 100_000_000

const corpoOrcamento = z.object({
  mensalCentavos: z.number().int().positive().max(MAX_CENTAVOS).nullable(),
}).strict()

const corpoCusto = z.object({
  /** null = usa o padrão do ambiente; 0 = sem teto por sessão. */
  tetoSessaoCentavos: z.number().int().nonnegative().max(MAX_CENTAVOS).nullable(),
}).strict()

/**
 * `exigirPapel` lê o papel pela linha de `usuario` — que nasce no batimento de
 * presença do console. Garantir a linha ANTES evita 403 para quem abriu a tela
 * de custo direto (nota de integração do plano, §4 P14).
 */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

function invalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const i = e.issues[0]!
  return reply.code(422).send({ erro: 'custo.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: [i.path.join('.')] })
}

export async function rotasCusto(app: FastifyInstance): Promise<void> {
  app.get('/v1/agente/orcamento', { preHandler: exigirTenant }, async (req, reply) => {
    const s = await req.comTenant((tx) => situacaoMensal(tx, new Date()))
    return reply.send({
      mes: s.mes,
      mensalCentavos: s.mensalCentavos,
      gastoMesCentavos: s.gastoCentavos,
      limiarAtingido: limiarAtingido(s.gastoCentavos, s.mensalCentavos),
      alertado80: s.alertado80,
      alertado100: s.alertado100,
      modelosSemPreco: s.modelosSemPreco,
      cambioBrl: cambioBrl(),
    })
  })

  app.put<{ Body: unknown }>(
    '/v1/agente/orcamento', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      const p = corpoOrcamento.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const novo = p.data.mensalCentavos
      await req.comTenant(async (tx) => {
        const [antes] = await tx<{ mensal: string | null }[]>`
          SELECT mensal_centavos::text AS mensal FROM agente_orcamento WHERE tenant_id = tenant_atual()`
        // ⚠️ Trocar o valor NÃO rearma o alerta do mês: "uma vez por mês" é do
        //    mês, não do valor — senão editar o orçamento viraria spam de alerta.
        await tx`
          INSERT INTO agente_orcamento (tenant_id, mensal_centavos, atualizado_em)
          VALUES (tenant_atual(), ${novo}, now())
          ON CONFLICT (tenant_id) DO UPDATE SET mensal_centavos = EXCLUDED.mensal_centavos, atualizado_em = now()`
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'agente.orcamento_alterado', entidade: 'agente_orcamento',
          dados: { antes: antes?.mensal === undefined || antes.mensal === null ? null : Number(antes.mensal), depois: novo },
        })
      })
      return reply.send({ ok: true, mensalCentavos: novo })
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/custo', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const dados = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        const [cfg] = await tx<{ teto: string | null; orcamento_dia: string | null }[]>`
          SELECT teto_sessao_centavos::text AS teto, orcamento_dia_centavos::text AS orcamento_dia
            FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        // Gasto de hoje no fuso do tenant — a mesma régua do teto diário (vendedor.ts).
        // ⚠️ Fuso validado em TS (fuso.ts): fuso inválido no AT TIME ZONE dava 500 na tela.
        const [tf] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
        const fuso = fusoSeguro(tf?.fuso)
        const [hoje] = await tx<{ total: string }[]>`
          SELECT coalesce(sum(custo_centavos), 0)::text AS total FROM agente_decisao
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}
             AND criado_em >= (date_trunc('day', now() AT TIME ZONE ${fuso}::text) AT TIME ZONE ${fuso}::text)`
        // Referência para escolher o teto: custo das sessões dos últimos 30 dias (limitado).
        const [sessoes] = await tx<{ n: string; media: string | null; maior: string | null }[]>`
          SELECT count(*)::text AS n, round(avg(custo_centavos))::text AS media, max(custo_centavos)::text AS maior
            FROM (SELECT custo_centavos FROM agente_sessao
                   WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}
                     AND iniciada_em >= now() - interval '30 days'
                   ORDER BY iniciada_em DESC LIMIT 1000) s`
        return { cfg, hoje, sessoes }
      })
      if (!dados) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const configurado = dados.cfg?.teto === null || dados.cfg?.teto === undefined ? null : Number(dados.cfg.teto)
      return reply.send({
        tetoSessaoCentavos: configurado,
        tetoSessaoPadraoCentavos: tetoSessaoDoAmbiente(),
        /** null = sem teto por sessão. */
        tetoSessaoEfetivoCentavos: tetoSessaoEfetivo({ teto_sessao_centavos: configurado }),
        orcamentoDiaCentavos: dados.cfg?.orcamento_dia === null || dados.cfg?.orcamento_dia === undefined ? null : Number(dados.cfg.orcamento_dia),
        gastoHojeCentavos: Number(dados.hoje?.total ?? 0),
        sessoes30Dias: {
          quantidade: Number(dados.sessoes?.n ?? 0),
          mediaCentavos: dados.sessoes?.media === null || dados.sessoes?.media === undefined ? null : Number(dados.sessoes.media),
          maiorCentavos: dados.sessoes?.maior === null || dados.sessoes?.maior === undefined ? null : Number(dados.sessoes.maior),
        },
      })
    },
  )

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/agente/custo', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const p = corpoCusto.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const novo = p.data.tetoSessaoCentavos
      const ok = await req.comTenant(async (tx) => {
        // Ordem canônica de locks (P17): a trava do playbook do tenant ANTES de tocar agente_config.
        await travarPlaybookDoTenant(tx)
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return false
        const [antes] = await tx<{ teto: string | null }[]>`
          SELECT teto_sessao_centavos::text AS teto FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        // Número sem configuração ainda: nasce desligado (padrões da tabela), só com o teto.
        await tx`
          INSERT INTO agente_config (tenant_id, canal_id, teto_sessao_centavos, atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${novo}, now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET teto_sessao_centavos = EXCLUDED.teto_sessao_centavos, atualizado_em = now()`
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'agente.teto_sessao_alterado', entidade: 'agente_config', entidadeId: req.params.id,
          dados: { antes: antes?.teto === undefined || antes.teto === null ? null : Number(antes.teto), depois: novo },
        })
        return true
      })
      if (!ok) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true, tetoSessaoCentavos: novo, tetoSessaoEfetivoCentavos: tetoSessaoEfetivo({ teto_sessao_centavos: novo }) })
    },
  )
}
