import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { calcularJanela, previewMensagem } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { midiaHabilitada, urlAssinada, ehChaveMidia } from './midia/armazenamento.js'

/**
 * E5-14: na leitura, a CHAVE de mídia vira URL ASSINADA de expiração curta. O
 * cliente renderiza a URL direto (sem credencial, sem base64). Mídia de ENTRADA
 * (URL http do provedor) passa direto — não é chave nossa.
 */
async function enriquecerMidia(tipo: string, conteudo: unknown): Promise<unknown> {
  if (!midiaHabilitada() || (tipo !== 'imagem' && tipo !== 'audio')) return conteudo
  const c = conteudo as Record<string, unknown> | null
  const val = c?.[tipo]
  if (typeof val === 'string' && ehChaveMidia(val)) {
    return { ...c, [tipo]: await urlAssinada(val) }
  }
  return conteudo
}

/**
 * Inbox — a lista de conversas e a thread.
 *
 * ⚠️ Hoje a base de conversas está VAZIA: elas nascem dos webhooks da Meta, que
 * dependem do registro (bloqueado). Os endpoints já existem e devolvem o vazio
 * honesto — quando o WhatsApp conectar e as mensagens chegarem, a tela acende
 * sem mudar de contrato.
 *
 * ⚠️ O estado da janela de 24h é DERIVADO (`@geracrm/shared/calcularJanela`),
 * nunca uma flag gravada — a mesma função que a contagem regressiva da tela usa.
 * Flag precisa de alguém para virá-la às 23h59, e não tem ninguém.
 */

const LIMITE_PADRAO = 40
const LIMITE_MAX = 100
const MENSAGENS_PAGINA = 50

export async function rotasConversas(app: FastifyInstance): Promise<void> {
  // Lista de conversas de um canal (ou todas), ordenada por atividade recente.
  /**
   * Inicia (ou reabre) uma conversa com um contato — "puxar o contato para o
   * chat". ⚠️ Uma conversa por (canal, contato) é a chave natural: se já existe,
   * DEVOLVE a mesma; não duplica. Escolhe o canal conectado do tenant.
   */
  app.post<{ Body: { contatoId?: string; canalId?: string } }>(
    '/v1/conversas',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const contatoId = req.body?.contatoId
      if (!contatoId || !/^[0-9a-f-]{36}$/i.test(contatoId)) {
        return reply.code(422).send({ erro: 'conversa.contato_invalido', mensagem: 'Contato inválido.' })
      }
      const resultado = await req.comTenant(async (tx) => {
        const [contato] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
        if (!contato) return { erro: 'contato_nao_encontrado' as const }

        const [canal] = req.body?.canalId
          ? await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.body.canalId}`
          : await tx<{ id: string }[]>`
              SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual()
               ORDER BY (estado = 'conectado') DESC, criado_em ASC LIMIT 1`
        if (!canal) return { erro: 'sem_canal' as const }

        const novoId = randomUUID()
        const [criada] = await tx<{ id: string }[]>`
          INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
          VALUES (tenant_atual(), ${novoId}, ${canal.id}, ${contatoId}, 0)
          ON CONFLICT (tenant_id, canal_id, contato_id) DO NOTHING
          RETURNING id`
        if (criada) return { conversaId: criada.id, criada: true }

        const [existente] = await tx<{ id: string }[]>`
          SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND canal_id = ${canal.id} AND contato_id = ${contatoId}`
        return { conversaId: existente!.id, criada: false }
      })

      if ('erro' in resultado) {
        if (resultado.erro === 'contato_nao_encontrado') return reply.code(404).send({ erro: 'contato.nao_encontrado' })
        return reply.code(409).send({ erro: 'conversa.sem_canal', mensagem: 'Nenhum número de WhatsApp conectado para iniciar a conversa.' })
      }
      return reply.code(resultado.criada ? 201 : 200).send(resultado)
    },
  )

  /** Marca a conversa como lida ATÉ a versão atual, para o usuário (E5-12). */
  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/lida',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const conversaId = req.params.id
      const ok = await req.comTenant(async (tx) => {
        const [cv] = await tx<{ versao: string }[]>`
          SELECT versao FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!cv) return false
        const usuarioId = await garantirUsuarioId(tx, req)
        await tx`
          INSERT INTO conversa_leitura (tenant_id, conversa_id, usuario_id, lida_ate_versao, atualizado_em)
          VALUES (tenant_atual(), ${conversaId}, ${usuarioId}, ${Number(cv.versao)}, now())
          ON CONFLICT (tenant_id, conversa_id, usuario_id)
          DO UPDATE SET lida_ate_versao = GREATEST(conversa_leitura.lida_ate_versao, EXCLUDED.lida_ate_versao),
                        atualizado_em = now()`
        return true
      })
      if (!ok) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      return reply.send({ ok: true })
    },
  )

  app.get('/v1/conversas', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; limite?: string; canal?: string; filtro?: string }
    const limite = Math.min(Number(q.limite) || LIMITE_PADRAO, LIMITE_MAX)
    const filtro = q.filtro === 'fila' || q.filtro === 'meus' ? q.filtro : 'todas'

    // Cursor: "<ultima_mensagem_em iso>:<conversa_id>".
    let cursorEm: string | null = null
    let cursorId: string | null = null
    if (q.cursor) {
      const [em, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('§')
      if (em && id) { cursorEm = em; cursorId = id }
    }

    const sub = req.usuarioSub ?? 'dev-header-sub'
    const linhas = await req.comTenant((tx) => tx<{
      id: string; contato_id: string; nome: string; conduzida_por: string
      ultima_mensagem_em: Date | null; ultima_entrante_em: Date | null
      ultima_direcao: string | null; arquivada: boolean
      ult_tipo: string | null; ult_conteudo: unknown; ult_direcao: string | null
      nao_lida: boolean; canal_tipo: string
    }[]>`
      SELECT cv.id, cv.contato_id, ct.nome, cv.conduzida_por,
             cv.ultima_mensagem_em, cv.ultima_entrante_em, cv.ultima_direcao, cv.arquivada,
             cc.tipo AS canal_tipo,
             um.tipo AS ult_tipo, um.conteudo AS ult_conteudo, um.direcao AS ult_direcao,
             -- ⚠️ Não-lida é DERIVADA (versao − lida_ate_versao) e POR USUÁRIO,
             --    nunca um contador na conversa. Só entrante conta como não-lida.
             (cv.ultima_direcao = 'entrante' AND cv.versao > coalesce(cl.lida_ate_versao, 0)) AS nao_lida
        FROM conversa cv
        JOIN contato ct ON ct.id = cv.contato_id
        JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
        LEFT JOIN conversa_leitura cl
          ON cl.tenant_id = cv.tenant_id AND cl.conversa_id = cv.id
         AND cl.usuario_id = (SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub})
        LEFT JOIN LATERAL (
          SELECT m.tipo, m.conteudo, m.direcao
            FROM mensagem m
           WHERE m.tenant_id = cv.tenant_id AND m.conversa_id = cv.id
           ORDER BY m.criado_em DESC
           LIMIT 1
        ) um ON true
       WHERE NOT cv.arquivada
         AND ${q.canal ? tx`cv.canal_id = ${q.canal}::uuid` : tx`true`}
         AND ${
           filtro === 'fila'
             ? tx`cv.ultima_direcao = 'entrante' AND NOT EXISTS (
                   SELECT 1 FROM atendimento a
                    WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')`
             : filtro === 'meus'
               ? tx`EXISTS (
                     SELECT 1 FROM atendimento a
                      JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
                     WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id
                       AND a.estado <> 'encerrado' AND u.cognito_sub = ${sub})`
               : tx`true`
         }
         AND ${cursorEm === null ? tx`true` : tx`
               (cv.ultima_mensagem_em, cv.id) < (${cursorEm}::timestamptz, ${cursorId}::uuid)`}
       ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC
       LIMIT ${limite + 1}
    `)

    const agora = new Date()
    const temMais = linhas.length > limite
    const pagina = temMais ? linhas.slice(0, limite) : linhas
    const itens = pagina.map((l) => ({
      id: l.id,
      contatoId: l.contato_id,
      nome: l.nome,
      conduzidaPor: l.conduzida_por,
      ultimaMensagemEm: l.ultima_mensagem_em,
      ultimaDirecao: l.ultima_direcao,
      // Prévia da última mensagem para a lista (como no WhatsApp). Genérica por
      // tipo (texto/imagem/áudio/ação…) via o contrato compartilhado.
      ultimaMensagem: l.ult_tipo
        ? { texto: previewMensagem(l.ult_tipo, l.ult_conteudo), direcao: l.ult_direcao }
        : null,
      naoLida: l.nao_lida,
      // Tipo de canal — a lista pinta o símbolo da marca por conversa (multicanal).
      canalTipo: l.canal_tipo,
      // ⚠️ Janela derivada do timestamp da última entrante — não uma flag.
      janela: calcularJanela(l.ultima_entrante_em, agora),
    }))
    const ultimo = pagina[pagina.length - 1]
    const proximoCursor = temMais && ultimo?.ultima_mensagem_em
      ? Buffer.from(`${ultimo.ultima_mensagem_em.toISOString()}§${ultimo.id}`, 'utf8').toString('base64url')
      : null

    return reply.send({ itens, proximoCursor })
  })

  // Thread de uma conversa: dados + mensagens (mais recentes por último).
  app.get<{ Params: { id: string } }>(
    '/v1/conversas/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const id = req.params.id
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return reply.code(400).send({ erro: 'conversa.id_invalido', mensagem: 'Id inválido.' })
      }

      const dados = await req.comTenant(async (tx) => {
        const [conversa] = await tx<{
          id: string; nome: string; contato_id: string
          ultima_entrante_em: Date | null; conduzida_por: string; canal_tipo: string
          at_estado: string | null; at_nome: string | null; at_protocolo: string | null
        }[]>`
          SELECT cv.id, ct.nome, cv.contato_id, cv.ultima_entrante_em, cv.conduzida_por,
                 cc.tipo AS canal_tipo, at.estado AS at_estado, at.nome AS at_nome, at.protocolo AS at_protocolo
            FROM conversa cv
            JOIN contato ct ON ct.id = cv.contato_id
            JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
            LEFT JOIN LATERAL (
              SELECT a.estado, a.protocolo, u.nome
                FROM atendimento a
                LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
               WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado'
               LIMIT 1
            ) at ON true
           WHERE cv.id = ${id}
        `
        if (!conversa) return null

        // ⚠️ Carrega as mais RECENTES (DESC + LIMIT) e inverte para exibir. O
        //    predicado por criado_em deixa o Postgres podar partições — nunca
        //    varre o histórico inteiro (mensagem é particionada por mês).
        const recentes = await tx<{
          id: string; direcao: string; tipo: string; conteudo: unknown
          status: string | null; criado_em: Date
          apagada_em: Date | null; apagada_para_todos: boolean | null; editada_em: Date | null
        }[]>`
          SELECT id, direcao, tipo, conteudo, status, criado_em,
                 apagada_em, apagada_para_todos, editada_em
            FROM mensagem WHERE conversa_id = ${id}
           ORDER BY criado_em DESC, id DESC LIMIT ${MENSAGENS_PAGINA + 1}
        `
        const temMais = recentes.length > MENSAGENS_PAGINA
        const mensagens = (temMais ? recentes.slice(0, MENSAGENS_PAGINA) : recentes).reverse()
        return { conversa, mensagens, temMais }
      })

      if (!dados) return reply.code(404).send({ erro: 'conversa.nao_encontrada', mensagem: 'Conversa não encontrada.' })

      return reply.send({
        id: dados.conversa.id,
        nome: dados.conversa.nome,
        contatoId: dados.conversa.contato_id,
        conduzidaPor: dados.conversa.conduzida_por,
        // Atendimento aberto (EP-06): null = ninguém assumiu → tela mostra "Assumir".
        atendimento: dados.conversa.at_estado
          ? {
              estado: dados.conversa.at_estado,
              atendenteNome: dados.conversa.at_nome,
              protocolo: dados.conversa.at_protocolo ? Number(dados.conversa.at_protocolo) : null,
            }
          : null,
        // ⚠️ A janela de 24h + template é regra SÓ do WhatsApp Oficial (Meta).
        //    No não-oficial (PlugZapi) manda texto livre a qualquer hora.
        exigeJanela24h: dados.conversa.canal_tipo === 'whatsapp_oficial',
        // Tipo de canal — o cabeçalho da conversa pinta o símbolo da marca (multicanal).
        canalTipo: dados.conversa.canal_tipo,
        temMaisAntigas: dados.temMais,
        janela: calcularJanela(dados.conversa.ultima_entrante_em, new Date()),
        mensagens: await Promise.all(dados.mensagens.map(async (m) => ({
          id: m.id, direcao: m.direcao, tipo: m.tipo,
          conteudo: await enriquecerMidia(m.tipo, m.conteudo),
          status: m.status, criadoEm: m.criado_em,
          apagada: m.apagada_em !== null,
          apagadaParaTodos: m.apagada_para_todos === true,
          editada: m.editada_em !== null,
        }))),
      })
    },
  )

  /**
   * Mensagens ANTERIORES (E5-09) — cursor para trás por (criado_em, id). ⚠️ O
   * predicado por criado_em poda partições; nunca varre partições fora da janela.
   */
  app.get<{ Params: { id: string }; Querystring: { anteriorEm?: string; anteriorId?: string } }>(
    '/v1/conversas/:id/mensagens',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const id = req.params.id
      const { anteriorEm, anteriorId } = req.query
      if (!anteriorEm || !anteriorId) return reply.code(422).send({ erro: 'cursor.ausente', mensagem: 'Cursor obrigatório.' })

      const dados = await req.comTenant(async (tx) => {
        const linhas = await tx<{
          id: string; direcao: string; tipo: string; conteudo: unknown
          status: string | null; criado_em: Date
          apagada_em: Date | null; apagada_para_todos: boolean | null; editada_em: Date | null
        }[]>`
          SELECT id, direcao, tipo, conteudo, status, criado_em, apagada_em, apagada_para_todos, editada_em
            FROM mensagem
           WHERE conversa_id = ${id}
             AND (criado_em, id) < (${anteriorEm}::timestamptz, ${anteriorId}::uuid)
           ORDER BY criado_em DESC, id DESC LIMIT ${MENSAGENS_PAGINA + 1}`
        const temMais = linhas.length > MENSAGENS_PAGINA
        return { mensagens: (temMais ? linhas.slice(0, MENSAGENS_PAGINA) : linhas).reverse(), temMais }
      })

      return reply.send({
        temMaisAntigas: dados.temMais,
        mensagens: await Promise.all(dados.mensagens.map(async (m) => ({
          id: m.id, direcao: m.direcao, tipo: m.tipo,
          conteudo: await enriquecerMidia(m.tipo, m.conteudo),
          status: m.status, criadoEm: m.criado_em,
          apagada: m.apagada_em !== null, apagadaParaTodos: m.apagada_para_todos === true, editada: m.editada_em !== null,
        }))),
      })
    },
  )
}
