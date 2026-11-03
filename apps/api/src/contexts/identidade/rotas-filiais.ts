import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { exigirPapel } from '../plataforma/papel.js'

/**
 * CADASTRO DE FILIAIS (raia D3, #98) — só ADMIN.
 *
 * A filial é a unidade do escopo de gestor/supervisor (`escopo.ts`): quem tem
 * papel numa filial vê os clientes dos vendedores dela. Desativar uma filial
 * (`ativa = false`) NÃO apaga vínculo nem muda escopo — é cadastro, a tela
 * deixa de oferecê-la para novos vínculos.
 *
 * ⚠️ `tipo`: 'matriz' | 'filial'; no máximo UMA matriz por tenant (índice
 *    `filial_matriz_unica`, 0111) → 409 `filial.matriz_duplicada`.
 * ⚠️ `cor`: '#RRGGBB' (CHECK no banco) — o chip da unidade nas telas.
 * ⚠️ Tenant SEMPRE de `tenant_atual()` (ADR-001).
 */

const PAGINA = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COR = /^#[0-9A-Fa-f]{6}$/
const UF = /^[A-Za-z]{2}$/
const TIPOS = ['matriz', 'filial'] as const

interface CorpoFilial { nome?: string; cidade?: string | null; uf?: string | null; tipo?: string; cor?: string | null; ativa?: boolean }

/** Valida o corpo; devolve a recusa tipificada ou null. `criando` exige nome. */
function validar(b: CorpoFilial, criando: boolean): { erro: string; mensagem: string; campos: string[] } | null {
  if ((criando || b.nome !== undefined) && !b.nome?.trim()) return { erro: 'filial.nome_obrigatorio', mensagem: 'Informe o nome da filial.', campos: ['nome'] }
  if (b.tipo !== undefined && !(TIPOS as readonly string[]).includes(b.tipo)) return { erro: 'filial.tipo_invalido', mensagem: 'Tipo deve ser matriz ou filial.', campos: ['tipo'] }
  if (b.cor !== undefined && b.cor !== null && !COR.test(b.cor)) return { erro: 'filial.cor_invalida', mensagem: 'Cor no formato #RRGGBB.', campos: ['cor'] }
  if (b.uf !== undefined && b.uf !== null && b.uf !== '' && !UF.test(b.uf)) return { erro: 'filial.uf_invalida', mensagem: 'UF com duas letras.', campos: ['uf'] }
  if (b.ativa !== undefined && typeof b.ativa !== 'boolean') return { erro: 'filial.ativa_invalida', mensagem: 'ativa deve ser verdadeiro ou falso.', campos: ['ativa'] }
  return null
}

const ehMatrizDuplicada = (e: unknown) =>
  (e as { code?: string; constraint_name?: string })?.code === '23505'
  && String((e as { constraint_name?: string }).constraint_name ?? (e as Error).message).includes('filial_matriz_unica')

const MATRIZ_DUPLICADA = { erro: 'filial.matriz_duplicada', mensagem: 'Já existe uma matriz. Mude a atual para filial antes.', campos: ['tipo'] }

const texto = (v: string | null | undefined) => (v === undefined ? undefined : (v?.trim() || null))

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

export async function rotasFiliais(app: FastifyInstance): Promise<void> {
  const SO_ADMIN = { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] }

  /** Lista por cursor `(nome, id)`, com quantos usuários têm papel em cada uma. */
  app.get<{ Querystring: { cursor?: string } }>('/v1/filiais', SO_ADMIN, async (req, reply) => {
    let curNome: string | null = null, curId: string | null = null
    if (req.query.cursor) {
      const [nome, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
      if (nome === undefined || !id || !UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
      curNome = nome; curId = id
    }
    const linhas = await req.comTenant((tx) => tx<{
      id: string; nome: string; cidade: string | null; uf: string | null; tipo: string; cor: string | null; ativa: boolean; usuarios: number
    }[]>`
      SELECT f.id, f.nome, f.cidade, f.uf, f.tipo, f.cor, f.ativa,
             (SELECT count(DISTINCT uf.usuario_id)::int FROM usuario_filial uf
               WHERE uf.tenant_id = f.tenant_id AND uf.filial_id = f.id) AS usuarios
        FROM filial f
       WHERE f.tenant_id = tenant_atual()
         AND ${curNome === null ? tx`true` : tx`(f.nome, f.id) > (${curNome}, ${curId}::uuid)`}
       ORDER BY f.nome ASC, f.id ASC
       LIMIT ${PAGINA + 1}`)
    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina,
      proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.nome}§${ultimo.id}`).toString('base64url') : null,
    })
  })

  app.post<{ Body: CorpoFilial }>('/v1/filiais', SO_ADMIN, async (req, reply) => {
    const b = req.body ?? {}
    const invalido = validar(b, true)
    if (invalido) return reply.code(422).send(invalido)
    const id = randomUUID()
    try {
      await req.comTenant(async (tx) => {
        await tx`INSERT INTO filial (tenant_id, id, nome, cidade, uf, tipo, cor, ativa)
                 VALUES (tenant_atual(), ${id}, ${b.nome!.trim()}, ${texto(b.cidade) ?? null},
                         ${texto(b.uf)?.toUpperCase() ?? null}, ${b.tipo ?? 'filial'}, ${b.cor ?? null}, ${b.ativa ?? true})`
        await auditar(tx, {
          atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'filial.criada', entidade: 'filial', entidadeId: id, dados: { nome: b.nome!.trim(), tipo: b.tipo ?? 'filial' },
        })
      })
    } catch (e) {
      if (ehMatrizDuplicada(e)) return reply.code(409).send(MATRIZ_DUPLICADA)
      throw e
    }
    return reply.code(201).send({ id })
  })

  app.patch<{ Params: { id: string }; Body: CorpoFilial }>('/v1/filiais/:id', SO_ADMIN, async (req, reply) => {
    const id = req.params.id
    if (!UUID.test(id)) return reply.code(404).send({ erro: 'filial.nao_encontrada' })
    const b = req.body ?? {}
    const invalido = validar(b, false)
    if (invalido) return reply.code(422).send(invalido)
    const cidade = texto(b.cidade)
    const uf = texto(b.uf)
    if (b.nome === undefined && cidade === undefined && uf === undefined && b.tipo === undefined && b.cor === undefined && b.ativa === undefined) {
      return reply.code(422).send({ erro: 'filial.nada_a_mudar' })
    }
    try {
      const ok = await req.comTenant(async (tx) => {
        const [r] = await tx`
          UPDATE filial SET
            nome   = ${b.nome === undefined ? tx`nome` : b.nome.trim()},
            cidade = ${cidade === undefined ? tx`cidade` : cidade},
            uf     = ${uf === undefined ? tx`uf` : (uf?.toUpperCase() ?? null)},
            tipo   = ${b.tipo === undefined ? tx`tipo` : b.tipo},
            cor    = ${b.cor === undefined ? tx`cor` : b.cor},
            ativa  = ${b.ativa === undefined ? tx`ativa` : b.ativa}
           WHERE tenant_id = tenant_atual() AND id = ${id} RETURNING id`
        if (!r) return false
        await auditar(tx, {
          atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'filial.alterada', entidade: 'filial', entidadeId: id, dados: { campos: Object.keys(b) },
        })
        return true
      })
      if (!ok) return reply.code(404).send({ erro: 'filial.nao_encontrada' })
    } catch (e) {
      if (ehMatrizDuplicada(e)) return reply.code(409).send(MATRIZ_DUPLICADA)
      throw e
    }
    return reply.send({ ok: true })
  })
}
