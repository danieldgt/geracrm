import type { FastifyInstance } from 'fastify'
import { itemPedidoEntrada, perfilDeCotacao, ehPerfilPreco } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { efetivarPedido } from './efetivacao.js'
import { conectorDoTenant } from '../integracao/conector-do-tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { ETAPAS_POS_CONFIRMACAO, etapaPos } from './proximas-etapas.js'
import { fragmentoPrecoDeVenda } from './preco-de-venda.js'
import {
  adicionarItemPorSku, alterarQuantidade, obterOuCriarRascunho, recalcularTotais, removerItem,
} from './montagem.js'
import { proporPedido } from './proposta.js'

/**
 * Pedido assistido — o tira-pedido que nasce na conversa (ADR-005).
 *
 * ⚠️ Preço e saldo AO VIVO do ERP dependem de `/estoques/tela-venda`, que exige
 * uma tabela de preço (`filtroTabelaPreco`) — uma integração de tabela de preço
 * que ainda não está ligada. Até lá o preço é entrado na tela (a vendedora
 * sabe), e o rascunho guarda o SNAPSHOT (INV-25). A degradação é visível, não
 * silenciosa (ADR-008).
 */

const LIMITE_CATALOGO = 20

export async function rotasPedido(app: FastifyInstance): Promise<void> {
  // Busca no catálogo: produtos com suas variações (grade cor × tamanho).
  app.get('/v1/catalogo', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { busca?: string; perfil?: string }
    const busca = (q.busca ?? '').trim()
    // ⚠️ Preço é POR PERFIL (ADR-019): atacado ≠ varejo. Varejo é opt-in
    //    explícito; o padrão é atacado (o cliente-piloto é varejo mas a maioria
    //    do fluxo B2B é atacado — e a tela deixa trocar).
    const perfil = perfilDeCotacao(q.perfil)

    // ⚠️ Preço vem da tabela do ERP para o perfil (`sku_preco` + `tabela_preco`),
    //    nunca da tela — e QUAL tabela é a regra de `preco-de-venda.ts`, uma só
    //    para o catálogo, a montagem e o agente. SKU sem preço vira `null`: o
    //    painel mostra "sem preço", não um número inventado.
    const produtos = await req.comTenant((tx) => tx<{
      id: string; referencia: string; descricao: string
      skus: { id: string; atributos: Record<string, string>; codigo_barras: string | null;
              preco_centavos: string | null; saldo: string | null; saldo_em: string | null }[]
    }[]>`
      SELECT p.id, p.referencia, p.descricao,
             coalesce(
               (SELECT json_agg(json_build_object(
                          'id', s.id, 'atributos', s.atributos, 'codigo_barras', s.codigo_barras,
                          'preco_centavos', ${fragmentoPrecoDeVenda(tx, 's', perfil)}::text,
                          -- ⚠️ Saldo da última sincronização + a data; NÃO ao vivo (ADR-008).
                          'saldo', (SELECT ss.quantidade::text FROM sku_saldo ss
                                     WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id),
                          'saldo_em', (SELECT ss.apurado_em::text FROM sku_saldo ss
                                        WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id)
                        ) ORDER BY s.atributos::text)
                  FROM sku s WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo),
               '[]'::json) AS skus
        FROM produto p
       WHERE p.ativo
         AND ${busca === '' ? tx`true` : tx`
               (p.descricao ILIKE ${'%' + busca + '%'} OR p.referencia ILIKE ${'%' + busca + '%'})`}
       ORDER BY p.descricao
       LIMIT ${LIMITE_CATALOGO}
    `)

    return reply.send({
      itens: produtos.map((p) => ({
        id: p.id, referencia: p.referencia, descricao: p.descricao,
        skus: p.skus.map((s) => ({
          id: s.id, atributos: s.atributos, codigoBarras: s.codigo_barras,
          precoCentavos: s.preco_centavos === null ? null : Number(s.preco_centavos),
          saldo: s.saldo === null ? null : Number(s.saldo),
          saldoEm: s.saldo_em,
        })),
      })),
      // ⚠️ Limite fixo com aviso: a busca refina; não é paginação profunda porque
      //    o painel de pedido mostra um punhado, não a base inteira.
      limitado: produtos.length >= LIMITE_CATALOGO,
    })
  })

  // Valores disponíveis para os filtros da tela robusta (cor, tamanho, categoria).
  app.get('/v1/catalogo/filtros', { preHandler: exigirTenant }, async (req, reply) => {
    const dados = await req.comTenant(async (tx) => {
      const cores = await tx<{ v: string }[]>`
        SELECT DISTINCT s.atributos->>'cor' AS v FROM sku s
         WHERE s.tenant_id = tenant_atual() AND s.ativo AND s.atributos->>'cor' IS NOT NULL
         ORDER BY 1 LIMIT 200`
      const tamanhos = await tx<{ v: string }[]>`
        SELECT DISTINCT s.atributos->>'tamanho' AS v FROM sku s
         WHERE s.tenant_id = tenant_atual() AND s.ativo AND s.atributos->>'tamanho' IS NOT NULL
         ORDER BY 1 LIMIT 200`
      const categorias = await tx<{ v: string }[]>`
        SELECT DISTINCT categoria AS v FROM produto
         WHERE tenant_id = tenant_atual() AND ativo AND categoria IS NOT NULL ORDER BY 1 LIMIT 200`
      return { cores, tamanhos, categorias }
    })
    return reply.send({
      cores: dados.cores.map((x) => x.v),
      tamanhos: dados.tamanhos.map((x) => x.v),
      categorias: dados.categorias.map((x) => x.v),
    })
  })

  // Catálogo PAGINADO com filtros (tela robusta de montagem de pedido).
  app.get<{ Querystring: { busca?: string; perfil?: string; cor?: string; tamanho?: string; categoria?: string; precoMin?: string; precoMax?: string; cursor?: string } }>(
    '/v1/catalogo/busca', { preHandler: exigirTenant },
    async (req, reply) => {
      const q = req.query
      const busca = (q.busca ?? '').trim()
      const perfil = perfilDeCotacao(q.perfil)
      const precoMin = q.precoMin ? Number(q.precoMin) : null
      const precoMax = q.precoMax ? Number(q.precoMax) : null
      let curDesc: string | null = null, curId: string | null = null
      if (q.cursor) {
        const [d, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('§')
        if (!d || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curDesc = d; curId = id
      }
      const produtos = await req.comTenant((tx) => {
        // ⚠️ A MESMA regra da busca rápida acima e da prévia do agente:
        //    qual tabela o perfil cota mora em `preco-de-venda.ts`, não aqui.
        const precoSku = (s: string) => fragmentoPrecoDeVenda(tx, s, perfil)
        return tx<{
          id: string; referencia: string; descricao: string; categoria: string | null
          skus: { id: string; atributos: Record<string, string>; codigo_barras: string | null; preco_centavos: string | null; saldo: string | null; saldo_em: string | null }[]
        }[]>`
        SELECT p.id, p.referencia, p.descricao, p.categoria,
               coalesce((SELECT json_agg(json_build_object(
                    'id', s.id, 'atributos', s.atributos, 'codigo_barras', s.codigo_barras,
                    'preco_centavos', ${precoSku('s')}::text,
                    'saldo', (SELECT ss.quantidade::text FROM sku_saldo ss WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id),
                    'saldo_em', (SELECT ss.apurado_em::text FROM sku_saldo ss WHERE ss.tenant_id = s.tenant_id AND ss.sku_id = s.id)
                  ) ORDER BY s.atributos::text)
                  FROM sku s WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo), '[]'::json) AS skus
          FROM produto p
         WHERE p.tenant_id = tenant_atual() AND p.ativo
           AND ${busca === '' ? tx`true` : tx`(p.descricao ILIKE ${'%' + busca + '%'} OR p.referencia ILIKE ${'%' + busca + '%'})`}
           AND ${q.categoria ? tx`p.categoria = ${q.categoria}` : tx`true`}
           AND ${q.cor ? tx`EXISTS (SELECT 1 FROM sku s WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo AND s.atributos->>'cor' = ${q.cor})` : tx`true`}
           AND ${q.tamanho ? tx`EXISTS (SELECT 1 FROM sku s WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo AND s.atributos->>'tamanho' = ${q.tamanho})` : tx`true`}
           AND ${precoMin === null && precoMax === null ? tx`true` : tx`EXISTS (
                 SELECT 1 FROM sku s WHERE s.tenant_id = p.tenant_id AND s.produto_id = p.id AND s.ativo
                   AND ${precoSku('s')} IS NOT NULL
                   AND ${precoMin === null ? tx`true` : tx`${precoSku('s')} >= ${precoMin}`}
                   AND ${precoMax === null ? tx`true` : tx`${precoSku('s')} <= ${precoMax}`})`}
           AND ${curDesc === null ? tx`true` : tx`(p.descricao, p.id) > (${curDesc}, ${curId}::uuid)`}
         ORDER BY p.descricao ASC, p.id ASC LIMIT ${LIMITE_CATALOGO + 1}`
      })
      const temMais = produtos.length > LIMITE_CATALOGO
      const pagina = temMais ? produtos.slice(0, LIMITE_CATALOGO) : produtos
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((p) => ({
          id: p.id, referencia: p.referencia, descricao: p.descricao, categoria: p.categoria,
          skus: p.skus.map((s) => ({
            id: s.id, atributos: s.atributos, codigoBarras: s.codigo_barras,
            precoCentavos: s.preco_centavos === null ? null : Number(s.preco_centavos),
            saldo: s.saldo === null ? null : Number(s.saldo), saldoEm: s.saldo_em,
          })),
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.descricao}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Cria um rascunho para o cliente. ⚠️ Vários por cliente (0049): por padrão
  // reaproveita o rascunho da conversa (continuidade do chat); com `novo:true`
  // ou `nome`, cria SEMPRE um novo (a tela robusta gerencia N rascunhos).
  app.post('/v1/pedidos', { preHandler: exigirTenant }, async (req, reply) => {
    const corpo = (req.body ?? {}) as { contatoId?: string; conversaId?: string; nome?: string; novo?: boolean }
    // ⚠️ A rota só cria por gente: `origem` é 'humano' aqui. O agente cria pelo
    //    mesmo caso de uso com origem 'agente' (ADR-027), nunca por esta rota.
    const pedido = await req.comTenant((tx) => obterOuCriarRascunho(tx, {
      contatoId: corpo.contatoId ?? null, conversaId: corpo.conversaId ?? null,
      nome: corpo.nome ?? null, novo: corpo.novo === true, origem: 'humano',
    }))
    return reply.code(201).send({ id: pedido.id })
  })

  // Rascunhos (e recentes) de um cliente — para a tela robusta escolher/abrir.
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/pedidos', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{
        id: string; nome: string | null; estado: string; total_centavos: string; itens: number; atualizado_em: Date
      }[]>`
        SELECT p.id, p.nome, p.estado, p.total_centavos::text, p.atualizado_em,
               (SELECT count(*)::int FROM pedido_item i WHERE i.tenant_id = p.tenant_id AND i.pedido_id = p.id) AS itens
          FROM pedido p
         WHERE p.tenant_id = tenant_atual() AND p.contato_id = ${req.params.id}
         ORDER BY (p.estado = 'rascunho') DESC, p.atualizado_em DESC LIMIT 50`)
      return reply.send({
        itens: linhas.map((l) => ({
          id: l.id, nome: l.nome, estado: l.estado, totalCentavos: Number(l.total_centavos),
          itens: l.itens, atualizadoEm: l.atualizado_em,
        })),
      })
    },
  )

  /**
   * Adiciona um item ao rascunho.
   *
   * ⚠️ Com `skuId`, o corpo é `{ skuId, quantidade }` e o PREÇO É RESOLVIDO NO
   *    SERVIDOR (ADR-025) pelo perfil do contato — `valorUnitarioCentavos` que
   *    venha no corpo é IGNORADO. `perfil` opcional é transitório: o botão
   *    varejo/atacado do console ainda não grava no contato; some na raia R7.
   *
   * ⚠️ SEM `skuId` é item de TEXTO LIVRE (fora do catálogo): descrição + preço
   *    entrados na tela. Mantido só para isso; o console passa a mandar `skuId`
   *    em tudo que vem do catálogo na raia R7.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/itens',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const corpo = (req.body ?? {}) as {
        skuId?: string; skuSnapshot?: string; descricaoSnapshot?: string; perfil?: string
        grade?: Record<string, string>; quantidade?: number; valorUnitarioCentavos?: number
      }

      if (corpo.skuId !== undefined) {
        const entrada = itemPedidoEntrada.safeParse({ skuId: corpo.skuId, quantidade: corpo.quantidade })
        if (!entrada.success) {
          return reply.code(422).send({ erro: 'pedido.item_invalido', mensagem: 'Informe o SKU e uma quantidade maior que zero.' })
        }
        const opcoes = ehPerfilPreco(corpo.perfil) ? { perfil: perfilDeCotacao(corpo.perfil) } : {}
        const r = await req.comTenant((tx) => adicionarItemPorSku(tx, req.params.id, entrada.data, opcoes))
        switch (r.tipo) {
          case 'ok': return reply.send({ ok: true, seq: r.seq, quantidade: r.quantidade, valorUnitarioCentavos: r.valorUnitarioCentavos, totalCentavos: r.totalCentavos })
          case 'pedido_nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado', mensagem: 'Rascunho não encontrado.' })
          case 'pedido_imutavel': return reply.code(409).send({ erro: 'pedido.imutavel', mensagem: 'Este pedido não é mais um rascunho.' })
          case 'sku_desconhecido': return reply.code(422).send({ erro: 'pedido.sku_desconhecido', mensagem: 'Este produto não está no catálogo.' })
          case 'sem_preco': return reply.code(422).send({ erro: 'pedido.sem_preco', mensagem: 'Este produto não tem preço na tabela do perfil. Configure a tabela no ERP.' })
          case 'quantidade_invalida': return reply.code(422).send({ erro: 'pedido.quantidade_invalida', regra: r.regra, mensagem: 'Quantidade deve ser maior que zero.' })
          case 'estoque_insuficiente': return reply.code(409).send({ erro: 'pedido.estoque_insuficiente', disponivel: r.disponivel, skuSnapshot: r.skuSnapshot, mensagem: `Estoque insuficiente de ${r.skuSnapshot} (disponível: ${r.disponivel}). Ajuste a quantidade.` })
        }
      }

      // Item de texto livre (sem SKU): preço entrado na tela.
      if (!corpo.quantidade || corpo.quantidade <= 0) {
        return reply.code(422).send({ erro: 'pedido.quantidade_invalida', mensagem: 'Quantidade deve ser maior que zero.' })
      }
      if (corpo.valorUnitarioCentavos === undefined || corpo.valorUnitarioCentavos < 0) {
        return reply.code(422).send({ erro: 'pedido.preco_invalido', mensagem: 'Informe o preço unitário.' })
      }
      // ⚠️ Extraídos após os guardas: dentro do closure o TS re-alarga a
      //    propriedade para `number | undefined`; a const local mantém o estreito.
      const quantidade = corpo.quantidade
      const valorUnitario = corpo.valorUnitarioCentavos

      const resultado = await req.comTenant(async (tx) => {
        const [pedido] = await tx<{ estado: string }[]>`SELECT estado FROM pedido WHERE id = ${req.params.id}`
        if (!pedido) return { erro: 404 as const }
        // ⚠️ Só rascunho recebe item: um pedido efetivado é imutável (INV).
        if (pedido.estado !== 'rascunho') return { erro: 409 as const }

        await tx`
          INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_id, sku_snapshot,
                                   descricao_snapshot, grade_snapshot, quantidade, valor_unitario_centavos)
          VALUES (tenant_atual(), ${req.params.id},
                  (SELECT coalesce(max(seq), 0) + 1 FROM pedido_item WHERE pedido_id = ${req.params.id}),
                  NULL, ${corpo.skuSnapshot ?? '—'}, ${corpo.descricaoSnapshot ?? '—'},
                  ${JSON.stringify(corpo.grade ?? {})}::text::jsonb,
                  ${quantidade}, ${valorUnitario})
        `
        await recalcularTotais(tx, req.params.id)
        return { ok: true as const }
      })

      if ('erro' in resultado) {
        return resultado.erro === 404
          ? reply.code(404).send({ erro: 'pedido.nao_encontrado', mensagem: 'Rascunho não encontrado.' })
          : reply.code(409).send({ erro: 'pedido.imutavel', mensagem: 'Este pedido não é mais um rascunho.' })
      }
      return reply.send({ ok: true })
    },
  )

  // O rascunho com seus itens e totais.
  app.get<{ Params: { id: string } }>(
    '/v1/pedidos/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const dados = await req.comTenant(async (tx) => {
        const [pedido] = await tx<{
          id: string; estado: string; total_centavos: string; total_pecas: string; contato_id: string | null
          ultimo_erro: unknown; forma_pagamento: string | null; observacao: string | null; nome: string | null
          contato: string | null; numero_externo: string | null; criado_em: Date; confirmado_em: Date | null
          cancelado_em: Date | null; cancelado_motivo: string | null; origem: string; desconto_pct: string
          conversa_id: string | null
        }[]>`SELECT p.id, p.estado, p.total_centavos::text, p.total_pecas::text, p.contato_id, p.ultimo_erro,
                    p.forma_pagamento, p.observacao, p.nome, p.numero_externo, p.criado_em, p.confirmado_em,
                    p.cancelado_em, p.cancelado_motivo, p.origem, p.desconto_pct::text, p.conversa_id,
                    c.nome AS contato
               FROM pedido p LEFT JOIN contato c ON c.tenant_id = p.tenant_id AND c.id = p.contato_id
              WHERE p.id = ${req.params.id}`
        if (!pedido) return null
        const itens = await tx<{
          seq: number; sku_snapshot: string; descricao_snapshot: string
          grade_snapshot: Record<string, string>; quantidade: string; valor_unitario_centavos: string
        }[]>`
          SELECT seq, sku_snapshot, descricao_snapshot, grade_snapshot,
                 quantidade::text, valor_unitario_centavos::text
            FROM pedido_item WHERE pedido_id = ${req.params.id} ORDER BY seq`
        return { pedido, itens }
      })
      if (!dados) return reply.code(404).send({ erro: 'pedido.nao_encontrado', mensagem: 'Pedido não encontrado.' })

      return reply.send({
        id: dados.pedido.id,
        estado: dados.pedido.estado,
        // Quem montou (humano/agente) e o desconto — a alçada (ADR-027) lê os dois.
        origem: dados.pedido.origem,
        descontoPct: Number(dados.pedido.desconto_pct),
        contatoId: dados.pedido.contato_id,
        contato: dados.pedido.contato,
        // A conversa onde o pedido nasceu (ADR-005) — a tela de detalhe linka de volta.
        conversaId: dados.pedido.conversa_id,
        nome: dados.pedido.nome,
        numeroExterno: dados.pedido.numero_externo,
        criadoEm: dados.pedido.criado_em,
        confirmadoEm: dados.pedido.confirmado_em,
        // ⚠️ O motivo vai para a TELA. Cancelamento sem razão visível vira
        //    mistério na semana seguinte — e o vendedor precisa saber se aquele
        //    pedido foi superado por um resumo novo ou cancelado à mão.
        canceladoEm: dados.pedido.cancelado_em,
        canceladoMotivo: dados.pedido.cancelado_motivo,
        ultimoErro: dados.pedido.ultimo_erro ?? null,
        formaPagamento: dados.pedido.forma_pagamento,
        observacao: dados.pedido.observacao,
        totalCentavos: Number(dados.pedido.total_centavos),
        totalPecas: Number(dados.pedido.total_pecas),
        itens: dados.itens.map((i) => ({
          seq: i.seq, skuSnapshot: i.sku_snapshot, descricaoSnapshot: i.descricao_snapshot,
          grade: i.grade_snapshot, quantidade: Number(i.quantidade),
          valorUnitarioCentavos: Number(i.valor_unitario_centavos),
        })),
        // Próximas etapas da jornada — só fazem sentido depois do cliente confirmar.
        // Penduradas no pedido.confirmado; hoje DEGRADAM (GeraCloud não ligado).
        proximasEtapas: dados.pedido.estado === 'confirmado' ? ETAPAS_POS_CONFIRMACAO : [],
      })
    },
  )

  /**
   * Aciona uma próxima etapa de um pedido CONFIRMADO (orçamento, cobrança PIX…).
   * ⚠️ Retorno TIPIFICADO, nunca exceção. Enquanto o GeraCloud não está ligado, a
   * etapa DEGRADA de forma visível (ADR-008): responde 200 com `ok:false` +
   * motivo, sem fingir que gerou nada. É o ponto de costura para o conector.
   */
  app.post<{ Params: { id: string; etapa: string } }>(
    '/v1/pedidos/:id/etapa/:etapa', { preHandler: exigirTenant },
    async (req, reply) => {
      const def = etapaPos(req.params.etapa)
      if (!def) return reply.code(400).send({ erro: 'etapa.desconhecida', mensagem: 'Etapa inválida.' })
      const [p] = await req.comTenant((tx) => tx<{ estado: string }[]>`
        SELECT estado FROM pedido WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`)
      if (!p) return reply.code(404).send({ erro: 'pedido.nao_encontrado', mensagem: 'Pedido não encontrado.' })
      if (p.estado !== 'confirmado') {
        return reply.code(409).send({ erro: 'pedido.nao_confirmado', mensagem: 'Só o pedido confirmado pelo cliente pode seguir para as próximas etapas.' })
      }
      if (!def.disponivel) {
        // Degradação honesta: a etapa existe, mas o conector não. 200 tipificado.
        return reply.send({ ok: false, etapa: def.etapa, motivo: 'integracao_pendente', mensagem: def.motivoIndisponivel })
      }
      // Quando o GeraCloud for ligado, a ação real de cada etapa entra aqui.
      return reply.send({ ok: true, etapa: def.etapa })
    },
  )

  /**
   * Efetiva o rascunho no ERP (ADR-005). ⚠️ Idempotente, falha tipificada e o
   * rascunho NUNCA se perde. Se o conector não escreve pedido (GeraCloud hoje),
   * DEGRADA visível: o rascunho fica exportável (ADR-008), não some.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/efetivar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        // ⚠️ O conector REAL do tenant, com a credencial cifrada dele. Antes isto
        //    era `null` fixo e todo pedido caía em `degradado` — a escrita no
        //    GeraCloud existia, testada contra o ERP, e nunca era usada.
        //    Sem conexão ou sem adaptador de escrita, o conector volta null e a
        //    degradação segue visível (ADR-008): o rascunho não se perde.
        const cx = await conectorDoTenant(tx)
        return efetivarPedido(tx, cx.conector, cx.sistema, req.params.id, new Date())
      })

      switch (r.tipo) {
        case 'nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado' })
        case 'nao_rascunho':   return reply.code(409).send({ erro: 'pedido.nao_rascunho', mensagem: 'Só um rascunho pode ser efetivado.' })
        case 'vazio':          return reply.code(422).send({ erro: 'pedido.vazio', mensagem: 'Adicione itens antes de efetivar.' })
        // Regra comercial (PED-05): o que falta, nomeado; o rascunho não mudou.
        case 'regras':         return reply.code(422).send({ erro: 'pedido.regras', violacao: r.violacao, mensagem: r.mensagem })
        case 'degradado':      return reply.send({ ok: false, degradado: true, mensagem: 'Seu ERP não recebe pedido automático. Exporte e registre no ERP.' })
        case 'aguardando_conferencia': return reply.code(202).send({ ok: false, estado: 'aguardando_conferencia', mensagem: 'A resposta do ERP se perdeu. Estamos conferindo se o pedido entrou — não reenvie.' })
        case 'falha':          return reply.code(409).send({ ok: false, estado: 'falhou', falha: r.falha, mensagem: mensagemFalha(r.falha) })
        case 'efetivado':
          // ⚠️ No GeraCloud esta via cria ORÇAMENTO, não venda (status fixo
          //    'Orcamento' — ver orcamento.ts). Quem ler "efetivado" e entender
          //    "venda fechada" se surpreende no fim do mês, então a mensagem diz
          //    o que existe do outro lado e o que ainda falta fazer lá.
          return reply.send({
            ok: true, numeroExterno: r.numeroExterno,
            mensagem: 'Orçamento criado no ERP. Converta em venda por lá para faturar.',
          })
      }
    },
  )

  // ───────── Lista e gestão do pedido ─────────

  /** Lista pedidos por cursor, filtrando por estado e/ou contato. */
  app.get<{ Querystring: { estado?: string; contatoId?: string; cursor?: string } }>(
    '/v1/pedidos', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const { estado, contatoId } = req.query
      const linhas = await req.comTenant((tx) => tx<{
        id: string; estado: string; total_centavos: string; total_pecas: string
        contato_id: string | null; contato: string | null; rotulo: string | null
        numero_externo: string | null; criado_em: Date; itens: number; origem: string; desconto_pct: string
      }[]>`
        SELECT p.id, p.estado, p.total_centavos::text, p.total_pecas::text, p.contato_id,
               c.nome AS contato, p.nome AS rotulo, p.numero_externo, p.criado_em, p.origem, p.desconto_pct::text,
               (SELECT count(*)::int FROM pedido_item i WHERE i.tenant_id = p.tenant_id AND i.pedido_id = p.id) AS itens
          FROM pedido p LEFT JOIN contato c ON c.tenant_id = p.tenant_id AND c.id = p.contato_id
         WHERE p.tenant_id = tenant_atual()
           AND ${estado ? tx`p.estado = ${estado}` : tx`true`}
           AND ${contatoId ? tx`p.contato_id = ${contatoId}` : tx`true`}
           AND ${curEm === null ? tx`true` : tx`(p.criado_em, p.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY p.criado_em DESC, p.id DESC LIMIT 31`)
      const temMais = linhas.length > 30
      const pagina = temMais ? linhas.slice(0, 30) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, estado: l.estado, contatoId: l.contato_id, contato: l.contato, rotulo: l.rotulo,
          origem: l.origem, descontoPct: Number(l.desconto_pct),
          totalCentavos: Number(l.total_centavos), totalPecas: Number(l.total_pecas), itens: l.itens,
          numeroExterno: l.numero_externo, criadoEm: l.criado_em,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  /** Altera a quantidade de um item do rascunho (recalcula totais). */
  app.patch<{ Params: { id: string; seq: string }; Body: { quantidade?: number } }>(
    '/v1/pedidos/:id/itens/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      const qtd = Number(req.body?.quantidade)
      if (!Number.isFinite(qtd) || qtd <= 0) return reply.code(422).send({ erro: 'item.quantidade_invalida', mensagem: 'Quantidade deve ser maior que zero.' })
      const r = await req.comTenant((tx) => alterarQuantidade(tx, req.params.id, Number(req.params.seq), qtd))
      switch (r.tipo) {
        case 'ok': return reply.send({ ok: true, totalCentavos: r.totalCentavos })
        case 'pedido_nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado' })
        case 'item_nao_encontrado': return reply.code(404).send({ erro: 'item.nao_encontrado' })
        case 'pedido_imutavel': return reply.code(409).send({ erro: 'pedido.imutavel' })
        case 'quantidade_invalida': return reply.code(422).send({ erro: 'item.quantidade_invalida', regra: r.regra, mensagem: 'Quantidade deve ser maior que zero.' })
        case 'estoque_insuficiente': return reply.code(409).send({ erro: 'pedido.estoque_insuficiente', disponivel: r.disponivel, skuSnapshot: r.skuSnapshot, mensagem: `Estoque insuficiente de ${r.skuSnapshot} (disponível: ${r.disponivel}). Ajuste a quantidade.` })
      }
    },
  )

  /** Remove um item do rascunho (recalcula totais). */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/pedidos/:id/itens/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant((tx) => removerItem(tx, req.params.id, Number(req.params.seq)))
      switch (r.tipo) {
        case 'ok': return reply.send({ ok: true, totalCentavos: r.totalCentavos })
        case 'pedido_nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado' })
        case 'item_nao_encontrado': return reply.code(404).send({ erro: 'item.nao_encontrado' })
        case 'pedido_imutavel': return reply.code(409).send({ erro: 'pedido.imutavel' })
      }
    },
  )

  /** Contexto de venda do rascunho: forma de pagamento e observação. */
  app.patch<{ Params: { id: string }; Body: { formaPagamento?: string | null; observacao?: string | null; nome?: string | null } }>(
    '/v1/pedidos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const r = await req.comTenant(async (tx) => {
        const [p] = await tx<{ estado: string }[]>`SELECT estado FROM pedido WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!p) return { erro: 404 as const }
        if (p.estado !== 'rascunho') return { erro: 409 as const }
        // COALESCE: só mexe no que veio no corpo (permite salvar campos isolados).
        await tx`
          UPDATE pedido SET
             forma_pagamento = COALESCE(${b.formaPagamento === undefined ? null : (b.formaPagamento?.trim() || null)}, forma_pagamento),
             observacao      = COALESCE(${b.observacao === undefined ? null : (b.observacao?.trim() || null)}, observacao),
             nome            = COALESCE(${b.nome === undefined ? null : (b.nome?.trim() || null)}, nome),
             atualizado_em   = now()
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(r.erro).send({ erro: r.erro === 409 ? 'pedido.imutavel' : 'pedido.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Cancela um rascunho (não efetivado). */
  /**
   * REABRIR um pedido cancelado — volta a rascunho para ser editado e reenviado.
   *
   * ⚠️ Existe porque cancelar não pode ser um sumiço. Um pedido é superado por um
   * resumo novo (ou cancelado por engano) e o trabalho de montagem continua
   * valendo: o vendedor abre, ajusta e manda de novo. Sem isto, "cancelado com
   * motivo" seria só uma lápide bonita.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/reabrir', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx<{ id: string }[]>`
        UPDATE pedido
           SET estado = 'rascunho', atualizado_em = now(),
               -- ⚠️ Exigido pelo CHECK do 0073: fora de cancelado, os campos de
               --    cancelamento têm de estar vazios.
               cancelado_em = NULL, cancelado_motivo = NULL,
               -- O resumo antigo não vale mais: quem reabrir precisa enviar outro.
               resumo_enviado_em = NULL, confirmado_em = NULL
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'cancelado'
        RETURNING id`)
      // ⚠️ Falha de negócio NOMEADA com ação corretiva, não 404 genérico: só
      //    pedido CANCELADO reabre, e a tela precisa poder dizer isso.
      if (!r) {
        return reply.code(422).send({
          erro: 'pedido.nao_reabrivel',
          mensagem: 'Só um pedido cancelado pode ser reaberto.',
        })
      }
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/cancelar', { preHandler: exigirTenant },
    async (req, reply) => {
      const [r] = await req.comTenant((tx) => tx`
        UPDATE pedido SET estado = 'cancelado', atualizado_em = now(),
                          -- ⚠️ Exigidos pelo CHECK do 0073: cancelado sem motivo
                          --    vira mistério na semana seguinte.
                          cancelado_em = now(),
                          cancelado_motivo = 'cancelado pelo operador'
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'rascunho' RETURNING id`)
      if (!r) return reply.code(409).send({ erro: 'pedido.nao_cancelavel', mensagem: 'Só um rascunho pode ser cancelado.' })
      return reply.send({ ok: true })
    },
  )

  /**
   * Confirma o pedido com o cliente: manda o RESUMO (itens + total) na conversa,
   * pelo gateway único (opt-out, janela de 24h, canal). ⚠️ Só para pedido que
   * nasceu numa conversa. Falha de envio volta TIPIFICADA (janela_fechada,
   * bloqueado, …) para a tela dar a ação corretiva.
   *
   * ⚠️ É o MESMO caso de uso do agente (`proporPedido`, ADR-027): grava a
   *    proposta com a versão do conteúdo, e o "sim" só confirma essa versão.
   *    Regra comercial violada (PED-05) volta 422 com o que falta.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/enviar-resumo', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        const [u] = await tx<{ nome: string }[]>`SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${eu}`
        return u?.nome ?? null
      })
      const r = await proporPedido(req.tenantId!, req.params.id, new Date(), { remetenteNome: nome })
      switch (r.tipo) {
        case 'nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado' })
        case 'sem_conversa': return reply.code(422).send({ erro: 'pedido.sem_conversa', mensagem: 'Este pedido não nasceu numa conversa; não há para quem enviar.' })
        case 'vazio': return reply.code(422).send({ erro: 'pedido.vazio', mensagem: 'Adicione itens antes de enviar o resumo.' })
        case 'nao_rascunho': return reply.code(409).send({ erro: 'pedido.nao_rascunho', mensagem: 'Só um rascunho (ou um pedido aguardando o sim) pode ter o resumo enviado.' })
        case 'regras': return reply.code(422).send({ erro: 'pedido.regras', violacao: r.violacao, mensagem: r.mensagem })
        case 'envio_recusado':
          if (r.motivo === 'conversa_nao_encontrada') return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
          // Devolve o conversaId para o front abrir o chat onde a mensagem caiu.
          return reply.send({ ok: false, motivo: r.motivo, conversaId: r.conversaId })
        case 'ok':
          return reply.send({ ok: true, conversaId: r.conversaId, propostaId: r.propostaId, expiraEm: r.expiraEm })
      }
    },
  )
}

/** Falha de negócio → texto com a ação corretiva (PED-08). */
function mensagemFalha(f: { tipo: string; skuExterno?: string; disponivel?: number; disponivelCentavos?: number }): string {
  switch (f.tipo) {
    case 'estoque_insuficiente': return `Estoque insuficiente do item ${f.skuExterno} (disponível: ${f.disponivel}). Ajuste a quantidade.`
    case 'credito_bloqueado':    return `Crédito do cliente bloqueado (disponível: R$ ${((f.disponivelCentavos ?? 0) / 100).toFixed(2)}). Libere o crédito no ERP.`
    case 'item_inativo':         return `O item ${f.skuExterno} está inativo no ERP. Remova-o do pedido.`
    case 'cliente_sem_cadastro_fiscal': return 'O cliente não tem cadastro fiscal no ERP. Cadastre antes de faturar.'
    case 'nao_chegou':           return 'O ERP não respondeu. Tente de novo em instantes.'
    default:                     return 'Não foi possível efetivar o pedido.'
  }
}
