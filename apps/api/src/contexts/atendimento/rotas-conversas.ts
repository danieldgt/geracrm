import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { calcularJanela, previewMensagem } from '@geracrm/shared'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { fragmentoForaDaSimulacao, fragmentoNaFila } from './sla-handoff.js'
import { midiaHabilitada, urlAssinada, ehChaveMidia } from './midia/armazenamento.js'
import { condicaoConversa, contatoNoEscopo, conversaNoEscopo, escopoDaRequisicao, exigirNoEscopo } from '../plataforma/escopo.js'
import { lerCursor, lerInstante, montarCursor } from '../crm/cursor-criado-em.js'

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
        // ⚠️ Escopo (D3): puxar para o chat só o cliente que a pessoa enxerga.
        if (!(await contatoNoEscopo(tx, await escopoDaRequisicao(tx, req), contatoId))) return { erro: 'contato_nao_encontrado' as const }

        const [canal] = req.body?.canalId
          // ⚠️ Canal arquivado (0083) não abre conversa nova: ele saiu da
          //    frota, e a conversa nasceria num número que não aparece na tela.
          ? await tx<{ id: string }[]>`SELECT id FROM canal_conectado
              WHERE tenant_id = tenant_atual() AND id = ${req.body.canalId} AND arquivado_em IS NULL`
          : await tx<{ id: string }[]>`
              SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND arquivado_em IS NULL
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
    { preHandler: [exigirTenant, exigirNoEscopo('conversa')] },
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
    const q = (req.query ?? {}) as { cursor?: string; limite?: string; canal?: string; filtro?: string; conduzidoPor?: string }
    const limite = Math.min(Number(q.limite) || LIMITE_PADRAO, LIMITE_MAX)
    const filtro = q.filtro === 'fila' || q.filtro === 'meus' ? q.filtro : 'todas'
    // Quem CONDUZ agora (combina com `filtro`): agente = conduzida pela IA sem atendimento aberto;
    // humano = atendimento aberto com atendente; aguardando = na fila (mesma régua da aba Fila).
    // ⚠️ `conduzida_por = 'humano'` SEM atendimento aberto (atendimento encerrado, ou conversa que
    //    nasceu de envio nosso — campanha, template) não entra em NENHUM chip enquanto a última
    //    palavra for nossa: ninguém conduz e ninguém espera. NÃO vai para "Aguardando" de propósito:
    //    o chip é a régua ÚNICA da fila (`fragmentoNaFila` — contador, aba Fila, coluna do kanban), e
    //    pôr ali quem não está esperando inflaria a fila com conversas encerradas. Quando o cliente
    //    escreve, `ultima_direcao` vira 'entrante' e a conversa entra em "Aguardando" sozinha.
    const conduzidoPor = q.conduzidoPor === 'agente' || q.conduzidoPor === 'humano' || q.conduzidoPor === 'aguardando' ? q.conduzidoPor : null
    if (q.conduzidoPor !== undefined && q.conduzidoPor !== '' && conduzidoPor === null) {
      return reply.code(422).send({ erro: 'conversas.conduzido_por_invalido', validos: ['agente', 'humano', 'aguardando'] })
    }

    // Cursor: "<ultima_mensagem_em::text>§<conversa_id>" — µs preservados (cursor-criado-em.ts).
    const cur = lerCursor(q.cursor)
    if (cur === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido' })
    const cursorEm = cur?.em ?? null
    const cursorId = cur?.id ?? null

    const sub = subDoUsuario(req) // a MESMA regra do assumir (dev: "dev-<tenant>")
    const linhas = await req.comTenant(async (tx) => {
      // ⚠️ Escopo (D3): a fila de não atribuídas do número que a pessoa atende
      //    continua visível (é dela que se assume) — ver condicaoConversa.
      const escopo = await escopoDaRequisicao(tx, req)
      return tx<{
      id: string; contato_id: string; nome: string; conduzida_por: string
      ultima_mensagem_em: Date | null; ultima_mensagem_em_txt: string | null; ultima_entrante_em: Date | null
      ultima_direcao: string | null; arquivada: boolean
      ult_tipo: string | null; ult_conteudo: unknown; ult_direcao: string | null
      nao_lida: boolean; canal_tipo: string; dono_carteira: string | null
    }[]>`
      SELECT cv.id, cv.contato_id, ct.nome, cv.conduzida_por,
             cv.ultima_mensagem_em, cv.ultima_mensagem_em::text AS ultima_mensagem_em_txt, cv.ultima_entrante_em, cv.ultima_direcao, cv.arquivada,
             cc.tipo AS canal_tipo,
             -- ⚠️ Quem CUIDA deste cliente. A régua de roteamento (regra 4 de
             --    roteamento-lead.ts) diz que relação existente não é triada
             --    por robô — e pelo mesmo motivo não deveria ficar numa fila
             --    genérica sem que a pessoa da relação saiba que ele escreveu.
             dono.nome AS dono_carteira,
             um.tipo AS ult_tipo, um.conteudo AS ult_conteudo, um.direcao AS ult_direcao,
             -- ⚠️ Não-lida é DERIVADA (versao − lida_ate_versao) e POR USUÁRIO,
             --    nunca um contador na conversa. Só entrante conta como não-lida.
             (cv.ultima_direcao = 'entrante' AND cv.versao > coalesce(cl.lida_ate_versao, 0)) AS nao_lida
        FROM conversa cv
        JOIN contato ct ON ct.id = cv.contato_id
        JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
        LEFT JOIN LATERAL (
          SELECT u.nome
            FROM carteira_atribuicao ca
            JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
           WHERE ca.tenant_id = cv.tenant_id AND ca.contato_id = cv.contato_id AND ca.ate IS NULL
           LIMIT 1
        ) dono ON true
        LEFT JOIN conversa_leitura cl
          ON cl.tenant_id = cv.tenant_id AND cl.conversa_id = cv.id
         AND cl.usuario_id = (SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub})
        -- ⚠️ A prévia é a última mensagem REAL: a de sistema (tipo 'sistema' — "Agente
        --    transferiu…") não é de ninguém, e aparecia como "Você: [sistema]".
        LEFT JOIN LATERAL (
          SELECT m.tipo, m.conteudo, m.direcao
            FROM mensagem m
           WHERE m.tenant_id = cv.tenant_id AND m.conversa_id = cv.id AND m.tipo <> 'sistema'
           ORDER BY m.criado_em DESC
           LIMIT 1
        ) um ON true
       WHERE NOT cv.arquivada
         AND ${fragmentoForaDaSimulacao(tx)}
         AND ${condicaoConversa(tx, escopo)}
         AND ${q.canal ? tx`cv.canal_id = ${q.canal}::uuid` : tx`true`}
         AND ${
           filtro === 'fila'
             ? fragmentoNaFila(tx)
             : filtro === 'meus'
               ? tx`EXISTS (
                     SELECT 1 FROM atendimento a
                      JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.atendente_id
                     WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id
                       AND a.estado <> 'encerrado' AND u.cognito_sub = ${sub})`
               : tx`true`
         }
         AND ${
           conduzidoPor === 'agente'
             ? tx`cv.conduzida_por = 'ia' AND NOT EXISTS (
                     SELECT 1 FROM atendimento a
                      WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado')`
             : conduzidoPor === 'humano'
               ? tx`EXISTS (
                     SELECT 1 FROM atendimento a
                      WHERE a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id
                        AND a.estado <> 'encerrado' AND a.atendente_id IS NOT NULL)`
               : conduzidoPor === 'aguardando'
                 ? fragmentoNaFila(tx)
                 : tx`true`
         }
         AND ${cursorEm === null ? tx`true` : tx`
               (cv.ultima_mensagem_em, cv.id) < (${cursorEm}::text::timestamptz, ${cursorId}::uuid)`}
       ORDER BY cv.ultima_mensagem_em DESC NULLS LAST, cv.id DESC
       LIMIT ${limite + 1}
    `
    })

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
      // ⚠️ `null` quando ninguém cuida — e é diferente de "não sei": a consulta
      //    olhou a carteira e não achou dono ativo.
      donoCarteira: l.dono_carteira,
      // ⚠️ Janela derivada do timestamp da última entrante — não uma flag.
      janela: calcularJanela(l.ultima_entrante_em, agora),
    }))
    const ultimo = pagina[pagina.length - 1]
    const proximoCursor = temMais && ultimo?.ultima_mensagem_em_txt
      ? montarCursor(ultimo.ultima_mensagem_em_txt, ultimo.id)
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

      const sub = subDoUsuario(req)
      const dados = await req.comTenant(async (tx) => {
        // ⚠️ Fora do escopo do usuário = 404, igual a inexistente (D3).
        if (!(await conversaNoEscopo(tx, await escopoDaRequisicao(tx, req), id))) return null
        const [conversa] = await tx<{
          id: string; nome: string; contato_id: string
          ultima_entrante_em: Date | null; conduzida_por: string; canal_tipo: string
          at_estado: string | null; at_nome: string | null; at_protocolo: string | null; at_meu: boolean | null
        }[]>`
          SELECT cv.id, ct.nome, cv.contato_id, cv.ultima_entrante_em, cv.conduzida_por,
                 cc.tipo AS canal_tipo, at.estado AS at_estado, at.nome AS at_nome, at.protocolo AS at_protocolo, at.meu AS at_meu
            FROM conversa cv
            JOIN contato ct ON ct.id = cv.contato_id
            JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
            LEFT JOIN LATERAL (
              SELECT a.estado, a.protocolo, u.nome, coalesce(u.cognito_sub = ${sub}, false) AS meu
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
              // Quem conduz sou EU? (G1: a tela só oferece "Devolver" a quem conduz ou à gestão.)
              meu: dados.conversa.at_meu === true,
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
    { preHandler: [exigirTenant, exigirNoEscopo('conversa')] },
    async (req, reply) => {
      const id = req.params.id
      const { anteriorId } = req.query
      if (!req.query.anteriorEm || !anteriorId) return reply.code(422).send({ erro: 'cursor.ausente', mensagem: 'Cursor obrigatório.' })
      const anteriorEm = lerInstante(req.query.anteriorEm)
      if (anteriorEm === null || !UUID.test(anteriorId)) {
        return reply.code(422).send({ erro: 'cursor.invalido', mensagem: 'Cursor inválido.' })
      }

      const dados = await req.comTenant(async (tx) => {
        const linhas = await tx<{
          id: string; direcao: string; tipo: string; conteudo: unknown
          status: string | null; criado_em: Date
          apagada_em: Date | null; apagada_para_todos: boolean | null; editada_em: Date | null
        }[]>`
          WITH ancora AS (
            -- ⚠️ O 'anteriorEm' do cliente veio de um Date (ms); a âncora real tem µs. Achamos
            --    a mensagem pelo id dentro desse milissegundo (poda as partições) e usamos o
            --    instante exato — senão a do mesmo ms, mais antiga em µs, nunca aparecia.
            SELECT criado_em, id FROM mensagem
             WHERE conversa_id = ${id} AND id = ${anteriorId}::uuid
               AND criado_em >= ${anteriorEm}::text::timestamptz
               AND criado_em < ${anteriorEm}::text::timestamptz + interval '1 millisecond')
          SELECT id, direcao, tipo, conteudo, status, criado_em, apagada_em, apagada_para_todos, editada_em
            FROM mensagem
           WHERE conversa_id = ${id}
             AND criado_em < ${anteriorEm}::text::timestamptz + interval '1 millisecond'
             AND (criado_em, id) < (coalesce((SELECT criado_em FROM ancora), ${anteriorEm}::text::timestamptz),
                                    coalesce((SELECT id FROM ancora), ${anteriorId}::uuid))
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
