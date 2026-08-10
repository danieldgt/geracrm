import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { enviarMensagemEntrada, criarAcaoEntrada } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { decifrar } from '../integracao/cofre.js'
import { criarCanal } from './canais/fabrica.js'
import { enviarPeloGateway, type ContextoEnvio } from './canais/gateway.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { midiaHabilitada, subirMidia, urlAssinada } from './midia/armazenamento.js'
import { ehDataUrl, decodificarMidia } from './midia/dataurl.js'
import { registrarMetrica, avaliarEAlertarEntrega } from '../plataforma/metricas.js'

/** Recusa de mídia inválida → mensagem para a tela. */
const MSG_MIDIA: Record<string, string> = {
  formato_invalido: 'Arquivo inválido.',
  tipo_nao_suportado: 'Tipo de arquivo não suportado pelo WhatsApp.',
  muito_grande: 'Arquivo grande demais (máximo 16 MB).',
}

/** Recusa de guardrail → mensagem para a tela (com a ação corretiva nomeada). */
const MENSAGEM_RECUSA: Record<string, string> = {
  bloqueado: 'Este contato optou por não receber mensagens (opt-out).',
  canal_indisponivel: 'O canal está suspenso ou desconectado. Reconecte o número para enviar.',
  canal_sem_credencial: 'O canal desta conversa ainda não está configurado para envio.',
  janela_fechada: 'A janela de 24h fechou. Só um template aprovado reabre a conversa.',
}

/**
 * ENVIO de mensagem (saliente) — o outro lado do chat, sobre o envelope genérico.
 *
 * ⚠️ Três fases, e a ordem importa:
 *   1. Persiste a mensagem 'pendente' + evento no MESMO commit — a tela do
 *      agente (e a dos colegas) mostra a mensagem na hora, via tempo real.
 *   2. Envia pelo adaptador do canal FORA da transação (é rede; segurar uma
 *      transação aberta durante um POST externo trava conexão do pool).
 *   3. Marca o status final ('enviada'/'falhou') + evento — o tique de status
 *      atualiza sozinho na tela.
 *
 * ⚠️ Falha de envio é RETORNO tipificado, não exceção: a tela precisa do motivo
 * nomeado (canal desconectado ≠ número inválido ≠ credencial recusada).
 */

interface Preparo {
  mensagemId: string
  destino: string
  provedor: string | null
  cred: Uint8Array | null
  tipoCanal: string
  estadoCanal: string
  ultimaEntranteEm: Date | null
  destinoBloqueado: boolean
  remetenteNome: string | null
}

/**
 * Cabeçalho de identificação do atendente na mensagem que vai ao WhatsApp: o
 * cliente vê quem está falando. Nome em negrito (markdown do WhatsApp) + quebra.
 * ⚠️ Decoração de TRANSPORTE: entra só no despacho, não no histórico gravado —
 * o inbox mostra a conversa limpa, sem repetir o cabeçalho em cada linha.
 */
function comCabecalho(nome: string | null, texto: string): string {
  return nome ? `*${nome}*\n${texto}` : texto
}

async function marcarStatus(
  tenantId: string,
  conversaId: string,
  p: Preparo,
  status: 'enviada' | 'falhou',
  idExterno?: string,
): Promise<void> {
  await comTenantServico(tenantId, async (tx: Sql) => {
    // ⚠️ Casa SÓ por id (uuid único). Incluir `criado_em` no WHERE quebra: o
    //    timestamptz tem precisão de microssegundo e o round-trip por JS Date
    //    perde precisão → o UPDATE não encontra a linha e o status trava.
    await tx`
      UPDATE mensagem SET status = ${status}, status_ordem = 1, id_externo = ${idExterno ?? null}
       WHERE tenant_id = tenant_atual() AND id = ${p.mensagemId}`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  })
}

export async function rotasMensagens(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/mensagens',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = enviarMensagemEntrada.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(422).send({ erro: 'mensagem.invalida', mensagem: 'Conteúdo da mensagem inválido.' })
      }
      const entrada = parsed.data
      const conversaId = req.params.id
      const tenantId = req.tenantId!

      // Fase 0 (E5-14): mídia sobe para o bucket ANTES da transação (S3 é rede);
      // o banco guarda só a CHAVE, nunca o base64. Sem bucket configurado,
      // degrada para o base64 antigo em vez de quebrar.
      let midiaChave: string | null = null
      if ((entrada.tipo === 'imagem' || entrada.tipo === 'audio') && midiaHabilitada()) {
        const bruto = entrada.tipo === 'imagem' ? entrada.imagem : entrada.audio
        if (ehDataUrl(bruto)) {
          const dec = decodificarMidia(bruto)
          if (!dec.ok) return reply.code(422).send({ erro: `midia.${dec.motivo}`, mensagem: MSG_MIDIA[dec.motivo] })
          midiaChave = await subirMidia(tenantId, dec.bytes, dec.mime)
        }
      }

      // Fase 1: persiste 'pendente' + evento, no mesmo commit. Já carrega o
      // contexto que o gateway revalida (tipo/estado do canal, janela, opt-out).
      const preparo = await req.comTenant(async (tx) => {
        const [ctx] = await tx<Preparo[]>`
          SELECT cc.provedor,
                 cc.credenciais_cifradas AS cred,
                 cc.tipo                 AS "tipoCanal",
                 cc.estado               AS "estadoCanal",
                 ct.e164                 AS destino,
                 c.ultima_entrante_em    AS "ultimaEntranteEm",
                 EXISTS (
                   -- ⚠️ INV-50: opt-out casa por chave_bloqueio (55+DDD+8 últimos),
                   --    não por e164 — vale com e sem o nono dígito.
                   SELECT 1 FROM lista_bloqueio lb
                    WHERE lb.tenant_id = c.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio
                 )                       AS "destinoBloqueado"
            FROM conversa c
            JOIN contato_telefone ct ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.contato_id AND ct.principal
            JOIN canal_conectado cc  ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
           WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
        if (!ctx) return null

        const mensagemId = randomUUID()
        // conteudo guarda só o conteúdo (sem o discriminador `tipo`, que é coluna).
        // ⚠️ Se subiu para o bucket, o campo de mídia vira a CHAVE, não o base64.
        const { tipo: _tipo, ...conteudoBase } = entrada
        const conteudo = midiaChave ? { ...conteudoBase, [entrada.tipo]: midiaChave } : conteudoBase
        await tx`
          INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem)
          VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', ${entrada.tipo},
                  ${JSON.stringify(conteudo)}::text::jsonb, 'pendente', 0)`
        const [conv] = await tx<{ versao: string }[]>`
          UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
           WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
        await tx`
          INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
          VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${conversaId},
                  ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
        // Nome de quem está atendendo, para o cabeçalho do WhatsApp.
        const eu = await garantirUsuarioId(tx, req)
        const [rem] = await tx<{ nome: string }[]>`
          SELECT nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ${eu}`
        return { ...ctx, mensagemId, remetenteNome: rem?.nome ?? null }
      })

      if (!preparo) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })

      // Fase 2: GATEWAY ÚNICO — revalida guardrails no servidor e só então
      // despacha. O adaptador nunca é chamado direto por esta rota.
      const ctxEnvio: ContextoEnvio = {
        tipoCanal: preparo.tipoCanal,
        estadoCanal: preparo.estadoCanal,
        provedor: preparo.provedor,
        temCredencial: !!preparo.cred,
        destinoBloqueado: preparo.destinoBloqueado,
        ehTemplate: false, // templates entram na Onda 0 (HSM); por ora, texto livre.
        ultimaEntranteEm: preparo.ultimaEntranteEm,
      }
      const r = await enviarPeloGateway(ctxEnvio, new Date(), async () => {
        const canal = criarCanal(preparo.provedor!, decifrar(Buffer.from(preparo.cred!)))
        if (entrada.tipo === 'texto') return canal.enviarTexto(preparo.destino, comCabecalho(preparo.remetenteNome, entrada.texto))
        // ⚠️ Provedor busca a mídia por HTTP: manda a URL assinada (curta), não a
        //    chave nem o base64. Sem bucket, cai no valor original (base64).
        if (entrada.tipo === 'imagem') {
          const img = midiaChave ? await urlAssinada(midiaChave, 600) : entrada.imagem
          const legenda = preparo.remetenteNome ? comCabecalho(preparo.remetenteNome, entrada.legenda ?? '') : entrada.legenda
          return canal.enviarImagem(preparo.destino, img, legenda)
        }
        const aud = midiaChave ? await urlAssinada(midiaChave, 600) : entrada.audio
        return canal.enviarAudio(preparo.destino, aud)
      })

      // Fase 3: status final + evento.
      await marcarStatus(tenantId, conversaId, preparo, r.ok ? 'enviada' : 'falhou', r.ok ? r.idExterno : undefined)

      // Telemetria de entrega (I-11) + alerta (I-10). ⚠️ Só conta TRANSPORTE:
      // recusa de política (janela/opt-out/bloqueio) não é falha de entrega —
      // contá-la dispararia alerta de "entrega baixa" que não existe.
      if (r.ok || r.classe === 'transporte') {
        await comTenantServico(tenantId, async (tx) => {
          await registrarMetrica(tx, r.ok ? 'envio_ok' : 'envio_falha', 1, new Date())
          await avaliarEAlertarEntrega(tx, new Date())
        })
      }

      if (r.ok) return reply.send({ ok: true, mensagemId: preparo.mensagemId, status: 'enviada' })

      // Recusa nossa (política) → 409 com motivo nomeado; falha de transporte → 502.
      if (r.classe === 'recusa') {
        return reply.code(409).send({
          ok: false, mensagemId: preparo.mensagemId, motivo: r.motivo,
          mensagem: MENSAGEM_RECUSA[r.motivo] ?? 'Envio recusado.',
        })
      }
      return reply.code(502).send({ ok: false, mensagemId: preparo.mensagemId, motivo: r.motivo, detalhe: r.detalhe })
    },
  )

  // ───────── Apagar / editar (como no WhatsApp) ─────────

  app.delete<{ Params: { id: string; mid: string }; Body: { paraTodos?: boolean } }>(
    '/v1/conversas/:id/mensagens/:mid',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const { id: conversaId, mid } = req.params
      const tenantId = req.tenantId!
      const querParaTodos = req.body?.paraTodos !== false // padrão: para todos
      const ctx = await req.comTenant((tx) => carregarCtxMensagem(tx, conversaId, mid))
      if (!ctx) return reply.code(404).send({ erro: 'mensagem.nao_encontrada' })

      // "Apagar para todos" só vale para mensagem NOSSA (saliente) com id externo.
      let recall = false
      if (querParaTodos && ctx.direcao === 'saliente' && ctx.id_externo && ctx.cred && ctx.provedor) {
        const canal = criarCanal(ctx.provedor, decifrar(Buffer.from(ctx.cred)))
        const r = await canal.apagarMensagem(ctx.destino ?? '', ctx.id_externo)
        if (!r.ok) return reply.code(502).send({ ok: false, motivo: r.motivo, detalhe: r.detalhe })
        recall = true
      }
      await comTenantServico(tenantId, async (tx) => {
        await tx`UPDATE mensagem SET apagada_em = now(), apagada_para_todos = ${recall}
                  WHERE tenant_id = tenant_atual() AND id = ${mid}`
        await eventoConversa(tx, conversaId)
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, { atorId, acao: 'mensagem.apagada', entidade: 'mensagem', entidadeId: mid, dados: { paraTodos: recall } })
      })
      return reply.send({ ok: true, paraTodos: recall })
    },
  )

  app.patch<{ Params: { id: string; mid: string }; Body: { texto?: string } }>(
    '/v1/conversas/:id/mensagens/:mid',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const { id: conversaId, mid } = req.params
      const tenantId = req.tenantId!
      const texto = req.body?.texto?.trim()
      if (!texto) return reply.code(422).send({ erro: 'mensagem.texto_obrigatorio', mensagem: 'Texto vazio.' })

      const ctx = await req.comTenant((tx) => carregarCtxMensagem(tx, conversaId, mid))
      if (!ctx) return reply.code(404).send({ erro: 'mensagem.nao_encontrada' })
      if (ctx.direcao !== 'saliente' || ctx.tipo !== 'texto') {
        return reply.code(409).send({ erro: 'mensagem.nao_editavel', mensagem: 'Só dá para editar um texto enviado por você.' })
      }
      if (ctx.apagada_em) return reply.code(409).send({ erro: 'mensagem.apagada', mensagem: 'Mensagem apagada não pode ser editada.' })

      if (ctx.id_externo && ctx.cred && ctx.provedor) {
        const canal = criarCanal(ctx.provedor, decifrar(Buffer.from(ctx.cred)))
        const r = await canal.editarMensagem(ctx.destino ?? '', ctx.id_externo, texto)
        if (!r.ok) return reply.code(502).send({ ok: false, motivo: r.motivo, detalhe: r.detalhe })
      }
      await comTenantServico(tenantId, async (tx) => {
        await tx`UPDATE mensagem SET conteudo = ${JSON.stringify({ texto })}::text::jsonb, editada_em = now()
                  WHERE tenant_id = tenant_atual() AND id = ${mid}`
        await eventoConversa(tx, conversaId)
        const atorId = await garantirUsuarioId(tx, req)
        await auditar(tx, { atorId, acao: 'mensagem.editada', entidade: 'mensagem', entidadeId: mid })
      })
      return reply.send({ ok: true })
    },
  )

  // ───────── Ações no chat (card de pedido/orçamento/…) ─────────

  /**
   * Cria um card de AÇÃO na conversa. ⚠️ NÃO vai ao WhatsApp — é um card interno
   * e interativo; o agente/cliente resolve por uma opção. Estrutura genérica: a
   * família (`acao`) + `dados` específico + `opcoes` + `estado`.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/conversas/:id/acoes',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const parsed = criarAcaoEntrada.safeParse(req.body)
      if (!parsed.success) return reply.code(422).send({ erro: 'acao.invalida', mensagem: 'Dados da ação inválidos.' })
      const a = parsed.data
      const conversaId = req.params.id

      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        if (!c) return null
        const mensagemId = randomUUID()
        const conteudo = {
          acao: a.acao, titulo: a.titulo, ...(a.resumo ? { resumo: a.resumo } : {}),
          dados: a.dados, opcoes: a.opcoes, estado: 'pendente',
        }
        await tx`
          INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status_ordem)
          VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', 'acao',
                  ${JSON.stringify(conteudo)}::text::jsonb, 0)`
        await tx`UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
                  WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        await eventoConversa(tx, conversaId)
        return { mensagemId }
      })
      if (!r) return reply.code(404).send({ erro: 'conversa.nao_encontrada' })
      return reply.code(201).send({ ok: true, mensagemId: r.mensagemId })
    },
  )

  /** Resolve um card de ação — o usuário escolheu uma opção. */
  app.post<{ Params: { mid: string }; Body: { opcaoId?: string } }>(
    '/v1/mensagens/:mid/resolver',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const mid = req.params.mid
      const opcaoId = req.body?.opcaoId
      if (!opcaoId) return reply.code(422).send({ erro: 'acao.opcao_obrigatoria', mensagem: 'Escolha uma opção.' })

      const r = await req.comTenant(async (tx) => {
        const [m] = await tx<{ conversa_id: string; conteudo: { opcoes?: { id: string }[]; estado?: string } }[]>`
          SELECT conversa_id, conteudo FROM mensagem
           WHERE tenant_id = tenant_atual() AND id = ${mid} AND tipo = 'acao'`
        if (!m) return null
        if (m.conteudo.estado && m.conteudo.estado !== 'pendente') return { erro: 'ja_resolvida' as const }
        const opcao = (m.conteudo.opcoes ?? []).find((o) => o.id === opcaoId)
        if (!opcao) return { erro: 'opcao_invalida' as const }
        // Convenção: 'recusar' → recusado; qualquer outra → confirmado.
        const estado = opcaoId === 'recusar' ? 'recusado' : 'confirmado'
        const novo = { ...m.conteudo, estado, opcaoEscolhida: opcaoId }
        await tx`UPDATE mensagem SET conteudo = ${JSON.stringify(novo)}::text::jsonb
                  WHERE tenant_id = tenant_atual() AND id = ${mid}`
        await eventoConversa(tx, m.conversa_id)
        return { estado }
      })
      if (!r) return reply.code(404).send({ erro: 'mensagem.nao_encontrada' })
      if ('erro' in r) {
        return reply.code(409).send({ erro: `acao.${r.erro}`, mensagem: r.erro === 'ja_resolvida' ? 'Essa ação já foi resolvida.' : 'Opção inválida.' })
      }
      return reply.send({ ok: true, estado: r.estado })
    },
  )
}

interface CtxMensagem {
  direcao: string
  id_externo: string | null
  tipo: string
  apagada_em: Date | null
  provedor: string | null
  cred: Uint8Array | null
  destino: string | null
}

async function carregarCtxMensagem(tx: Sql, conversaId: string, mid: string): Promise<CtxMensagem | null> {
  const [m] = await tx<CtxMensagem[]>`
    SELECT m.direcao, m.id_externo, m.tipo, m.apagada_em,
           cc.provedor, cc.credenciais_cifradas AS cred, ct.e164 AS destino
      FROM mensagem m
      JOIN conversa c        ON c.tenant_id = m.tenant_id AND c.id = m.conversa_id
      JOIN canal_conectado cc ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
      LEFT JOIN contato_telefone ct
             ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.contato_id AND ct.principal
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.id = ${mid}
     LIMIT 1
  `
  return m ?? null
}

/** Bump de versão + evento de tempo real para a tela refletir a mudança. */
async function eventoConversa(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}
