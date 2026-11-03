import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { arquivosBucket } from './arquivos-bucket.js'
import { TAMANHO_MAX_ARQUIVO, chaveDoArquivo, nomeSeguro, tipoPermitido } from './arquivos-regras.js'

/**
 * Arquivos do contato (A3). Metadados no banco (`contato_arquivo`, RLS), bytes no bucket com o
 * tenant no prefixo da chave. Leitura = URL assinada CURTA (o link não vira acesso permanente).
 * Lista por cursor (criado_em, id).
 */

const PAGINA = 30
const TTL_URL_SEGUNDOS = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const bucketIndisponivel = {
  erro: 'arquivos.bucket_indisponivel',
  mensagem: 'O armazenamento de arquivos não está configurado neste ambiente.',
}

export async function rotasContatoArquivo(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: TAMANHO_MAX_ARQUIVO, files: 1, fields: 4 } })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/contatos/:id/arquivos', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      let cur: [string, string] | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id) || Number.isNaN(Date.parse(em))) return reply.code(422).send({ erro: 'cursor.invalido' })
        cur = [em, id]
      }
      const linhas = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        return tx<{
          id: string; nome: string; tipo_mime: string; tamanho_bytes: string; legenda: string | null
          enviado_por: string | null; autor: string | null; criado_em: Date; em_txt: string
        }[]>`
          SELECT a.id, a.nome, a.tipo_mime, a.tamanho_bytes::text, a.legenda, a.enviado_por, u.nome AS autor, a.criado_em,
                 to_char(a.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
            FROM contato_arquivo a
            LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.enviado_por
           WHERE a.tenant_id = tenant_atual() AND a.contato_id = ${req.params.id}
             AND ${cur === null ? tx`true` : tx`(a.criado_em, a.id) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)`}
           ORDER BY a.criado_em DESC, a.id DESC LIMIT ${PAGINA + 1}`
      })
      if (!linhas) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, nome: l.nome, tipoMime: l.tipo_mime, tamanhoBytes: Number(l.tamanho_bytes), legenda: l.legenda,
          enviadoPor: l.enviado_por ? { id: l.enviado_por, nome: l.autor ?? 'Usuário' } : null, criadoEm: l.criado_em,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.em_txt}§${ultimo.id}`).toString('base64url') : null,
        bucketDisponivel: arquivosBucket().disponivel(),
      })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/contatos/:id/arquivos', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      const bucket = arquivosBucket()
      if (!bucket.disponivel()) return reply.code(503).send(bucketIndisponivel)
      if (!req.isMultipart()) return reply.code(415).send({ erro: 'arquivos.multipart', mensagem: 'Envie o arquivo como multipart/form-data.' })

      const parte = await req.file()
      if (!parte) return reply.code(422).send({ erro: 'arquivos.sem_arquivo', mensagem: 'Nenhum arquivo enviado.' })
      const nome = nomeSeguro(parte.filename)
      if (!nome) return reply.code(422).send({ erro: 'arquivos.nome_invalido', mensagem: 'O arquivo precisa de um nome.' })
      if (!tipoPermitido(parte.mimetype, nome)) {
        // Esvazia o fluxo para não deixar a requisição pendurada.
        parte.file.resume()
        return reply.code(415).send({
          erro: 'arquivos.tipo_nao_permitido',
          mensagem: 'Tipo não permitido. Aceitos: PDF, imagens, planilhas, Word e texto.',
        })
      }
      const grande = { erro: 'arquivos.grande_demais', mensagem: 'O arquivo passa de 15 MB.' }
      let bytes: Buffer
      try {
        bytes = await parte.toBuffer() // lança FST_REQ_FILE_TOO_LARGE acima do limite
      } catch (e) {
        if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send(grande)
        throw e
      }
      if (parte.file.truncated) return reply.code(413).send(grande)
      const campo = parte.fields.legenda as { value?: unknown } | undefined
      const legenda = typeof campo?.value === 'string' && campo.value.trim() ? campo.value.trim().slice(0, 300) : null

      const tenantId = req.tenantId!
      const id = randomUUID()
      const chave = chaveDoArquivo(tenantId, req.params.id, id, nome)

      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        const eu = await garantirUsuarioId(tx, req)
        // Bytes primeiro: se o bucket falhar nada fica no banco; se o banco falhar o objeto órfão é
        // removido abaixo (a transação desfaz a linha).
        await bucket.subir(chave, bytes, parte.mimetype.toLowerCase())
        try {
          await tx`
            INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket, legenda, enviado_por)
            VALUES (tenant_atual(), ${id}, ${req.params.id}, ${nome}, ${parte.mimetype.toLowerCase()}, ${bytes.length}, ${chave}, ${legenda}, ${eu})`
          await auditar(tx, {
            atorId: eu, acao: 'contato.arquivo_enviado', entidade: 'contato', entidadeId: req.params.id,
            dados: { arquivoId: id, nome, tamanhoBytes: bytes.length },
          })
        } catch (e) {
          await bucket.remover(chave).catch(() => undefined)
          throw e
        }
        return { id }
      })
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ id: r.id, nome, tipoMime: parte.mimetype.toLowerCase(), tamanhoBytes: bytes.length, legenda })
    },
  )

  app.delete<{ Params: { id: string; arquivoId: string } }>(
    '/v1/contatos/:id/arquivos/:arquivoId', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.arquivoId)) return reply.code(404).send({ erro: 'arquivo.nao_encontrado' })
      const chave = await req.comTenant(async (tx) => {
        const [a] = await tx<{ chave_bucket: string; nome: string }[]>`
          DELETE FROM contato_arquivo
           WHERE tenant_id = tenant_atual() AND id = ${req.params.arquivoId} AND contato_id = ${req.params.id}
          RETURNING chave_bucket, nome`
        if (!a) return null
        const eu = await garantirUsuarioId(tx, req)
        await auditar(tx, {
          atorId: eu, acao: 'contato.arquivo_removido', entidade: 'contato', entidadeId: req.params.id,
          dados: { arquivoId: req.params.arquivoId, nome: a.nome },
        })
        return a.chave_bucket
      })
      if (!chave) return reply.code(404).send({ erro: 'arquivo.nao_encontrado' })
      // Melhor esforço: linha já removida; objeto órfão no bucket não vaza (só a chave o alcança).
      await arquivosBucket().remover(chave).catch((e) => req.log.warn({ erro: String(e) }, 'objeto de arquivo não removido do bucket'))
      return reply.send({ ok: true })
    },
  )

  app.get<{ Params: { id: string; arquivoId: string } }>(
    '/v1/contatos/:id/arquivos/:arquivoId/url', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.arquivoId)) return reply.code(404).send({ erro: 'arquivo.nao_encontrado' })
      const bucket = arquivosBucket()
      if (!bucket.disponivel()) return reply.code(503).send(bucketIndisponivel)
      const [a] = await req.comTenant((tx) => tx<{ chave_bucket: string; nome: string }[]>`
        SELECT chave_bucket, nome FROM contato_arquivo
         WHERE tenant_id = tenant_atual() AND id = ${req.params.arquivoId} AND contato_id = ${req.params.id}`)
      if (!a) return reply.code(404).send({ erro: 'arquivo.nao_encontrado' })
      const url = await bucket.urlAssinada(a.chave_bucket, TTL_URL_SEGUNDOS)
      return reply.send({ url, nome: a.nome, expiraEmSegundos: TTL_URL_SEGUNDOS })
    },
  )
}
