import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { variaveisDoCorpo, validarMapeamento } from '@geracrm/shared'
import { lerBusca, padraoContem } from '../../db/busca.js'

const PAGINA = 50

/**
 * Templates (HSM) do WhatsApp Oficial — o que reabre a janela de 24h.
 *
 * ⚠️ O `nome` é o identificador NA META e vai no envio (não é rótulo interno):
 * minúsculas, dígitos e `_`. Só a versão `APPROVED` é enviável (índice parcial
 * `template_versao_aprovada` garante no máximo uma). Enquanto a Meta não está
 * conectada, o template nasce `PENDING` e a aprovação é externa — a tela deixa
 * isso VISÍVEL (degrada com honestidade), nunca finge aprovado.
 *
 * Editar = NOVA versão (a Meta reavalia); o histórico e o motivo de rejeição
 * ficam guardados para não repetir o erro no próximo envio para aprovação.
 */
interface Corpo {
  header?: { texto: string }
  body: { texto: string }
  footer?: { texto: string }
  botoes?: { texto: string }[]
}
const CATEGORIAS = ['MARKETING', 'UTILITY', 'AUTHENTICATION']
const STATUS_META = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOME_META = /^[a-z0-9_]{1,512}$/

interface FiltrosTemplate {
  status: string | null
  categoria: string | null
  canalId: string | null
  busca: string | null
}

/**
 * Filtros do catálogo (todos opcionais). Valor fora do conjunto → `campos` para o formulário.
 * Ausente = sem filtro; vazio em status/categoria/canalId é erro, não "todos".
 */
function lerFiltrosTemplate(q: { status?: string; categoria?: string; canalId?: string; q?: string }):
  { ok: true; filtros: FiltrosTemplate } | { ok: false; campos: Record<string, string> } {
  const campos: Record<string, string> = {}
  const status = q.status === undefined ? null : STATUS_META.includes(q.status) ? q.status : undefined
  const categoria = q.categoria === undefined ? null : CATEGORIAS.includes(q.categoria) ? q.categoria : undefined
  const canalId = q.canalId === undefined ? null : UUID.test(q.canalId) ? q.canalId : undefined
  const busca = lerBusca(q.q)
  if (status === undefined) campos.status = `Use um de: ${STATUS_META.join(', ')}.`
  if (categoria === undefined) campos.categoria = `Use um de: ${CATEGORIAS.join(', ')}.`
  if (canalId === undefined) campos.canalId = 'Informe o id (uuid) de um canal.'
  if (busca === 'invalido') campos.q = 'Use até 100 caracteres.'
  if (status === undefined || categoria === undefined || canalId === undefined || busca === 'invalido') {
    return { ok: false, campos }
  }
  return { ok: true, filtros: { status, categoria, canalId, busca } }
}

/** Valida o corpo (componentes da Meta). Retorna erro tipificado ou null. */
function validarCorpo(c: unknown): string | null {
  if (!c || typeof c !== 'object') return 'corpo.ausente'
  const corpo = c as Corpo
  if (!corpo.body || typeof corpo.body.texto !== 'string' || !corpo.body.texto.trim()) return 'corpo.body_vazio'
  if (corpo.body.texto.length > 1024) return 'corpo.body_longo'
  if (corpo.header && (typeof corpo.header.texto !== 'string' || corpo.header.texto.length > 60)) return 'corpo.header_invalido'
  if (corpo.footer && (typeof corpo.footer.texto !== 'string' || corpo.footer.texto.length > 60)) return 'corpo.footer_invalido'
  if (corpo.botoes && (!Array.isArray(corpo.botoes) || corpo.botoes.length > 3)) return 'corpo.botoes_invalidos'
  return null
}

export async function rotasTemplate(app: FastifyInstance): Promise<void> {
  /** Catálogo: cada template com a última versão (status/corpo). Cursor por criado_em. */
  // Filtros opcionais (a resposta só acrescenta): `status` e `categoria` pelo valor que a tabela
  // guarda; `q` pelo nome (ILIKE "contém"). `canalId` não é coluna de template (o catálogo é do
  // tenant): ele decide só se o número envia template — o oficial sim, o não-oficial não tem
  // catálogo aqui e recebe lista vazia. Canal de outro tenant ou inexistente → 422.
  app.get<{ Querystring: { cursor?: string; status?: string; categoria?: string; canalId?: string; q?: string } }>(
    '/v1/templates',
    { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null
      let curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const lidos = lerFiltrosTemplate(req.query)
      if (!lidos.ok) {
        return reply.code(422).send({ erro: 'template.filtro_invalido', mensagem: 'Filtro inválido.', campos: lidos.campos })
      }
      const f = lidos.filtros
      const r = await req.comTenant(async (tx) => {
        if (f.canalId !== null) {
          const [canal] = await tx<{ tipo: string }[]>`
            SELECT tipo FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${f.canalId}`
          if (!canal) return { estado: 'canal_invalido' as const }
          if (canal.tipo !== 'whatsapp_oficial') return { estado: 'ok' as const, linhas: [] }
        }
        const linhas = await tx<{
          id: string; nome: string; categoria: string; idioma: string; criado_em: Date
          versao: number; status_meta: string; motivo_rejeicao: string | null; corpo: Corpo; submetido: boolean
          mapeamento_variaveis: Record<string, string>
        }[]>`
          SELECT t.id, t.nome, t.categoria, t.idioma, t.criado_em, t.mapeamento_variaveis,
                 v.versao, v.status_meta, v.motivo_rejeicao, v.corpo, v.id_externo IS NOT NULL AS submetido
            FROM template t
            JOIN LATERAL (
              SELECT versao, status_meta, motivo_rejeicao, corpo, id_externo
                FROM template_versao tv
               WHERE tv.tenant_id = t.tenant_id AND tv.template_id = t.id
               ORDER BY versao DESC LIMIT 1) v ON true
           WHERE t.tenant_id = tenant_atual()
             AND ${f.status === null ? tx`true` : tx`v.status_meta = ${f.status}`}
             AND ${f.categoria === null ? tx`true` : tx`t.categoria = ${f.categoria}`}
             AND ${f.busca === null ? tx`true` : tx`t.nome ILIKE ${padraoContem(f.busca)}`}
             AND ${curEm === null ? tx`true`
                  : tx`(t.criado_em, t.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
           ORDER BY t.criado_em DESC, t.id DESC
           LIMIT ${PAGINA + 1}`
        return { estado: 'ok' as const, linhas }
      })
      if (r.estado === 'canal_invalido') {
        return reply.code(422).send({ erro: 'template.filtro_invalido', mensagem: 'Filtro inválido.', campos: { canalId: 'Canal não encontrado.' } })
      }
      const linhas = r.linhas

      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor = temMais && ultimo
        ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null

      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, nome: l.nome, categoria: l.categoria, idioma: l.idioma, criadoEm: l.criado_em,
          versao: l.versao, statusMeta: l.status_meta, motivoRejeicao: l.motivo_rejeicao,
          corpo: l.corpo, submetido: l.submetido, mapeamentoVariaveis: l.mapeamento_variaveis,
        })),
        proximoCursor,
      })
    },
  )

  /** Um template com TODAS as versões (histórico + motivos de rejeição). */
  app.get<{ Params: { id: string } }>(
    '/v1/templates/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [t] = await tx<{ id: string; nome: string; categoria: string; idioma: string; criado_em: Date; mapeamento_variaveis: Record<string, string> }[]>`
          SELECT id, nome, categoria, idioma, criado_em, mapeamento_variaveis FROM template
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!t) return null
        const versoes = await tx<{
          versao: number; status_meta: string; motivo_rejeicao: string | null; corpo: Corpo
          id_externo: string | null; revisado_em: Date | null; criado_em: Date
        }[]>`
          SELECT versao, status_meta, motivo_rejeicao, corpo, id_externo, revisado_em, criado_em
            FROM template_versao
           WHERE tenant_id = tenant_atual() AND template_id = ${req.params.id}
           ORDER BY versao DESC`
        return { t, versoes }
      })
      if (!r) return reply.code(404).send({ erro: 'template.nao_encontrado' })
      return reply.send({
        id: r.t.id, nome: r.t.nome, categoria: r.t.categoria, idioma: r.t.idioma, criadoEm: r.t.criado_em, mapeamentoVariaveis: r.t.mapeamento_variaveis,
        versoes: r.versoes.map((v) => ({
          versao: v.versao, statusMeta: v.status_meta, motivoRejeicao: v.motivo_rejeicao, corpo: v.corpo,
          submetido: v.id_externo !== null, revisadoEm: v.revisado_em, criadoEm: v.criado_em,
        })),
      })
    },
  )

  /** Criar template (rascunho) + versão 1 PENDING. */
  app.post<{ Body: { nome?: string; categoria?: string; idioma?: string; corpo?: unknown } }>(
    '/v1/templates',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const { nome, categoria, corpo } = req.body ?? {}
      const idioma = req.body?.idioma || 'pt_BR'
      if (!nome || !NOME_META.test(nome)) return reply.code(422).send({ erro: 'nome.invalido', mensagem: 'Use minúsculas, números e _.' })
      if (!categoria || !CATEGORIAS.includes(categoria)) return reply.code(422).send({ erro: 'categoria.invalida' })
      const erroCorpo = validarCorpo(corpo)
      if (erroCorpo) return reply.code(422).send({ erro: erroCorpo })

      const id = randomUUID()
      const r = await req.comTenant(async (tx) => {
        const [t] = await tx<{ id: string }[]>`
          INSERT INTO template (tenant_id, id, nome, categoria, idioma)
          VALUES (tenant_atual(), ${id}, ${nome}, ${categoria}, ${idioma})
          ON CONFLICT (tenant_id, nome, idioma) DO NOTHING
          RETURNING id`
        if (!t) return { conflito: true as const }
        await tx`
          INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
          VALUES (tenant_atual(), ${id}, 1, ${JSON.stringify(corpo)}::text::jsonb, 'PENDING')`
        return { conflito: false as const }
      })
      if (r.conflito) return reply.code(409).send({ erro: 'template.ja_existe', mensagem: 'Já existe um template com esse nome e idioma.' })
      return reply.code(201).send({ id })
    },
  )

  /** Editar = nova versão PENDING (a Meta reavalia). */
  app.post<{ Params: { id: string }; Body: { corpo?: unknown } }>(
    '/v1/templates/:id/versao',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const erroCorpo = validarCorpo(req.body?.corpo)
      if (erroCorpo) return reply.code(422).send({ erro: erroCorpo })
      const r = await req.comTenant(async (tx) => {
        const [t] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(versao), 0) + 1 AS prox FROM template_versao
           WHERE tenant_id = tenant_atual() AND template_id = ${req.params.id}`
        // Sem template → o SELECT ainda devolve prox=1; confirmamos que existe.
        const [existe] = await tx<{ id: string }[]>`
          SELECT id FROM template WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!existe) return { ok: false as const }
        await tx`
          INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
          VALUES (tenant_atual(), ${req.params.id}, ${t!.prox}, ${JSON.stringify(req.body!.corpo)}::text::jsonb, 'PENDING')`
        return { ok: true as const, versao: t!.prox }
      })
      if (!r.ok) return reply.code(404).send({ erro: 'template.nao_encontrado' })
      return reply.code(201).send({ versao: r.versao })
    },
  )

  /**
   * Mapeamento {{n}} -> campo do contato (F2). Lista FECHADA de campos (shared) e só variáveis
   * que o corpo da última versão realmente tem. `{}` limpa o mapeamento.
   */
  app.patch<{ Params: { id: string }; Body: { variaveis?: unknown } }>(
    '/v1/templates/:id/mapeamento',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const v = req.body?.variaveis
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return reply.code(422).send({ erro: 'mapeamento.invalido', mensagem: 'Envie variaveis como objeto {"1": campo}.', campos: { variaveis: 'Informe um objeto.' } })
      }
      const r = await req.comTenant(async (tx) => {
        const [t] = await tx<{ corpo: Corpo }[]>`
          SELECT v.corpo FROM template t
            JOIN LATERAL (SELECT corpo FROM template_versao tv
                           WHERE tv.tenant_id = t.tenant_id AND tv.template_id = t.id
                           ORDER BY versao DESC LIMIT 1) v ON true
           WHERE t.tenant_id = tenant_atual() AND t.id = ${req.params.id}`
        if (!t) return { estado: 'nao_encontrado' as const }
        const texto = `${t.corpo.header?.texto ?? ''} ${t.corpo.body?.texto ?? ''}`
        const erro = validarMapeamento(v as Record<string, unknown>, variaveisDoCorpo(texto))
        if (erro) return { estado: 'invalido' as const, erro }
        await tx`
          UPDATE template SET mapeamento_variaveis = ${JSON.stringify(v)}::text::jsonb
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { estado: 'ok' as const }
      })
      if (r.estado === 'nao_encontrado') return reply.code(404).send({ erro: 'template.nao_encontrado' })
      if (r.estado === 'invalido') {
        return reply.code(422).send({
          erro: r.erro.motivo === 'campo_invalido' ? 'mapeamento.campo_invalido' : 'mapeamento.variavel_inexistente',
          mensagem: r.erro.motivo === 'campo_invalido'
            ? `Campo inválido para {{${r.erro.variavel}}}.` : `O corpo do template não tem a variável {{${r.erro.variavel}}}.`,
          campos: { [`variaveis.${r.erro.variavel}`]: r.erro.motivo === 'campo_invalido' ? 'Campo inválido.' : 'O corpo não tem esta variável.' },
        })
      }
      return reply.send({ ok: true, mapeamentoVariaveis: v })
    },
  )

  /** Apagar rascunho — só se NUNCA foi submetido à Meta (sem id_externo). */
  app.delete<{ Params: { id: string } }>(
    '/v1/templates/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [t] = await tx<{ id: string }[]>`
          SELECT id FROM template WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!t) return { estado: 'nao_encontrado' as const }
        const [sub] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM template_versao
           WHERE tenant_id = tenant_atual() AND template_id = ${req.params.id} AND id_externo IS NOT NULL`
        if (sub && sub.n > 0) return { estado: 'submetido' as const }
        await tx`DELETE FROM template WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { estado: 'removido' as const }
      })
      if (r.estado === 'nao_encontrado') return reply.code(404).send({ erro: 'template.nao_encontrado' })
      if (r.estado === 'submetido') return reply.code(409).send({ erro: 'template.submetido', mensagem: 'Já foi enviado à Meta; não pode ser apagado aqui.' })
      return reply.send({ ok: true, estado: 'removido' })
    },
  )
}
