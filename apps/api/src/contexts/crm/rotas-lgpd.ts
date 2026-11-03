import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { auditar } from '../plataforma/auditoria.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { anonimizarContato, previaAnonimizacao, relatorioAnonimizacao } from './lgpd-anonimizacao.js'

/**
 * LGPD (raia H2):
 *
 *   POST /v1/contatos/:id/anonimizar[?somenteCanais=true]  {protocolo?, solicitadoEm?}
 *        — ADMIN ATRIBUÍDO ou staff (não vale modo fundador); pedido do titular. Anonimiza JÁ.
 *        Contato com compra (ou vindo do ERP) é dado fiscal: sem `somenteCanais` → 422
 *        `lgpd.contato_com_compra` com a ação corretiva; com `somenteCanais=true` apaga só canais e
 *        conversas. A resposta diz quantos objetos do bucket ainda estão EM REMOÇÃO.
 *   GET  /v1/lgpd/relatorio?de&ate  — admin; anonimizados por motivo/modo, mídia pendente/removida.
 *   GET  /v1/lgpd/previa            — admin; MODO RELATÓRIO: estado da automática + quantos ela
 *        anonimizaria agora, por motivo. Não altera nada.
 *   POST /v1/lgpd/automatica {ativar, confirmo} — admin atribuído ou staff. Ligar exige
 *        `confirmo: true` (sem ele → 422 com a prévia); desligar não. Auditado com a prévia.
 *
 * ⚠️ O tenant sai do token (RLS), nunca de parâmetro.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PERIODO_DIAS = 366
const PROTOCOLO = /^[\w./-]{1,60}$/

/** `AAAA-MM-DD` (UTC) → Date; qualquer outra coisa → null. */
function dia(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d
}

/**
 * Admin ATRIBUÍDO (linha `admin` em `usuario_filial` de usuário ativo) ou sessão de staff. Ao
 * contrário de `exigirPapel('admin')`, o modo fundador NÃO vale: apagar dado de titular e ligar a
 * anonimização em massa pedem alguém que o tenant designou.
 * TODO(D3b): usar o helper estrito de papel quando integrar
 */
export async function adminAtribuidoOuStaff(req: FastifyRequest): Promise<boolean> {
  if (req.atorStaff) return true
  if (!req.tenantId) return false
  const sub = subDoUsuario(req)
  const [l] = await req.comTenant((tx) => tx<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM usuario u
                     JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id
                    WHERE u.tenant_id = tenant_atual() AND u.cognito_sub = ${sub} AND u.ativo
                      AND uf.papel = 'admin') AS ok`)
  return l?.ok ?? false
}

/** preHandler com `adminAtribuidoOuStaff`. */
export async function exigirAdminAtribuido(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (await adminAtribuidoOuStaff(req)) return undefined
  return reply.code(403).send({
    erro: 'acesso.admin_atribuido',
    mensagem: 'Só um administrador designado na equipe pode fazer isto. Peça a ele ou atribua o papel em Equipe.',
    exige: ['admin'],
  })
}

export async function rotasLgpd(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Querystring: { somenteCanais?: string }; Body: { protocolo?: unknown; solicitadoEm?: unknown } | undefined }>(
    '/v1/contatos/:id/anonimizar',
    { preHandler: [exigirTenant, exigirAdminAtribuido] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })
      const somenteCanais = req.query?.somenteCanais === 'true'
      const corpo = req.body ?? {}
      const protocolo = typeof corpo.protocolo === 'string' && corpo.protocolo.trim() ? corpo.protocolo.trim() : null
      if (protocolo !== null && !PROTOCOLO.test(protocolo)) {
        return reply.code(422).send({ erro: 'lgpd.protocolo_invalido', campo: 'protocolo', mensagem: 'Protocolo: até 60 letras, números, ponto, barra ou hífen.' })
      }
      const solicitadoEm = corpo.solicitadoEm === undefined || corpo.solicitadoEm === null || corpo.solicitadoEm === '' ? null : dia(corpo.solicitadoEm)
      if (solicitadoEm === null && corpo.solicitadoEm !== undefined && corpo.solicitadoEm !== null && corpo.solicitadoEm !== '') {
        return reply.code(422).send({ erro: 'lgpd.data_invalida', campo: 'solicitadoEm', mensagem: 'Data da solicitação no formato AAAA-MM-DD.' })
      }
      const agora = new Date()
      if (solicitadoEm && solicitadoEm.getTime() > agora.getTime()) {
        return reply.code(422).send({ erro: 'lgpd.data_invalida', campo: 'solicitadoEm', mensagem: 'A data da solicitação não pode estar no futuro.' })
      }
      const r = await req.comTenant(async (tx) => {
        const atorId = req.atorStaff ? null : await garantirUsuarioId(tx, req)
        return anonimizarContato(tx, req.params.id, {
          motivo: 'titular', agora, atorId, atorStaff: req.atorStaff ?? false, somenteCanais, protocolo, solicitadoEm,
        })
      })
      if (!r.ok && r.erro === 'contato_nao_encontrado') {
        return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })
      }
      if (!r.ok) {
        return reply.code(422).send({
          erro: 'lgpd.contato_com_compra',
          mensagem: 'Este contato tem compra registrada ou veio do ERP (dado fiscal) e não pode ser anonimizado por inteiro. '
            + 'Você pode apagar só os canais de contato e as conversas, mantendo o vínculo fiscal.',
          acao: { somenteCanais: true },
        })
      }
      return reply.send({ ok: true, modo: r.modo, jaAnonimizado: r.jaAnonimizado, midiasPendentes: r.midiasPendentes })
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

  app.get('/v1/lgpd/previa', { preHandler: [exigirTenant, exigirPapel('admin')] }, async (req, reply) => {
    const r = await req.comTenant(async (tx) => {
      const [t] = await tx<{ lgpd_auto: boolean; lgpd_auto_alterada_em: Date | null; retencao_meses: number }[]>`
        SELECT lgpd_auto, lgpd_auto_alterada_em, retencao_meses FROM tenant WHERE id = tenant_atual()`
      const previa = await previaAnonimizacao(tx, { agora: new Date() })
      return { ativa: t?.lgpd_auto ?? false, alteradaEm: t?.lgpd_auto_alterada_em ?? null, retencaoMeses: t?.retencao_meses ?? 12, ...previa }
    })
    return reply.send(r)
  })

  app.post<{ Body: { ativar?: unknown; confirmo?: unknown } | undefined }>(
    '/v1/lgpd/automatica',
    { preHandler: [exigirTenant, exigirAdminAtribuido] },
    async (req, reply) => {
      const ativar = req.body?.ativar
      if (typeof ativar !== 'boolean') {
        return reply.code(422).send({ erro: 'lgpd.ativar_invalido', campo: 'ativar', mensagem: 'Informe ativar: true ou false.' })
      }
      const agora = new Date()
      const r = await req.comTenant(async (tx) => {
        const previa = await previaAnonimizacao(tx, { agora })
        // Ligar é irreversível para quem cair na primeira passada: só com a confirmação explícita.
        if (ativar && req.body?.confirmo !== true) return { tipo: 'sem_confirmacao' as const, previa }
        const [t] = await tx<{ lgpd_auto: boolean }[]>`
          UPDATE tenant SET lgpd_auto = ${ativar}, lgpd_auto_alterada_em = ${agora}::timestamptz
           WHERE id = tenant_atual() RETURNING lgpd_auto`
        const atorId = req.atorStaff ? null : await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'lgpd.automatica_alterada', entidade: 'tenant',
          dados: { ativa: ativar, previa: { ...previa.porMotivo, limitado: previa.limitado } },
        })
        return { tipo: 'ok' as const, ativa: t?.lgpd_auto ?? ativar, previa }
      })
      if (r.tipo === 'sem_confirmacao') {
        return reply.code(422).send({
          erro: 'lgpd.confirmacao_exigida',
          mensagem: 'Confira a prévia e confirme: a primeira passada anonimiza estes contatos e não tem volta.',
          previa: r.previa,
        })
      }
      return reply.send({ ok: true, ativa: r.ativa, alteradaEm: agora.toISOString(), previa: r.previa })
    },
  )
}
