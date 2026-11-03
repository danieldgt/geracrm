import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import type { Sql } from 'postgres'
import { dadosMinimosDoGanho, type CampoGanho, type DadosDoGanho } from '@geracrm/shared'
import { exigirPapel } from '../plataforma/papel.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { garantirEtapasFunil } from './funil-modelos.js'
import { gravarEndereco, acrescentarCnpj } from './contato-gravacao.js'

const PAGINA = 50 // cards por página de coluna (kanban paginado por coluna, ADR)

const TIPOS_ETAPA = ['aberto', 'ganho', 'perdido'] as const
type TipoEtapa = (typeof TIPOS_ETAPA)[number]

function ehTipoEtapa(v: unknown): v is TipoEtapa {
  return typeof v === 'string' && (TIPOS_ETAPA as readonly string[]).includes(v)
}

function slug(nome: string): string {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'etapa'
}

type CamposGanho = Partial<Record<CampoGanho, string>>

type Falha =
  | { erro: 'etapa_nao_encontrada' | 'motivo_obrigatorio' | 'conflito' | 'nao_encontrada' | 'ja_tem_aberta' }
  | { erro: 'ganho_dados_minimos'; campos: CamposGanho }

const MENSAGEM: Record<Falha['erro'], string> = {
  etapa_nao_encontrada: 'Não foi possível mover.',
  motivo_obrigatorio: 'Escolha o motivo da perda.',
  conflito: 'Alguém moveu este card antes de você. Recarregue.',
  nao_encontrada: 'Não foi possível mover.',
  ja_tem_aberta: 'Este cliente já tem uma oportunidade aberta.',
  ganho_dados_minimos: 'Faltam dados do cliente para ganhar o negócio.',
}
const STATUS: Record<Falha['erro'], number> = {
  etapa_nao_encontrada: 404, motivo_obrigatorio: 422, conflito: 409, nao_encontrada: 404, ja_tem_aberta: 409,
  ganho_dados_minimos: 422,
}

/** Resposta tipificada de falha de movimento. 422 de ganho carrega `campos` por campo. */
function responderFalha(reply: FastifyReply, f: Falha, prefixo = 'move') {
  const erro = f.erro === 'ganho_dados_minimos' ? 'ganho.dados_minimos' : `${prefixo}.${f.erro}`
  return reply.code(STATUS[f.erro]).send({
    erro, mensagem: MENSAGEM[f.erro], ...(f.erro === 'ganho_dados_minimos' ? { campos: f.campos } : {}),
  })
}

interface DadosAtuais { contatoId: string; dados: DadosDoGanho }

/** O que o contato da oportunidade já tem dos dados mínimos do ganho (CNPJ fiscal primeiro). */
async function dadosDoContato(tx: Sql, oportunidadeId: string): Promise<DadosAtuais | null> {
  const [l] = await tx<{
    contato_id: string; razao_social: string | null; nome_fantasia: string | null; cnpj: string | null
    cep: string | null; logradouro: string | null; numero: string | null; bairro: string | null
    cidade: string | null; uf: string | null
  }[]>`
    SELECT o.contato_id, c.razao_social, c.nome_fantasia,
           (SELECT d.numero FROM contato_documento d
             WHERE d.tenant_id = o.tenant_id AND d.contato_id = o.contato_id AND d.tipo = 'cnpj'
             ORDER BY d.fiscal DESC, d.seq LIMIT 1) AS cnpj,
           e.cep, e.logradouro, e.numero, e.bairro, e.cidade, e.uf
      FROM oportunidade o
      JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
      LEFT JOIN LATERAL (
        SELECT cep, logradouro, numero, bairro, cidade, uf FROM contato_endereco
         WHERE tenant_id = o.tenant_id AND contato_id = o.contato_id
         ORDER BY principal DESC, seq LIMIT 1) e ON true
     WHERE o.tenant_id = tenant_atual() AND o.id = ${oportunidadeId}`
  if (!l) return null
  return {
    contatoId: l.contato_id,
    dados: {
      cnpj: l.cnpj, razaoSocial: l.razao_social, nomeFantasia: l.nome_fantasia, cep: l.cep,
      logradouro: l.logradouro, numero: l.numero, bairro: l.bairro, cidade: l.cidade, uf: l.uf,
    },
  }
}

interface Movimento {
  id: string; etapaId: string; posicao: number; versao: number | null
  motivo: string | null; descricao: string | null; validarGanho: boolean
}

/**
 * Núcleo ÚNICO do movimento (mover, ganhar e perder passam por aqui): concorrência otimista por `versao`
 * (null = sem checagem), motivo na perda, dados mínimos no ganho, histórico de etapa.
 */
async function aplicarMovimento(tx: Sql, ator: string, m: Movimento): Promise<{ ok: true } | Falha> {
  const [etapa] = await tx<{ tipo: string }[]>`
    SELECT tipo FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${m.etapaId}`
  if (!etapa) return { erro: 'etapa_nao_encontrada' }
  // ⚠️ Perda sem motivo é barrada aqui (e no banco pelo CHECK).
  if (etapa.tipo === 'perdido' && !m.motivo) return { erro: 'motivo_obrigatorio' }
  // Já ganha e só reposicionando: não revalida (dado legado não pode travar o card).
  const [cur] = await tx<{ estado: string }[]>`SELECT estado FROM oportunidade WHERE tenant_id = tenant_atual() AND id = ${m.id}`
  if (etapa.tipo === 'ganho' && m.validarGanho && cur?.estado !== 'ganha') {
    const atual = await dadosDoContato(tx, m.id)
    if (atual) {
      const v = dadosMinimosDoGanho(atual.dados)
      if (!v.ok) return { erro: 'ganho_dados_minimos', campos: v.faltando }
    }
  }

  const estado = etapa.tipo === 'perdido' ? 'perdida' : etapa.tipo === 'ganho' ? 'ganha' : 'aberta'
  const fecha = estado !== 'aberta'
  // ⚠️ Reabrir (fechada → aberta) pode esbarrar em `oportunidade_aberta_unica`
  // se já criaram outra aberta para o mesmo contato. É 409, não 500.
  let mov: { id: string } | undefined
  try {
    ;[mov] = await tx<{ id: string }[]>`
      UPDATE oportunidade
         SET etapa_id = ${m.etapaId}, posicao = ${m.posicao}, entrou_etapa_em = now(),
             estado = ${estado}, motivo_perda_codigo = ${etapa.tipo === 'perdido' ? m.motivo : null},
             perda_descricao = ${etapa.tipo === 'perdido' ? m.descricao : null},
             pedido_id = ${estado === 'ganha' ? tx`pedido_id` : null},
             fechada_em = ${fecha ? tx`now()` : null}, versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${m.id}
         AND (${m.versao}::bigint IS NULL OR versao = ${m.versao}::bigint)
       RETURNING id`
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { erro: 'ja_tem_aberta' }
    throw e
  }
  if (!mov) {
    const [existe] = await tx`SELECT 1 FROM oportunidade WHERE tenant_id = tenant_atual() AND id = ${m.id}`
    return { erro: existe ? 'conflito' : 'nao_encontrada' }
  }
  // Histórico: fecha a etapa anterior, abre a nova.
  await tx`UPDATE oportunidade_etapa_historico SET saiu_em = now()
            WHERE tenant_id = tenant_atual() AND oportunidade_id = ${m.id} AND saiu_em IS NULL`
  await tx`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, ator_id)
           VALUES (tenant_atual(), ${randomUUID()}, ${m.id}, ${m.etapaId}, ${ator})`
  return { ok: true }
}

/** Primeira etapa ativa do tipo, por `ordem` (as etapas são configuráveis: nunca pela chave). */
async function etapaDoTipo(tx: Sql, tipo: TipoEtapa): Promise<string | null> {
  const [e] = await tx<{ id: string }[]>`
    SELECT id FROM funil_etapa WHERE tenant_id = tenant_atual() AND tipo = ${tipo} AND ativo ORDER BY ordem LIMIT 1`
  return e?.id ?? null
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined)

/** Pedido só vincula ao ganho quando já existe de fato (número no ERP) ou está sob conferência. */
const ESTADOS_PEDIDO_VINCULAVEIS: readonly string[] = ['efetivado', 'aguardando_conferencia']

interface CorpoGanho {
  versao?: number
  pedidoId?: string | null
  dados?: {
    cnpj?: string; razaoSocial?: string; nomeFantasia?: string
    endereco?: { cep?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; cidade?: string; uf?: string }
  }
}

/**
 * Kanban do funil de relacionamento (Onda 2).
 *
 * ⚠️ Paginação POR COLUNA por cursor `(posicao, id)` — nunca virtual scroll (o
 * CDK não junta drag-drop + virtual scroll) nem lista ilimitada. A coluna tem
 * 11 mil cards; carrega 50 e "carregar mais".
 *
 * ⚠️ Perda exige motivo do catálogo (garantido no banco). Mover usa concorrência
 * OTIMISTA (`versao`): duas vendedoras arrastando o mesmo card — a segunda leva
 * 409, não sobrescreve.
 */
export async function rotasFunil(app: FastifyInstance): Promise<void> {
  /** Estágios (ordenados) + contagem de cards por estágio. */
  app.get('/v1/funil/etapas', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant(async (tx) => {
      await garantirEtapasFunil(tx)
      return tx<{
        id: string; chave: string; nome: string; tipo: string; criterio: string | null; total: number
      }[]>`
      SELECT e.id, e.chave, e.nome, e.tipo, e.criterio,
             (SELECT count(*) FROM oportunidade o WHERE o.tenant_id = e.tenant_id AND o.etapa_id = e.id)::int AS total
        FROM funil_etapa e
       WHERE e.tenant_id = tenant_atual() AND e.ativo
       ORDER BY e.ordem`
    })
    return reply.send({ itens: linhas.map((l) => ({
      id: l.id, chave: l.chave, nome: l.nome, tipo: l.tipo, criterio: l.criterio, total: l.total,
    })) })
  })

  /** Motivos de perda (catálogo fechado). */
  app.get('/v1/funil/motivos', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant(async (tx) => {
      await garantirEtapasFunil(tx)
      return tx<{ codigo: string; nome: string }[]>`
      SELECT codigo, nome FROM motivo_perda WHERE tenant_id = tenant_atual() AND ativo ORDER BY nome`
    })
    return reply.send({ itens: linhas })
  })

  /** Cards de UMA coluna, paginados por cursor (posicao, id). */
  app.get<{ Params: { etapaId: string }; Querystring: { cursor?: string } }>(
    '/v1/funil/coluna/:etapaId',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let curPos: string | null = null
      let curId: string | null = null
      if (req.query.cursor) {
        const [p, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!p || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curPos = p; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; contato_id: string; nome: string; titulo: string | null
        valor_estimado_centavos: string | null; responsavel: string | null
        posicao: number; entrou_etapa_em: Date; versao: string
      }[]>`
        SELECT o.id, o.contato_id, c.nome, o.titulo, o.valor_estimado_centavos::text,
               u.nome AS responsavel, o.posicao, o.entrou_etapa_em, o.versao::text
          FROM oportunidade o
          JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
          LEFT JOIN usuario u ON u.tenant_id = o.tenant_id AND u.id = o.responsavel_id
         WHERE o.tenant_id = tenant_atual() AND o.etapa_id = ${req.params.etapaId}
           AND ${curPos === null ? tx`true` : tx`(o.posicao, o.id) > (${curPos}::double precision, ${curId}::uuid)`}
         ORDER BY o.posicao ASC, o.id ASC
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.posicao}§${ultimo.id}`).toString('base64url') : null

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, contatoId: l.contato_id, nome: l.titulo || l.nome,
          valorCentavos: l.valor_estimado_centavos ? Number(l.valor_estimado_centavos) : null,
          responsavel: l.responsavel, entrouEtapaEm: l.entrou_etapa_em,
          posicao: l.posicao, versao: Number(l.versao),
        })),
        proximoCursor,
      })
    },
  )

  /**
   * Cria uma oportunidade na PRIMEIRA etapa aberta. Uma aberta por contato (atômico).
   *
   * ⚠️ A etapa inicial é "a primeira `aberto` e ativa por `ordem`", não a de
   * `chave = 'lead'`: com etapas configuráveis, o cliente pode não ter nenhuma
   * etapa chamada `lead` — e a busca literal devolvia 500 `sem_etapa`. Mesmo
   * critério que o kanban de atendimento usa em `rotas-fila.ts`.
   */
  app.post<{ Body: { contatoId?: string; etapaId?: string; titulo?: string; valorCentavos?: number } }>(
    '/v1/funil/oportunidades',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const contatoId = req.body?.contatoId
      if (!contatoId) return reply.code(422).send({ erro: 'contato.obrigatorio', mensagem: 'Informe o contato.' })

      const r = await req.comTenant(async (tx) => {
        await garantirEtapasFunil(tx)
        // Etapa inicial: a informada (tem de ser `aberto` e ativa) ou a primeira por `ordem`.
        const etapaPedida = req.body?.etapaId
        const [etapa] = etapaPedida
          ? await tx<{ id: string }[]>`
              SELECT id FROM funil_etapa
               WHERE tenant_id = tenant_atual() AND id = ${etapaPedida} AND tipo = 'aberto' AND ativo`
          : await tx<{ id: string }[]>`
              SELECT id FROM funil_etapa
               WHERE tenant_id = tenant_atual() AND tipo = 'aberto' AND ativo
               ORDER BY ordem LIMIT 1`
        if (!etapa) return { erro: etapaPedida ? ('etapa_invalida' as const) : ('sem_etapa' as const) }
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
        if (!c) return { erro: 'contato_nao_encontrado' as const }

        const id = randomUUID()
        // ⚠️ Vencedor atômico: uma aberta por contato (índice parcial).
        const [criada] = await tx<{ id: string }[]>`
          INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, titulo, valor_estimado_centavos, posicao)
          VALUES (tenant_atual(), ${id}, ${contatoId}, ${etapa.id}, ${req.body?.titulo ?? null},
                  ${req.body?.valorCentavos ?? null}, extract(epoch from now()))
          ON CONFLICT (tenant_id, contato_id) WHERE estado = 'aberta' DO NOTHING
          RETURNING id`
        if (!criada) return { erro: 'ja_tem_aberta' as const }
        await tx`INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id, ator_id)
                 VALUES (tenant_atual(), ${randomUUID()}, ${id}, ${etapa.id}, ${await garantirUsuarioId(tx, req)})`
        return { id }
      })
      if ('erro' in r) {
        const cod = { sem_etapa: 500, etapa_invalida: 422, contato_nao_encontrado: 404, ja_tem_aberta: 409 }[r.erro]
        return reply.code(cod).send({ erro: `oportunidade.${r.erro}` })
      }
      return reply.code(201).send({ id: r.id })
    },
  )

  /**
   * Move um card para outro estágio. Concorrência otimista por `versao`. Perda
   * exige motivo. Atualiza histórico (fecha o anterior, abre o novo).
   */
  app.post<{ Params: { id: string }; Body: { etapaId?: string; posicao?: number; versao?: number; motivo?: string } }>(
    '/v1/funil/oportunidades/:id/mover',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const { etapaId, posicao, versao, motivo } = req.body ?? {}
      if (!etapaId || typeof versao !== 'number') {
        return reply.code(422).send({ erro: 'move.invalido', mensagem: 'Estágio e versão são obrigatórios.' })
      }

      const r = await req.comTenant(async (tx) => aplicarMovimento(tx, await garantirUsuarioId(tx, req), {
        id: req.params.id, etapaId, posicao: posicao ?? 0, versao, motivo: motivo ?? null, descricao: null, validarGanho: true,
      }))
      if ('erro' in r) return responderFalha(reply, r)
      return reply.send({ ok: true })
    },
  )

  /**
   * GANHAR com dados mínimos (decisão do dono: CNPJ válido, razão social, nome fantasia e endereço completo).
   * Numa transação só: valida (contato já tem + o que veio em `dados`), move para a etapa de ganho, grava os
   * dados no contato pelo caminho de domínio do cadastro e vincula `pedidoId` (pedido do MESMO contato).
   * Falta dado → 422 `ganho.dados_minimos` com `campos`, sem mover e sem gravar. Falha depois de gravar
   * algo desfaz tudo (nada pela metade).
   */
  app.post<{ Params: { id: string }; Body: CorpoGanho }>(
    '/v1/funil/oportunidades/:id/ganhar', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const d = b.dados
      {
        const r = await req.comTenant(async (tx) => {
          const atual = await dadosDoContato(tx, req.params.id)
          if (!atual) return { erro: 'nao_encontrada' } satisfies Falha
          // Idempotente: já ganha → 200 sem escrever (nem histórico duplicado, nem `fechada_em` reiniciado).
          const [jaEstado] = await tx<{ estado: string }[]>`
            SELECT estado FROM oportunidade WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          if (jaEstado?.estado === 'ganha') return { ok: true as const }
          const etapaId = await etapaDoTipo(tx, 'ganho')
          if (!etapaId) return { erro: 'sem_etapa_ganho' as const }

          // Dados efetivos = o que o contato tem, sobrescrito pelo que a tela mandou (undefined = mantém).
          const e = d?.endereco
          const efetivos: DadosDoGanho = { ...atual.dados }
          const pega = <K extends keyof DadosDoGanho>(k: K, v: string | undefined) => { if (v !== undefined) efetivos[k] = v }
          pega('cnpj', texto(d?.cnpj)); pega('razaoSocial', texto(d?.razaoSocial)); pega('nomeFantasia', texto(d?.nomeFantasia))
          pega('cep', texto(e?.cep)); pega('logradouro', texto(e?.logradouro)); pega('numero', texto(e?.numero))
          pega('bairro', texto(e?.bairro)); pega('cidade', texto(e?.cidade)); pega('uf', texto(e?.uf)?.toUpperCase())
          const v = dadosMinimosDoGanho(efetivos)
          if (!v.ok) return { erro: 'ganho_dados_minimos', campos: v.faltando } satisfies Falha

          if (b.pedidoId) {
            const [ped] = await tx`
              SELECT estado FROM pedido WHERE tenant_id = tenant_atual() AND id = ${b.pedidoId} AND contato_id = ${atual.contatoId}`
            if (!ped) return { erro: 'pedido_invalido' as const, motivo: 'O pedido não existe ou é de outro cliente.' }
            if (!ESTADOS_PEDIDO_VINCULAVEIS.includes(ped.estado as string)) {
              return { erro: 'pedido_invalido' as const, motivo: `Só pedido efetivado ou aguardando conferência pode ser vinculado (este está ${ped.estado}).` }
            }
          }

          const ator = await garantirUsuarioId(tx, req)
          const mov = await aplicarMovimento(tx, ator, {
            id: req.params.id, etapaId, posicao: Date.now() / 1000, versao: typeof b.versao === 'number' ? b.versao : null,
            motivo: null, descricao: null, validarGanho: false,
          })
          if ('erro' in mov) return mov

          // Daqui em diante há escrita: qualquer erro desfaz a transação inteira (movimento incluso).
          if (d) {
            await tx`UPDATE contato SET razao_social = ${efetivos.razaoSocial?.trim() ?? null}, nome_fantasia = ${efetivos.nomeFantasia?.trim() ?? null}
                      WHERE tenant_id = tenant_atual() AND id = ${atual.contatoId}`
            // ⚠️ Ganho nunca apaga o CPF manual do contato: o CNPJ entra como linha nova (ver acrescentarCnpj).
            if (efetivos.cnpj) await acrescentarCnpj(tx, atual.contatoId, efetivos.cnpj)
            if (e) {
              await gravarEndereco(tx, atual.contatoId, { endereco: {
                cep: efetivos.cep, logradouro: efetivos.logradouro, numero: efetivos.numero, complemento: texto(e.complemento) || null,
                bairro: efetivos.bairro, cidade: efetivos.cidade, uf: efetivos.uf,
              } })
            }
          }
          await tx`UPDATE oportunidade SET pedido_id = ${b.pedidoId ?? null} WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          await auditar(tx, {
            atorId: ator, acao: 'funil.ganhar', entidade: 'oportunidade', entidadeId: req.params.id,
            dados: { contatoId: atual.contatoId, pedidoId: b.pedidoId ?? null, dadosAtualizados: !!d },
          })
          return { ok: true as const }
        })
        if ('erro' in r) {
          if (r.erro === 'sem_etapa_ganho') {
            return reply.code(422).send({ erro: 'ganho.sem_etapa', mensagem: 'O funil não tem etapa de ganho ativa.' })
          }
          if (r.erro === 'pedido_invalido') {
            return reply.code(422).send({ erro: 'ganho.pedido_invalido', mensagem: (r as { motivo: string }).motivo })
          }
          return responderFalha(reply, r as Falha)
        }
        return reply.send({ ok: true })
      }
    },
  )

  /** PERDER: motivo do catálogo (ativo, do tenant) obrigatório + descrição livre opcional. */
  app.post<{ Params: { id: string }; Body: { motivoCodigo?: string; descricao?: string; versao?: number } }>(
    '/v1/funil/oportunidades/:id/perder', { preHandler: exigirTenant },
    async (req, reply) => {
      const motivo = texto(req.body?.motivoCodigo)
      const descricao = texto(req.body?.descricao) || null
      if (!motivo) return reply.code(422).send({ erro: 'perda.motivo_obrigatorio', mensagem: 'Escolha o motivo da perda.' })
      if (descricao && descricao.length > 1000) {
        return reply.code(422).send({ erro: 'perda.descricao_grande', mensagem: 'Máximo de 1000 caracteres.' })
      }
      const r = await req.comTenant(async (tx) => {
        // Idempotente: já perdida → 200 sem escrever (histórico e `fechada_em` intactos).
        const [jaEstado] = await tx<{ estado: string }[]>`
          SELECT estado FROM oportunidade WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (jaEstado?.estado === 'perdida') return { ok: true as const }
        const [m] = await tx`SELECT 1 FROM motivo_perda WHERE tenant_id = tenant_atual() AND codigo = ${motivo} AND ativo`
        if (!m) return { erro: 'motivo_invalido' as const }
        const etapaId = await etapaDoTipo(tx, 'perdido')
        if (!etapaId) return { erro: 'sem_etapa_perdido' as const }
        const ator = await garantirUsuarioId(tx, req)
        const mov = await aplicarMovimento(tx, ator, {
          id: req.params.id, etapaId, posicao: Date.now() / 1000, versao: typeof req.body?.versao === 'number' ? req.body.versao : null,
          motivo, descricao, validarGanho: false,
        })
        if ('erro' in mov) return mov
        await auditar(tx, { atorId: ator, acao: 'funil.perder', entidade: 'oportunidade', entidadeId: req.params.id, dados: { motivo } })
        return { ok: true as const }
      })
      if ('erro' in r) {
        if (r.erro === 'motivo_invalido') return reply.code(422).send({ erro: 'perda.motivo_invalido', mensagem: 'Motivo de perda inexistente.' })
        if (r.erro === 'sem_etapa_perdido') return reply.code(422).send({ erro: 'perda.sem_etapa', mensagem: 'O funil não tem etapa de perda ativa.' })
        return responderFalha(reply, r as Falha)
      }
      return reply.send({ ok: true })
    },
  )

  /**
   * TRANSFERIR o card: troca a carteira do contato pelo MESMO caminho de `rotas-carteira.ts`
   * (`transferir_carteira`, histórico de posse), acompanha o responsável das oportunidades abertas, audita e
   * avisa o destino com uma tarefa. Motivo obrigatório. Só gestor/supervisor (admin vale por tudo).
   */
  app.post<{ Params: { id: string }; Body: { usuarioId?: string; motivo?: string } }>(
    '/v1/funil/oportunidades/:id/transferir', { preHandler: [exigirTenant, exigirPapel('gestor', 'supervisor')] },
    async (req, reply) => {
      const destino = texto(req.body?.usuarioId)
      const motivo = texto(req.body?.motivo)
      if (!destino) return reply.code(422).send({ erro: 'transferencia.usuario_obrigatorio', mensagem: 'Escolha o vendedor de destino.' })
      if (!motivo) return reply.code(422).send({ erro: 'transferencia.motivo_obrigatorio', mensagem: 'Informe o motivo da transferência.' })
      if (!/^[0-9a-f-]{36}$/i.test(destino)) return reply.code(422).send({ erro: 'carteira.usuario_invalido', mensagem: 'Vendedor não encontrado.' })
      const r = await req.comTenant(async (tx) => {
        const [o] = await tx<{ contato_id: string; nome: string }[]>`
          SELECT o.contato_id, c.nome FROM oportunidade o
            JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
           WHERE o.tenant_id = tenant_atual() AND o.id = ${req.params.id}`
        if (!o) return { erro: 'nao_encontrada' as const }
        const [u] = await tx`SELECT 1 FROM usuario WHERE tenant_id = tenant_atual() AND id = ${destino} AND ativo`
        if (!u) return { erro: 'usuario_invalido' as const }
        const eu = await garantirUsuarioId(tx, req)
        const [t] = await tx<{ transferir_carteira: string | null }[]>`
          SELECT transferir_carteira(tenant_atual(), ${o.contato_id}, ${destino}, ${eu}, 'manual', ${motivo})`
        const mudou = (t?.transferir_carteira ?? null) !== null
        await tx`UPDATE oportunidade SET responsavel_id = ${destino}
                  WHERE tenant_id = tenant_atual() AND contato_id = ${o.contato_id} AND estado = 'aberta'`
        await auditar(tx, {
          atorId: eu, acao: 'funil.transferir', entidade: 'oportunidade', entidadeId: req.params.id,
          dados: { contatoId: o.contato_id, destinoId: destino, motivo, semMudanca: !mudou },
        })
        // Aviso ao destino (não a quem transferiu para si mesmo): vira tarefa dele, com o contato.
        if (mudou && destino !== eu) {
          const titulo = `Cliente transferido para você: ${o.nome}`.slice(0, 200)
          const [dup] = await tx`
            SELECT 1 FROM tarefa WHERE tenant_id = tenant_atual() AND contato_id = ${o.contato_id}
               AND responsavel_id = ${destino} AND estado = 'aberta' AND titulo = ${titulo} LIMIT 1`
          if (!dup) {
            // Vence no FIM do próximo dia útil (seg–sex) no fuso do tenant — fuso validado em TS antes do AT TIME ZONE.
            const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
            const fuso = fusoSeguro(t?.fuso)
            await tx`
              INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, tipo, vence_em, criado_por)
              VALUES (tenant_atual(), ${randomUUID()}, ${o.contato_id}, ${destino}, ${titulo}, ${motivo}, 'ligacao',
                      (SELECT (((d + CASE extract(isodow FROM d)::int WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END + 1)::timestamp
                                AT TIME ZONE ${fuso}::text) - interval '1 second')
                         FROM (SELECT (now() AT TIME ZONE ${fuso}::text)::date AS d) x), ${eu})`
          }
        }
        return { ok: true as const, semMudanca: !mudou }
      })
      if ('erro' in r) {
        if (r.erro === 'usuario_invalido') return reply.code(422).send({ erro: 'carteira.usuario_invalido', mensagem: 'Vendedor não encontrado.' })
        return reply.code(404).send({ erro: 'transferencia.nao_encontrada', mensagem: 'Oportunidade não encontrada.' })
      }
      return reply.send({ ok: true, semMudanca: r.semMudanca })
    },
  )

  /**
   * Métricas do funil + recompra (skill funil-de-vendas §"Métricas que valem").
   * Tudo derivado do que já existe: `oportunidade_etapa_historico` (tempo em
   * estágio + conversão A→B), `oportunidade`/`motivo_perda` (perda) e `venda`
   * (recompra + tempo até o 2º pedido). Leitura agregada, sob RLS.
   */
  app.get('/v1/funil/metricas', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      // Por estágio: quantos ENTRARAM (histórico) e tempo médio de permanência
      // (só estadias concluídas — saiu_em preenchido — para não inflar com o now()).
      const etapas = await tx<{
        chave: string; nome: string; ordem: number; tipo: string
        entraram: number; tempo_medio_dias: number | null
      }[]>`
        SELECT e.chave, e.nome, e.ordem, e.tipo,
               count(DISTINCT h.oportunidade_id)::int AS entraram,
               round((avg(EXTRACT(EPOCH FROM (h.saiu_em - h.entrou_em)) / 86400.0)
                      FILTER (WHERE h.saiu_em IS NOT NULL))::numeric, 1) AS tempo_medio_dias
          FROM funil_etapa e
          LEFT JOIN oportunidade_etapa_historico h
            ON h.tenant_id = e.tenant_id AND h.etapa_id = e.id
         WHERE e.tenant_id = tenant_atual() AND e.ativo
         GROUP BY e.chave, e.nome, e.ordem, e.tipo
         ORDER BY e.ordem`

      // Recompra: dos clientes com ao menos 1 venda, quantos compraram 2+.
      const [recompra] = await tx<{ com_compra: number; recompraram: number }[]>`
        SELECT count(*) FILTER (WHERE qtd_vendas >= 1)::int AS com_compra,
               count(*) FILTER (WHERE qtd_vendas >= 2)::int AS recompraram
          FROM metricas_contato WHERE tenant_id = tenant_atual()`

      // Tempo até o 2º pedido: (data da 2ª venda − 1ª), média E mediana (a skill
      // pede a mediana ao lado — um outlier gigante distorce a média).
      const [segundo] = await tx<{ base: number; media_dias: number | null; mediana_dias: number | null }[]>`
        WITH ord AS (
          SELECT contato_id, ocorrida_em,
                 row_number() OVER (PARTITION BY contato_id ORDER BY ocorrida_em) AS rn
            FROM venda
           WHERE tenant_id = tenant_atual() AND contato_id IS NOT NULL AND cancelada_em IS NULL
        ),
        ps AS (
          SELECT contato_id,
                 min(ocorrida_em) FILTER (WHERE rn = 1) AS v1,
                 min(ocorrida_em) FILTER (WHERE rn = 2) AS v2
            FROM ord WHERE rn <= 2 GROUP BY contato_id
        ),
        dif AS (SELECT (v2::date - v1::date) AS dias FROM ps WHERE v2 IS NOT NULL)
        SELECT count(*)::int AS base,
               round(avg(dias)::numeric, 1) AS media_dias,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dias))::numeric, 1) AS mediana_dias
          FROM dif`

      // Perda/churn do funil: fechadas × perdidas + top motivos.
      const [perda] = await tx<{ fechadas: number; perdidas: number }[]>`
        SELECT count(*) FILTER (WHERE estado IN ('ganha','perdida'))::int AS fechadas,
               count(*) FILTER (WHERE estado = 'perdida')::int AS perdidas
          FROM oportunidade WHERE tenant_id = tenant_atual()`
      const motivos = await tx<{ codigo: string; nome: string; qtd: number }[]>`
        SELECT o.motivo_perda_codigo AS codigo, m.nome, count(*)::int AS qtd
          FROM oportunidade o
          JOIN motivo_perda m ON m.tenant_id = o.tenant_id AND m.codigo = o.motivo_perda_codigo
         WHERE o.tenant_id = tenant_atual() AND o.estado = 'perdida'
         GROUP BY o.motivo_perda_codigo, m.nome
         ORDER BY qtd DESC`
      return { etapas, recompra, segundo, perda, motivos }
    })

    // Conversão por estágio (A→B): quantos dos que entraram no estágio avançaram
    // para o próximo, na ordem. É onde o gargalo aparece (skill: meça A→B).
    const etapas = dados.etapas.map((e, i) => {
      const prox = dados.etapas[i + 1]
      const conversao = prox && e.entraram > 0 ? Math.round((prox.entraram / e.entraram) * 1000) / 10 : null
      return {
        chave: e.chave, nome: e.nome, tipo: e.tipo,
        entraram: e.entraram,
        tempoMedioDias: e.tempo_medio_dias !== null ? Number(e.tempo_medio_dias) : null,
        conversaoParaProxima: conversao, // % ; null no último estágio ou sem base
      }
    })
    const r = dados.recompra ?? { com_compra: 0, recompraram: 0 }
    const p = dados.perda ?? { fechadas: 0, perdidas: 0 }
    return reply.send({
      etapas,
      recompra: {
        comCompra: r.com_compra, recompraram: r.recompraram,
        taxa: r.com_compra > 0 ? Math.round((r.recompraram / r.com_compra) * 1000) / 10 : null,
      },
      tempoSegundoPedido: {
        base: dados.segundo?.base ?? 0,
        mediaDias: dados.segundo?.media_dias !== null && dados.segundo?.media_dias !== undefined ? Number(dados.segundo.media_dias) : null,
        medianaDias: dados.segundo?.mediana_dias !== null && dados.segundo?.mediana_dias !== undefined ? Number(dados.segundo.mediana_dias) : null,
      },
      perda: {
        fechadas: p.fechadas, perdidas: p.perdidas,
        taxaPerda: p.fechadas > 0 ? Math.round((p.perdidas / p.fechadas) * 1000) / 10 : null,
        motivos: dados.motivos,
      },
    })
  })

  // ───────── Config do funil (a empresa monta as próprias raias) ─────────

  /** Etapas para configuração — inclui as INATIVAS e a contagem de uso. */
  app.get('/v1/funil/config/etapas', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant(async (tx) => {
      await garantirEtapasFunil(tx)
      return tx<{
        id: string; chave: string; nome: string; tipo: string
        criterio: string | null; ordem: number; ativo: boolean; total: number
      }[]>`
        SELECT e.id, e.chave, e.nome, e.tipo, e.criterio, e.ordem, e.ativo,
               (SELECT count(*) FROM oportunidade o WHERE o.tenant_id = e.tenant_id AND o.etapa_id = e.id)::int AS total
          FROM funil_etapa e WHERE e.tenant_id = tenant_atual() ORDER BY e.ordem`
    })
    return reply.send({ itens })
  })

  app.post<{ Body: { nome?: string; tipo?: string; criterio?: string } }>(
    '/v1/funil/config/etapas', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      if (!nome) return reply.code(422).send({ erro: 'etapa.nome_vazio', mensagem: 'Dê um nome à etapa.' })
      const tipo: TipoEtapa = ehTipoEtapa(req.body?.tipo) ? req.body.tipo : 'aberto'
      const id = await req.comTenant(async (tx) => {
        const [ordem] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(ordem), 0) + 1 AS prox FROM funil_etapa WHERE tenant_id = tenant_atual()`
        // ⚠️ Chave nunca colide (UNIQUE (tenant_id, chave)) e nunca é editada depois.
        const chave = `${slug(nome)}_${randomUUID().slice(0, 4)}`
        const nid = randomUUID()
        await tx`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo, criterio)
                 VALUES (tenant_atual(), ${nid}, ${ordem?.prox ?? 1}, ${chave}, ${nome}, ${tipo},
                         ${req.body?.criterio?.trim() || null})`
        return nid
      })
      return reply.code(201).send({ id })
    },
  )

  /**
   * ⚠️ `chave` NÃO é editável: ela é a identidade estável da etapa, e o resto do
   * produto pode passar a se apoiar nela. Nome, ordem, tipo e critério, sim.
   *
   * ⚠️ Guarda: o funil não pode ficar sem nenhuma etapa `aberto` ativa — sem ela
   * `POST /v1/funil/oportunidades` não teria onde criar o card.
   */
  app.patch<{ Params: { id: string }; Body: { nome?: string; ordem?: number; ativo?: boolean; tipo?: string; criterio?: string } }>(
    '/v1/funil/config/etapas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      if (b.tipo !== undefined && !ehTipoEtapa(b.tipo)) {
        return reply.code(422).send({ erro: 'etapa.tipo_invalido', mensagem: 'Tipo deve ser aberto, ganho ou perdido.' })
      }
      const r = await req.comTenant(async (tx) => {
        const [atual] = await tx<{ tipo: string; ativo: boolean }[]>`
          SELECT tipo, ativo FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!atual) return { erro: 'nao_encontrada' as const }

        const viraNaoAberta = (b.tipo !== undefined && b.tipo !== 'aberto') || b.ativo === false
        if (viraNaoAberta && atual.tipo === 'aberto' && atual.ativo) {
          const [outras] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM funil_etapa
             WHERE tenant_id = tenant_atual() AND tipo = 'aberto' AND ativo AND id <> ${req.params.id}`
          if ((outras?.n ?? 0) === 0) return { erro: 'ultima_aberta' as const }
        }

        const [row] = await tx<{ id: string }[]>`
          UPDATE funil_etapa SET
            nome     = coalesce(${b.nome?.trim() ?? null}, nome),
            ordem    = coalesce(${b.ordem ?? null}, ordem),
            ativo    = coalesce(${b.ativo ?? null}, ativo),
            tipo     = coalesce(${b.tipo ?? null}, tipo),
            criterio = coalesce(${b.criterio?.trim() ?? null}, criterio)
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
          RETURNING id`
        return row ? { ok: true as const } : { erro: 'nao_encontrada' as const }
      })
      if ('erro' in r) {
        if (r.erro === 'ultima_aberta') {
          return reply.code(422).send({ erro: 'etapa.ultima_aberta',
            mensagem: 'Esta é a única etapa em aberto. Crie outra antes de mudar esta.' })
        }
        return reply.code(404).send({ erro: 'etapa.nao_encontrada' })
      }
      return reply.send({ ok: true })
    },
  )

  /**
   * ⚠️ Se há oportunidade na etapa, DESATIVA em vez de apagar. `oportunidade.etapa_id`
   * é NOT NULL com FK sem ON DELETE — o banco recusaria o DELETE — e
   * `oportunidade_etapa_historico.etapa_id` não tem FK, então apagar deixaria
   * histórico órfão e mudaria as métricas retroativamente. Como toda leitura do
   * funil filtra `AND ativo`, desativar já esconde a coluna sem perder nada.
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/funil/config/etapas/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [atual] = await tx<{ tipo: string; ativo: boolean }[]>`
          SELECT tipo, ativo FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!atual) return { estado: 'nao_encontrada' as const }
        if (atual.tipo === 'aberto' && atual.ativo) {
          const [outras] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM funil_etapa
             WHERE tenant_id = tenant_atual() AND tipo = 'aberto' AND ativo AND id <> ${req.params.id}`
          if ((outras?.n ?? 0) === 0) return { estado: 'ultima_aberta' as const }
        }
        const [uso] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM oportunidade WHERE tenant_id = tenant_atual() AND etapa_id = ${req.params.id}`
        if ((uso?.n ?? 0) > 0) {
          await tx`UPDATE funil_etapa SET ativo = false WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          return { estado: 'desativada' as const }
        }
        await tx`DELETE FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { estado: 'removida' as const }
      })
      if (r.estado === 'nao_encontrada') return reply.code(404).send({ erro: 'etapa.nao_encontrada' })
      if (r.estado === 'ultima_aberta') {
        return reply.code(422).send({ erro: 'etapa.ultima_aberta',
          mensagem: 'Esta é a única etapa em aberto. Crie outra antes de remover esta.' })
      }
      return reply.send({ ok: true, estado: r.estado })
    },
  )

  /** Motivos de perda para configuração — inclui os INATIVOS e o uso. */
  app.get('/v1/funil/config/motivos', { preHandler: exigirTenant }, async (req, reply) => {
    const itens = await req.comTenant(async (tx) => {
      await garantirEtapasFunil(tx)
      return tx<{ codigo: string; nome: string; ativo: boolean; total: number }[]>`
        SELECT m.codigo, m.nome, m.ativo,
               (SELECT count(*) FROM oportunidade o
                 WHERE o.tenant_id = m.tenant_id AND o.motivo_perda_codigo = m.codigo)::int AS total
          FROM motivo_perda m WHERE m.tenant_id = tenant_atual() ORDER BY m.nome`
    })
    return reply.send({ itens })
  })

  app.post<{ Body: { nome?: string } }>(
    '/v1/funil/config/motivos', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      if (!nome) return reply.code(422).send({ erro: 'motivo.nome_vazio', mensagem: 'Dê um nome ao motivo.' })
      const codigo = `${slug(nome)}_${randomUUID().slice(0, 4)}`
      await req.comTenant((tx) => tx`
        INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (tenant_atual(), ${codigo}, ${nome})`)
      return reply.code(201).send({ codigo })
    },
  )

  app.patch<{ Params: { codigo: string }; Body: { nome?: string; ativo?: boolean } }>(
    '/v1/funil/config/motivos/:codigo', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const [row] = await req.comTenant((tx) => tx<{ codigo: string }[]>`
        UPDATE motivo_perda SET
          nome  = coalesce(${b.nome?.trim() ?? null}, nome),
          ativo = coalesce(${b.ativo ?? null}, ativo)
         WHERE tenant_id = tenant_atual() AND codigo = ${req.params.codigo}
        RETURNING codigo`)
      if (!row) return reply.code(404).send({ erro: 'motivo.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /**
   * ⚠️ Mesma regra das etapas: motivo já usado é DESATIVADO, não apagado.
   * `oportunidade.motivo_perda_codigo` é texto sem FK — apagar não estouraria no
   * banco, mas o JOIN de `GET /v1/funil/metricas` perderia a linha e a perda
   * sumiria do relatório retroativamente.
   */
  app.delete<{ Params: { codigo: string } }>(
    '/v1/funil/config/motivos/:codigo', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [existe] = await tx`
          SELECT 1 FROM motivo_perda WHERE tenant_id = tenant_atual() AND codigo = ${req.params.codigo}`
        if (!existe) return { estado: 'nao_encontrado' as const }
        const [uso] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM oportunidade
           WHERE tenant_id = tenant_atual() AND motivo_perda_codigo = ${req.params.codigo}`
        if ((uso?.n ?? 0) > 0) {
          await tx`UPDATE motivo_perda SET ativo = false WHERE tenant_id = tenant_atual() AND codigo = ${req.params.codigo}`
          return { estado: 'desativado' as const }
        }
        await tx`DELETE FROM motivo_perda WHERE tenant_id = tenant_atual() AND codigo = ${req.params.codigo}`
        return { estado: 'removido' as const }
      })
      if (r.estado === 'nao_encontrado') return reply.code(404).send({ erro: 'motivo.nao_encontrado' })
      return reply.send({ ok: true, estado: r.estado })
    },
  )
}
