import type { FastifyInstance } from 'fastify'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'

const PAGINA = 30

/**
 * Carteirização — quem é o dono de cada cliente, com histórico auditável.
 *
 * ⚠️ A tabela e a regra já existem no banco (migration 0010): `carteira_atribuicao`
 * guarda o HISTÓRICO de posse (de/ate, período gerado), a restrição de exclusão
 * gist impede dois donos simultâneos, e `transferir_carteira(...)` fecha o período
 * anterior e abre o novo na MESMA transação — sem instante sem dono. Estas rotas
 * só expõem essa maquinaria.
 *
 * ⚠️ ADR-001: o tenant vem SEMPRE de `tenant_atual()` (token), nunca de parâmetro.
 * `transferir_carteira` recebe o tenant, mas quem o passa é `tenant_atual()`, e a
 * função roda sob RLS na mesma sessão.
 *
 * Órfão (usuario_id NULL, ou nenhuma atribuição vigente) é legítimo — precisa
 * aparecer, não sumir.
 */
export async function rotasCarteira(app: FastifyInstance): Promise<void> {
  // A equipe do tenant — alimenta o seletor de "atribuir para". Conjunto pequeno
  // e limitado (dezenas), não é grid de domínio; ordenado por nome, com teto de
  // segurança para nunca virar lista ilimitada.
  app.get('/v1/equipe', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string }[]>`
      SELECT id, nome FROM usuario
       WHERE tenant_id = tenant_atual() AND ativo = true
       ORDER BY nome ASC LIMIT 200`)
    return reply.send({ itens: linhas.map((l) => ({ id: l.id, nome: l.nome })) })
  })

  // Resumo por vendedor: quantos clientes cada um tem AGORA, + órfãos.
  app.get('/v1/carteiras', { preHandler: exigirTenant }, async (req, reply) => {
    const { porVendedor, orfaos } = await req.comTenant(async (tx) => {
      const porVendedor = await tx<{ usuario_id: string; usuario: string; clientes: number }[]>`
        SELECT u.id AS usuario_id, u.nome AS usuario, count(*)::int AS clientes
          FROM carteira_atribuicao ca
          JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
         WHERE ca.tenant_id = tenant_atual() AND ca.ate IS NULL AND ca.usuario_id IS NOT NULL
         GROUP BY u.id, u.nome
         ORDER BY clientes DESC, u.nome ASC`
      const [o] = await tx<{ orfaos: number }[]>`
        SELECT count(*)::int AS orfaos
          FROM contato c
         WHERE c.tenant_id = tenant_atual()
           AND NOT EXISTS (
             SELECT 1 FROM carteira_atribuicao ca
              WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id
                AND ca.ate IS NULL AND ca.usuario_id IS NOT NULL)`
      return { porVendedor, orfaos: o?.orfaos ?? 0 }
    })
    return reply.send({
      itens: porVendedor.map((l) => ({ usuarioId: l.usuario_id, usuario: l.usuario, clientes: l.clientes })),
      orfaos,
    })
  })

  // Clientes de UMA carteira: ?usuarioId=<id> ou ?orfaos=1. Cursor por (nome, id).
  app.get<{ Querystring: { usuarioId?: string; orfaos?: string; cursor?: string } }>(
    '/v1/carteiras/contatos', { preHandler: exigirTenant },
    async (req, reply) => {
      const { usuarioId, orfaos } = req.query
      if (!usuarioId && orfaos !== '1') {
        return reply.code(422).send({ erro: 'carteira.alvo_obrigatorio', mensagem: 'Informe usuarioId ou orfaos=1.' })
      }
      let curNome: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [nome, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!nome || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curNome = nome; curId = id
      }
      const linhas = await req.comTenant((tx) => {
        // Órfão = sem dono vigente com usuario_id não-nulo.
        const filtroDono = orfaos === '1'
          ? tx`NOT EXISTS (
              SELECT 1 FROM carteira_atribuicao ca
               WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id
                 AND ca.ate IS NULL AND ca.usuario_id IS NOT NULL)`
          : tx`EXISTS (
              SELECT 1 FROM carteira_atribuicao ca
               WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id
                 AND ca.ate IS NULL AND ca.usuario_id = ${usuarioId!})`
        return tx<{ id: string; nome: string; qtd_vendas: number; ultima_venda_em: Date | null }[]>`
          SELECT c.id, c.nome, c.qtd_vendas, c.ultima_venda_em
            FROM contato c
           WHERE c.tenant_id = tenant_atual() AND ${filtroDono}
             AND ${curNome === null ? tx`true` : tx`(c.nome, c.id) > (${curNome}, ${curId}::uuid)`}
           ORDER BY c.nome ASC, c.id ASC LIMIT ${PAGINA + 1}`
      })
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, nome: l.nome, qtdVendas: l.qtd_vendas, ultimaVendaEm: l.ultima_venda_em,
        })),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.nome}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // Histórico de posse de UM cliente (para a ficha).
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/carteira/historico', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{
        id: string; usuario_id: string | null; usuario: string | null
        de: Date; ate: Date | null; origem: string; motivo: string | null; por: string | null
      }[]>`
        SELECT ca.id, ca.usuario_id, u.nome AS usuario, ca.de, ca.ate, ca.origem, ca.motivo,
               ab.nome AS por
          FROM carteira_atribuicao ca
          LEFT JOIN usuario u  ON u.tenant_id = ca.tenant_id  AND u.id  = ca.usuario_id
          LEFT JOIN usuario ab ON ab.tenant_id = ca.tenant_id AND ab.id = ca.atribuido_por
         WHERE ca.tenant_id = tenant_atual() AND ca.contato_id = ${req.params.id}
         ORDER BY ca.de DESC`)
      return reply.send({
        itens: linhas.map((l) => ({
          id: l.id, usuarioId: l.usuario_id, usuario: l.usuario,
          de: l.de, ate: l.ate, atual: l.ate === null,
          origem: l.origem, motivo: l.motivo, por: l.por,
        })),
      })
    },
  )

  // Atribuir/transferir o dono. usuarioId null (ou ausente) = remover o dono.
  app.post<{ Params: { id: string }; Body: { usuarioId?: string | null; motivo?: string } }>(
    '/v1/contatos/:id/carteira', { preHandler: exigirTenant },
    async (req, reply) => {
      const novoDono = req.body?.usuarioId ?? null
      const motivo = req.body?.motivo?.trim() || null
      try {
        const resultado = await req.comTenant(async (tx) => {
          const eu = await garantirUsuarioId(tx, req)
          const [r] = await tx<{ transferir_carteira: string | null }[]>`
            SELECT transferir_carteira(
              tenant_atual(), ${req.params.id}, ${novoDono},
              ${eu}, 'manual', ${motivo})`
          return r?.transferir_carteira ?? null
        })
        // NULL = já era esse o dono; a função não cria linha para uma mudança que não houve.
        if (resultado === null) return reply.send({ id: null, semMudanca: true })
        return reply.send({ id: resultado, semMudanca: false })
      } catch (e) {
        // FK (tenant_id, usuario_id): dono inexistente neste tenant → falha tipificada.
        if (e instanceof Error && e.message.includes('carteira_atribuicao_tenant_id_usuario_id_fkey')) {
          return reply.code(422).send({ erro: 'carteira.usuario_invalido', mensagem: 'Vendedor não encontrado.' })
        }
        throw e
      }
    },
  )

  // Soltar o cliente (vira órfão). Atalho para transferir com dono NULL.
  app.delete<{ Params: { id: string } }>(
    '/v1/contatos/:id/carteira', { preHandler: exigirTenant },
    async (req, reply) => {
      const resultado = await req.comTenant(async (tx) => {
        const eu = await garantirUsuarioId(tx, req)
        const [r] = await tx<{ transferir_carteira: string | null }[]>`
          SELECT transferir_carteira(tenant_atual(), ${req.params.id}, NULL, ${eu}, 'manual', NULL)`
        return r?.transferir_carteira ?? null
      })
      if (resultado === null) return reply.send({ id: null, semMudanca: true })
      return reply.send({ id: resultado, semMudanca: false })
    },
  )
}
