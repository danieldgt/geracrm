import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  JANELA_CAMPANHA_PADRAO, LIMITE_TESTE_NUMERO_HORA, LIMITE_TESTE_USUARIO_HORA, LOTE_DIARIO_MAXIMO, LOTE_DIARIO_PADRAO,
  limitarJanelaMarketing, validarJanelaCampanha, MAX_TELEFONES_TESTE, acaoPermitida, confirmacaoDoNomeConfere,
  custoCampanhaCentavos, duracaoDias, ehEstadoCampanha, ehEstadoDestinatario, type EstadoCampanha,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { auditar } from '../plataforma/auditoria.js'
import { condicaoContato, escopoDaRequisicao } from '../plataforma/escopo.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { statusAquecimento } from '../atendimento/aquecimento.js'
import { ehCategoria, precosEfetivos } from '../atendimento/consumo.js'
import { enviarTesteCampanha } from '../atendimento/envio-campanha.js'
import type { criarCanal } from '../atendimento/canais/fabrica.js'
import { audienciaDoSegmento, roiCampanha } from './campanha-analise.js'
import { validarConteudo, type ErroConteudo } from './campanha-conteudo.js'
import { lerPublico, materializarFatia, previaDoPublico, publicoGravado } from './campanha-publico.js'
import { pausarCampanha, resolverAlertaSeNenhumaPausada } from './campanha-destinatario.js'
import { relatorioCampanha } from './campanha-relatorio.js'

const PAGINA = 30
const PAGINA_DESTINATARIOS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * CAMPANHAS — o legado (Onda 3: segmento RFV + texto livre + ROI) e a V2 (F1: template
 * obrigatório no oficial, público composto com exclusões, prévia de custo, lote diário na
 * janela, teste, iniciar digitando o nome, pausa automática, destinatários e relatório).
 *
 * ── PAPÉIS ────────────────────────────────────────────────────────────────────
 *   Criar, editar, excluir, testar, iniciar, pausar, retomar, cancelar: admin/gestor.
 *   Ler (lista, detalhe, prévia, destinatários, relatório, ROI): gestão (admin, gestor,
 *   supervisor). Destinatários ficam no ESCOPO de quem lê (D3).
 *
 * ── LEGADO × V2 ───────────────────────────────────────────────────────────────
 *   `POST /v1/campanhas` sem `canalId` e sem `publico` = criação LEGADA (a tela atual):
 *   `disparar` + despacho antigo + ROI de sempre. Com `canalId`/`publico` = V2, que só
 *   anda por `iniciar`. As antigas continuam exatamente como estavam.
 *
 * ⚠️ O tenant vem SEMPRE do token (tenant_atual()), nunca do corpo (ADR-001).
 * ⚠️ Nada aqui envia em massa: `iniciar` materializa e agenda; quem envia é o
 *    despachante, pelo gateway único. Só o TESTE (≤ 5 números) sai na hora.
 */

export interface OpcoesRotasCampanha {
  /** Fábrica de adaptador para o envio de teste (o teste injeta; produção usa a real). */
  readonly criarCanal?: typeof criarCanal
  /** Relógio injetável (teste). */
  readonly agora?: () => Date
  /** Teste: chamado depois de cada fatia do snapshot no iniciar (simula edição concorrente). */
  readonly aoMaterializarFatia?: () => Promise<void>
}

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

const GESTAO = [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor', 'supervisor')]
const GESTOR = [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor')]

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/
const faixa = z.object({ de: z.string().regex(HORA), ate: z.string().regex(HORA) }).strict().nullable()
const esquemaJanela = z.object({
  seg: faixa.optional(), ter: faixa.optional(), qua: faixa.optional(), qui: faixa.optional(),
  sex: faixa.optional(), sab: faixa.optional(), dom: faixa.optional(),
}).strict()

const esquemaV2 = z.object({
  nome: z.string().trim().min(1).max(120),
  canalId: z.string().regex(UUID),
  templateId: z.string().regex(UUID).nullable().optional(),
  mensagem: z.string().trim().min(1).max(4096).nullable().optional(),
  confirmaRiscoBanimento: z.boolean().optional(),
  publico: z.unknown().optional(),
  loteDiario: z.number().int().min(1).max(LOTE_DIARIO_MAXIMO).optional(),
  inicioEm: z.string().datetime({ offset: true }).nullable().optional(),
  janela: esquemaJanela.nullable().optional(),
  janelaDias: z.number().int().min(1).max(90).optional(),
}).strict()

type CorpoV2 = z.infer<typeof esquemaV2>

function invalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const campos = Object.fromEntries(e.issues.map((i) => [i.path.join('.') || 'corpo', i.message]))
  return reply.code(422).send({ erro: 'campanha.invalida', mensagem: 'Confira os campos destacados.', campos })
}

const erroConteudo = (reply: FastifyReply, e: ErroConteudo) => reply.code(422).send(e)

/** Janela da campanha: ao menos um dia aberto e dentro de 08:00–21:00. `null` = ok. */
function erroJanela(reply: FastifyReply, janela: CorpoV2['janela']): FastifyReply | null {
  if (!janela) return null
  const v = validarJanelaCampanha(janela)
  if (v === 'vazia') {
    return reply.code(422).send({ erro: 'campanha.janela_vazia', mensagem: 'Abra ao menos um dia na janela de envio.', campos: { janela: 'Nenhum dia aberto.' } })
  }
  if (v === 'fora_do_permitido') {
    return reply.code(422).send({ erro: 'campanha.janela_fora_do_permitido', mensagem: 'Campanha de marketing só sai entre 08:00 e 21:00, sem virar a meia-noite.', campos: { janela: 'Use horários entre 08:00 e 21:00.' } })
  }
  return null
}

const naoEncontrada = (reply: FastifyReply) => reply.code(404).send({ erro: 'campanha.nao_encontrada' })

const estadoInvalido = (reply: FastifyReply, estado: string, acao: string) =>
  reply.code(409).send({ erro: 'campanha.estado_invalido', mensagem: `Campanha ${estado} não permite ${acao}.`, estado })

interface LinhaCampanha {
  id: string; nome: string; segmento_alvo: string; estado: EstadoCampanha; modelo_versao: number
  janela_atribuicao_dias: number; disparada_em: Date | null; criado_em: Date
  canal_id: string | null; canal_nome: string | null; canal_tipo: string | null
  template_id: string | null; template_nome: string | null; template_categoria: string | null
  mensagem: string | null; publico: unknown; lote_diario: number | null; inicio_em: Date | null
  janela: unknown; pausa_motivo: string | null; pausada_em: Date | null; confirma_risco_banimento: boolean
  iniciada_em: Date | null; iniciada_por: string | null; concluida_em: Date | null; atualizado_em: Date | null
  suspensa_desde: Date | null; suspensa_motivo: string | null; bloqueio_motivo: string | null
}

function selecionarCampanhas(tx: Sql) {
  return tx`
    SELECT k.id, k.nome, k.segmento_alvo, k.estado, k.modelo_versao, k.janela_atribuicao_dias, k.disparada_em, k.criado_em,
           k.canal_id, cc.nome_amigavel AS canal_nome, cc.tipo AS canal_tipo,
           k.template_id, t.nome AS template_nome, t.categoria AS template_categoria,
           k.mensagem, k.publico, k.lote_diario, k.inicio_em, k.janela, k.pausa_motivo, k.pausada_em,
           k.confirma_risco_banimento, k.iniciada_em, k.iniciada_por, k.concluida_em, k.atualizado_em,
           -- Número com ATIVAS suspensas pela Meta (P11): o despachante segura a
           -- campanha em curso; a tela precisa dizer por quê (P0c-m).
           CASE WHEN k.estado IN ('disparando', 'enviando', 'agendada') THEN cc.ativas_suspensas_em END AS suspensa_desde,
           CASE WHEN k.estado IN ('disparando', 'enviando', 'agendada') THEN cc.ativas_suspensas_motivo END AS suspensa_motivo,
           -- Campanha em curso parada porque o NÚMERO não pode enviar: a tela diz o quê.
           CASE WHEN k.modelo_versao = 2 AND k.estado IN ('enviando', 'agendada') THEN
             CASE WHEN cc.id IS NULL THEN 'sem_numero'
                  WHEN cc.arquivado_em IS NOT NULL THEN 'numero_arquivado'
                  WHEN cc.estado IN ('desconectado', 'suspenso') THEN 'numero_desconectado'
                  WHEN cc.credenciais_cifradas IS NULL THEN 'numero_sem_credencial'
                  WHEN coalesce(cfg.disparo_pausado, false) THEN 'disparo_pausado'
             END END AS bloqueio_motivo
      FROM campanha k
      LEFT JOIN canal_conectado cc ON cc.tenant_id = k.tenant_id AND cc.id = k.canal_id
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = k.tenant_id AND cfg.canal_id = k.canal_id
      LEFT JOIN template t ON t.tenant_id = k.tenant_id AND t.id = k.template_id`
}

function resumo(l: LinhaCampanha) {
  return {
    id: l.id, nome: l.nome, segmentoAlvo: l.segmento_alvo, estado: l.estado, modeloVersao: l.modelo_versao,
    janelaDias: l.janela_atribuicao_dias, disparadaEm: l.disparada_em, criadoEm: l.criado_em,
    canal: l.canal_id ? { id: l.canal_id, nome: l.canal_nome, tipo: l.canal_tipo } : null,
    template: l.template_id ? { id: l.template_id, nome: l.template_nome, categoria: l.template_categoria } : null,
    loteDiario: l.lote_diario, inicioEm: l.inicio_em, pausaMotivo: l.pausa_motivo, pausadaEm: l.pausada_em,
    iniciadaEm: l.iniciada_em, concluidaEm: l.concluida_em,
    pausadaPorQualidade: l.suspensa_desde ? { desde: l.suspensa_desde, motivo: l.suspensa_motivo } : null,
    bloqueio: l.bloqueio_motivo ? { motivo: l.bloqueio_motivo } : null,
  }
}

function acoes(estado: EstadoCampanha, modelo: number) {
  if (modelo !== 2) return { editar: false, excluir: false, iniciar: false, pausar: false, retomar: false, cancelar: false, testar: false }
  return {
    editar: acaoPermitida(estado, 'editar'), excluir: acaoPermitida(estado, 'excluir'), iniciar: acaoPermitida(estado, 'iniciar'),
    pausar: acaoPermitida(estado, 'pausar'), retomar: acaoPermitida(estado, 'retomar'), cancelar: acaoPermitida(estado, 'cancelar'),
    testar: acaoPermitida(estado, 'testar'),
  }
}

/** Preço por mensagem da campanha: categoria do template no oficial (F2); não oficial não paga a Meta. */
async function precoDaCampanha(tx: Sql, tipoCanal: string, categoriaTemplate: string | null): Promise<number> {
  if (tipoCanal !== 'whatsapp_oficial') return 0
  const cat = (categoriaTemplate ?? 'MARKETING').toLowerCase()
  if (!ehCategoria(cat)) return 0
  const linhas = await tx<{ categoria: string; centavos: number }[]>`
    SELECT categoria, centavos_por_mensagem AS centavos FROM preco_whatsapp WHERE tenant_id = tenant_atual()`
  return precosEfetivos(linhas)[cat]
}

/**
 * A janela que vale para o envio: a da campanha; senão o expediente do número; senão a
 * padrão de campanha (8h–20h, seg–sáb). A tela mostra isto no passo de Envio.
 */
async function janelaEfetiva(tx: Sql, canalId: string | null, daCampanha: unknown) {
  if (daCampanha && typeof daCampanha === 'object' && Object.keys(daCampanha).length > 0) {
    return { origem: 'campanha' as const, horario: daCampanha, ajustada: false }
  }
  const [cfg] = canalId
    ? await tx<{ horario: Record<string, { de: string; ate: string } | null> | null }[]>`
        SELECT horario_atendimento AS horario FROM canal_configuracao WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
    : []
  if (cfg?.horario && Object.keys(cfg.horario).length > 0) {
    // Marketing só de 08:00 às 21:00: o expediente do número é RECORTADO a isso.
    // `ajustada` = o recorte mudou algo (a tela avisa).
    const { horario, ajustada } = limitarJanelaMarketing(cfg.horario)
    return { origem: 'canal' as const, horario, ajustada }
  }
  return { origem: 'padrao' as const, horario: JANELA_CAMPANHA_PADRAO, ajustada: false }
}

export async function rotasCampanha(app: FastifyInstance, opcoes: OpcoesRotasCampanha = {}): Promise<void> {
  const agora = (): Date => opcoes.agora?.() ?? new Date()

  // ─────────────────────────────── lista ───────────────────────────────
  app.get<{ Querystring: { cursor?: string; estado?: string } }>(
    '/v1/campanhas', { preHandler: GESTAO },
    async (req, reply) => {
      let curEm: string | null = null, curId: string | null = null
      if (req.query.cursor) {
        const [em, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('§')
        if (!em || !id || !UUID.test(id) || Number.isNaN(Date.parse(em))) return reply.code(422).send({ erro: 'cursor.invalido' })
        curEm = em; curId = id
      }
      const estado = req.query.estado
      if (estado !== undefined && !ehEstadoCampanha(estado)) {
        return reply.code(422).send({ erro: 'campanha.invalida', campos: { estado: 'Estado inválido.' } })
      }
      const linhas = await req.comTenant((tx) => tx<LinhaCampanha[]>`
        ${selecionarCampanhas(tx)}
         WHERE k.tenant_id = tenant_atual()
           AND ${estado === undefined ? tx`true` : tx`k.estado = ${estado}`}
           AND ${curEm === null ? tx`true` : tx`(k.criado_em, k.id) < (${curEm}::timestamptz, ${curId}::uuid)`}
         ORDER BY k.criado_em DESC, k.id DESC LIMIT ${PAGINA + 1}`)
      const temMais = linhas.length > PAGINA
      const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map(resumo),
        proximoCursor: temMais && ultimo
          ? Buffer.from(`${ultimo.criado_em.toISOString()}§${ultimo.id}`).toString('base64url') : null,
      })
    },
  )

  // ─────────────────────────────── prévia ──────────────────────────────
  /**
   * Prévia do público e do custo — antes de criar ou de iniciar. Nada é gravado.
   * `canalId` decide o preço (oficial: categoria do template; não oficial: 0) e o teto de
   * aquecimento; `loteDiario` decide a duração.
   */
  app.post<{ Body: { canalId?: unknown; templateId?: unknown; publico?: unknown; loteDiario?: unknown } }>(
    '/v1/campanhas/previa', { preHandler: GESTAO },
    async (req, reply) => {
      const corpo = z.object({
        canalId: z.string().regex(UUID),
        templateId: z.string().regex(UUID).nullable().optional(),
        publico: z.unknown().optional(),
        loteDiario: z.number().int().min(1).max(LOTE_DIARIO_MAXIMO).optional(),
      }).strict().safeParse(req.body ?? {})
      if (!corpo.success) return invalido(reply, corpo.error)
      const pub = lerPublico(corpo.data.publico)
      if (!pub.ok) return reply.code(422).send({ erro: 'campanha.publico_invalido', mensagem: 'Público inválido.', campos: Object.fromEntries(pub.campos.map((c) => [c, 'Inválido.'])) })
      const instante = agora()
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ tipo: string }[]>`
          SELECT tipo FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${corpo.data.canalId} AND arquivado_em IS NULL`
        if (!canal) return null
        let categoria: string | null = null
        if (corpo.data.templateId) {
          const [t] = await tx<{ categoria: string }[]>`SELECT categoria FROM template WHERE tenant_id = tenant_atual() AND id = ${corpo.data.templateId}`
          categoria = t?.categoria ?? null
        }
        const escopo = await escopoDaRequisicao(tx, req)
        const previa = await previaDoPublico(tx, pub.publico, escopo, instante)
        const preco = await precoDaCampanha(tx, canal.tipo, categoria)
        const aq = await statusAquecimento(tx, corpo.data.canalId, instante)
        const janela = await janelaEfetiva(tx, corpo.data.canalId, null)
        return { previa, preco, canal, aq, janela }
      })
      if (!r) return reply.code(422).send({ erro: 'campanha.canal_invalido', mensagem: 'Número não encontrado.', campos: { canalId: 'Número inválido.' } })
      const lote = corpo.data.loteDiario ?? LOTE_DIARIO_PADRAO
      // No não oficial em aquecimento, o teto do número segura o ritmo antes do lote.
      const ritmo = r.aq.emAquecimento ? Math.min(lote, r.aq.limiteHoje) : lote
      return reply.send({
        ...r.previa,
        custoEstimadoCentavos: custoCampanhaCentavos(r.previa.elegiveis, r.preco),
        precoUnitarioCentavos: r.preco,
        loteDiario: lote,
        duracaoDias: duracaoDias(r.previa.elegiveis, ritmo),
        aquecimento: r.aq.emAquecimento ? { dia: r.aq.dia, limiteHoje: r.aq.limiteHoje, restanteHoje: r.aq.restante } : null,
        janelaDoNumero: r.janela,
      })
    },
  )

  // ─────────────────────────────── criar ───────────────────────────────
  app.post<{ Body: Record<string, unknown> | undefined }>(
    '/v1/campanhas', { preHandler: GESTOR },
    async (req, reply) => {
      const b = req.body ?? {}
      // LEGADO: a tela atual (nome + segmento + texto + janela). Some quando o wizard (F1b) entrar.
      if (b['canalId'] === undefined && b['publico'] === undefined && b['templateId'] === undefined) {
        const nome = typeof b['nome'] === 'string' ? b['nome'].trim() : ''
        const mensagem = typeof b['mensagem'] === 'string' ? b['mensagem'].trim() : ''
        if (!nome || !mensagem) return reply.code(422).send({ erro: 'campanha.invalida', mensagem: 'Nome e mensagem são obrigatórios.' })
        const janela = Math.min(Math.max(Number(b['janelaDias']) || 7, 1), 90)
        const segmento = typeof b['segmentoAlvo'] === 'string' ? b['segmentoAlvo'] : 'todos'
        const id = randomUUID()
        await req.comTenant((tx) => tx`
          INSERT INTO campanha (tenant_id, id, nome, segmento_alvo, mensagem, janela_atribuicao_dias)
          VALUES (tenant_atual(), ${id}, ${nome}, ${segmento}, ${mensagem}, ${janela})`)
        return reply.code(201).send({ id })
      }

      const p = esquemaV2.safeParse(b)
      if (!p.success) return invalido(reply, p.error)
      const ej = erroJanela(reply, p.data.janela)
      if (ej) return ej
      const pub = lerPublico(p.data.publico)
      if (!pub.ok) return reply.code(422).send({ erro: 'campanha.publico_invalido', mensagem: 'Público inválido.', campos: Object.fromEntries(pub.campos.map((c) => [c, 'Inválido.'])) })
      const id = randomUUID()
      const r = await req.comTenant(async (tx) => {
        const v = await validarConteudo(tx, conteudoDoCorpo(p.data))
        if (!v.ok) return v
        const usuarioId = await garantirUsuarioId(tx, req)
        await tx`
          INSERT INTO campanha (tenant_id, id, nome, segmento_alvo, canal_id, template_id, mensagem, janela_atribuicao_dias,
                                modelo_versao, publico, lote_diario, inicio_em, janela, confirma_risco_banimento,
                                criado_por, atualizado_em)
          VALUES (tenant_atual(), ${id}, ${p.data.nome}, 'publico', ${p.data.canalId}, ${v.template?.id ?? null},
                  ${v.template ? null : (p.data.mensagem ?? null)}, ${p.data.janelaDias ?? 7},
                  2, ${JSON.stringify(pub.publico)}::text::jsonb, ${p.data.loteDiario ?? LOTE_DIARIO_PADRAO},
                  ${p.data.inicioEm ?? null}, ${p.data.janela ? JSON.stringify(p.data.janela) : null}::text::jsonb,
                  ${v.template ? false : p.data.confirmaRiscoBanimento === true}, ${usuarioId}, now())`
        await auditar(tx, { atorId: usuarioId, atorStaff: req.atorStaff ?? false, acao: 'campanha.criada', entidade: 'campanha', entidadeId: id,
          dados: { canalId: p.data.canalId, templateId: v.template?.id ?? null, riscoBanimentoConfirmado: !v.template } })
        return { ok: true as const }
      })
      if (!r.ok) return erroConteudo(reply, r.e)
      return reply.code(201).send({ id })
    },
  )

  // ─────────────────────────────── detalhe ─────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id', { preHandler: GESTAO },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const r = await req.comTenant(async (tx) => {
        const [l] = await tx<LinhaCampanha[]>`${selecionarCampanhas(tx)} WHERE k.tenant_id = tenant_atual() AND k.id = ${req.params.id}`
        if (!l) return null
        const cont = await tx<{ estado: string; n: number }[]>`
          SELECT estado, count(*)::int AS n FROM campanha_destinatario
           WHERE tenant_id = tenant_atual() AND campanha_id = ${req.params.id} GROUP BY estado`
        return { l, cont, janela: await janelaEfetiva(tx, l.canal_id, l.janela) }
      })
      if (!r) return naoEncontrada(reply)
      const { l } = r
      return reply.send({
        ...resumo(l),
        mensagem: l.mensagem, publico: l.publico, janela: l.janela, janelaEfetiva: r.janela,
        confirmaRiscoBanimento: l.confirma_risco_banimento, iniciadaPor: l.iniciada_por, atualizadoEm: l.atualizado_em,
        destinatarios: Object.fromEntries(r.cont.map((c) => [c.estado, c.n])),
        acoes: acoes(l.estado, l.modelo_versao),
      })
    },
  )

  // ─────────────────────────────── editar ──────────────────────────────
  app.put<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>(
    '/v1/campanhas/:id', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const p = esquemaV2.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const ej = erroJanela(reply, p.data.janela)
      if (ej) return ej
      const pub = lerPublico(p.data.publico)
      if (!pub.ok) return reply.code(422).send({ erro: 'campanha.publico_invalido', mensagem: 'Público inválido.', campos: Object.fromEntries(pub.campos.map((c) => [c, 'Inválido.'])) })
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha; modelo_versao: number }[]>`
          SELECT estado, modelo_versao FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'editar')) return { e: 'estado' as const, estado: k.estado }
        const v = await validarConteudo(tx, conteudoDoCorpo(p.data))
        if (!v.ok) return { e: 'conteudo' as const, erro: v.e }
        await tx`
          UPDATE campanha SET nome = ${p.data.nome}, canal_id = ${p.data.canalId}, template_id = ${v.template?.id ?? null},
                 mensagem = ${v.template ? null : (p.data.mensagem ?? null)}, janela_atribuicao_dias = ${p.data.janelaDias ?? 7},
                 publico = ${JSON.stringify(pub.publico)}::text::jsonb, lote_diario = ${p.data.loteDiario ?? LOTE_DIARIO_PADRAO},
                 inicio_em = ${p.data.inicioEm ?? null}, janela = ${p.data.janela ? JSON.stringify(p.data.janela) : null}::text::jsonb,
                 confirma_risco_banimento = ${v.template ? false : p.data.confirmaRiscoBanimento === true}, atualizado_em = now()
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        // Um iniciar interrompido pode ter deixado fatias do público ANTIGO: o snapshot é do público novo.
        await tx`DELETE FROM campanha_destinatario WHERE tenant_id = tenant_atual() AND campanha_id = ${req.params.id}`
        await auditar(tx, { atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'campanha.editada', entidade: 'campanha', entidadeId: req.params.id })
        return { e: null }
      })
      if (r.e === 'nao_encontrada') return naoEncontrada(reply)
      if (r.e === 'estado') return estadoInvalido(reply, r.estado, 'edição')
      if (r.e === 'conteudo') return erroConteudo(reply, r.erro)
      return reply.send({ ok: true })
    },
  )

  // ─────────────────────────────── excluir ─────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/campanhas/:id', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha }[]>`
          SELECT estado FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!k) return 'nao_encontrada' as const
        if (k.estado !== 'rascunho') return k.estado
        await tx`DELETE FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        await auditar(tx, { atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'campanha.excluida', entidade: 'campanha', entidadeId: req.params.id })
        return 'ok' as const
      })
      if (r === 'nao_encontrada') return naoEncontrada(reply)
      if (r !== 'ok') return estadoInvalido(reply, r, 'exclusão (só rascunho)')
      return reply.code(204).send()
    },
  )

  // ─────────────────────────────── teste ───────────────────────────────
  /**
   * Envia JÁ o conteúdo a até 5 números: fora do lote, sem destinatário de campanha, sem
   * entrar no relatório. ⚠️ Opt-out vale igual (número bloqueado não recebe nem teste).
   */
  app.post<{ Params: { id: string }; Body: { telefones?: unknown } }>(
    '/v1/campanhas/:id/teste', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const corpo = z.object({ telefones: z.array(z.string().trim().min(8).max(20)).min(1).max(MAX_TELEFONES_TESTE) }).strict()
        .safeParse(req.body ?? {})
      if (!corpo.success) {
        return reply.code(422).send({ erro: 'campanha.teste_invalido', mensagem: `Informe de 1 a ${MAX_TELEFONES_TESTE} telefones.`, campos: { telefones: 'De 1 a 5 telefones.' } })
      }
      const tenantId = req.tenantId!
      const prep = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha; modelo_versao: number; canal_id: string | null; template_id: string | null; mensagem: string | null; confirma: boolean }[]>`
          SELECT estado, modelo_versao, canal_id, template_id, mensagem, confirma_risco_banimento AS confirma
            FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'testar')) return { e: 'estado' as const, estado: k.estado }
        const v = await validarConteudo(tx, { canalId: k.canal_id, templateId: k.template_id, mensagem: k.mensagem, confirmaRiscoBanimento: k.confirma })
        if (!v.ok) return { e: 'conteudo' as const, erro: v.e }
        const usuarioId = await garantirUsuarioId(tx, req)
        const quantos = corpo.data.telefones.length
        // ⚠️ Teste repetido vira disparo disfarçado: teto por usuário e por número, na última hora.
        const [uso] = await tx<{ usuario: number; numero: number }[]>`
          SELECT coalesce(sum((dados->>'quantos')::int) FILTER (WHERE ator_id = ${usuarioId}), 0)::int AS usuario,
                 coalesce(sum((dados->>'quantos')::int) FILTER (WHERE dados->>'canalId' = ${k.canal_id}), 0)::int AS numero
            FROM auditoria
           WHERE tenant_id = tenant_atual() AND acao = 'campanha.teste_enviado' AND criado_em >= now() - interval '1 hour'`
        if ((uso?.usuario ?? 0) + quantos > LIMITE_TESTE_USUARIO_HORA || (uso?.numero ?? 0) + quantos > LIMITE_TESTE_NUMERO_HORA) {
          return { e: 'limite' as const }
        }
        // No não oficial em aquecimento, o teste também cabe no teto do dia do número.
        if (v.canal.tipo === 'whatsapp_nao_oficial' && (await statusAquecimento(tx, k.canal_id!, agora())).restante < quantos) {
          return { e: 'sem_cota' as const }
        }
        await auditar(tx, { atorId: usuarioId, atorStaff: req.atorStaff ?? false,
          acao: 'campanha.teste_enviado', entidade: 'campanha', entidadeId: req.params.id, dados: { quantos, canalId: k.canal_id } })
        return { e: null, k }
      })
      if (prep.e === 'nao_encontrada') return naoEncontrada(reply)
      if (prep.e === 'estado') return estadoInvalido(reply, prep.estado, 'envio de teste')
      if (prep.e === 'limite') {
        return reply.code(429).send({ erro: 'campanha.teste_limite', mensagem: `Limite de testes: ${LIMITE_TESTE_USUARIO_HORA} telefones por pessoa e ${LIMITE_TESTE_NUMERO_HORA} por número a cada hora.`,
          limiteUsuarioHora: LIMITE_TESTE_USUARIO_HORA, limiteNumeroHora: LIMITE_TESTE_NUMERO_HORA })
      }
      if (prep.e === 'sem_cota') {
        return reply.code(409).send({ erro: 'campanha.teste_sem_cota', mensagem: 'O número está em aquecimento e o teto de hoje acabou; o teste também conta.' })
      }
      if (prep.e === 'conteudo') return erroConteudo(reply, prep.erro)
      const resultados = await enviarTesteCampanha(tenantId, {
        canalId: prep.k.canal_id!, templateId: prep.k.template_id, texto: prep.k.template_id ? null : prep.k.mensagem,
        telefones: corpo.data.telefones,
      }, agora(), { criar: opcoes.criarCanal })
      return reply.send({ resultados })
    },
  )

  // ─────────────────────────────── iniciar ─────────────────────────────
  /**
   * Congela o público (snapshot com as exclusões) e agenda. ⚠️ A confirmação é o NOME
   * digitado: iniciar é irreversível no que já saiu.
   * Grande base: o snapshot vai em fatias de 2000 contatos, cada uma na sua transação
   * curta; uma queda no meio deixa a campanha em rascunho e o iniciar seguinte continua
   * de onde parou (idempotente por contato).
   */
  app.post<{ Params: { id: string }; Body: { confirmacaoNome?: unknown } }>(
    '/v1/campanhas/:id/iniciar', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const instante = agora()
      const prep = await req.comTenant(async (tx) => {
        const [k] = await tx<{ nome: string; estado: EstadoCampanha; modelo_versao: number; canal_id: string | null; template_id: string | null; mensagem: string | null; confirma: boolean; publico: unknown; versao: string | null }[]>`
          SELECT nome, estado, modelo_versao, canal_id, template_id, mensagem, confirma_risco_banimento AS confirma, publico,
                 atualizado_em::text AS versao
            FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'iniciar')) return { e: 'estado' as const, estado: k.estado }
        if (!confirmacaoDoNomeConfere(k.nome, req.body?.confirmacaoNome)) return { e: 'nome' as const }
        const v = await validarConteudo(tx, { canalId: k.canal_id, templateId: k.template_id, mensagem: k.mensagem, confirmaRiscoBanimento: k.confirma })
        if (!v.ok) return { e: 'conteudo' as const, erro: v.e }
        const escopo = await escopoDaRequisicao(tx, req)
        const usuarioId = await garantirUsuarioId(tx, req)
        return { e: null, publico: publicoGravado(k.publico), escopo, usuarioId, versao: k.versao }
      })
      if (prep.e === 'nao_encontrada') return naoEncontrada(reply)
      if (prep.e === 'estado') return estadoInvalido(reply, prep.estado, 'iniciar')
      if (prep.e === 'nome') {
        return reply.code(422).send({ erro: 'campanha.confirmacao_nome', mensagem: 'Digite o nome da campanha exatamente como está para confirmar.', campos: { confirmacaoNome: 'Não confere com o nome.' } })
      }
      if (prep.e === 'conteudo') return erroConteudo(reply, prep.erro)

      let depoisDe: string | null = null
      for (;;) {
        const fatia = await req.comTenant((tx) => materializarFatia(tx, {
          campanhaId: req.params.id, publico: prep.publico, escopo: prep.escopo, agora: instante, depoisDe,
        }))
        if (fatia.ultimo === null) break
        depoisDe = fatia.ultimo
        await opcoes.aoMaterializarFatia?.()
      }

      const r = await req.comTenant(async (tx) => {
        const [n] = await tx<{ pendentes: number; excluidos: number }[]>`
          SELECT count(*) FILTER (WHERE estado = 'pendente')::int AS pendentes,
                 count(*) FILTER (WHERE estado = 'excluida')::int AS excluidos
            FROM campanha_destinatario WHERE tenant_id = tenant_atual() AND campanha_id = ${req.params.id}`
        if ((n?.pendentes ?? 0) === 0) {
          await tx`DELETE FROM campanha_destinatario WHERE tenant_id = tenant_atual() AND campanha_id = ${req.params.id}`
          return { e: 'vazio' as const }
        }
        const [k] = await tx<{ estado: string }[]>`
          UPDATE campanha
             SET estado = CASE WHEN inicio_em > ${instante} THEN 'agendada' ELSE 'enviando' END,
                 iniciada_em = ${instante}, iniciada_por = ${prep.usuarioId}, contagem_desde = ${instante},
                 disparada_em = greatest(coalesce(inicio_em, ${instante}), ${instante}),
                 lote_diario = coalesce(lote_diario, ${LOTE_DIARIO_PADRAO}), atualizado_em = ${instante}
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado = 'rascunho'
             -- ⚠️ A campanha não pode ter sido editada enquanto o snapshot era montado: o
             --    público congelado seria o ANTIGO. Mesmo atualizado_em do começo, ou nada.
             AND atualizado_em::text IS NOT DISTINCT FROM ${prep.versao}
          RETURNING estado`
        if (!k) {
          const [atual] = await tx<{ estado: string }[]>`SELECT estado FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          if (atual?.estado === 'rascunho') {
            await tx`DELETE FROM campanha_destinatario WHERE tenant_id = tenant_atual() AND campanha_id = ${req.params.id}`
            return { e: 'alterada' as const }
          }
          return { e: 'concorrencia' as const }
        }
        await auditar(tx, { atorId: prep.usuarioId, atorStaff: req.atorStaff ?? false, acao: 'campanha.iniciada',
          entidade: 'campanha', entidadeId: req.params.id, dados: { destinatarios: n!.pendentes, excluidos: n!.excluidos } })
        return { e: null, estado: k.estado, destinatarios: n!.pendentes, excluidos: n!.excluidos }
      })
      if (r.e === 'vazio') return reply.code(422).send({ erro: 'campanha.sem_elegiveis', mensagem: 'Nenhum contato elegível neste público depois das exclusões.' })
      if (r.e === 'concorrencia') return reply.code(409).send({ erro: 'campanha.ja_iniciada', mensagem: 'A campanha já foi iniciada.' })
      if (r.e === 'alterada') {
        return reply.code(409).send({ erro: 'campanha.alterada_durante_inicio', mensagem: 'A campanha foi editada enquanto era iniciada. Confira e inicie de novo.' })
      }
      return reply.send({ ok: true, estado: r.estado, destinatarios: r.destinatarios, excluidos: r.excluidos })
    },
  )

  // ──────────────────────── pausar / retomar / cancelar ─────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/campanhas/:id/pausar', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha; modelo_versao: number }[]>`
          SELECT estado, modelo_versao FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'pausar')) return { e: 'estado' as const, estado: k.estado }
        await pausarCampanha(tx, { campanhaId: req.params.id, motivo: 'manual', agora: agora(), atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false })
        return { e: null }
      })
      if (r.e === 'nao_encontrada') return naoEncontrada(reply)
      if (r.e === 'estado') return estadoInvalido(reply, r.estado, 'pausar')
      return reply.send({ ok: true, estado: 'pausada' })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/campanhas/:id/retomar', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const instante = agora()
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha; modelo_versao: number; canal_id: string | null; template_id: string | null; mensagem: string | null; confirma: boolean; suspensa: boolean }[]>`
          SELECT k.estado, k.modelo_versao, k.canal_id, k.template_id, k.mensagem, k.confirma_risco_banimento AS confirma,
                 (cc.ativas_suspensas_em IS NOT NULL) AS suspensa
            FROM campanha k LEFT JOIN canal_conectado cc ON cc.tenant_id = k.tenant_id AND cc.id = k.canal_id
           WHERE k.tenant_id = tenant_atual() AND k.id = ${req.params.id} FOR UPDATE OF k`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'retomar')) return { e: 'estado' as const, estado: k.estado }
        // ⚠️ Número ainda com as ativas suspensas pela Meta: retomar seria insistir no que derruba o número.
        if (k.suspensa) return { e: 'suspenso' as const }
        const v = await validarConteudo(tx, { canalId: k.canal_id, templateId: k.template_id, mensagem: k.mensagem, confirmaRiscoBanimento: k.confirma })
        if (!v.ok) return { e: 'conteudo' as const, erro: v.e }
        // contagem_desde = agora: as taxas da pausa automática recomeçam (senão a campanha
        // pausada por taxa pausaria de novo no mesmo segundo).
        const [n] = await tx<{ estado: string }[]>`
          UPDATE campanha SET estado = CASE WHEN inicio_em > ${instante} THEN 'agendada' ELSE 'enviando' END,
                 pausa_motivo = NULL, pausada_em = NULL, contagem_desde = ${instante}, atualizado_em = ${instante}
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING estado`
        await resolverAlertaSeNenhumaPausada(tx, instante)
        await auditar(tx, { atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'campanha.retomada', entidade: 'campanha', entidadeId: req.params.id })
        return { e: null, estado: n!.estado }
      })
      if (r.e === 'nao_encontrada') return naoEncontrada(reply)
      if (r.e === 'estado') return estadoInvalido(reply, r.estado, 'retomar')
      if (r.e === 'suspenso') {
        return reply.code(409).send({ erro: 'campanha.numero_suspenso', mensagem: 'O número está com os disparos suspensos pela qualidade na Meta. Libere o número antes de retomar.' })
      }
      if (r.e === 'conteudo') return erroConteudo(reply, r.erro)
      return reply.send({ ok: true, estado: r.estado })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/campanhas/:id/cancelar', { preHandler: GESTOR },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const instante = agora()
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx<{ estado: EstadoCampanha; modelo_versao: number }[]>`
          SELECT estado, modelo_versao FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!k) return { e: 'nao_encontrada' as const }
        if (k.modelo_versao !== 2 || !acaoPermitida(k.estado, 'cancelar')) return { e: 'estado' as const, estado: k.estado }
        // Os pendentes ficam como estão (a fila não anda mais): o relatório mostra o que não saiu.
        await tx`
          UPDATE campanha SET estado = 'cancelada', atualizado_em = ${instante}
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        await resolverAlertaSeNenhumaPausada(tx, instante)
        await auditar(tx, { atorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
          acao: 'campanha.cancelada', entidade: 'campanha', entidadeId: req.params.id })
        return { e: null }
      })
      if (r.e === 'nao_encontrada') return naoEncontrada(reply)
      if (r.e === 'estado') return estadoInvalido(reply, r.estado, 'cancelar')
      return reply.send({ ok: true, estado: 'cancelada' })
    },
  )

  // ─────────────────────────────── destinatários ───────────────────────
  /** Destinatários por estado, com cursor (id). No ESCOPO de quem lê (D3). Sem telefone. */
  app.get<{ Params: { id: string }; Querystring: { estado?: string; cursor?: string } }>(
    '/v1/campanhas/:id/destinatarios', { preHandler: GESTAO },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const { estado, cursor } = req.query
      if (estado !== undefined && !ehEstadoDestinatario(estado)) {
        return reply.code(422).send({ erro: 'campanha.invalida', campos: { estado: 'Estado inválido.' } })
      }
      let depois: string | null = null
      if (cursor) {
        const id = Buffer.from(cursor, 'base64url').toString('utf8')
        if (!UUID.test(id)) return reply.code(422).send({ erro: 'cursor.invalido' })
        depois = id
      }
      const r = await req.comTenant(async (tx) => {
        const [k] = await tx`SELECT 1 FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!k) return null
        const escopo = await escopoDaRequisicao(tx, req)
        return tx<{
          id: string; contato_id: string; contato_nome: string; estado: string; motivo_exclusao: string | null
          erro_codigo: string | null; conversa_id: string | null; enviado_em: Date | null; entregue_em: Date | null
          lido_em: Date | null; respondeu_em: Date | null; optout_em: Date | null
        }[]>`
          SELECT d.id, d.contato_id, c.nome AS contato_nome, d.estado, d.motivo_exclusao, d.erro_codigo, d.conversa_id,
                 d.enviado_em, d.entregue_em, d.lido_em, d.respondeu_em, d.optout_em
            FROM campanha_destinatario d
            JOIN contato c ON c.tenant_id = d.tenant_id AND c.id = d.contato_id
           WHERE d.tenant_id = tenant_atual() AND d.campanha_id = ${req.params.id}
             AND ${estado === undefined ? tx`true` : tx`d.estado = ${estado}`}
             AND ${depois === null ? tx`true` : tx`d.id > ${depois}::uuid`}
             AND ${condicaoContato(tx, escopo, 'c')}
           ORDER BY d.id LIMIT ${PAGINA_DESTINATARIOS + 1}`
      })
      if (!r) return naoEncontrada(reply)
      const temMais = r.length > PAGINA_DESTINATARIOS
      const pagina = temMais ? r.slice(0, PAGINA_DESTINATARIOS) : r
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((d) => ({
          id: d.id, contatoId: d.contato_id, contatoNome: d.contato_nome, estado: d.estado,
          motivoExclusao: d.motivo_exclusao, erroCodigo: d.erro_codigo, conversaId: d.conversa_id,
          enviadoEm: d.enviado_em, entregueEm: d.entregue_em, lidoEm: d.lido_em, respondeuEm: d.respondeu_em, optoutEm: d.optout_em,
        })),
        proximoCursor: temMais && ultimo ? Buffer.from(ultimo.id).toString('base64url') : null,
      })
    },
  )

  // ─────────────────────────────── relatório ───────────────────────────
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id/relatorio', { preHandler: GESTAO },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return naoEncontrada(reply)
      const r = await req.comTenant((tx) => relatorioCampanha(tx, req.params.id))
      if (!r) return naoEncontrada(reply)
      return reply.send(r)
    },
  )

  // ═══════════════════════════════ LEGADO ══════════════════════════════

  /** Prévia da audiência (legado) — quantos contatos o segmento alcança. */
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id/audiencia', { preHandler: GESTAO },
    async (req, reply) => {
      const total = await req.comTenant(async (tx) => {
        const [c] = await tx<{ segmento_alvo: string }[]>`
          SELECT segmento_alvo FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return null
        return (await audienciaDoSegmento(tx, c.segmento_alvo)).length
      })
      if (total === null) return naoEncontrada(reply)
      return reply.send({ total })
    },
  )

  /**
   * Dispara (legado): enfileira UM envio por destinatário do segmento (idempotente).
   * ⚠️ O envio real sai pelo despachante + gateway (opt-out/janela/aquecimento). A v2
   *    não dispara por aqui: usa `iniciar` (com o nome digitado e o público congelado).
   */
  app.post<{ Params: { id: string } }>(
    '/v1/campanhas/:id/disparar', { preHandler: GESTOR },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx<{ segmento_alvo: string; estado: string; modelo_versao: number }[]>`
          SELECT segmento_alvo, estado, modelo_versao FROM campanha WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 'nao_encontrada' as const }
        if (c.modelo_versao === 2) return { erro: 'use_iniciar' as const }
        if (c.estado !== 'rascunho') return { erro: 'ja_disparada' as const }

        const alvo = await audienciaDoSegmento(tx, c.segmento_alvo)
        for (const contatoId of alvo) {
          await tx`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id)
                   VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${contatoId})
                   ON CONFLICT (tenant_id, campanha_id, contato_id) DO NOTHING`
        }
        await tx`UPDATE campanha SET estado = 'disparando', disparada_em = now()
                  WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { enfileirados: alvo.length }
      })
      if ('erro' in r) {
        return reply.code(r.erro === 'nao_encontrada' ? 404 : 409).send({ erro: `campanha.${r.erro}` })
      }
      return reply.send({ ok: true, enfileirados: r.enfileirados })
    },
  )

  /** ROI — atribuição exata e estimada, SEPARADAS. */
  app.get<{ Params: { id: string } }>(
    '/v1/campanhas/:id/roi', { preHandler: GESTAO },
    async (req, reply) => {
      const roi = await req.comTenant((tx) => roiCampanha(tx, req.params.id))
      if (!roi) return naoEncontrada(reply)
      return reply.send(roi)
    },
  )
}

function conteudoDoCorpo(b: CorpoV2) {
  return {
    canalId: b.canalId, templateId: b.templateId ?? null, mensagem: b.mensagem ?? null,
    confirmaRiscoBanimento: b.confirmaRiscoBanimento === true,
  }
}
