import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { exigirTenant } from '../../../../plugins/tenant.js'
import { sql } from '../../../../db/index.js'
import { embutirConsulta } from '../../../catalogo/busca.js'
import { cacheConsultaPadrao } from '../../../catalogo/cache-consulta.js'
import { embeddingDoAmbiente } from '../../../catalogo/porta-embedding.js'
import { buscarConhecimento } from './busca.js'
import { capacidadesDeBusca, embutirPendentes } from './embutir-pendentes.js'
import { extrairTexto, MAX_BYTES_ARQUIVO, MAX_CARACTERES_DOCUMENTO, TIPOS_ARQUIVO } from './extrair-texto.js'
import { reindexarDocumento } from './indexador.js'
import { TIPOS_DOCUMENTO, type TipoDocumento } from './porta.js'

/**
 * A BASE DE CONHECIMENTO como produto: o dono escreve documentos (FAQ, frete,
 * pagamento, troca…), vê a versão de cada um e TESTA a base — "o que o robô
 * acharia se o cliente perguntasse X?" — antes de ligar o agente.
 *
 * ⚠️ O documento 'politicas' de um canal espelha `agente_config.politicas`
 *    (sincronizado pela rota do agente). Criar outro pelo POST é recusado;
 *    editar o conteúdo pelo PATCH escreve de volta na coluna, para que a tela
 *    do agente e a base nunca digam coisas diferentes.
 */

const PAGINA = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const corpoCriar = z.object({
  titulo: z.string().trim().min(1).max(200),
  tipo: z.enum(TIPOS_DOCUMENTO),
  conteudo: z.string().trim().min(1).max(MAX_CARACTERES_DOCUMENTO),
  canalId: z.string().regex(UUID).nullable().optional(),
})

const corpoEditar = z.object({
  titulo: z.string().trim().min(1).max(200).optional(),
  tipo: z.enum(TIPOS_DOCUMENTO).optional(),
  conteudo: z.string().trim().min(1).max(MAX_CARACTERES_DOCUMENTO).optional(),
  canalId: z.string().regex(UUID).nullable().optional(),
  publicado: z.boolean().optional(),
})

const corpoBuscar = z.object({
  pergunta: z.string().trim().min(1).max(300),
  canalId: z.string().regex(UUID).nullable().optional(),
})

/** Base64 de até 6 MB decodificados (≈ 8 MB no fio); o teto do corpo da rota acompanha. */
const corpoExtrair = z.object({
  nome: z.string().trim().min(1).max(200),
  tipo: z.enum(TIPOS_ARQUIVO),
  conteudoBase64: z.string().min(1).max(Math.ceil(MAX_BYTES_ARQUIVO * 4 / 3) + 4),
})
const LIMITE_CORPO_EXTRAIR = 12 * 1024 * 1024
/** "Embutir agora" da tela: até 5 lotes por clique — o worker continua o resto. */
const MAX_LOTES_PELA_TELA = 5

interface LinhaDocumento {
  id: string; canal_id: string | null; titulo: string; tipo: TipoDocumento; conteudo: string
  versao: number; publicado: boolean; trechos: number; atualizado_em: Date; criado_em: Date
}

function paraSaida(l: LinhaDocumento) {
  return {
    id: l.id, canalId: l.canal_id, titulo: l.titulo, tipo: l.tipo, conteudo: l.conteudo,
    versao: l.versao, publicado: l.publicado, trechos: l.trechos,
    atualizadoEm: l.atualizado_em, criadoEm: l.criado_em,
  }
}

function campoInvalido(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, erro: z.ZodError) {
  const i = erro.issues[0]!
  return reply.code(422).send({
    erro: 'conhecimento.campo_invalido', mensagem: `${i.path.join('.')}: ${i.message}`, campos: [i.path.join('.')],
  })
}

export async function rotasConhecimento(app: FastifyInstance): Promise<void> {
  /** Documentos — cursor (atualizado_em, id), 20 por página; por canal opcionalmente. */
  app.get<{ Querystring: { cursor?: string; canalId?: string; incluirDespublicados?: string } }>(
    '/v1/agente/conhecimento', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const canalId = req.query.canalId && UUID.test(req.query.canalId) ? req.query.canalId : null
      const soPublicados = req.query.incluirDespublicados !== 'true'
      const linhas = await req.comTenant((tx) => tx<LinhaDocumento[]>`
        SELECT d.id, d.canal_id, d.titulo, d.tipo, d.conteudo, d.versao, d.publicado, d.atualizado_em, d.criado_em,
               (SELECT count(*)::int FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id) AS trechos
          FROM conhecimento_documento d
         WHERE d.tenant_id = tenant_atual()
           AND ${canalId ? tx`(d.canal_id IS NULL OR d.canal_id = ${canalId})` : tx`true`}
           AND ${soPublicados ? tx`d.publicado` : tx`true`}
           AND ${curEm === null ? tx`true` : tx`(d.atualizado_em, d.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY d.atualizado_em DESC, d.id DESC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map(paraSaida),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.atualizado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  app.post<{ Body: unknown }>(
    '/v1/agente/conhecimento', { preHandler: exigirTenant },
    async (req, reply) => {
      const parse = corpoCriar.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const c = parse.data
      const canalId = c.canalId ?? null
      if (c.tipo === 'politicas' && canalId) {
        return reply.code(422).send({
          erro: 'conhecimento.politicas_pelo_canal',
          mensagem: 'As políticas de um canal são escritas na configuração do agente desse canal — a base espelha de lá.',
          campos: ['tipo'],
        })
      }
      const r = await req.comTenant(async (tx) => {
        if (canalId) {
          const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
          if (!canal) return { erro: 'canal_nao_encontrado' as const }
        }
        const id = randomUUID()
        await tx`
          INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado)
          VALUES (tenant_atual(), ${id}, ${canalId}, ${c.titulo}, ${c.tipo}, ${c.conteudo}, 1, true)`
        await reindexarDocumento(tx, id)
        const [linha] = await tx<LinhaDocumento[]>`
          SELECT d.id, d.canal_id, d.titulo, d.tipo, d.conteudo, d.versao, d.publicado, d.atualizado_em, d.criado_em,
                 (SELECT count(*)::int FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id) AS trechos
            FROM conhecimento_documento d WHERE d.tenant_id = tenant_atual() AND d.id = ${id}`
        return { doc: linha! }
      })
      if ('erro' in r) {
        return reply.code(422).send({ erro: 'conhecimento.canal_invalido', mensagem: 'Canal não encontrado neste tenant.', campos: ['canalId'] })
      }
      return reply.code(201).send(paraSaida(r.doc))
    },
  )

  /** Edita: conteúdo ou título novo sobe a versão e reindexa; `publicado` liga/desliga do retrieval. */
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/v1/agente/conhecimento/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      const parse = corpoEditar.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const c = parse.data
      const r = await req.comTenant(async (tx) => {
        const [atual] = await tx<{ id: string; canal_id: string | null; tipo: TipoDocumento; titulo: string; conteudo: string }[]>`
          SELECT id, canal_id, tipo, titulo, conteudo FROM conhecimento_documento
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!atual) return { erro: 'nao_encontrado' as const }
        const ehPoliticasDoCanal = atual.tipo === 'politicas' && atual.canal_id !== null
        // O documento espelho não muda de tipo nem de canal: ele É as políticas daquele canal.
        if (ehPoliticasDoCanal && ((c.tipo && c.tipo !== 'politicas') || (c.canalId !== undefined && c.canalId !== atual.canal_id))) {
          return { erro: 'politicas_pelo_canal' as const }
        }
        if (!ehPoliticasDoCanal && c.tipo === 'politicas' && (c.canalId ?? atual.canal_id)) {
          return { erro: 'politicas_pelo_canal' as const }
        }
        if (c.canalId) {
          const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${c.canalId}`
          if (!canal) return { erro: 'canal_nao_encontrado' as const }
        }
        const titulo = c.titulo ?? atual.titulo
        const conteudo = c.conteudo ?? atual.conteudo
        const sobeVersao = titulo !== atual.titulo || conteudo !== atual.conteudo
        await tx`
          UPDATE conhecimento_documento
             SET titulo = ${titulo},
                 conteudo = ${conteudo},
                 tipo = ${c.tipo ?? atual.tipo},
                 canal_id = ${c.canalId === undefined ? atual.canal_id : c.canalId},
                 publicado = ${c.publicado === undefined ? tx`publicado` : c.publicado},
                 versao = ${sobeVersao ? tx`versao + 1` : tx`versao`},
                 atualizado_em = now()
           WHERE tenant_id = tenant_atual() AND id = ${atual.id}`
        if (sobeVersao) await reindexarDocumento(tx, atual.id)
        // Espelho de volta: a tela do agente lê a coluna, a base lê o documento.
        if (ehPoliticasDoCanal && conteudo !== atual.conteudo) {
          await tx`UPDATE agente_config SET politicas = ${conteudo}, atualizado_em = now()
                    WHERE tenant_id = tenant_atual() AND canal_id = ${atual.canal_id}`
        }
        const [linha] = await tx<LinhaDocumento[]>`
          SELECT d.id, d.canal_id, d.titulo, d.tipo, d.conteudo, d.versao, d.publicado, d.atualizado_em, d.criado_em,
                 (SELECT count(*)::int FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id) AS trechos
            FROM conhecimento_documento d WHERE d.tenant_id = tenant_atual() AND d.id = ${atual.id}`
        return { doc: linha! }
      })
      if ('erro' in r) {
        if (r.erro === 'nao_encontrado') return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
        if (r.erro === 'canal_nao_encontrado') {
          return reply.code(422).send({ erro: 'conhecimento.canal_invalido', mensagem: 'Canal não encontrado neste tenant.', campos: ['canalId'] })
        }
        return reply.code(422).send({
          erro: 'conhecimento.politicas_pelo_canal',
          mensagem: 'O documento de políticas de um canal não muda de tipo nem de canal — edite o texto na configuração do agente.',
          campos: ['tipo'],
        })
      }
      return reply.send(paraSaida(r.doc))
    },
  )

  /** Despublica (sai do retrieval; o texto fica guardado). */
  app.delete<{ Params: { id: string } }>(
    '/v1/agente/conhecimento/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      const n = await req.comTenant(async (tx) => {
        const r = await tx`
          UPDATE conhecimento_documento SET publicado = false, atualizado_em = now()
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return r.count
      })
      if (n === 0) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /**
   * O que a busca CONSEGUE neste servidor: pgvector? chave de embedding? quanto
   * falta embutir? É o que a tela mostra como "lexical" ou "lexical + semântica"
   * — e o que nos diz, em produção, se o Postgres tem a extensão (ADR-008).
   */
  app.get(
    '/v1/agente/conhecimento/capacidades', { preHandler: exigirTenant },
    async (req, reply) => {
      const porta = embeddingDoAmbiente()
      const cap = await req.comTenant((tx) => capacidadesDeBusca(tx, porta))
      return reply.send(cap)
    },
  )

  /** "Embutir agora": alguns lotes deste tenant, sob RLS; o worker segue o resto. */
  app.post(
    '/v1/agente/conhecimento/embutir', { preHandler: exigirTenant },
    async (req, reply) => {
      const porta = embeddingDoAmbiente()
      const r = await embutirPendentes((fn) => req.comTenant(fn), porta, { maxLotes: MAX_LOTES_PELA_TELA })
      if (r.parou === 'sem_pgvector' || r.parou === 'sem_chave') {
        return reply.code(409).send({ erro: 'conhecimento.semantica_desligada', semantica: r.parou })
      }
      if (r.parou !== null) {
        return reply.code(502).send({ erro: 'conhecimento.embedding_falhou', codigo: r.parou, produtos: r.produtos, trechos: r.trechos, restantes: r.restantes })
      }
      return reply.send({ ok: true, produtos: r.produtos, trechos: r.trechos, restantes: r.restantes })
    },
  )

  /**
   * Importar arquivo: devolve o TEXTO para a pessoa revisar — nunca cria o
   * documento sozinho. `.txt`/`.md` direto; PDF pela camada de texto.
   */
  app.post<{ Body: unknown }>(
    '/v1/agente/conhecimento/extrair', { preHandler: exigirTenant, bodyLimit: LIMITE_CORPO_EXTRAIR },
    async (req, reply) => {
      const parse = corpoExtrair.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const c = parse.data
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(Buffer.from(c.conteudoBase64.replace(/^data:[^,]*,/, ''), 'base64'))
      } catch {
        return reply.code(422).send({ erro: 'conhecimento.arquivo_invalido', mensagem: 'Conteúdo não é base64 válido.', campos: ['conteudoBase64'] })
      }
      const r = await extrairTexto(c.tipo, bytes)
      if (!r.ok) return reply.code(422).send({ erro: `conhecimento.${r.erro}`, mensagem: r.mensagem, campos: ['conteudoBase64'] })
      return reply.send({ texto: r.texto, caracteres: r.caracteres, paginas: r.paginas, avisos: r.avisos })
    },
  )

  /** "Testar a base": o que o agente receberia para esta pergunta, com fonte e versão. */
  app.post<{ Body: unknown }>(
    '/v1/agente/conhecimento/buscar', { preHandler: exigirTenant },
    async (req, reply) => {
      const parse = corpoBuscar.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const c = parse.data
      // Embedding ANTES da transação: rede externa nunca com transação aberta.
      const porta = embeddingDoAmbiente()
      const embutido = porta.capacidades.buscaSemantica
        ? await embutirConsulta(porta, c.pergunta, { cache: cacheConsultaPadrao(sql) })
        : { vetor: null as null, motivo: 'capacidade_desligada' }
      const r = await req.comTenant((tx) => buscarConhecimento(tx, {
        pergunta: c.pergunta, canalId: c.canalId ?? undefined, limite: 5,
        ...(embutido.vetor ? { vetorConsulta: embutido.vetor, modeloEmbedding: embutido.modelo } : {}),
      }))
      return reply.send({
        trechos: r.trechos.map((t) => ({ ...t, fonte: `${t.titulo} v${t.versao}` })),
        fontes: r.fontes,
        semantica: embutido.vetor ? 'ligada' : embutido.motivo,
        vetorDe: embutido.vetor ? embutido.origem : null,
      })
    },
  )
}
