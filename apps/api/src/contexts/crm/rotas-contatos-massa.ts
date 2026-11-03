import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  ehAcaoEmMassaContato, ehMotivoDescarteContato, LIMITE_ACAO_EM_MASSA, rotuloMotivoDescarte,
  type AcaoEmMassaContato,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { condicaoContato, escopoDaRequisicao } from '../plataforma/escopo.js'
import { temPapel } from '../plataforma/papel.js'
import { qualificarContato, type EstadoQualificacao } from './qualificacao.js'
import { corpoLote, criarTarefasEmLote, responsavelDoTenantExiste } from './rotas-tarefa.js'

/**
 * Ações em massa sobre a lista de contatos (A2).
 *
 *   POST /v1/contatos/acoes-em-massa/:acao   { contatoIds: uuid[1..500], ... }
 *   → { aplicados, ignorados }
 *
 * ⚠️ O ESCOPO (D3) é aplicado ANTES de agir: contato fora do escopo (ou inexistente,
 *    ou inativo) vira `ignorados` — a resposta só conta, nunca diz qual nem de quem.
 * ⚠️ Cada ação é UMA transação (tudo ou nada) e deixa UMA auditoria
 *    `contatos.acao_em_massa` com a ação e as quantidades — sem lista de nomes nem
 *    texto livre. As regras são as de domínio que já existem: `qualificarContato`,
 *    `transferir_carteira`, as tabelas de etiqueta/lista e `criarTarefasEmLote`.
 * ⚠️ O tenant vem do token (RLS); nenhum parâmetro o carrega.
 *
 * Papéis: transferir e criar tarefa são da gestão (gestor/supervisor/admin), como
 * `/v1/tarefas/lote` e a transferência do funil; as demais valem para quem enxerga
 * o contato.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = z.string().regex(UUID)
const contatoIds = z.array(uuid).min(1).max(LIMITE_ACAO_EM_MASSA)
const etiquetaIds = z.array(uuid).min(1).max(10)

const COM_IDS = z.object({ contatoIds })
const esquemas: Record<AcaoEmMassaContato, z.ZodType> = {
  qualificar: COM_IDS,
  reabrir: COM_IDS,
  descartar: COM_IDS.extend({
    motivo: z.string().refine(ehMotivoDescarteContato),
    observacao: z.string().trim().min(1).max(1000),
  }),
  transferir: COM_IDS.extend({ usuarioId: uuid, motivo: z.string().trim().min(1).max(500) }),
  etiquetar: COM_IDS.extend({ etiquetaIds }),
  desetiquetar: COM_IDS.extend({ etiquetaIds }),
  'adicionar-lista': COM_IDS.extend({ listaId: uuid }),
  'criar-tarefa': corpoLote,
}

/** Ações que só a gestão faz. */
const SO_GESTAO: readonly AcaoEmMassaContato[] = ['transferir', 'criar-tarefa']

interface Resultado { readonly aplicados: number }
type Falha = { readonly falha: string; readonly campos: string[]; readonly mensagem: string }
const ehFalha = (r: Resultado | Falha): r is Falha => 'falha' in r

type Contexto = { tx: Sql; ids: string[]; eu: string; req: FastifyRequest; escopo: Awaited<ReturnType<typeof escopoDaRequisicao>> }

async function qualificarTodos(c: Contexto, estado: EstadoQualificacao, somenteSeEstava?: EstadoQualificacao): Promise<number> {
  let aplicados = 0
  for (const contatoId of c.ids) {
    const r = await qualificarContato(c.tx, {
      contatoId, estado, atorId: c.eu, atorStaff: c.req.atorStaff ?? false, somenteSeEstava,
    })
    if (r.tipo === 'ok') aplicados += 1
  }
  return aplicados
}

export async function rotasContatosAcoesEmMassa(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { acao: string }; Body: unknown }>(
    '/v1/contatos/acoes-em-massa/:acao', { preHandler: exigirTenant },
    async (req, reply) => {
      const acao = req.params.acao
      if (!ehAcaoEmMassaContato(acao)) {
        return reply.code(404).send({ erro: 'contatos.acao_desconhecida', mensagem: 'Ação em massa desconhecida.' })
      }
      if (SO_GESTAO.includes(acao) && !(await temPapel(req, 'gestor', 'supervisor'))) {
        return reply.code(403).send({
          erro: 'acesso.papel_insuficiente', mensagem: 'Seu papel não permite esta ação. Peça a um administrador.',
          exige: ['gestor', 'supervisor', 'admin'],
        })
      }
      const parsed = esquemas[acao].safeParse(req.body)
      if (!parsed.success) return entradaInvalida(reply, parsed.error)
      const corpo = parsed.data as Record<string, unknown> & { contatoIds: string[] }
      const ids = [...new Set(corpo.contatoIds.map((i) => i.toLowerCase()))]

      const r = await req.comTenant(async (tx): Promise<Resultado & { ignorados: number } | Falha> => {
        const escopo = await escopoDaRequisicao(tx, req)
        const eu = await garantirUsuarioId(tx, req)
        const alvo = await validarAlvo(tx, acao, corpo)
        if (alvo) return alvo

        // ⚠️ Só o que o chamador enxerga: o resto vira `ignorados`, sem distinção.
        const visiveis = (await tx<{ id: string }[]>`
          SELECT c.id FROM contato c
           WHERE c.tenant_id = tenant_atual() AND c.id = ANY(${ids}::uuid[]) AND c.ativo
             AND coalesce(c.origem_carga, '') <> 'simulacao'
             AND ${condicaoContato(tx, escopo, 'c')}`).map((l) => l.id)
        const ctx: Contexto = { tx, ids: visiveis, eu, req, escopo }

        const out = visiveis.length === 0 ? { aplicados: 0 } : await executar(ctx, acao, corpo)
        if (ehFalha(out)) return out
        const ignorados = ids.length - out.aplicados
        await auditar(tx, {
          atorId: eu, atorStaff: req.atorStaff ?? false, acao: 'contatos.acao_em_massa', entidade: 'contato',
          // Sem nomes, ids nem texto livre: só a ação, o motivo codificado e as quantidades.
          dados: {
            acao, solicitados: ids.length, aplicados: out.aplicados, ignorados,
            ...(acao === 'descartar' ? { motivo: corpo.motivo } : {}),
          },
        })
        return { aplicados: out.aplicados, ignorados }
      })
      if (ehFalha(r)) return reply.code(422).send({ erro: r.falha, mensagem: r.mensagem, campos: r.campos })
      return reply.send(r)
    },
  )
}

/** Referências do corpo (etiquetas, lista, destino) — checadas antes de qualquer escrita. */
async function validarAlvo(tx: Sql, acao: AcaoEmMassaContato, c: Record<string, unknown>): Promise<Falha | null> {
  if (acao === 'etiquetar') {
    const ids = [...new Set(c.etiquetaIds as string[])]
    const ok = await tx<{ id: string }[]>`
      SELECT id FROM etiqueta WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[]) AND ativa`
    if (ok.length !== ids.length) {
      return { falha: 'etiqueta.inexistente', mensagem: 'Alguma etiqueta não existe ou está inativa.', campos: ['etiquetaIds'] }
    }
  }
  if (acao === 'adicionar-lista') {
    const [l] = await tx`SELECT 1 FROM lista WHERE tenant_id = tenant_atual() AND id = ${c.listaId as string}`
    if (!l) return { falha: 'lista.nao_encontrada', mensagem: 'Lista não encontrada.', campos: ['listaId'] }
  }
  if (acao === 'transferir') {
    const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${c.usuarioId as string} AND ativo`
    if (!u) return { falha: 'carteira.usuario_invalido', mensagem: 'Vendedor não encontrado.', campos: ['usuarioId'] }
  }
  if (acao === 'criar-tarefa' && c.responsavelId && !(await responsavelDoTenantExiste(tx, c.responsavelId as string))) {
    return { falha: 'tarefa.responsavel_invalido', mensagem: 'Responsável não encontrado.', campos: ['responsavelId'] }
  }
  return null
}

async function executar(c: Contexto, acao: AcaoEmMassaContato, corpo: Record<string, unknown>): Promise<Resultado | Falha> {
  const { tx, ids, eu } = c
  switch (acao) {
    case 'qualificar':
      return { aplicados: await qualificarTodos(c, 'qualificado') }
    case 'reabrir':
      return { aplicados: await qualificarTodos(c, 'novo', 'descartado') }
    case 'descartar': {
      const aplicados = await qualificarTodos(c, 'descartado')
      // O porquê vira nota do contato (aparece no feed da ficha); a auditoria agregada não carrega texto livre.
      const nota = `Descartado (${rotuloMotivoDescarte(corpo.motivo as string)}): ${corpo.observacao as string}`
      await tx`
        INSERT INTO comentario (tenant_id, id, contato_id, autor_id, texto)
        SELECT tenant_atual(), gen_random_uuid(), x, ${eu}, ${nota} FROM unnest(${ids}::uuid[]) AS x`
      return { aplicados }
    }
    case 'transferir': {
      let aplicados = 0
      for (const contatoId of ids) {
        // NULL = o destino já era o dono: nada mudou, conta como ignorado.
        const [r] = await tx<{ transferir_carteira: string | null }[]>`
          SELECT transferir_carteira(tenant_atual(), ${contatoId}, ${corpo.usuarioId as string}, ${eu}, 'manual', ${corpo.motivo as string})`
        if (r?.transferir_carteira) aplicados += 1
      }
      return { aplicados }
    }
    case 'etiquetar': {
      const etiquetas = [...new Set(corpo.etiquetaIds as string[])]
      await tx`
        INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id)
        SELECT tenant_atual(), c, e FROM unnest(${ids}::uuid[]) AS c CROSS JOIN unnest(${etiquetas}::uuid[]) AS e
        ON CONFLICT DO NOTHING`
      return { aplicados: ids.length }
    }
    case 'desetiquetar': {
      const etiquetas = [...new Set(corpo.etiquetaIds as string[])]
      await tx`
        DELETE FROM contato_etiqueta
         WHERE tenant_id = tenant_atual() AND contato_id = ANY(${ids}::uuid[]) AND etiqueta_id = ANY(${etiquetas}::uuid[])`
      return { aplicados: ids.length }
    }
    case 'adicionar-lista': {
      await tx`
        INSERT INTO lista_membro (tenant_id, lista_id, contato_id, adicionado_por)
        SELECT tenant_atual(), ${corpo.listaId as string}, x, ${eu} FROM unnest(${ids}::uuid[]) AS x
        ON CONFLICT (tenant_id, lista_id, contato_id) DO NOTHING`
      return { aplicados: ids.length }
    }
    case 'criar-tarefa': {
      const v = corpo as { titulo: string; descricao?: string | null; venceEm: string; tipo?: string; responsavelId?: string | null }
      const criadas = await criarTarefasEmLote(tx, c.escopo, eu, ids, { ...v, tipo: v.tipo ?? 'outro' })
      return { aplicados: criadas.length }
    }
  }
}

function entradaInvalida(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const campos = [...new Set(e.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))]
  const primeiro = e.issues[0]
  let erro = 'contatos.acao_invalida'
  if (campos[0] === 'contatoIds' && primeiro?.code === 'too_small') erro = 'contatos.lote_vazio'
  if (campos[0] === 'contatoIds' && primeiro?.code === 'too_big') erro = 'contatos.lote_grande'
  return reply.code(422).send({ erro, mensagem: 'Dados da ação inválidos.', campos })
}
