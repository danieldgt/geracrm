import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  REGRAS_AGENTE_PADRAO, validarRegrasAgente, MODOS_AGENTE, OBJETIVOS_AGENTE, SLOTS_QUALIFICACAO,
  persona as personaSchema, alcadaAgente, ALCADA_PADRAO, PERSONA_PADRAO,
  type RegrasDoAgente, type ModoAgente,
} from '@geracrm/shared'
import { z } from 'zod'
import { exigirTenant } from '../../../plugins/tenant.js'
import { comTenantServico } from '../../../db/index.js'
import { faltaParaLlmFerramentas } from './fabrica-ferramentas.js'
import { conduzirTurnoVendedor } from './vendedor.js'
import { ligacoesPadrao } from './ferramentas/ligacoes.js'
import { sincronizarPoliticas } from './conhecimento/indexador.js'

/**
 * A superfície do AGENTE VENDEDOR: configurar (modo, persona, alçada, regras,
 * políticas), ver cada DECISÃO que ele tomou, e conversar com ele no
 * PLAYGROUND antes de ligar para cliente de verdade.
 *
 * ⚠️ `ativo` continua na resposta e no corpo por compatibilidade de um deploy
 * com o console anterior: `ativo: true` sem `modo` vira `autonomo`, que é o que
 * "ligado" sempre significou. A tela nova fala em `modo`.
 */

const PAGINA = 20
const UUID = /^[0-9a-f-]{36}$/i

const corpoConfig = z.object({
  ativo: z.boolean().optional(),
  modo: z.enum(MODOS_AGENTE).optional(),
  politicas: z.string().max(20_000).optional(),
  persona: personaSchema.partial().optional(),
  objetivo: z.enum(OBJETIVOS_AGENTE).optional(),
  alcada: alcadaAgente.partial().optional(),
  qualificacao: z.array(z.enum(SLOTS_QUALIFICACAO)).max(SLOTS_QUALIFICACAO.length).optional(),
  modelo: z.string().trim().max(80).nullable().optional(),
  limiarConfianca: z.number().min(0).max(1).optional(),
  maxRodadas: z.number().int().min(1).max(12).optional(),
  prazoTurnoMs: z.number().int().min(3000).max(60000).optional(),
  orcamentoDiaCentavos: z.number().int().nonnegative().nullable().optional(),
}).passthrough()

export async function rotasAgente(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const { cfg, temMensagemAusencia } = await req.comTenant(async (tx) => {
        const [linha] = await tx<{
          ativo: boolean; modo: ModoAgente; politicas: string | null; persona: unknown; objetivo: string; alcada: unknown
          qualificacao: unknown; modelo: string | null; limiar_confianca: string; max_rodadas: number; prazo_turno_ms: number
          orcamento_dia_centavos: string | null
          so_quando_ninguem_disponivel: boolean; exigir_ausencia_antes: boolean
          horas_desde_ausencia: number; reabrir_apos_encerrada: boolean; horas_para_reabrir: number
          minutos_presenca: number; max_turnos: number; max_caracteres: number; falas_de_contexto: number
        }[]>`
          SELECT ativo, modo, politicas, persona, objetivo, alcada, qualificacao, modelo, limiar_confianca, max_rodadas,
                 prazo_turno_ms, orcamento_dia_centavos,
                 so_quando_ninguem_disponivel, exigir_ausencia_antes,
                 horas_desde_ausencia, reabrir_apos_encerrada, horas_para_reabrir,
                 minutos_presenca, max_turnos, max_caracteres, falas_de_contexto
            FROM agente_config
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        const [canal] = await tx<{ tem: boolean }[]>`
          SELECT btrim(coalesce(mensagem_ausencia, '')) <> '' AS tem
            FROM canal_configuracao
           WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        return { cfg: linha, temMensagemAusencia: canal?.tem ?? false }
      })

      const p = REGRAS_AGENTE_PADRAO
      const per = personaSchema.safeParse(cfg?.persona ?? {})
      const alc = alcadaAgente.safeParse(cfg?.alcada ?? {})
      return reply.send({
        ativo: cfg?.ativo ?? false,
        modo: cfg?.modo ?? 'desligado',
        politicas: cfg?.politicas ?? '',
        persona: per.success ? per.data : PERSONA_PADRAO,
        objetivo: cfg?.objetivo ?? 'vender',
        alcada: alc.success ? alc.data : ALCADA_PADRAO,
        qualificacao: Array.isArray(cfg?.qualificacao) ? cfg!.qualificacao : [],
        modelo: cfg?.modelo ?? null,
        limiarConfianca: cfg ? Number(cfg.limiar_confianca) : 0.6,
        maxRodadas: cfg?.max_rodadas ?? 6,
        prazoTurnoMs: cfg?.prazo_turno_ms ?? 20000,
        orcamentoDiaCentavos: cfg?.orcamento_dia_centavos === null || cfg?.orcamento_dia_centavos === undefined ? null : Number(cfg.orcamento_dia_centavos),
        regras: {
          soQuandoNinguemDisponivel: cfg?.so_quando_ninguem_disponivel ?? p.soQuandoNinguemDisponivel,
          exigirAusenciaAntes: cfg?.exigir_ausencia_antes ?? p.exigirAusenciaAntes,
          horasDesdeAusencia: cfg?.horas_desde_ausencia ?? p.horasDesdeAusencia,
          reabrirAposEncerrada: cfg?.reabrir_apos_encerrada ?? p.reabrirAposEncerrada,
          horasParaReabrir: cfg?.horas_para_reabrir ?? p.horasParaReabrir,
          minutosPresenca: cfg?.minutos_presenca ?? p.minutosPresenca,
          maxTurnos: cfg?.max_turnos ?? p.maxTurnos,
          maxCaracteres: cfg?.max_caracteres ?? p.maxCaracteres,
          falasDeContexto: cfg?.falas_de_contexto ?? p.falasDeContexto,
        } satisfies RegrasDoAgente,
        padroes: p,
        maxTurnos: cfg?.max_turnos ?? p.maxTurnos,
        faltaConfigurar: faltaParaLlmFerramentas(),
        temMensagemAusencia,
        modos: MODOS_AGENTE,
        slotsDisponiveis: SLOTS_QUALIFICACAO,
      })
    },
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/v1/canais/:id/agente', { preHandler: exigirTenant },
    async (req, reply) => {
      const parse = corpoConfig.safeParse(req.body ?? {})
      if (!parse.success) {
        const i = parse.error.issues[0]!
        return reply.code(422).send({ erro: 'agente.campo_invalido', mensagem: `${i.path.join('.')}: ${i.message}`, campos: [i.path.join('.')] })
      }
      const corpo = parse.data
      const politicas = corpo.politicas?.trim() ?? ''
      // ⚠️ `modo` manda; sem ele, `ativo` decide pelo significado antigo.
      const modo: ModoAgente = corpo.modo ?? (corpo.ativo === true ? 'autonomo' : 'desligado')
      const ativo = modo !== 'desligado'

      const v = validarRegrasAgente({ ...corpo, maxTurnos: corpo['maxTurnos'] })
      if (!v.ok) {
        return reply.code(422).send({ erro: 'agente.regra_invalida', mensagem: v.erros[0]!.mensagem, campos: v.erros.map((e) => e.campo) })
      }
      const r = v.regras
      if (modo === 'autonomo' && !politicas) {
        return reply.code(422).send({
          erro: 'agente.sem_politicas',
          mensagem: 'Escreva as políticas da loja antes de deixar o agente autônomo — sem elas ele responde "não sei" a tudo. Sombra e assistido não exigem.',
        })
      }
      const falta = faltaParaLlmFerramentas()
      if (ativo && falta.length > 0) {
        return reply.code(422).send({ erro: 'agente.sem_chave', mensagem: `Falta configurar ${falta.join(', ')} no servidor.` })
      }
      const personaFinal = personaSchema.parse({ ...PERSONA_PADRAO, ...corpo.persona })
      const alcadaFinal = alcadaAgente.parse({ ...ALCADA_PADRAO, ...corpo.alcada })

      const gravado = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`
          SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return null
        await tx`
          INSERT INTO agente_config (
            tenant_id, canal_id, ativo, modo, politicas, max_turnos,
            so_quando_ninguem_disponivel, exigir_ausencia_antes, horas_desde_ausencia,
            reabrir_apos_encerrada, horas_para_reabrir, minutos_presenca, max_caracteres, falas_de_contexto,
            persona, objetivo, alcada, qualificacao, modelo, limiar_confianca, max_rodadas, prazo_turno_ms, orcamento_dia_centavos,
            atualizado_em)
          VALUES (tenant_atual(), ${req.params.id}, ${ativo}, ${modo}, ${politicas || null}, ${r.maxTurnos},
                  ${r.soQuandoNinguemDisponivel}, ${r.exigirAusenciaAntes}, ${r.horasDesdeAusencia},
                  ${r.reabrirAposEncerrada}, ${r.horasParaReabrir}, ${r.minutosPresenca}, ${r.maxCaracteres}, ${r.falasDeContexto},
                  ${JSON.stringify(personaFinal)}::text::jsonb, ${corpo.objetivo ?? 'vender'}, ${JSON.stringify(alcadaFinal)}::text::jsonb,
                  ${JSON.stringify(corpo.qualificacao ?? [])}::text::jsonb, ${corpo.modelo ?? null},
                  ${corpo.limiarConfianca ?? 0.6}, ${corpo.maxRodadas ?? 6}, ${corpo.prazoTurnoMs ?? 20000}, ${corpo.orcamentoDiaCentavos ?? null},
                  now())
          ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
            ativo = EXCLUDED.ativo, modo = EXCLUDED.modo, politicas = EXCLUDED.politicas,
            max_turnos = EXCLUDED.max_turnos,
            so_quando_ninguem_disponivel = EXCLUDED.so_quando_ninguem_disponivel,
            exigir_ausencia_antes = EXCLUDED.exigir_ausencia_antes,
            horas_desde_ausencia = EXCLUDED.horas_desde_ausencia,
            reabrir_apos_encerrada = EXCLUDED.reabrir_apos_encerrada,
            horas_para_reabrir = EXCLUDED.horas_para_reabrir,
            minutos_presenca = EXCLUDED.minutos_presenca,
            max_caracteres = EXCLUDED.max_caracteres,
            falas_de_contexto = EXCLUDED.falas_de_contexto,
            persona = ${corpo.persona ? tx`EXCLUDED.persona` : tx`agente_config.persona`},
            objetivo = ${corpo.objetivo ? tx`EXCLUDED.objetivo` : tx`agente_config.objetivo`},
            alcada = ${corpo.alcada ? tx`EXCLUDED.alcada` : tx`agente_config.alcada`},
            qualificacao = ${corpo.qualificacao ? tx`EXCLUDED.qualificacao` : tx`agente_config.qualificacao`},
            modelo = ${corpo.modelo !== undefined ? tx`EXCLUDED.modelo` : tx`agente_config.modelo`},
            limiar_confianca = ${corpo.limiarConfianca !== undefined ? tx`EXCLUDED.limiar_confianca` : tx`agente_config.limiar_confianca`},
            max_rodadas = ${corpo.maxRodadas !== undefined ? tx`EXCLUDED.max_rodadas` : tx`agente_config.max_rodadas`},
            prazo_turno_ms = ${corpo.prazoTurnoMs !== undefined ? tx`EXCLUDED.prazo_turno_ms` : tx`agente_config.prazo_turno_ms`},
            orcamento_dia_centavos = ${corpo.orcamentoDiaCentavos !== undefined ? tx`EXCLUDED.orcamento_dia_centavos` : tx`agente_config.orcamento_dia_centavos`},
            atualizado_em = now()`
        // A base de conhecimento espelha as políticas na MESMA transação (R3).
        if (corpo.politicas !== undefined) await sincronizarPoliticas(tx, req.params.id, politicas)
        return canal
      })
      if (!gravado) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true, modo })
    },
  )

  /** Sessões conduzidas — paginado por cursor. */
  app.get<{ Querystring: { cursor?: string } }>(
    '/v1/agente/sessoes', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; contato: string | null; estado: string; turnos: number; motivo_saida: string | null
        iniciada_em: Date; encerrada_em: Date | null; extraido: Record<string, unknown>; descartados: unknown[]
        tokens_entrada: number; tokens_saida: number; fase: string; modo: string | null; slots: Record<string, unknown>; custo_centavos: string
      }[]>`
        SELECT s.id, s.conversa_id, ct.nome AS contato, s.estado, s.turnos, s.motivo_saida,
               s.iniciada_em, s.encerrada_em, s.extraido, s.descartados, s.tokens_entrada, s.tokens_saida,
               s.fase, s.modo, s.slots, s.custo_centavos
          FROM agente_sessao s
          JOIN conversa cv ON cv.tenant_id = s.tenant_id AND cv.id = s.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE s.tenant_id = tenant_atual()
           AND ${curEm === null ? tx`true` : tx`(s.iniciada_em, s.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY s.iniciada_em DESC, s.id DESC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, conversaId: l.conversa_id, contato: l.contato, estado: l.estado, turnos: l.turnos,
          motivoSaida: l.motivo_saida, iniciadaEm: l.iniciada_em, encerradaEm: l.encerrada_em,
          extraido: l.extraido, descartados: l.descartados, tokens: l.tokens_entrada + l.tokens_saida,
          fase: l.fase, modo: l.modo, slots: l.slots, custoCentavos: Number(l.custo_centavos),
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.iniciada_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  /**
   * As DECISÕES — uma por turno (ADR-023). Por conversa ou por canal, cursor.
   * É a resposta a "por que o robô disse isso?".
   */
  app.get<{ Querystring: { cursor?: string; conversaId?: string; canalId?: string } }>(
    '/v1/agente/decisoes', { preHandler: exigirTenant },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const conversaId = req.query.conversaId && UUID.test(req.query.conversaId) ? req.query.conversaId : null
      const canalId = req.query.canalId && UUID.test(req.query.canalId) ? req.query.canalId : null
      const linhas = await req.comTenant((tx) => tx<{
        id: string; conversa_id: string; canal_id: string; contato: string | null; modo: string; desfecho: string
        portao_motivo: string | null; modelo: string | null; ferramentas: unknown[]; resposta: unknown; confianca: string | null
        handoff_motivo: string | null; numeros_bloqueados: unknown[]; uso: unknown; custo_centavos: string; latencia_ms: number | null
        rodadas: number; enviada: boolean; erro: string | null; criado_em: Date
      }[]>`
        SELECT d.id, d.conversa_id, d.canal_id, ct.nome AS contato, d.modo, d.desfecho, d.portao_motivo, d.modelo,
               d.ferramentas, d.resposta, d.confianca, d.handoff_motivo, d.numeros_bloqueados, d.uso, d.custo_centavos,
               d.latencia_ms, d.rodadas, d.enviada, d.erro, d.criado_em
          FROM agente_decisao d
          JOIN conversa cv ON cv.tenant_id = d.tenant_id AND cv.id = d.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE d.tenant_id = tenant_atual()
           AND ${conversaId ? tx`d.conversa_id = ${conversaId}` : tx`true`}
           AND ${canalId ? tx`d.canal_id = ${canalId}` : tx`true`}
           AND ${curEm === null ? tx`true` : tx`(d.criado_em, d.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY d.criado_em DESC, d.id DESC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, conversaId: l.conversa_id, canalId: l.canal_id, contato: l.contato, modo: l.modo, desfecho: l.desfecho,
          portaoMotivo: l.portao_motivo, modelo: l.modelo, ferramentas: l.ferramentas, resposta: l.resposta,
          confianca: l.confianca === null ? null : Number(l.confianca), handoffMotivo: l.handoff_motivo,
          numerosBloqueados: l.numeros_bloqueados, uso: l.uso, custoCentavos: Number(l.custo_centavos),
          latenciaMs: l.latencia_ms, rodadas: l.rodadas, enviada: l.enviada, erro: l.erro, criadoEm: l.criado_em,
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  /**
   * PLAYGROUND: conversa com o agente REAL (ferramentas, catálogo, políticas do
   * canal) numa conversa de simulação — nunca envia WhatsApp, nunca cria
   * atendimento, grava decisão com modo 'simulacao'.
   *
   * ⚠️ É assim que o dono testa antes de ligar: "o que ele diria se o cliente
   * perguntasse X?" com o catálogo de verdade e o custo de verdade medido.
   */
  app.post<{ Params: { id: string }; Body: { mensagem?: string; conversaId?: string } }>(
    '/v1/canais/:id/agente/simular', { preHandler: exigirTenant },
    async (req, reply) => {
      const canalId = req.params.id
      const texto = req.body?.mensagem?.trim() ?? ''
      if (!texto) return reply.code(422).send({ erro: 'agente.mensagem_vazia', mensagem: 'Escreva a mensagem do cliente.' })
      if (texto.length > 2000) return reply.code(422).send({ erro: 'agente.mensagem_longa', mensagem: 'Até 2000 caracteres.' })
      const pedida = req.body?.conversaId && UUID.test(req.body.conversaId) ? req.body.conversaId : null

      const preparo = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
        if (!canal) return null
        const [cfg] = await tx<{ modo: string }[]>`SELECT modo FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
        if (!cfg) return { semConfig: true as const }
        // O contato de simulação do canal: um só, reaproveitado.
        const chave = `sim:${canalId}`
        const [existente] = await tx<{ contato_id: string }[]>`
          SELECT ie.contato_id FROM contato_identidade_externa ie
           WHERE ie.tenant_id = tenant_atual() AND ie.sistema = 'simulacao' AND ie.id_externo = ${chave}`
        let contatoId = existente?.contato_id
        if (!contatoId) {
          contatoId = randomUUID()
          await tx`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, recebe_campanhas, recebe_automacoes)
                   VALUES (tenant_atual(), ${contatoId}, 'Cliente de simulação', 'simulacao', true, false, false)`
          await tx`INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo)
                   VALUES (tenant_atual(), ${contatoId}, 'simulacao', ${chave})`
        }
        let conversaId = pedida
        if (conversaId) {
          const [c] = await tx<{ id: string }[]>`
            SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId} AND contato_id = ${contatoId} AND canal_id = ${canalId}`
          if (!c) conversaId = null
        }
        if (!conversaId) {
          const [c] = await tx<{ id: string }[]>`
            SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND contato_id = ${contatoId}`
          conversaId = c?.id ?? null
          if (!conversaId) {
            conversaId = randomUUID()
            await tx`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_entrante_em)
                     VALUES (tenant_atual(), ${conversaId}, ${canalId}, ${contatoId}, 1, now())`
          }
        }
        const mensagemId = randomUUID()
        await tx`
          INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
          VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'entrante', 'texto', ${JSON.stringify({ texto, simulacao: true })}::text::jsonb, now())`
        await tx`UPDATE conversa SET ultima_entrante_em = now(), ultima_mensagem_em = now(), ultima_direcao = 'entrante' WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
        return { semConfig: false as const, conversaId, mensagemId, contatoId }
      })
      if (!preparo) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      if (preparo.semConfig) return reply.code(422).send({ erro: 'agente.sem_configuracao', mensagem: 'Salve a configuração do agente antes de simular.' })

      const r = await conduzirTurnoVendedor(
        { tenant_id: req.tenantId!, id: randomUUID(), conversa_id: preparo.conversaId, canal_id: canalId, mensagens_ids: [preparo.mensagemId], tentativas: 1, executar_em: new Date() },
        { ligacoes: ligacoesPadrao, simulacao: true },
      )
      // As mensagens do agente entram na conversa de simulação para o próximo turno ter contexto.
      if (r.mensagens?.length) {
        await comTenantServico(req.tenantId!, async (tx) => {
          for (const m of r.mensagens!) {
            await tx`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
                     VALUES (tenant_atual(), ${randomUUID()}, ${preparo.conversaId}, 'saliente', 'texto',
                             ${JSON.stringify({ texto: m, automatica: 'agente', simulacao: true })}::text::jsonb, 'enviada', now())`
          }
        })
      }
      return reply.send({
        conversaId: preparo.conversaId,
        desfecho: r.desfecho,
        mensagens: r.mensagens ?? [],
        handoff: r.handoff ?? null,
        motivo: r.motivo ?? null,
        detalhe: r.detalhe ?? null,
        decisaoId: r.decisaoId ?? null,
        rastro: r.rastro ? { chamadas: r.rastro.chamadas, rodadas: r.rastro.rodadas, uso: r.rastro.uso, modelo: r.rastro.modelo, latenciaMs: r.rastro.latenciaMs } : null,
      })
    },
  )

  /** Zera a conversa de simulação do canal (mensagens, sessão e decisões dela). */
  app.delete<{ Params: { id: string } }>(
    '/v1/canais/:id/agente/simular', { preHandler: exigirTenant },
    async (req, reply) => {
      const apagadas = await req.comTenant(async (tx) => {
        const [c] = await tx<{ id: string }[]>`
          SELECT cv.id FROM conversa cv
            JOIN contato_identidade_externa ie ON ie.tenant_id = cv.tenant_id AND ie.contato_id = cv.contato_id
           WHERE cv.tenant_id = tenant_atual() AND cv.canal_id = ${req.params.id}
             AND ie.sistema = 'simulacao' AND ie.id_externo = ${`sim:${req.params.id}`}`
        if (!c) return 0
        await tx`DELETE FROM agente_decisao WHERE tenant_id = tenant_atual() AND conversa_id = ${c.id}`
        await tx`DELETE FROM agente_sessao WHERE tenant_id = tenant_atual() AND conversa_id = ${c.id}`
        await tx`DELETE FROM pedido WHERE tenant_id = tenant_atual() AND conversa_id = ${c.id}`
        const r = await tx`DELETE FROM mensagem WHERE tenant_id = tenant_atual() AND conversa_id = ${c.id}`
        return r.count
      })
      return reply.send({ ok: true, mensagensApagadas: apagadas })
    },
  )

  /**
   * MÉTRICAS do agente (§6 do plano): o que diz se ele ajuda ou atrapalha.
   * Janela em dias (padrão 7, máx. 90), por canal opcional. Agregados do
   * banco — nunca uma lista crua.
   */
  app.get<{ Querystring: { dias?: string; canalId?: string } }>(
    '/v1/agente/metricas', { preHandler: exigirTenant },
    async (req, reply) => {
      const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90)
      const canalId = req.query.canalId && UUID.test(req.query.canalId) ? req.query.canalId : null
      const m = await req.comTenant(async (tx) => {
        const filtroCanal = canalId ? tx`AND d.canal_id = ${canalId}` : tx``
        const [d] = await tx<{
          turnos: number; respondidos: number; sugeridos: number; handoffs: number; falhas: number; superadas: number
          conversas: number; custo_centavos: string; latencia_p95_ms: number | null; numeros_bloqueados: number
          cache_leitura: string; entrada: string
        }[]>`
          SELECT count(*)::int AS turnos,
                 count(*) FILTER (WHERE d.desfecho = 'respondeu')::int AS respondidos,
                 count(*) FILTER (WHERE d.desfecho = 'sugeriu')::int AS sugeridos,
                 count(*) FILTER (WHERE d.desfecho = 'handoff')::int AS handoffs,
                 count(*) FILTER (WHERE d.desfecho = 'falha')::int AS falhas,
                 count(*) FILTER (WHERE d.desfecho = 'superada')::int AS superadas,
                 count(DISTINCT d.conversa_id)::int AS conversas,
                 coalesce(sum(d.custo_centavos), 0)::text AS custo_centavos,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY d.latencia_ms)::int AS latencia_p95_ms,
                 count(*) FILTER (WHERE jsonb_array_length(d.numeros_bloqueados) > 0)::int AS numeros_bloqueados,
                 coalesce(sum((d.uso->>'cacheLeitura')::bigint), 0)::text AS cache_leitura,
                 coalesce(sum((d.uso->>'entrada')::bigint), 0)::text AS entrada
            FROM agente_decisao d
           WHERE d.tenant_id = tenant_atual() AND d.modo <> 'simulacao'
             AND d.criado_em >= now() - make_interval(days => ${dias}) ${filtroCanal}`
        const handoffPorMotivo = await tx<{ motivo: string; n: number }[]>`
          SELECT coalesce(d.handoff_motivo, 'sem_motivo') AS motivo, count(*)::int AS n
            FROM agente_decisao d
           WHERE d.tenant_id = tenant_atual() AND d.modo <> 'simulacao' AND d.desfecho = 'handoff'
             AND d.criado_em >= now() - make_interval(days => ${dias}) ${filtroCanal}
           GROUP BY 1 ORDER BY 2 DESC`
        const [p] = await tx<{ propostos: number; confirmados: number; efetivados: number; valor_efetivado: string }[]>`
          SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pedido_proposta pp WHERE pp.tenant_id = pe.tenant_id AND pp.pedido_id = pe.id))::int AS propostos,
                 count(*) FILTER (WHERE pe.confirmado_em IS NOT NULL)::int AS confirmados,
                 count(*) FILTER (WHERE pe.estado = 'efetivado')::int AS efetivados,
                 coalesce(sum(pe.total_centavos) FILTER (WHERE pe.estado = 'efetivado'), 0)::text AS valor_efetivado
            FROM pedido pe
           WHERE pe.tenant_id = tenant_atual() AND pe.origem = 'agente'
             AND pe.criado_em >= now() - make_interval(days => ${dias})
             ${canalId ? tx`AND EXISTS (SELECT 1 FROM conversa c WHERE c.tenant_id = pe.tenant_id AND c.id = pe.conversa_id AND c.canal_id = ${canalId})` : tx``}`
        const [h] = await tx<{ corrigidas: number }[]>`
          -- "Corrigidas por humano": conversas em que o agente falou e, depois, uma pessoa assumiu.
          SELECT count(DISTINCT d.conversa_id)::int AS corrigidas
            FROM agente_decisao d
            JOIN atendimento a ON a.tenant_id = d.tenant_id AND a.conversa_id = d.conversa_id
                              AND a.atendente_id IS NOT NULL AND a.assumido_em > d.criado_em
           WHERE d.tenant_id = tenant_atual() AND d.enviada
             AND d.criado_em >= now() - make_interval(days => ${dias}) ${filtroCanal}`
        return { d: d!, handoffPorMotivo, p: p!, corrigidas: h?.corrigidas ?? 0 }
      })
      const entrada = Number(m.d.entrada), cache = Number(m.d.cache_leitura)
      return reply.send({
        dias, canalId,
        turnos: m.d.turnos, respondidos: m.d.respondidos, sugeridos: m.d.sugeridos, handoffs: m.d.handoffs,
        falhas: m.d.falhas, superadas: m.d.superadas, conversas: m.d.conversas,
        custoCentavos: Number(m.d.custo_centavos),
        custoPorConversaCentavos: m.d.conversas ? Math.round(Number(m.d.custo_centavos) / m.d.conversas) : 0,
        latenciaP95Ms: m.d.latencia_p95_ms,
        turnosComNumeroBloqueado: m.d.numeros_bloqueados,
        taxaCache: entrada + cache > 0 ? Number((cache / (entrada + cache)).toFixed(3)) : null,
        handoffPorMotivo: m.handoffPorMotivo,
        pedidos: { propostos: m.p.propostos, confirmados: m.p.confirmados, efetivados: m.p.efetivados, valorEfetivadoCentavos: Number(m.p.valor_efetivado) },
        conversasCorrigidasPorHumano: m.corrigidas,
      })
    },
  )
}
