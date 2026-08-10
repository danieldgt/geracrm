import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { efetivarPedido } from './efetivacao.js'

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
    const perfilPadrao = q.perfil === 'varejo' ? '%varejo%' : '%atacado%'

    // ⚠️ Preço vem da tabela do ERP para o perfil (`sku_preco` + `tabela_preco`),
    //    não da tela. Escolha DETERMINÍSTICA: descrição do perfil, sem os ruídos
    //    (CFe/teste), preferindo a padrão, desempate por id. SKU sem preço vira
    //    `null` — o painel mostra "sem preço", não um número inventado.
    const produtos = await req.comTenant((tx) => tx<{
      id: string; referencia: string; descricao: string
      skus: { id: string; atributos: Record<string, string>; codigo_barras: string | null;
              preco_centavos: string | null; saldo: string | null; saldo_em: string | null }[]
    }[]>`
      SELECT p.id, p.referencia, p.descricao,
             coalesce(
               (SELECT json_agg(json_build_object(
                          'id', s.id, 'atributos', s.atributos, 'codigo_barras', s.codigo_barras,
                          'preco_centavos', (
                            SELECT sp.preco_centavos::text FROM sku_preco sp
                              JOIN tabela_preco tp ON tp.tenant_id = sp.tenant_id AND tp.id_externo = sp.tabela_externa
                             WHERE sp.tenant_id = s.tenant_id AND sp.sku_id = s.id
                               AND tp.descricao ILIKE ${perfilPadrao}
                               AND tp.descricao NOT ILIKE '%cfe%' AND tp.descricao NOT ILIKE '%teste%'
                             ORDER BY tp.padrao DESC, tp.id_externo
                             LIMIT 1),
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

  // Cria (ou pega) o rascunho de uma conversa/contato.
  app.post('/v1/pedidos', { preHandler: exigirTenant }, async (req, reply) => {
    const corpo = (req.body ?? {}) as { contatoId?: string; conversaId?: string }
    const id = randomUUID()

    const pedido = await req.comTenant(async (tx) => {
      // ⚠️ Reaproveita o rascunho existente da conversa (INV-52) em vez de criar
      //    outro — a mesma tela reaberta continua o mesmo pedido.
      if (corpo.conversaId) {
        const [existente] = await tx<{ id: string }[]>`
          SELECT id FROM pedido
           WHERE conversa_id = ${corpo.conversaId} AND estado = 'rascunho'`
        if (existente) return existente
      }
      const [novo] = await tx<{ id: string }[]>`
        INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado)
        VALUES (tenant_atual(), ${id}, ${corpo.contatoId ?? null}, ${corpo.conversaId ?? null}, 'rascunho')
        RETURNING id`
      return novo!
    })

    return reply.code(201).send({ id: pedido.id })
  })

  // Adiciona um item ao rascunho, com o preço-snapshot entrado na tela.
  app.post<{ Params: { id: string } }>(
    '/v1/pedidos/:id/itens',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const corpo = (req.body ?? {}) as {
        skuId?: string; skuSnapshot?: string; descricaoSnapshot?: string
        grade?: Record<string, string>; quantidade?: number; valorUnitarioCentavos?: number
      }
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
                  ${corpo.skuId ?? null}, ${corpo.skuSnapshot ?? '—'}, ${corpo.descricaoSnapshot ?? '—'},
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
          ultimo_erro: unknown
        }[]>`SELECT id, estado, total_centavos::text, total_pecas::text, contato_id, ultimo_erro FROM pedido WHERE id = ${req.params.id}`
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
        contatoId: dados.pedido.contato_id,
        ultimoErro: dados.pedido.ultimo_erro ?? null,
        totalCentavos: Number(dados.pedido.total_centavos),
        totalPecas: Number(dados.pedido.total_pecas),
        itens: dados.itens.map((i) => ({
          seq: i.seq, skuSnapshot: i.sku_snapshot, descricaoSnapshot: i.descricao_snapshot,
          grade: i.grade_snapshot, quantidade: Number(i.quantidade),
          valorUnitarioCentavos: Number(i.valor_unitario_centavos),
        })),
      })
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
        // Conector fonte-de-venda do tenant (para o `sistema` da identidade externa).
        const [cx] = await tx<{ conector: string }[]>`
          SELECT conector FROM conexao_erp WHERE tenant_id = tenant_atual() AND fonte_de_venda LIMIT 1`
        // ⚠️ Nenhum conector atual tem escritaPedido → passamos null (degrada).
        //    Quando um conector com escrita existir, instancia-se aqui.
        return efetivarPedido(tx, null, cx?.conector ?? '', req.params.id, new Date())
      })

      switch (r.tipo) {
        case 'nao_encontrado': return reply.code(404).send({ erro: 'pedido.nao_encontrado' })
        case 'nao_rascunho':   return reply.code(409).send({ erro: 'pedido.nao_rascunho', mensagem: 'Só um rascunho pode ser efetivado.' })
        case 'vazio':          return reply.code(422).send({ erro: 'pedido.vazio', mensagem: 'Adicione itens antes de efetivar.' })
        case 'degradado':      return reply.send({ ok: false, degradado: true, mensagem: 'Seu ERP não recebe pedido automático. Exporte e registre no ERP.' })
        case 'aguardando_conferencia': return reply.code(202).send({ ok: false, estado: 'aguardando_conferencia', mensagem: 'A resposta do ERP se perdeu. Estamos conferindo se o pedido entrou — não reenvie.' })
        case 'falha':          return reply.code(409).send({ ok: false, estado: 'falhou', falha: r.falha, mensagem: mensagemFalha(r.falha) })
        case 'efetivado':      return reply.send({ ok: true, numeroExterno: r.numeroExterno })
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

/** Recalcula totais na MESMA transação da mutação — nunca defasa da linha. */
async function recalcularTotais(tx: import('../../db/index.js').Sql, pedidoId: string): Promise<void> {
  await tx`
    UPDATE pedido SET
      total_centavos = coalesce((SELECT sum(quantidade * valor_unitario_centavos)::bigint
                                   FROM pedido_item WHERE pedido_id = ${pedidoId}), 0),
      total_pecas    = coalesce((SELECT sum(quantidade) FROM pedido_item WHERE pedido_id = ${pedidoId}), 0),
      versao_conteudo = versao_conteudo + 1,
      atualizado_em  = now()
     WHERE id = ${pedidoId}
  `
}
