import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  LIMITES_PROVA_SOCIAL, TIPOS_PROVA_SOCIAL, errosFormatoProvaSocial, errosParaAprovarProvaSocial, type TipoProvaSocial,
} from '@geracrm/shared'
import { exigirTenant } from '../../../../plugins/tenant.js'
import { exigirPapel } from '../../../plataforma/papel.js'
import { sql, type Sql } from '../../../../db/index.js'
import { auditar } from '../../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../../rotas-fila.js'
import { embutirConsulta } from '../../../catalogo/busca.js'
import { cacheConsultaPadrao } from '../../../catalogo/cache-consulta.js'
import { embeddingDoAmbiente } from '../../../catalogo/porta-embedding.js'
import { buscarConhecimento } from './busca.js'
import { capacidadesDeBusca, embutirPendentes } from './embutir-pendentes.js'
import { extrairTexto, MAX_BYTES_ARQUIVO, MAX_CARACTERES_DOCUMENTO, TIPOS_ARQUIVO } from './extrair-texto.js'
import { reindexarDocumento } from './indexador.js'
import { TIPOS_DOCUMENTO, type TipoDocumento } from './porta.js'
import {
  MAX_OBSERVACAO, lerVersao, listarVersoes, registrarVersao, type SnapshotDocumento,
} from './versoes.js'

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

/**
 * Campos da PROVA SOCIAL (G3) — só valem em documento `prova_social`; nos outros
 * tipos são ignorados e gravados nulos. Vazio = nulo. A aprovação NÃO vem por
 * aqui: é `POST …/:id/aprovar` (admin).
 */
const textoOuNulo = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null))
const camposProvaSocial = {
  fonte: textoOuNulo(LIMITES_PROVA_SOCIAL.fonte),
  link: textoOuNulo(LIMITES_PROVA_SOCIAL.link),
  apuradoEm: textoOuNulo(10),
  provaTipo: z.enum(TIPOS_PROVA_SOCIAL).nullable().optional(),
  consentimento: z.boolean().optional(),
}

const corpoCriar = z.object({
  titulo: z.string().trim().min(1).max(200),
  tipo: z.enum(TIPOS_DOCUMENTO),
  conteudo: z.string().trim().min(1).max(MAX_CARACTERES_DOCUMENTO),
  canalId: z.string().regex(UUID).nullable().optional(),
  ...camposProvaSocial,
})

const corpoEditar = z.object({
  titulo: z.string().trim().min(1).max(200).optional(),
  tipo: z.enum(TIPOS_DOCUMENTO).optional(),
  conteudo: z.string().trim().min(1).max(MAX_CARACTERES_DOCUMENTO).optional(),
  canalId: z.string().regex(UUID).nullable().optional(),
  publicado: z.boolean().optional(),
  /** Nota da versão nova (só vale quando título/conteúdo mudam). */
  observacao: z.string().trim().max(MAX_OBSERVACAO).optional(),
  ...camposProvaSocial,
})

/**
 * M2: aprovar AMARRA a versão vista. `versao` é obrigatória para aprovar (para
 * revogar, opcional): se o documento mudou desde que o admin o leu, 409.
 */
const corpoAprovar = z.object({ aprovado: z.boolean(), versao: z.number().int().min(1).optional() })
  .refine((c) => !c.aprovado || c.versao !== undefined, { message: 'Informe a versão que você conferiu.', path: ['versao'] })

/** Os campos de prova social como ficam gravados (nulos fora do tipo). */
interface ProvaSocialGravada {
  fonte: string | null; link: string | null; apurado_em: string | null; prova_tipo: TipoProvaSocial | null; consentimento: boolean
}
function provaSocialDoCorpo(
  tipo: TipoDocumento,
  c: { fonte?: string | null | undefined; link?: string | null | undefined; apuradoEm?: string | null | undefined; provaTipo?: TipoProvaSocial | null | undefined; consentimento?: boolean | undefined },
  atual: ProvaSocialGravada | null,
): ProvaSocialGravada {
  if (tipo !== 'prova_social') return { fonte: null, link: null, apurado_em: null, prova_tipo: null, consentimento: false }
  return {
    fonte: c.fonte === undefined ? atual?.fonte ?? null : c.fonte,
    link: c.link === undefined ? atual?.link ?? null : c.link,
    apurado_em: c.apuradoEm === undefined ? atual?.apurado_em ?? null : c.apuradoEm,
    prova_tipo: c.provaTipo === undefined ? atual?.prova_tipo ?? null : c.provaTipo,
    consentimento: c.consentimento === undefined ? atual?.consentimento ?? false : c.consentimento,
  }
}
function errosDeFormato(p: ProvaSocialGravada) {
  return errosFormatoProvaSocial({ fonte: p.fonte, link: p.link, apuradoEm: p.apurado_em, provaTipo: p.prova_tipo })
}

const corpoRestaurar = z.object({
  versao: z.number().int().min(1),
  observacao: z.string().trim().max(MAX_OBSERVACAO).optional(),
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

interface LinhaDocumento extends ProvaSocialGravada {
  id: string; canal_id: string | null; titulo: string; tipo: TipoDocumento; conteudo: string
  versao: number; publicado: boolean; trechos: number; atualizado_em: Date; criado_em: Date
  aprovado: boolean; aprovado_em: Date | null
}

function paraSaida(l: LinhaDocumento) {
  return {
    id: l.id, canalId: l.canal_id, titulo: l.titulo, tipo: l.tipo, conteudo: l.conteudo,
    versao: l.versao, publicado: l.publicado, trechos: l.trechos,
    atualizadoEm: l.atualizado_em, criadoEm: l.criado_em,
    // Prova social (G3): nulos/false nos outros tipos.
    fonte: l.fonte, link: l.link, apuradoEm: l.apurado_em, provaTipo: l.prova_tipo, consentimento: l.consentimento,
    aprovado: l.aprovado, aprovadoEm: l.aprovado_em,
  }
}

/** Colunas de saída do documento (com os campos da prova social). */
const COLUNAS_DOC = 'd.id, d.canal_id, d.titulo, d.tipo, d.conteudo, d.versao, d.publicado, d.atualizado_em, d.criado_em, '
  + 'd.fonte, d.link, d.apurado_em::text AS apurado_em, d.prova_tipo, d.consentimento, d.aprovado, d.aprovado_em'

/**
 * Quem age, para o histórico e a auditoria. Sessão de staff (PLT-05) não vira
 * linha em `usuario` do cliente: fica `autorId` NULL com a marca de staff.
 */
async function autoria(tx: Sql, req: FastifyRequest): Promise<{ autorId: string | null; autorStaff: boolean }> {
  if (req.atorStaff) return { autorId: null, autorStaff: true }
  return { autorId: await garantirUsuarioId(tx, req), autorStaff: false }
}

/**
 * Ordem de locks do documento-espelho das políticas: `agente_config` ANTES do
 * documento — a mesma do PUT do agente (upsert da config → sincronizarPoliticas).
 * Ordem invertida entre os dois caminhos é deadlock quando salvam juntos.
 */
async function travarConfigDoEspelho(tx: Sql, documentoId: string): Promise<void> {
  await tx`
    SELECT 1 FROM agente_config ac
      JOIN conhecimento_documento d ON d.tenant_id = ac.tenant_id AND d.canal_id = ac.canal_id
     WHERE d.tenant_id = tenant_atual() AND d.id = ${documentoId} AND d.tipo = 'politicas'
       FOR UPDATE OF ac`
}

const SELECT_DOCUMENTO_SAIDA = (tx: Sql, id: string) => tx<LinhaDocumento[]>`
  SELECT ${tx.unsafe(COLUNAS_DOC)},
         (SELECT count(*)::int FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id) AS trechos
    FROM conhecimento_documento d WHERE d.tenant_id = tenant_atual() AND d.id = ${id}`

/** O usuário existe antes da checagem de papel (modo fundador, PLT-05) — como nas rotas do playbook. */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId && !req.atorStaff) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

function campoInvalido(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, erro: z.ZodError) {
  const i = erro.issues[0]!
  return reply.code(422).send({
    erro: 'conhecimento.campo_invalido', mensagem: `${i.path.join('.')}: ${i.message}`, campos: [i.path.join('.')],
  })
}

export async function rotasConhecimento(app: FastifyInstance): Promise<void> {
  /** Documentos — cursor (atualizado_em, id), 20 por página; por canal opcionalmente. */
  app.get<{ Querystring: { cursor?: string; canalId?: string; incluirDespublicados?: string; tipo?: string } }>(
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
      // Filtro por tipo (a tela usa `tipo=prova_social` no filtro "Prova social").
      const tipo = req.query.tipo && (TIPOS_DOCUMENTO as readonly string[]).includes(req.query.tipo) ? req.query.tipo : null
      if (req.query.tipo && !tipo) return reply.code(422).send({ erro: 'conhecimento.campo_invalido', mensagem: 'tipo: inválido.', campos: ['tipo'] })
      const linhas = await req.comTenant((tx) => tx<LinhaDocumento[]>`
        SELECT ${tx.unsafe(COLUNAS_DOC)},
               (SELECT count(*)::int FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id) AS trechos
          FROM conhecimento_documento d
         WHERE d.tenant_id = tenant_atual()
           AND ${tipo ? tx`d.tipo = ${tipo}` : tx`true`}
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
      const ps = provaSocialDoCorpo(c.tipo, c, null)
      const errosPs = errosDeFormato(ps)
      if (errosPs.length > 0) {
        return reply.code(422).send({ erro: 'conhecimento.campo_invalido', mensagem: `${errosPs[0]!.campo}: ${errosPs[0]!.mensagem}`, campos: errosPs.map((e) => e.campo) })
      }
      const r = await req.comTenant(async (tx) => {
        if (canalId) {
          const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
          if (!canal) return { erro: 'canal_nao_encontrado' as const }
        }
        const id = randomUUID()
        // ⚠️ Prova social nasce NÃO aprovada: só um admin a libera para o agente.
        const [snap] = await tx<SnapshotDocumento[]>`
          INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado,
                                              fonte, link, apurado_em, prova_tipo, consentimento, aprovado)
          VALUES (tenant_atual(), ${id}, ${canalId}, ${c.titulo}, ${c.tipo}, ${c.conteudo}, 1, true,
                  ${ps.fonte}, ${ps.link}, ${ps.apurado_em}::date, ${ps.prova_tipo}, ${ps.consentimento}, false)
          RETURNING id, versao, titulo, tipo, canal_id, conteudo`
        const autor = await autoria(tx, req)
        await registrarVersao(tx, snap!, { origem: 'criacao', ...autor })
        await reindexarDocumento(tx, id)
        await auditar(tx, {
          atorId: autor.autorId, atorStaff: autor.autorStaff, acao: 'conhecimento.criado', entidade: 'conhecimento_documento',
          entidadeId: id, dados: { versao: 1, titulo: c.titulo, tipo: c.tipo, canalId, caracteres: c.conteudo.length },
        })
        const [linha] = await SELECT_DOCUMENTO_SAIDA(tx, id)
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
        // FOR UPDATE: duas edições simultâneas comparam com o texto que vão substituir, uma de cada vez.
        await travarConfigDoEspelho(tx, req.params.id)
        const [atual] = await tx<({ id: string; canal_id: string | null; tipo: TipoDocumento; titulo: string; conteudo: string; publicado: boolean; versao: number; aprovado: boolean } & ProvaSocialGravada)[]>`
          SELECT id, canal_id, tipo, titulo, conteudo, publicado, versao, aprovado,
                 fonte, link, apurado_em::text AS apurado_em, prova_tipo, consentimento
            FROM conhecimento_documento
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!atual) return { erro: 'nao_encontrado' as const }
        const ps = provaSocialDoCorpo(c.tipo ?? atual.tipo, c, atual)
        const errosPs = errosDeFormato(ps)
        if (errosPs.length > 0) return { erro: 'prova_social_invalida' as const, errosPs }
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
        const textoMudou = titulo !== atual.titulo || conteudo !== atual.conteudo
        const novoCanal = c.canalId === undefined ? atual.canal_id : c.canalId
        // ⚠️ Prova social APROVADA que muda o que o agente diria ou a quem (texto, título,
        //    tipo, fonte, link, data, número/depoimento, consentimento, número/canal — B2)
        //    volta a pendente: o admin aprovou AQUELA versão, não a próxima.
        const mudouProva = textoMudou || (c.tipo ?? atual.tipo) !== atual.tipo || ps.fonte !== atual.fonte
          || ps.link !== atual.link || ps.apurado_em !== atual.apurado_em || ps.prova_tipo !== atual.prova_tipo
          || ps.consentimento !== atual.consentimento || novoCanal !== atual.canal_id
        const ehProva = atual.tipo === 'prova_social' || c.tipo === 'prova_social'
        // ⚠️ M2: em prova social QUALQUER mudança dessas sobe a versão — é a versão que o
        //    admin aprova (`POST …/aprovar {versao}`); sem subir, aprovar "a v3" aprovaria
        //    também o consentimento retirado depois de ela ser vista.
        const sobeVersao = textoMudou || (ehProva && mudouProva)
        const revogaAprovacao = atual.aprovado && mudouProva
        const [snap] = await tx<SnapshotDocumento[]>`
          UPDATE conhecimento_documento
             SET titulo = ${titulo},
                 conteudo = ${conteudo},
                 tipo = ${c.tipo ?? atual.tipo},
                 canal_id = ${novoCanal},
                 publicado = ${c.publicado === undefined ? tx`publicado` : c.publicado},
                 versao = ${sobeVersao ? tx`versao + 1` : tx`versao`},
                 fonte = ${ps.fonte}, link = ${ps.link}, apurado_em = ${ps.apurado_em}::date,
                 prova_tipo = ${ps.prova_tipo}, consentimento = ${ps.consentimento},
                 ${revogaAprovacao ? tx`aprovado = false, aprovado_por = NULL, aprovado_em = NULL,` : tx``}
                 atualizado_em = now()
           WHERE tenant_id = tenant_atual() AND id = ${atual.id}
           RETURNING id, versao, titulo, tipo, canal_id, conteudo`
        const autor = await autoria(tx, req)
        // ⚠️ Versão nova = linha nova no histórico, nesta mesma transação (P9).
        if (sobeVersao) await registrarVersao(tx, snap!, { origem: 'edicao', ...autor, observacao: c.observacao || null })
        if (textoMudou) await reindexarDocumento(tx, atual.id)
        // Espelho de volta: a tela do agente lê a coluna, a base lê o documento.
        if (ehPoliticasDoCanal && conteudo !== atual.conteudo) {
          await tx`UPDATE agente_config SET politicas = ${conteudo}, atualizado_em = now()
                    WHERE tenant_id = tenant_atual() AND canal_id = ${atual.canal_id}`
        }
        const campos = [
          ...(titulo !== atual.titulo ? ['titulo'] : []),
          ...(conteudo !== atual.conteudo ? ['conteudo'] : []),
          ...(snap!.tipo !== atual.tipo ? ['tipo'] : []),
          ...(snap!.canal_id !== atual.canal_id ? ['canalId'] : []),
          ...(c.publicado !== undefined && c.publicado !== atual.publicado ? ['publicado'] : []),
          ...(mudouProva && !textoMudou && ehProva && snap!.tipo === atual.tipo && snap!.canal_id === atual.canal_id ? ['provaSocial'] : []),
          ...(revogaAprovacao ? ['aprovado'] : []),
        ]
        if (campos.length > 0) {
          await auditar(tx, {
            atorId: autor.autorId, atorStaff: autor.autorStaff, acao: 'conhecimento.editado', entidade: 'conhecimento_documento',
            entidadeId: atual.id,
            dados: {
              campos, versaoAnterior: atual.versao, versao: snap!.versao,
              ...(c.publicado !== undefined && c.publicado !== atual.publicado ? { publicado: c.publicado } : {}),
              ...(sobeVersao && c.observacao ? { observacao: c.observacao } : {}),
            },
          })
        }
        const [linha] = await SELECT_DOCUMENTO_SAIDA(tx, atual.id)
        return { doc: linha! }
      })
      if ('erro' in r) {
        if (r.erro === 'nao_encontrado') return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
        if (r.erro === 'canal_nao_encontrado') {
          return reply.code(422).send({ erro: 'conhecimento.canal_invalido', mensagem: 'Canal não encontrado neste tenant.', campos: ['canalId'] })
        }
        if (r.erro === 'prova_social_invalida') {
          const e = r.errosPs
          return reply.code(422).send({ erro: 'conhecimento.campo_invalido', mensagem: `${e[0]!.campo}: ${e[0]!.mensagem}`, campos: e.map((x) => x.campo) })
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

  /**
   * APROVAR (ou revogar) uma prova social — só admin (G3, #100). Aprovar exige
   * fonte, data da apuração (não futura), número/depoimento, consentimento do
   * depoimento e texto sem veto (vetos próprios + filtro base do agente); falta →
   * 422 por campo. Só o aprovado (e vigente) chega à ferramenta do agente.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agente/conhecimento/:id/aprovar', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      const parse = corpoAprovar.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const aprovar = parse.data.aprovado
      const agora = new Date()
      const r = await req.comTenant(async (tx) => {
        const [atual] = await tx<({ id: string; tipo: TipoDocumento; conteudo: string; aprovado: boolean; versao: number } & ProvaSocialGravada)[]>`
          SELECT id, tipo, conteudo, aprovado, versao, fonte, link, apurado_em::text AS apurado_em, prova_tipo, consentimento
            FROM conhecimento_documento WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!atual) return { erro: 'nao_encontrado' as const }
        if (atual.tipo !== 'prova_social') return { erro: 'nao_e_prova_social' as const }
        if (parse.data.versao !== undefined && parse.data.versao !== atual.versao) {
          return { erro: 'versao_divergente' as const, versaoAtual: atual.versao }
        }
        if (aprovar) {
          const erros = errosParaAprovarProvaSocial({
            conteudo: atual.conteudo, fonte: atual.fonte, link: atual.link, apuradoEm: atual.apurado_em,
            provaTipo: atual.prova_tipo, consentimento: atual.consentimento,
          }, agora)
          if (erros.length > 0) return { erro: 'nao_aprovavel' as const, erros }
        }
        if (atual.aprovado !== aprovar) {
          const autor = await autoria(tx, req)
          await tx`
            UPDATE conhecimento_documento
               SET aprovado = ${aprovar}, aprovado_por = ${aprovar ? autor.autorId : null},
                   aprovado_em = ${aprovar ? agora : null}, atualizado_em = now()
             WHERE tenant_id = tenant_atual() AND id = ${atual.id}`
          await auditar(tx, {
            atorId: autor.autorId, atorStaff: autor.autorStaff,
            acao: aprovar ? 'conhecimento.prova_social_aprovada' : 'conhecimento.prova_social_revogada',
            entidade: 'conhecimento_documento', entidadeId: atual.id, dados: { versao: atual.versao },
          })
        }
        const [linha] = await SELECT_DOCUMENTO_SAIDA(tx, atual.id)
        return { doc: linha! }
      })
      if ('doc' in r) return reply.send(paraSaida(r.doc))
      if (r.erro === 'nao_encontrado') return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      if (r.erro === 'nao_e_prova_social') {
        return reply.code(422).send({ erro: 'conhecimento.nao_e_prova_social', mensagem: 'Só documentos do tipo prova social são aprovados.', campos: ['tipo'] })
      }
      if (r.erro === 'versao_divergente') {
        return reply.code(409).send({
          erro: 'conhecimento.versao_divergente', versaoAtual: r.versaoAtual,
          mensagem: `O documento mudou desde que você o abriu (agora está na v${r.versaoAtual}). Confira de novo antes de aprovar.`,
        })
      }
      return reply.code(422).send({
        erro: 'conhecimento.prova_social_incompleta', mensagem: r.erros[0]!.mensagem,
        campos: [...new Set(r.erros.map((e) => e.campo))], erros: r.erros,
      })
    },
  )

  /** Despublica (sai do retrieval; o texto fica guardado). */
  app.delete<{ Params: { id: string } }>(
    '/v1/agente/conhecimento/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      const n = await req.comTenant(async (tx) => {
        const r = await tx<{ versao: number; publicado_antes: boolean }[]>`
          UPDATE conhecimento_documento d SET publicado = false, atualizado_em = now()
            FROM (SELECT id, publicado FROM conhecimento_documento
                   WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE) antes
           WHERE d.tenant_id = tenant_atual() AND d.id = antes.id
           RETURNING d.versao, antes.publicado AS publicado_antes`
        const l = r[0]
        if (l?.publicado_antes) {
          const autor = await autoria(tx, req)
          await auditar(tx, {
            atorId: autor.autorId, atorStaff: autor.autorStaff, acao: 'conhecimento.despublicado',
            entidade: 'conhecimento_documento', entidadeId: req.params.id, dados: { versao: l.versao },
          })
        }
        return r.length
      })
      if (n === 0) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Histórico do documento — mais nova primeiro, 20 por página, cursor = número da versão (P9). */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/agente/conhecimento/:id/versoes', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      let antesDe: number | null = null
      if (req.query.cursor !== undefined) {
        if (!/^\d{1,9}$/.test(req.query.cursor)) return reply.code(422).send({ erro: 'cursor.invalido' })
        antesDe = Number(req.query.cursor)
      }
      const r = await req.comTenant((tx) => listarVersoes(tx, req.params.id, antesDe))
      if (!r.ok) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      return reply.send({ versaoAtual: r.versaoAtual, itens: r.itens, proximoCursor: r.proximoCursor })
    },
  )

  /**
   * O TEXTO EXATO da versão N — o que "Título vN" numa decisão do agente abre.
   * Versão sobrescrita antes do histórico existir é falha nomeada, nunca o texto de outra.
   */
  app.get<{ Params: { id: string; versao: string } }>(
    '/v1/agente/conhecimento/:id/versoes/:versao', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      if (!/^\d{1,9}$/.test(req.params.versao) || Number(req.params.versao) < 1) {
        return reply.code(404).send({ erro: 'conhecimento.versao_nao_encontrada', mensagem: 'Versão inválida.' })
      }
      const r = await req.comTenant((tx) => lerVersao(tx, req.params.id, Number(req.params.versao)))
      if (r.ok) return reply.send(r.versao)
      if (r.erro === 'nao_encontrado') return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      if (r.erro === 'versao_anterior_ao_historico') {
        return reply.code(404).send({
          erro: 'conhecimento.versao_anterior_ao_historico',
          mensagem: 'Esta versão foi sobrescrita antes de o histórico existir — o texto dela não foi guardado.',
          ...(r.primeiraRegistrada ? { primeiraRegistrada: r.primeiraRegistrada } : {}),
        })
      }
      if (r.erro === 'versao_removida') {
        return reply.code(404).send({
          erro: 'conhecimento.versao_removida',
          mensagem: 'O texto desta versão foi removido do histórico (exclusão a pedido do titular dos dados).',
          primeiraRegistrada: r.primeiraRegistrada,
        })
      }
      return reply.code(404).send({ erro: 'conhecimento.versao_nao_encontrada', mensagem: 'Este documento não tem essa versão.' })
    },
  )

  /**
   * Restaurar = criar uma versão NOVA com o título e o texto da versão escolhida.
   * O histórico nunca é reescrito; tipo, alcance e publicação ficam como estão.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agente/conhecimento/:id/restaurar', { preHandler: exigirTenant },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
      const parse = corpoRestaurar.safeParse(req.body ?? {})
      if (!parse.success) return campoInvalido(reply, parse.error)
      const c = parse.data
      const r = await req.comTenant(async (tx) => {
        await travarConfigDoEspelho(tx, req.params.id)
        const [atual] = await tx<{ id: string; canal_id: string | null; tipo: TipoDocumento; titulo: string; conteudo: string; versao: number }[]>`
          SELECT id, canal_id, tipo, titulo, conteudo, versao FROM conhecimento_documento
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!atual) return { erro: 'nao_encontrado' as const }
        const alvo = await lerVersao(tx, atual.id, c.versao)
        if (!alvo.ok) return { erro: alvo.erro }
        const ehPoliticasDoCanal = atual.tipo === 'politicas' && atual.canal_id !== null
        // O espelho das políticas mantém o título fixo: só o texto volta.
        const titulo = ehPoliticasDoCanal ? atual.titulo : alvo.versao.titulo
        const conteudo = alvo.versao.conteudo
        if (titulo === atual.titulo && conteudo === atual.conteudo) return { erro: 'igual_a_atual' as const }
        const [snap] = await tx<SnapshotDocumento[]>`
          UPDATE conhecimento_documento
             SET titulo = ${titulo}, conteudo = ${conteudo}, versao = versao + 1, atualizado_em = now(),
                 -- Prova social restaurada volta a pendente: a aprovação era da versão anterior.
                 aprovado = false, aprovado_por = NULL, aprovado_em = NULL
           WHERE tenant_id = tenant_atual() AND id = ${atual.id}
           RETURNING id, versao, titulo, tipo, canal_id, conteudo`
        const autor = await autoria(tx, req)
        await registrarVersao(tx, snap!, { origem: 'restauracao', restauradaDe: c.versao, observacao: c.observacao || null, ...autor })
        await reindexarDocumento(tx, atual.id)
        if (ehPoliticasDoCanal && conteudo !== atual.conteudo) {
          await tx`UPDATE agente_config SET politicas = ${conteudo}, atualizado_em = now()
                    WHERE tenant_id = tenant_atual() AND canal_id = ${atual.canal_id}`
        }
        await auditar(tx, {
          atorId: autor.autorId, atorStaff: autor.autorStaff, acao: 'conhecimento.restaurado', entidade: 'conhecimento_documento',
          entidadeId: atual.id,
          dados: { versaoAnterior: atual.versao, versao: snap!.versao, restauradaDe: c.versao, ...(c.observacao ? { observacao: c.observacao } : {}) },
        })
        const [linha] = await SELECT_DOCUMENTO_SAIDA(tx, atual.id)
        return { doc: linha! }
      })
      if ('doc' in r) return reply.send({ ...paraSaida(r.doc), restauradaDe: c.versao })
      switch (r.erro) {
        case 'nao_encontrado': return reply.code(404).send({ erro: 'conhecimento.nao_encontrado' })
        case 'versao_anterior_ao_historico':
          return reply.code(422).send({
            erro: 'conhecimento.versao_anterior_ao_historico',
            mensagem: 'Esta versão foi sobrescrita antes de o histórico existir — não há texto para restaurar.', campos: ['versao'],
          })
        case 'versao_removida':
          return reply.code(422).send({
            erro: 'conhecimento.versao_removida',
            mensagem: 'O texto desta versão foi removido do histórico — não há texto para restaurar.', campos: ['versao'],
          })
        case 'versao_nao_encontrada':
          return reply.code(422).send({ erro: 'conhecimento.versao_nao_encontrada', mensagem: 'Este documento não tem essa versão.', campos: ['versao'] })
        case 'igual_a_atual':
          return reply.code(422).send({
            erro: 'conhecimento.restaurar_sem_mudanca',
            mensagem: 'Essa versão tem o mesmo título e texto da versão atual — não há o que restaurar.', campos: ['versao'],
          })
      }
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
