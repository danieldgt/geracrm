import type { FastifyInstance } from 'fastify'
import type { Sql } from '../../db/index.js'
import { normalizarTelefone } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { exigirAdminAtribuido } from './rotas-lgpd.js'

const PAGINA = 30
const MOTIVOS = new Set(['opt_out', 'denuncia', 'manual', 'invalido'])

/**
 * Gestão de opt-out / bloqueio (EP-04). ⚠️ A `lista_bloqueio` já é respeitada no
 * servidor pelo gateway de envio (E5-13) — esta rota é só para GERIR a lista.
 *
 * ⚠️ Bloqueio é por `chave_bloqueio` (55+DDD+8 últimos, INV-50), não por e164 —
 * vale com e sem o nono dígito. A tela manda um telefone; nós derivamos a chave.
 */
export async function rotasBloqueios(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/bloqueios',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let cursorEm: string | null = null
      let cursorChave: string | null = null
      if (req.query.cursor) {
        const [em, ch] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !ch) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
        cursorEm = em; cursorChave = ch
      }
      const linhas = await req.comTenant((tx) => tx<{
        chave_bloqueio: string; motivo: string; origem: string | null; bloqueado_em: Date; lgpd_em: Date | null
      }[]>`
        SELECT chave_bloqueio, motivo, origem, bloqueado_em, lgpd_em
          FROM lista_bloqueio
         WHERE tenant_id = tenant_atual()
           AND ${cursorEm === null ? tx`true` : tx`
                 (bloqueado_em, chave_bloqueio) < (${cursorEm}::timestamptz, ${cursorChave})`}
         ORDER BY bloqueado_em DESC, chave_bloqueio DESC
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.bloqueado_em.toISOString()}§${ultimo.chave_bloqueio}`).toString('base64url')
        : null

      return reply.send({
        itens: pagina.map((l) => ({
          chave: l.chave_bloqueio, motivo: l.motivo, origem: l.origem, bloqueadoEm: l.bloqueado_em,
          lgpd: l.lgpd_em !== null,
        })),
        proximoCursor,
      })
    },
  )

  /** Bloqueia um telefone (opt-out manual pela tela). Idempotente. */
  app.post<{ Body: { telefone?: string; motivo?: string } }>(
    '/v1/bloqueios',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const tel = normalizarTelefone(req.body?.telefone ?? '')
      if (!tel) return reply.code(422).send({ erro: 'telefone.invalido', mensagem: 'Telefone inválido.' })
      const motivo = MOTIVOS.has(req.body?.motivo ?? '') ? req.body!.motivo! : 'opt_out'

      await req.comTenant((tx) => tx`
        INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem)
        VALUES (tenant_atual(), ${tel.chaveBloqueio}, ${motivo}, 'console')
        ON CONFLICT (tenant_id, chave_bloqueio) DO NOTHING`)
      return reply.code(201).send({ ok: true, chave: tel.chaveBloqueio })
    },
  )

  /**
   * Remove o bloqueio (desfaz o opt-out). Grava `consentimento_contato` `whatsapp` CONCEDIDO para os
   * contatos que têm o número: é o rastro de que a recusa foi desfeita — e o que tira o contato da
   * anonimização por opt-out.
   * ⚠️ Bloqueio LGPD (`lgpd_em`) não sai por aqui: só por novo consentimento auditado (abaixo).
   */
  app.delete<{ Params: { chave: string } }>(
    '/v1/bloqueios/:chave',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const chave = req.params.chave
      if (!/^\d{10,13}$/.test(chave)) return reply.code(422).send({ erro: 'chave.invalida' })
      const r = await req.comTenant(async (tx) => {
        // Um comando só: sem janela entre "ler o motivo" e "apagar".
        const [apagado] = await tx<{ chave_bloqueio: string }[]>`
          DELETE FROM lista_bloqueio
           WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${chave} AND lgpd_em IS NULL
          RETURNING chave_bloqueio`
        if (!apagado) {
          const [lgpd] = await tx<{ ok: number }[]>`
            SELECT 1 AS ok FROM lista_bloqueio WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${chave} AND lgpd_em IS NOT NULL`
          return lgpd ? 'lgpd' as const : 'nada' as const
        }
        await concederWhatsapp(tx, chave, 'desbloqueio_manual')
        return 'ok' as const
      })
      if (r === 'lgpd') {
        return reply.code(422).send({
          erro: 'bloqueio.lgpd_irremovivel',
          mensagem: 'O titular deste número pediu para ser esquecido (LGPD). Só um administrador pode liberar, '
            + 'registrando o novo consentimento do titular.',
          acao: { novoConsentimento: true },
        })
      }
      return reply.send({ ok: true })
    },
  )

  /**
   * NOVO CONSENTIMENTO do titular para um número com bloqueio LGPD — admin atribuído ou staff.
   * Exige a evidência (onde/como o titular consentiu). Remove o bloqueio, grava consentimento
   * `concedido=true` para quem tem o número hoje e audita (sem o número: só os 4 últimos dígitos).
   */
  app.post<{ Params: { chave: string }; Body: { origem?: unknown; evidencia?: unknown } | undefined }>(
    '/v1/bloqueios/:chave/novo-consentimento',
    { preHandler: [exigirTenant, exigirAdminAtribuido] },
    async (req, reply) => {
      const chave = req.params.chave
      if (!/^\d{10,13}$/.test(chave)) return reply.code(422).send({ erro: 'chave.invalida' })
      if (req.body?.origem !== 'titular') {
        return reply.code(422).send({ erro: 'consentimento.origem_invalida', campo: 'origem', mensagem: 'O novo consentimento precisa vir do titular (origem: titular).' })
      }
      const evidencia = typeof req.body?.evidencia === 'string' ? req.body.evidencia.trim() : ''
      if (evidencia.length < 5 || evidencia.length > 500) {
        return reply.code(422).send({ erro: 'consentimento.evidencia_invalida', campo: 'evidencia', mensagem: 'Descreva a evidência do consentimento (5 a 500 caracteres).' })
      }
      const r = await req.comTenant(async (tx) => {
        const [apagado] = await tx<{ motivo: string }[]>`
          DELETE FROM lista_bloqueio
           WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${chave} AND lgpd_em IS NOT NULL
          RETURNING motivo`
        if (!apagado) return null
        const contatos = await concederWhatsapp(tx, chave, 'novo_consentimento_titular')
        const atorId = req.atorStaff ? null : await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'bloqueio.novo_consentimento', entidade: 'lista_bloqueio',
          dados: { finalChave: chave.slice(-4), motivoAnterior: apagado.motivo, origem: 'titular', evidencia, contatos },
        })
        return { contatos }
      })
      if (!r) return reply.code(404).send({ erro: 'bloqueio.lgpd_nao_encontrado', mensagem: 'Este número não tem bloqueio LGPD.' })
      return reply.send({ ok: true, contatos: r.contatos })
    },
  )
}

/** Consentimento `whatsapp` concedido para todo contato que tem a chave. Devolve quantos. Sob tenant. */
async function concederWhatsapp(tx: Sql, chave: string, origem: string): Promise<number> {
  const r = await tx`
    INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
    SELECT DISTINCT tenant_atual(), ct.contato_id, 'whatsapp', true, ${origem},
           -- ⚠️ É SEMPRE o registro mais recente (relógio do banco atrás de um registro injetado não
           --    pode deixar a recusa antiga "por cima" e manter o contato na fila de anonimização).
           greatest(clock_timestamp(),
                    (SELECT max(cc.registrado_em) + interval '1 millisecond' FROM consentimento_contato cc
                      WHERE cc.tenant_id = ct.tenant_id AND cc.contato_id = ct.contato_id AND cc.tipo = 'whatsapp'))
      FROM contato_telefone ct
     WHERE ct.tenant_id = tenant_atual() AND ct.chave_bloqueio = ${chave}
    ON CONFLICT DO NOTHING`
  return r.count
}
