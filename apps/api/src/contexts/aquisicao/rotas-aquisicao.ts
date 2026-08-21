import { randomBytes, randomUUID } from 'node:crypto'
import { codigoDeBytes, montarTextoWaMe, extrairCodigoOrigem, PLATAFORMAS } from '@geracrm/shared'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { roiDaVeiculacao, type ModeloAtribuicao } from './roi.js'

/**
 * Rotas da camada de aquisição (agencia-mkt).
 *
 * ⚠️ **Tudo aqui é autenticado, inclusive a criação de sessão da LP.**
 *
 * A tentação era expor `/publico/lp/sessao` recebendo o `tenantId` no corpo — a
 * landing page não tem sessão, afinal. Mas isso viola o ADR-001 de frente: tenant
 * NUNCA vem de parâmetro. Os webhooks, que também recebem chamada externa, não
 * confiam no que chega — eles **resolvem** o tenant a partir de um identificador
 * (`phone_number_id` → `canal_conectado` → tenant, migration 0057).
 *
 * A LP precisa do mesmo: uma **chave pública por tenant**, resolvível, como o
 * webhook faz. Isso é superfície de segurança e é decisão de produto, não algo
 * para inventar de passagem — está registrado em `perguntas-em-aberto.md`.
 *
 * Enquanto isso, a sessão é criada **com token**: serve para testar o fluxo
 * inteiro e para uma LP com backend próprio. Só a LP servida direto ao navegador
 * do lead fica esperando a decisão.
 */

const PAGINA = 50

export async function rotasAquisicao(app: FastifyInstance): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────
  // Contas de anúncio
  // ─────────────────────────────────────────────────────────────────────
  app.get('/v1/aquisicao/contas', { preHandler: exigirTenant }, async (req, reply) => {
    const contas = await req.comTenant((tx) => tx<{
      id: string; plataforma: string; id_externo: string; nome: string; moeda: string; ativo: boolean
    }[]>`
      SELECT id, plataforma, id_externo, nome, moeda, ativo
        FROM midia_conta WHERE tenant_id = tenant_atual()
       ORDER BY criado_em DESC LIMIT ${PAGINA}`)
    return reply.send({ contas })
  })

  app.post<{ Body: { plataforma?: string; idExterno?: string; nome?: string; moeda?: string } }>(
    '/v1/aquisicao/contas', { preHandler: exigirTenant }, async (req, reply) => {
      const { plataforma, idExterno, nome, moeda } = req.body ?? {}
      if (!plataforma || !PLATAFORMAS.includes(plataforma as never)) {
        return reply.code(422).send({ erro: 'plataforma.invalida', aceitas: PLATAFORMAS })
      }
      if (!idExterno?.trim() || !nome?.trim()) {
        return reply.code(422).send({ erro: 'campos.obrigatorios' })
      }
      try {
        const [c] = await req.comTenant((tx) => tx<{ id: string }[]>`
          INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome, moeda)
          VALUES (tenant_atual(), ${randomUUID()}, ${plataforma}, ${idExterno.trim()},
                  ${nome.trim()}, ${(moeda ?? 'BRL').toUpperCase()})
          RETURNING id`)
        return reply.code(201).send({ id: c!.id })
      } catch (e) {
        // ⚠️ Conflito é resultado ESPERADO (a conta já foi cadastrada), não erro
        //    de servidor. Falha de negócio é retorno tipificado (PED-08).
        if (String(e).includes('midia_conta_externa_unica')) {
          return reply.code(409).send({ erro: 'conta.ja_cadastrada' })
        }
        throw e
      }
    })

  // ─────────────────────────────────────────────────────────────────────
  // Painel: anúncios com custo e leads no período
  // ─────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { de?: string; ate?: string; cursor?: string } }>(
    '/v1/aquisicao/anuncios', { preHandler: exigirTenant }, async (req, reply) => {
      const { de, ate } = req.query
      if (!ehData(de) || !ehData(ate)) return reply.code(422).send({ erro: 'periodo.invalido' })

      // ⚠️ Paginação por cursor, nunca OFFSET nem top-N cru (regra da casa).
      let cur: string | null = null
      if (req.query.cursor) {
        cur = Buffer.from(req.query.cursor, 'base64url').toString('utf8')
        if (!cur) return reply.code(422).send({ erro: 'cursor.invalido' })
      }

      const linhas = await req.comTenant((tx) => tx<{
        id: string; nome: string; estado: string; campanha: string;
        custo_centavos: string; cliques: number; impressoes: number; leads: number
      }[]>`
        SELECT a.id, a.nome, a.estado, c.nome AS campanha,
               coalesce(m.custo, 0)::text AS custo_centavos,
               coalesce(m.cliques, 0)::int AS cliques,
               coalesce(m.impressoes, 0)::int AS impressoes,
               coalesce(l.n, 0)::int AS leads
          FROM midia_anuncio  a
          JOIN midia_conjunto cj ON cj.tenant_id = a.tenant_id  AND cj.id = a.conjunto_id
          JOIN midia_campanha c  ON c.tenant_id  = cj.tenant_id AND c.id  = cj.campanha_id
          LEFT JOIN LATERAL (
            SELECT sum(custo_centavos) AS custo, sum(cliques) AS cliques, sum(impressoes) AS impressoes
              FROM midia_metrica_dia d
             WHERE d.tenant_id = a.tenant_id AND d.anuncio_id = a.id
               AND d.dia >= ${de!}::date AND d.dia <= ${ate!}::date
          ) m ON true
          LEFT JOIN LATERAL (
            SELECT count(*) AS n FROM midia_lead_origem o
             WHERE o.tenant_id = a.tenant_id AND o.anuncio_id = a.id
               AND o.capturado_em >= ${de!}::date AND o.capturado_em < ${ate!}::date + 1
          ) l ON true
         WHERE a.tenant_id = tenant_atual()
           AND ${cur === null ? tx`true` : tx`a.id > ${cur}::uuid`}
         ORDER BY a.id
         LIMIT ${PAGINA + 1}`)

      const temMais = linhas.length > PAGINA
      const itens = temMais ? linhas.slice(0, PAGINA) : linhas
      return reply.send({
        itens,
        temMais,
        cursor: temMais ? Buffer.from(itens[itens.length - 1]!.id).toString('base64url') : null,
      })
    })

  // ─────────────────────────────────────────────────────────────────────
  // ROI de um anúncio
  // ─────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { id: string }
    Querystring: { de?: string; ate?: string; janelaDias?: string; modelo?: string }
  }>('/v1/aquisicao/anuncios/:id/roi', { preHandler: exigirTenant }, async (req, reply) => {
    const { de, ate, modelo } = req.query
    if (!ehData(de) || !ehData(ate)) return reply.code(422).send({ erro: 'periodo.invalido' })

    const janelaDias = Number(req.query.janelaDias ?? 14)
    if (!Number.isInteger(janelaDias) || janelaDias < 1 || janelaDias > 90) {
      return reply.code(422).send({ erro: 'janela.invalida' })
    }
    // ⚠️ O modelo é EXPLÍCITO. Sem default silencioso: um número de atribuição
    //    sem o modelo ao lado é o tipo de promessa que o produto não sustenta
    //    (AMK-009).
    if (modelo !== 'primeiro_toque' && modelo !== 'ultimo_toque') {
      return reply.code(422).send({ erro: 'modelo.obrigatorio', aceitos: ['primeiro_toque', 'ultimo_toque'] })
    }

    const roi = await req.comTenant((tx) => roiDaVeiculacao(tx, {
      anuncioId: req.params.id, de: de!, ate: ate!, janelaDias, modelo: modelo as ModeloAtribuicao,
    }))
    return reply.send(roi)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Sessão da landing page — gera o código e o link do WhatsApp
  // ─────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      telefone?: string; textoBase?: string
      clickId?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string
      anuncioExternoId?: string; pagina?: string
    }
  }>('/v1/aquisicao/sessoes', { preHandler: exigirTenant }, async (req, reply) => {
    const b = req.body ?? {}
    if (!b.telefone?.trim()) return reply.code(422).send({ erro: 'telefone.obrigatorio' })
    const telefone = b.telefone.replace(/\D/g, '')
    if (telefone.length < 10 || telefone.length > 15) {
      return reply.code(422).send({ erro: 'telefone.invalido' })
    }

    // ⚠️ 16 bytes de entropia para 6 caracteres — sobra de propósito. O código é
    //    marcador de sessão, não segredo, mas colisão dentro do tenant custaria
    //    uma atribuição errada, e o índice único recusaria a segunda.
    const codigo = codigoDeBytes(randomBytes(16))
    const texto = montarTextoWaMe(b.textoBase?.slice(0, 200) ?? 'Olá! Vi o anúncio', codigo)

    await req.comTenant((tx) => tx`
      INSERT INTO midia_sessao_lp
        (tenant_id, id, codigo, click_id, utm_source, utm_medium, utm_campaign,
         anuncio_externo_id, pagina)
      VALUES (tenant_atual(), ${randomUUID()}, ${codigo}, ${b.clickId ?? null},
              ${corta(b.utmSource)}, ${corta(b.utmMedium)}, ${corta(b.utmCampaign)},
              ${corta(b.anuncioExternoId)}, ${corta(b.pagina, 500)})`)

    return reply.send({
      codigo,
      textoPronto: texto,
      // O link que o botão da LP abre. ⚠️ O lead escreve PRIMEIRO — é isso que
      // mantém a operação inbound e autoriza o agente autônomo (AMK-014).
      link: `https://wa.me/${telefone}?text=${encodeURIComponent(texto)}`,
    })
  })

  /**
   * Diagnóstico do extrator — ⚠️ existe para PODER TESTAR à mão sem mandar
   * mensagem de verdade. Não escreve nada.
   */
  app.post<{ Body: { mensagem?: string } }>(
    '/v1/aquisicao/diagnostico/codigo', { preHandler: exigirTenant }, async (req, reply) => {
      const mensagem = req.body?.mensagem ?? ''
      const codigo = extrairCodigoOrigem(mensagem)
      if (codigo === null) {
        return reply.send({ encontrado: false, motivo: 'sem_codigo_ou_ambiguo' })
      }
      const [s] = await req.comTenant((tx) => tx<{
        id: string; click_id: string | null; utm_source: string | null; consumida_em: Date | null
      }[]>`
        SELECT id, click_id, utm_source, consumida_em FROM midia_sessao_lp
         WHERE tenant_id = tenant_atual() AND codigo = ${codigo}`)
      return reply.send({ encontrado: true, codigo, sessao: s ?? null })
    })
}

const ehData = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
const corta = (v: string | undefined, n = 200): string | null => (v ? v.slice(0, n) : null)
