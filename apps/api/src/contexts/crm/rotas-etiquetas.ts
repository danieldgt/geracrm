import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { exigirNoEscopo } from '../plataforma/escopo.js'
import { auditar } from '../plataforma/auditoria.js'
import { atorDaRequisicao } from '../atendimento/rotas-fila.js'

const PAGINA = 50
const MAX_ETIQUETAS_POR_CONTATO = 50
/** Paleta FIXA: a cor é o nome de um token do design system, nunca um hex. */
export const CORES_ETIQUETA = ['acao', 'sucesso', 'atencao', 'erro', 'ia', 'neutro'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const escrita = [exigirTenant, exigirPapel('gestor')]

const invalido = (reply: FastifyReply, erro: string, mensagem: string) => reply.code(422).send({ erro, mensagem })
const duplicado = (reply: FastifyReply, erro: string, nome: string) =>
  reply.code(409).send({ erro, mensagem: `Já existe um registro com o nome "${nome}".` })
const ehViolacaoUnica = (e: unknown) => (e as { code?: string })?.code === '23505'
const corValida = (v: unknown) => typeof v === 'string' && (CORES_ETIQUETA as readonly string[]).includes(v)

function nomeValido(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const nome = v.trim()
  return nome.length >= 1 && nome.length <= max ? nome : null
}

/** Cursor opaco da lista pequena: (chave de ordem, id). */
function lerCursor(bruto: string | undefined): { chave: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  try {
    const o = JSON.parse(Buffer.from(bruto, 'base64url').toString('utf8')) as { k?: unknown; i?: unknown }
    if (typeof o.k !== 'string' || typeof o.i !== 'string' || !UUID.test(o.i)) return 'invalido'
    return { chave: o.k, id: o.i }
  } catch { return 'invalido' }
}
const montarCursor = (chave: string, id: string) =>
  Buffer.from(JSON.stringify({ k: chave, i: id })).toString('base64url')

interface LinhaEtiqueta { id: string; nome: string; cor: string; ativa: boolean }
interface LinhaOrigem { id: string; nome: string; ativa: boolean; ordem: number }

/**
 * Catálogos do CRM (A4): etiquetas e origens do tenant. Leitura para qualquer usuário do tenant;
 * escrita só admin/gestor. `tenant_id` sempre do token (RLS), nunca de parâmetro.
 * Listas por cursor — pequenas, mas o padrão é cursor.
 */
export async function rotasEtiquetas(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- etiquetas
  app.get<{ Querystring: { cursor?: string; ativas?: string } }>(
    '/v1/etiquetas', { preHandler: exigirTenant },
    async (req, reply) => {
      const cur = lerCursor(req.query.cursor)
      if (cur === 'invalido') return invalido(reply, 'cursor.invalido', 'Cursor inválido.')
      const soAtivas = req.query.ativas === 'true'
      const linhas = await req.comTenant((tx) => tx<(LinhaEtiqueta & { chave: string })[]>`
        SELECT id, nome, cor, ativa, lower(nome) AS chave FROM etiqueta
         WHERE tenant_id = tenant_atual()
           AND ${soAtivas ? tx`ativa` : tx`true`}
           AND ${cur === null ? tx`true` : tx`(lower(nome), id) > (${cur.chave}, ${cur.id}::uuid)`}
         ORDER BY lower(nome), id
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({ id: l.id, nome: l.nome, cor: l.cor, ativa: l.ativa })),
        proximoCursor: temMais && ultimo ? montarCursor(ultimo.chave, ultimo.id) : null,
      })
    })

  app.post<{ Body: { nome?: unknown; cor?: unknown } }>(
    '/v1/etiquetas', { preHandler: escrita },
    async (req, reply) => {
      const nome = nomeValido(req.body?.nome, 40)
      if (!nome) return invalido(reply, 'etiqueta.nome_invalido', 'Informe o nome (até 40 caracteres).')
      const cor = req.body?.cor === undefined ? 'neutro' : req.body.cor
      if (!corValida(cor)) return invalido(reply, 'etiqueta.cor_invalida', 'Cor fora da paleta.')
      try {
        const [l] = await req.comTenant((tx) => tx<LinhaEtiqueta[]>`
          INSERT INTO etiqueta (tenant_id, id, nome, cor) VALUES (tenant_atual(), ${randomUUID()}, ${nome}, ${cor as string})
          RETURNING id, nome, cor, ativa`)
        return reply.code(201).send(l)
      } catch (e) {
        if (ehViolacaoUnica(e)) return duplicado(reply, 'etiqueta.nome_duplicado', nome)
        throw e
      }
    })

  app.patch<{ Params: { id: string }; Body: { nome?: unknown; cor?: unknown; ativa?: unknown } }>(
    '/v1/etiquetas/:id', { preHandler: escrita },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'etiqueta.nao_encontrada' })
      const b = req.body ?? {}
      const nome = b.nome === undefined ? null : nomeValido(b.nome, 40)
      if (b.nome !== undefined && !nome) return invalido(reply, 'etiqueta.nome_invalido', 'Nome inválido (até 40 caracteres).')
      if (b.cor !== undefined && !corValida(b.cor)) return invalido(reply, 'etiqueta.cor_invalida', 'Cor fora da paleta.')
      if (b.ativa !== undefined && typeof b.ativa !== 'boolean') return invalido(reply, 'etiqueta.ativa_invalida', 'Campo ativa inválido.')
      try {
        const [l] = await req.comTenant((tx) => tx<LinhaEtiqueta[]>`
          UPDATE etiqueta SET nome = COALESCE(${nome}, nome), cor = COALESCE(${(b.cor as string | undefined) ?? null}, cor),
                              ativa = COALESCE(${(b.ativa as boolean | undefined) ?? null}, ativa)
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
          RETURNING id, nome, cor, ativa`)
        if (!l) return reply.code(404).send({ erro: 'etiqueta.nao_encontrada' })
        return reply.send(l)
      } catch (e) {
        if (ehViolacaoUnica(e)) return duplicado(reply, 'etiqueta.nome_duplicado', nome ?? '')
        throw e
      }
    })

  // ------------------------------------------------------------------ origens
  app.get<{ Querystring: { cursor?: string; ativas?: string } }>(
    '/v1/origens', { preHandler: exigirTenant },
    async (req, reply) => {
      const cur = lerCursor(req.query.cursor)
      if (cur === 'invalido') return invalido(reply, 'cursor.invalido', 'Cursor inválido.')
      const soAtivas = req.query.ativas === 'true'
      // Chave de ordem textual: ordem com zeros à esquerda + nome sem caixa.
      const linhas = await req.comTenant((tx) => tx<(LinhaOrigem & { chave: string })[]>`
        SELECT id, nome, ativa, ordem, lpad(ordem::text, 4, '0') || lower(nome) AS chave FROM origem
         WHERE tenant_id = tenant_atual()
           AND ${soAtivas ? tx`ativa` : tx`true`}
           AND ${cur === null ? tx`true` : tx`(lpad(ordem::text, 4, '0') || lower(nome), id) > (${cur.chave}, ${cur.id}::uuid)`}
         ORDER BY lpad(ordem::text, 4, '0') || lower(nome), id
         LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({ id: l.id, nome: l.nome, ativa: l.ativa, ordem: l.ordem })),
        proximoCursor: temMais && ultimo ? montarCursor(ultimo.chave, ultimo.id) : null,
      })
    })

  const ordemValida = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999 ? v : null

  app.post<{ Body: { nome?: unknown; ordem?: unknown } }>(
    '/v1/origens', { preHandler: escrita },
    async (req, reply) => {
      const nome = nomeValido(req.body?.nome, 60)
      if (!nome) return invalido(reply, 'origem.nome_invalido', 'Informe o nome (até 60 caracteres).')
      const ordem = req.body?.ordem === undefined ? 0 : ordemValida(req.body.ordem)
      if (ordem === null) return invalido(reply, 'origem.ordem_invalida', 'Ordem deve ser um inteiro de 0 a 9999.')
      try {
        const [l] = await req.comTenant((tx) => tx<LinhaOrigem[]>`
          INSERT INTO origem (tenant_id, id, nome, ordem) VALUES (tenant_atual(), ${randomUUID()}, ${nome}, ${ordem})
          RETURNING id, nome, ativa, ordem`)
        return reply.code(201).send(l)
      } catch (e) {
        if (ehViolacaoUnica(e)) return duplicado(reply, 'origem.nome_duplicado', nome)
        throw e
      }
    })

  app.patch<{ Params: { id: string }; Body: { nome?: unknown; ordem?: unknown; ativa?: unknown } }>(
    '/v1/origens/:id', { preHandler: escrita },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'origem.nao_encontrada' })
      const b = req.body ?? {}
      const nome = b.nome === undefined ? null : nomeValido(b.nome, 60)
      if (b.nome !== undefined && !nome) return invalido(reply, 'origem.nome_invalido', 'Nome inválido (até 60 caracteres).')
      const ordem = b.ordem === undefined ? null : ordemValida(b.ordem)
      if (b.ordem !== undefined && ordem === null) return invalido(reply, 'origem.ordem_invalida', 'Ordem deve ser um inteiro de 0 a 9999.')
      if (b.ativa !== undefined && typeof b.ativa !== 'boolean') return invalido(reply, 'origem.ativa_invalida', 'Campo ativa inválido.')
      try {
        const [l] = await req.comTenant((tx) => tx<LinhaOrigem[]>`
          UPDATE origem SET nome = COALESCE(${nome}, nome), ordem = COALESCE(${ordem}::integer, ordem),
                            ativa = COALESCE(${(b.ativa as boolean | undefined) ?? null}, ativa)
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
          RETURNING id, nome, ativa, ordem`)
        if (!l) return reply.code(404).send({ erro: 'origem.nao_encontrada' })
        return reply.send(l)
      } catch (e) {
        if (ehViolacaoUnica(e)) return duplicado(reply, 'origem.nome_duplicado', nome ?? '')
        throw e
      }
    })

  // ------------------------------------------------------ etiquetas do contato
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/etiquetas', { preHandler: [exigirTenant, exigirNoEscopo('contato')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        // Teto por contato (MAX_ETIQUETAS_POR_CONTATO): não é lista aberta.
        return tx<LinhaEtiqueta[]>`
          SELECT e.id, e.nome, e.cor, e.ativa FROM contato_etiqueta ce
            JOIN etiqueta e ON e.tenant_id = ce.tenant_id AND e.id = ce.etiqueta_id
           WHERE ce.tenant_id = tenant_atual() AND ce.contato_id = ${req.params.id}
           ORDER BY lower(e.nome), e.id LIMIT ${MAX_ETIQUETAS_POR_CONTATO}`
      })
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ itens: r })
    })

  /**
   * Substitui o conjunto. Só vale etiqueta ATIVA do tenant — ou já vinculada ao contato (uma
   * etiqueta desativada depois não pode travar o salvamento do resto). Alguma inexistente →
   * 422 `etiqueta.inexistente` com os ids; nada é gravado.
   */
  app.put<{ Params: { id: string }; Body: { etiquetaIds?: unknown } }>(
    '/v1/contatos/:id/etiquetas', { preHandler: [exigirTenant, exigirNoEscopo('contato')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const bruto = req.body?.etiquetaIds
      if (!Array.isArray(bruto) || bruto.some((x) => typeof x !== 'string' || !UUID.test(x))) {
        return invalido(reply, 'etiquetas.corpo_invalido', 'etiquetaIds deve ser uma lista de UUIDs.')
      }
      const ids = [...new Set((bruto as string[]).map((x) => x.toLowerCase()))]
      if (ids.length > MAX_ETIQUETAS_POR_CONTATO) {
        return invalido(reply, 'etiquetas.excesso', `No máximo ${MAX_ETIQUETAS_POR_CONTATO} etiquetas por contato.`)
      }
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { tipo: 'sem_contato' as const }
        const validas = ids.length === 0 ? [] : await tx<{ id: string }[]>`
          SELECT e.id FROM etiqueta e
           WHERE e.tenant_id = tenant_atual() AND e.id = ANY(${ids}::uuid[])
             AND (e.ativa OR EXISTS (SELECT 1 FROM contato_etiqueta ce
                   WHERE ce.tenant_id = e.tenant_id AND ce.contato_id = ${req.params.id} AND ce.etiqueta_id = e.id))`
        const ok = new Set(validas.map((v) => v.id))
        const faltando = ids.filter((i) => !ok.has(i))
        if (faltando.length > 0) return { tipo: 'inexistente' as const, faltando }
        const antes = new Set((await tx<{ etiqueta_id: string }[]>`
          SELECT etiqueta_id FROM contato_etiqueta WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`)
          .map((x) => x.etiqueta_id))
        await tx`DELETE FROM contato_etiqueta
                  WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}
                    AND NOT (etiqueta_id = ANY(${ids}::uuid[]))`
        if (ids.length > 0) {
          await tx`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id)
                   SELECT tenant_atual(), ${req.params.id}, x FROM unnest(${ids}::uuid[]) AS x
                   ON CONFLICT DO NOTHING`
        }
        // Rastro para o feed da ficha (A3): só grava se algo mudou; nomes (não ids) no resumo.
        const novas = ids.filter((i) => !antes.has(i))
        const fora = [...antes].filter((i) => !ids.includes(i))
        if (novas.length > 0 || fora.length > 0) {
          const nomes = async (lista: string[]) => lista.length === 0 ? [] : (await tx<{ nome: string }[]>`
            SELECT nome FROM etiqueta WHERE tenant_id = tenant_atual() AND id = ANY(${lista}::uuid[]) ORDER BY nome`).map((n) => n.nome)
          const add = await nomes(novas)
          const rem = await nomes(fora)
          const partes = [add.length ? `adicionou ${add.join(', ')}` : '', rem.length ? `removeu ${rem.join(', ')}` : ''].filter(Boolean)
          const resumo = `Etiquetas: ${partes.join('; ')}`
          await auditar(tx, {
            atorId: await atorDaRequisicao(tx, req), acao: 'contato.etiquetas_alteradas', entidade: 'contato',
            entidadeId: req.params.id, dados: { resumo, adicionadas: add, removidas: rem },
          })
        }
        return { tipo: 'ok' as const }
      })
      if (r.tipo === 'sem_contato') return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      if (r.tipo === 'inexistente') {
        return reply.code(422).send({
          erro: 'etiqueta.inexistente', mensagem: 'Alguma etiqueta não existe ou está inativa.', etiquetaIds: r.faltando,
        })
      }
      return reply.send({ ok: true, etiquetaIds: ids })
    })
}
