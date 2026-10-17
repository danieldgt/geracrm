import type { FastifyInstance, FastifyRequest } from 'fastify'
import { textoAvisoPrivacidade, verificarNumerosNaResposta } from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { lerPrivacidade, VERSAO_PADRAO } from './privacidade.js'

/**
 * PRIVACIDADE (raia P4, 0098):
 *
 *   GET /v1/privacidade                         — configuração + prévia do aviso (qualquer usuário do tenant)
 *   PUT /v1/privacidade                         — grava (admin; auditada com {antes, depois})
 *   GET /v1/contatos/:id/avisos-privacidade     — avisos exibidos ao contato, por cursor (gestor/admin:
 *                                                 é prova LGPD, não dado de atendimento)
 *
 * ⚠️ O tenant sai do token (RLS), nunca do corpo.
 */
const PAGINA = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/

interface CorpoPrivacidade { url?: unknown; versao?: unknown; textoPadrao?: unknown }

type Validacao =
  | { ok: true; url: string | null; versao: string; textoPadrao: string | null }
  | { ok: false; campo: string; mensagem: string }

/** Puro: valida e normaliza o corpo do PUT. */
export function validarPrivacidade(b: CorpoPrivacidade | undefined): Validacao {
  const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const url = texto(b?.url)
  if (url && (!/^https?:\/\/\S+$/i.test(url) || url.length > 300)) {
    return { ok: false, campo: 'url', mensagem: 'Informe um link começando com http:// ou https:// (até 300 caracteres).' }
  }
  const versao = texto(b?.versao) || VERSAO_PADRAO
  if (versao.length > 40) return { ok: false, campo: 'versao', mensagem: 'A versão tem no máximo 40 caracteres.' }
  const textoPadrao = texto(b?.textoPadrao)
  if (textoPadrao.length > 500) return { ok: false, campo: 'textoPadrao', mensagem: 'O texto do aviso tem no máximo 500 caracteres.' }
  // ⚠️ O aviso sai na abertura, antes de qualquer ferramenta: valor ou
  //    percentual ali seria número sem fonte (e a rede descartaria a abertura).
  if (textoPadrao && (verificarNumerosNaResposta(textoPadrao, new Set()).length > 0 || /\d+(?:[.,]\d+)?\s*%|\bR\$/i.test(textoPadrao))) {
    return { ok: false, campo: 'textoPadrao', mensagem: 'O aviso de privacidade não pode citar valor em reais nem percentual.' }
  }
  return { ok: true, url: url || null, versao, textoPadrao: textoPadrao || null }
}

/** A linha de `usuario` nasce no batimento; garantir antes de `exigirPapel` (sem ela, o papel não resolve). */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

export async function rotasPrivacidade(app: FastifyInstance): Promise<void> {
  app.get('/v1/privacidade', { preHandler: exigirTenant }, async (req, reply) => {
    const cfg = await req.comTenant((tx) => lerPrivacidade(tx))
    return reply.send({ ...cfg, previa: textoAvisoPrivacidade({ url: cfg.url, textoPadrao: cfg.textoPadrao }) })
  })

  app.put<{ Body: CorpoPrivacidade }>(
    '/v1/privacidade',
    { preHandler: [exigirTenant, exigirPapel('admin')] },
    async (req, reply) => {
      const v = validarPrivacidade(req.body)
      if (!v.ok) return reply.code(422).send({ erro: 'privacidade.invalida', campo: v.campo, mensagem: v.mensagem })
      const depois = await req.comTenant(async (tx) => {
        const antes = await lerPrivacidade(tx)
        await tx`
          INSERT INTO tenant_privacidade (tenant_id, url, versao, texto_padrao, atualizado_em)
          VALUES (tenant_atual(), ${v.url}, ${v.versao}, ${v.textoPadrao}, now())
          ON CONFLICT (tenant_id) DO UPDATE
            SET url = EXCLUDED.url, versao = EXCLUDED.versao, texto_padrao = EXCLUDED.texto_padrao, atualizado_em = now()`
        const novo = await lerPrivacidade(tx)
        await auditar(tx, {
          atorId: req.atorStaff ? null : await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'privacidade.alterada', entidade: 'tenant_privacidade',
          dados: {
            antes: { url: antes.url, versao: antes.versao, textoPadrao: antes.textoPadrao },
            depois: { url: novo.url, versao: novo.versao, textoPadrao: novo.textoPadrao },
          },
        })
        return novo
      })
      return reply.send({ ...depois, previa: textoAvisoPrivacidade({ url: depois.url, textoPadrao: depois.textoPadrao }) })
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/contatos/:id/avisos-privacidade',
    { preHandler: [exigirTenant, garantirUsuario, exigirPapel('gestor', 'admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(422).send({ erro: 'contato.id_invalido', mensagem: 'Contato inválido.' })
      let cursor: { em: string; id: string } | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id) || !TIMESTAMP.test(em)) return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
        cursor = { em, id }
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; canal_id: string; mensagem_id: string; texto: string; versao: string
        origem: string; exibido_em: Date; exibido_em_txt: string
      }[]>`
        SELECT id, conversa_id, canal_id, mensagem_id, texto, versao, origem, exibido_em, exibido_em::text AS exibido_em_txt
          FROM aviso_privacidade
         WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}
           AND ${cursor === null ? tx`true` : tx`(exibido_em, id) < (${cursor.em}::text::timestamptz, ${cursor.id}::uuid)`}
         ORDER BY exibido_em DESC, id DESC
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, conversaId: l.conversa_id, canalId: l.canal_id, mensagemId: l.mensagem_id,
          texto: l.texto, versao: l.versao, origem: l.origem, exibidoEm: l.exibido_em,
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.exibido_em_txt}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )
}
