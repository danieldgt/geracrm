import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { classificarRfv, normalizarTelefone, normalizarDocumento } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { parseCsvContatos } from './importar-csv.js'

/** Teto de linhas por importação — evita engolir um arquivo gigante numa tx. */
const MAX_LINHAS_CSV = 5000

/**
 * CRM: a base de clientes com RFV, em duas leituras da MESMA verdade.
 *
 *  · `/v1/contatos`     — ordenada por VALOR (maiores compradores).
 *  · `/v1/fila-do-dia`  — ordenada por URGÊNCIA (quem está saindo do ritmo).
 *
 * ⚠️ Paginação por CURSOR (keyset), nunca OFFSET profundo — grid não paginado
 * derrubou o Postgres do GeraCloud por OOM, e há coluna de 11 mil cards.
 *
 * ⚠️ A classificação RFV vem de `@geracrm/shared` — a mesma regra serve web, app
 * e API. O endpoint monta o dado; o domínio decide o segmento.
 */

const LIMITE_PADRAO = 30
const LIMITE_MAX = 100

/** Linha crua da view; bigint/numeric vêm como STRING do driver. */
interface LinhaMetrica {
  id: string; nome: string; qtd_vendas: string; total_centavos: string
  dias_sem_comprar: number | null; atraso_relativo: string | null
  media_entre_vendas_dias: string | null; ultima_venda_em: Date | null
  confiavel: boolean; ticket_medio_centavos: string | null
}

/** Converte a linha em item de API, já com o segmento RFV do domínio. */
function paraItem(l: LinhaMetrica) {
  const atrasoRelativo = l.atraso_relativo === null ? null : Number(l.atraso_relativo)
  const segmento = classificarRfv({
    qtdVendas: Number(l.qtd_vendas),
    diasSemComprar: l.dias_sem_comprar,
    atrasoRelativo,
  })
  return {
    id: l.id,
    nome: l.nome,
    qtdVendas: Number(l.qtd_vendas),
    totalCentavos: Number(l.total_centavos),
    ticketMedioCentavos: l.ticket_medio_centavos === null ? null : Number(l.ticket_medio_centavos),
    diasSemComprar: l.dias_sem_comprar,
    mediaEntreVendasDias: l.media_entre_vendas_dias === null ? null : Number(l.media_entre_vendas_dias),
    atrasoRelativo,
    ultimaVendaEm: l.ultima_venda_em,
    // ⚠️ Viaja com o dado: false → a tela diz "estimado" em vez de afirmar um
    //    ritmo que o histórico anterior à carga não deixa ver.
    confiavel: l.confiavel,
    segmento,
  }
}

const limiteDe = (bruto: unknown) => Math.min(Number(bruto) || LIMITE_PADRAO, LIMITE_MAX)

/** Cursor opaco de dois campos. Inválido → começa do início, nunca 500. */
function lerCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null
  const [a, b] = Buffer.from(cursor, 'base64url').toString('utf8').split(':')
  return a !== undefined && b ? [a, b] : null
}
const escreverCursor = (a: string | number, id: string) =>
  Buffer.from(`${a}:${id}`, 'utf8').toString('base64url')

export async function rotasContatos(app: FastifyInstance): Promise<void> {
  /**
   * Cadastra um contato (nome + telefone). ⚠️ Idempotente pelo telefone: se já
   * existe um contato com esse número principal, DEVOLVE o existente em vez de
   * duplicar — telefone é identidade no WhatsApp.
   */
  app.post<{ Body: { nome?: string; telefone?: string } }>(
    '/v1/contatos',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const tel = normalizarTelefone(req.body?.telefone ?? '')
      if (!nome) return reply.code(422).send({ erro: 'contato.nome_obrigatorio', mensagem: 'Informe o nome.' })
      if (!tel) return reply.code(422).send({ erro: 'contato.telefone_invalido', mensagem: 'Telefone inválido. Use DDD + número.' })

      const r = await req.comTenant(async (tx) => {
        const [existe] = await tx<{ contato_id: string }[]>`
          SELECT contato_id FROM contato_telefone
           WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal
           LIMIT 1`
        if (existe) return { id: existe.contato_id, novo: false }

        const id = randomUUID()
        await tx`
          INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
          VALUES (tenant_atual(), ${id}, ${nome}, 'manual', true)`
        await tx`
          INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
          VALUES (tenant_atual(), ${id}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'manual')
          ON CONFLICT DO NOTHING`
        return { id, novo: true }
      })

      return reply.code(r.novo ? 201 : 200).send({ id: r.id, nome, novo: r.novo })
    },
  )

  /**
   * Importação de contatos por CSV (EP-02). ⚠️ Validação NO SERVIDOR pelo parser
   * puro; dedup por telefone (chave_bloqueio, INV-50). Falha de linha é RETORNO
   * tipificado — a tela mostra quantas entraram e quais linhas caíram e por quê.
   */
  app.post<{ Body: { csv?: string } }>(
    '/v1/contatos/importar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const csv = req.body?.csv
      if (typeof csv !== 'string' || !csv.trim()) {
        return reply.code(422).send({ erro: 'csv.vazio', mensagem: 'Envie o conteúdo do CSV.' })
      }
      const { linhas, rejeicoes } = parseCsvContatos(csv)
      if (linhas.length > MAX_LINHAS_CSV) {
        return reply.code(422).send({ erro: 'csv.grande_demais', mensagem: `Máximo ${MAX_LINHAS_CSV} linhas por importação.` })
      }

      let criados = 0
      let atualizados = 0
      await req.comTenant(async (tx) => {
        for (const l of linhas) {
          let contatoId: string | null = null
          // Dedup por telefone quando há; sem telefone, sempre novo.
          if (l.chaveBloqueio) {
            const [existe] = await tx<{ contato_id: string }[]>`
              SELECT contato_id FROM contato_telefone
               WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${l.chaveBloqueio} AND principal LIMIT 1`
            if (existe) { contatoId = existe.contato_id; atualizados++ }
          }
          if (!contatoId) {
            contatoId = randomUUID()
            criados++
            await tx`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
                     VALUES (tenant_atual(), ${contatoId}, ${l.nome}, 'importacao', true)`
            if (l.e164 && l.chaveBloqueio) {
              await tx`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
                       VALUES (tenant_atual(), ${contatoId}, 1, ${l.e164}, ${l.chaveBloqueio}, true, true, 'importacao')
                       ON CONFLICT DO NOTHING`
            }
          }
          if (l.documento && l.tipoDocumento) {
            await tx`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fonte)
                     VALUES (tenant_atual(), ${contatoId}, 1, ${l.tipoDocumento}, ${l.documento}, 'importacao')
                     ON CONFLICT DO NOTHING`
          }
        }
      })

      return reply.send({
        total: linhas.length + rejeicoes.length,
        criados, atualizados,
        rejeitados: rejeicoes.length,
        rejeicoes: rejeicoes.slice(0, 50),
      })
    },
  )

  /**
   * Busca de contato por nome OU telefone — varre `contato` DIRETO (não as
   * métricas), então acha também contato manual sem histórico de venda.
   */
  app.get('/v1/contatos/busca', { preHandler: exigirTenant }, async (req, reply) => {
    const q = String((req.query as { q?: string })?.q ?? '').trim()
    if (q.length < 2) return reply.send({ itens: [] })
    const digitos = q.replace(/\D/g, '')
    const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; e164: string | null }[]>`
      SELECT c.id, c.nome, ct.e164
        FROM contato c
        LEFT JOIN contato_telefone ct
          ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.principal
       WHERE c.tenant_id = tenant_atual() AND c.ativo
         AND ( c.nome ILIKE ${'%' + q + '%'}
               ${digitos.length >= 4 ? tx`OR ct.e164 LIKE ${'%' + digitos + '%'}` : tx``} )
       ORDER BY c.nome ASC
       LIMIT 20
    `)
    return reply.send({ itens: linhas.map((l) => ({ id: l.id, nome: l.nome, telefone: l.e164 })) })
  })

  // ---------------------------------------------------------------------------
  // Clientes por valor.
  // ---------------------------------------------------------------------------
  app.get('/v1/contatos', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; limite?: string }
    const limite = limiteDe(q.limite)
    const c = lerCursor(q.cursor)

    const linhas = await req.comTenant((tx) => tx<LinhaMetrica[]>`
      SELECT c.id, c.nome, m.qtd_vendas::text, m.total_centavos::text,
             m.dias_sem_comprar, m.atraso_relativo::text,
             m.media_entre_vendas_dias::text, m.ultima_venda_em,
             m.confiavel, m.ticket_medio_centavos::text
        FROM metricas_contato m JOIN contato c ON c.id = m.contato_id
       WHERE ${c === null ? tx`true` : tx`(m.total_centavos, c.id) < (${Number(c[0])}, ${c[1]}::uuid)`}
       ORDER BY m.total_centavos DESC, c.id DESC
       LIMIT ${limite + 1}
    `)

    const temMais = linhas.length > limite
    const pagina = temMais ? linhas.slice(0, limite) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraItem),
      proximoCursor: temMais && ultimo ? escreverCursor(ultimo.total_centavos, ultimo.id) : null,
    })
  })

  // ---------------------------------------------------------------------------
  // Ficha do Contato — o cliente 360°.
  //
  // ⚠️ Uma leitura por bloco, na MESMA transação (mesmo tenant, RLS). Cada bloco
  //    tem seu estado: métricas ausentes = cliente sem venda; itens ausentes =
  //    detalhe de venda ainda não importado. A tela mostra isso, não finge.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const id = req.params.id
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return reply.code(400).send({ erro: 'contato.id_invalido', mensagem: 'Id de contato inválido.' })
      }

      const dados = await req.comTenant(async (tx) => {
        const [contato] = await tx<{
          id: string; nome: string; modalidade: string | null; qualificado: boolean
          recebe_campanhas: boolean; recebe_automacoes: boolean; criado_em: Date
        }[]>`
          SELECT id, nome, modalidade, qualificado, recebe_campanhas, recebe_automacoes, criado_em
            FROM contato WHERE id = ${id}
        `
        if (!contato) return null

        const [metrica] = await tx<LinhaMetrica[]>`
          SELECT c.id, c.nome, m.qtd_vendas::text, m.total_centavos::text,
                 m.dias_sem_comprar, m.atraso_relativo::text,
                 m.media_entre_vendas_dias::text, m.ultima_venda_em,
                 m.confiavel, m.ticket_medio_centavos::text
            FROM metricas_contato m JOIN contato c ON c.id = m.contato_id
           WHERE c.id = ${id}
        `

        const telefones = await tx<{ seq: number; e164: string; principal: boolean; whatsapp: boolean }[]>`
          SELECT seq, e164, principal, whatsapp FROM contato_telefone
           WHERE contato_id = ${id} ORDER BY principal DESC, seq`
        // ⚠️ DISTINCT + limite: a dedup por telefone pode ter fundido muitos
        //    cadastros do ERP num contato (na demo, 566 CNPJs no mesmo telefone).
        //    A ficha mostra alguns e a contagem total — o excesso é sinal de
        //    over-merge, não some escondido.
        const documentos = await tx<{ seq: number; tipo: string; numero: string; fiscal: boolean }[]>`
          SELECT seq, tipo, numero, fiscal FROM contato_documento
           WHERE contato_id = ${id} ORDER BY numero LIMIT 6`
        const [{ n: totalDocumentos } = { n: 0 }] = await tx<{ n: number }[]>`
          SELECT count(DISTINCT numero)::int AS n FROM contato_documento WHERE contato_id = ${id}`
        const [endereco] = await tx<{
          logradouro: string | null; numero: string | null; bairro: string | null
          cidade: string | null; uf: string | null; cep: string | null
        }[]>`
          SELECT logradouro, numero, bairro, cidade, uf, cep FROM contato_endereco
           WHERE contato_id = ${id} ORDER BY principal DESC, seq LIMIT 1`

        const ultimasVendas = await tx<{ id: string; ocorrida_em: Date; valor_centavos: string; cancelada: boolean }[]>`
          SELECT id, ocorrida_em, valor_centavos::text,
                 (cancelada_em IS NOT NULL) AS cancelada
            FROM venda WHERE contato_id = ${id}
           ORDER BY ocorrida_em DESC LIMIT 10`

        // ⚠️ Categorias dependem de item_venda, que só existe quando o detalhe
        //    da venda foi importado. Vazio aqui é honesto — não é bug.
        const categorias = await tx<{ categoria: string | null; total: string; qtd: string }[]>`
          SELECT p.categoria,
                 sum(iv.quantidade * iv.valor_unitario_centavos)::text AS total,
                 sum(iv.quantidade)::text AS qtd
            FROM item_venda iv
            JOIN venda v ON v.tenant_id = iv.tenant_id AND v.id = iv.venda_id
            LEFT JOIN sku s ON s.tenant_id = iv.tenant_id AND s.id = iv.sku_id
            LEFT JOIN produto p ON p.tenant_id = s.tenant_id AND p.id = s.produto_id
           WHERE v.contato_id = ${id} AND v.cancelada_em IS NULL
           GROUP BY p.categoria ORDER BY total DESC LIMIT 8`

        const comentarios = await tx<{ id: string; texto: string; criado_em: Date }[]>`
          SELECT id, texto, criado_em FROM comentario
           WHERE contato_id = ${id} ORDER BY criado_em DESC LIMIT 20`

        return { contato, metrica, telefones, documentos, totalDocumentos, endereco, ultimasVendas, categorias, comentarios }
      })

      if (!dados) return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })

      const m = dados.metrica
      return reply.send({
        id: dados.contato.id,
        nome: dados.contato.nome,
        modalidade: dados.contato.modalidade,
        qualificado: dados.contato.qualificado,
        recebeCampanhas: dados.contato.recebe_campanhas,
        recebeAutomacoes: dados.contato.recebe_automacoes,
        telefones: dados.telefones,
        documentos: dados.documentos,
        totalDocumentos: dados.totalDocumentos,
        endereco: dados.endereco ?? null,
        // Métricas + segmento só quando há venda; senão null (cliente sem compra).
        metricas: m ? paraItem(m) : null,
        ultimasVendas: dados.ultimasVendas.map((v) => ({
          id: v.id, ocorridaEm: v.ocorrida_em, valorCentavos: Number(v.valor_centavos), cancelada: v.cancelada,
        })),
        categorias: dados.categorias.map((c) => ({
          categoria: c.categoria ?? 'Sem categoria',
          totalCentavos: Number(c.total), qtd: Number(c.qtd),
        })),
        comentarios: dados.comentarios,
      })
    },
  )

  // ───────── Edição da ficha do contato (CRUD dos satélites) ─────────

  /** Edita nome e/ou ativa/desativa (soft delete) o contato. */
  app.patch<{ Params: { id: string }; Body: { nome?: string; ativo?: boolean } }>(
    '/v1/contatos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const ativo = req.body?.ativo
      if (nome === undefined && ativo === undefined) return reply.code(422).send({ erro: 'contato.nada_a_mudar' })
      if (nome !== undefined && !nome) return reply.code(422).send({ erro: 'contato.nome_obrigatorio', mensagem: 'Nome não pode ficar vazio.' })
      const [r] = await req.comTenant((tx) => tx`
        UPDATE contato SET
          nome  = ${nome ?? tx`nome`},
          ativo = ${ativo === undefined ? tx`ativo` : ativo}
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Adiciona um telefone ao contato (idempotente por chave_bloqueio). */
  app.post<{ Params: { id: string }; Body: { telefone?: string; principal?: boolean } }>(
    '/v1/contatos/:id/telefones', { preHandler: exigirTenant },
    async (req, reply) => {
      const tel = normalizarTelefone(req.body?.telefone ?? '')
      if (!tel) return reply.code(422).send({ erro: 'telefone.invalido', mensagem: 'Telefone inválido.' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const [linhaProx] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(seq), 0) + 1 AS prox FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        const prox = linhaProx!.prox
        const principal = req.body?.principal === true || prox === 1 // 1º vira principal
        if (principal) await tx`UPDATE contato_telefone SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        await tx`
          INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
          VALUES (tenant_atual(), ${req.params.id}, ${prox}, ${tel.e164}, ${tel.chaveBloqueio}, ${principal}, true, 'manual')
          ON CONFLICT DO NOTHING`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true })
    },
  )

  /** Define qual telefone é o principal. */
  app.post<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/telefones/:seq/principal', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant(async (tx) => {
        await tx`UPDATE contato_telefone SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        await tx`UPDATE contato_telefone SET principal = true WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`
      })
      return reply.send({ ok: true })
    },
  )

  /** Remove um telefone. */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/telefones/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        DELETE FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`)
      return reply.send({ ok: true })
    },
  )

  /** Adiciona um documento (CNPJ/CPF) validando o dígito. */
  app.post<{ Params: { id: string }; Body: { tipo?: 'cnpj' | 'cpf'; numero?: string } }>(
    '/v1/contatos/:id/documentos', { preHandler: exigirTenant },
    async (req, reply) => {
      const tipo = req.body?.tipo
      if (tipo !== 'cnpj' && tipo !== 'cpf') return reply.code(422).send({ erro: 'documento.tipo_invalido' })
      const numero = normalizarDocumento(tipo, req.body?.numero ?? '')
      if (!numero) return reply.code(422).send({ erro: 'documento.invalido', mensagem: `${tipo.toUpperCase()} inválido (dígito verificador).` })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const [linhaProx] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(seq), 0) + 1 AS prox FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        const prox = linhaProx!.prox
        await tx`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fonte)
                 VALUES (tenant_atual(), ${req.params.id}, ${prox}, ${tipo}, ${numero}, 'manual')`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true, numero })
    },
  )

  /** Remove um documento. */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/documentos/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        DELETE FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`)
      return reply.send({ ok: true })
    },
  )

  /** Define/atualiza o endereço principal (um por contato, seq 1). */
  app.put<{ Params: { id: string }; Body: Record<string, string | undefined> }>(
    '/v1/contatos/:id/endereco', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        await tx`
          INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte)
          VALUES (tenant_atual(), ${req.params.id}, 1, ${b['logradouro'] ?? null}, ${b['numero'] ?? null}, ${b['complemento'] ?? null},
                  ${b['bairro'] ?? null}, ${b['cidade'] ?? null}, ${b['uf'] ?? null}, ${b['cep'] ?? null}, true, 'manual')
          ON CONFLICT (tenant_id, contato_id, seq) DO UPDATE SET
            logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero, complemento = EXCLUDED.complemento,
            bairro = EXCLUDED.bairro, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, cep = EXCLUDED.cep`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Comentários/notas do contato — histórico simples. */
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/comentarios', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{ id: string; texto: string; autor: string | null; criado_em: Date }[]>`
        SELECT c.id, c.texto, u.nome AS autor, c.criado_em
          FROM comentario c LEFT JOIN usuario u ON u.tenant_id = c.tenant_id AND u.id = c.autor_id
         WHERE c.tenant_id = tenant_atual() AND c.contato_id = ${req.params.id}
         ORDER BY c.criado_em DESC LIMIT 50`)
      return reply.send({ itens: linhas.map((l) => ({ id: l.id, texto: l.texto, autor: l.autor, criadoEm: l.criado_em })) })
    },
  )
  app.post<{ Params: { id: string }; Body: { texto?: string } }>(
    '/v1/contatos/:id/comentarios', { preHandler: exigirTenant },
    async (req, reply) => {
      const texto = req.body?.texto?.trim()
      if (!texto) return reply.code(422).send({ erro: 'comentario.vazio', mensagem: 'Escreva algo.' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const autorId = await garantirUsuarioId(tx, req)
        await tx`INSERT INTO comentario (tenant_id, id, contato_id, autor_id, texto)
                 VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${autorId}, ${texto})`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true })
    },
  )

  // ---------------------------------------------------------------------------
  // Fila do Dia: quem está saindo do ritmo — o coração explicável (RFV-10).
  //
  // ⚠️ A ordenação é por URGÊNCIA, não por valor: um fiel em dia não precisa de
  //    ação hoje; quem passou do próprio ritmo, sim. A urgência = atraso ao
  //    ritmo dele; para quem tem 1 compra (sem ritmo), aproxima por recência.
  // ---------------------------------------------------------------------------
  app.get('/v1/fila-do-dia', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; limite?: string }
    const limite = limiteDe(q.limite)
    const c = lerCursor(q.cursor)

    const linhas = await req.comTenant((tx) => tx<(LinhaMetrica & { urgencia: string })[]>`
      WITH fila AS (
        SELECT c.id, c.nome, m.qtd_vendas::text, m.total_centavos::text,
               m.dias_sem_comprar, m.atraso_relativo::text,
               m.media_entre_vendas_dias::text, m.ultima_venda_em,
               m.confiavel, m.ticket_medio_centavos::text,
               -- ⚠️ Score sempre presente: sem ritmo (atraso NULL) aproxima por
               --    recência (dias/30), para o cliente de 1 compra antiga também
               --    entrar na fila em vez de sumir por não ter média.
               coalesce(m.atraso_relativo, m.dias_sem_comprar::numeric / 30) AS urgencia
          FROM metricas_contato m JOIN contato c ON c.id = m.contato_id
      )
      SELECT * FROM fila
       -- Só quem precisa de ação: quem está dentro do ritmo (<= 0.9) fica fora.
       WHERE urgencia > 0.9
         AND ${c === null ? tx`true` : tx`(urgencia, id) < (${Number(c[0])}, ${c[1]}::uuid)`}
       ORDER BY urgencia DESC, id DESC
       LIMIT ${limite + 1}
    `)

    const temMais = linhas.length > limite
    const pagina = temMais ? linhas.slice(0, limite) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraItem),
      proximoCursor: temMais && ultimo ? escreverCursor(ultimo.urgencia, ultimo.id) : null,
    })
  })
}
