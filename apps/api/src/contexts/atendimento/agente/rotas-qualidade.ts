import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AMOSTRA_PADRAO_POR_MODO, CRITERIOS_RUBRICA, REGRAS_QUALIDADE, ROTULO_REGRA_QUALIDADE,
  mascararTextoQualidade, ordenarAmostraSemanal,
  type AvaliacaoQualidadeDto, type CriterioRubrica, type GravidadeQualidade, type ModoAgente, type ResumoQualidadeDto,
} from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import { lerCursor, paginar } from '../../crm/cursor-criado-em.js'
import type { PortaLlmFerramentas } from './porta-llm.js'
import { gastoJuizNoMes, inicioDoMesDoTenant, julgarSessao, tetoJuizDoAmbiente, tetoJuizEfetivo } from './qualidade/avaliacao.js'
import { fusoSeguro } from '../../plataforma/fuso.js'
import { juizDoAmbiente } from './qualidade/juiz.js'

/**
 * QUALIDADE EM PRODUÇÃO (ADR-031, raia P12).
 *
 *   GET  /v1/agente/qualidade                      — avaliações (regras e juiz), cursor; filtros canalId, tipo, gravidade, origem
 *   GET  /v1/agente/qualidade/resumo               — contagens por gravidade/regra, notas, amostra e teto do juiz
 *   GET  /v1/agente/qualidade/amostra-semanal.csv  — amostra da semana por número (CRÍTICA → ALTA/nota ≤ 3 → aleatórias), MASCARADA
 *   POST /v1/agente/qualidade/avaliar              — juiz sob demanda numa conversa (fora da amostra; respeita o teto)
 *   GET/PUT /v1/canais/:id/agente/qualidade        — amostra e teto mensal do juiz do número (admin grava; auditoria)
 *
 * ⚠️ Tudo sob RLS (`req.comTenant`); `tenant_id` nunca vem de parâmetro.
 * ⚠️ O CSV não leva telefone, nome nem texto cru: id da conversa, regras e
 *    trechos já mascarados (gravados mascarados e mascarados de novo aqui).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA = /^\d{4}-\d{2}-\d{2}$/
const MAX_CENTAVOS = 100_000_000

export interface OpcoesRotasQualidade {
  /** Testes: porta falsa do juiz. Produção: o do ambiente. */
  readonly juiz?: PortaLlmFerramentas | undefined
}

const filtros = z.object({
  cursor: z.string().optional(),
  canalId: z.string().regex(UUID).optional(),
  tipo: z.enum(['regras', 'juiz']).optional(),
  gravidade: z.enum(['CRITICA', 'ALTA', 'MEDIA']).optional(),
  origem: z.enum(['agente', 'sugestao']).optional(),
  /** Só avaliações com algo a ver (violação que escapou ou nota do juiz). */
  comAchado: z.enum(['1', 'true']).optional(),
}).strict()

const corpoConfig = z.object({
  /** null = padrão do modo. */
  amostra: z.number().min(0).max(1).nullable(),
  /** null = padrão do ambiente; 0 = juiz desligado no número. */
  tetoMesCentavos: z.number().int().nonnegative().max(MAX_CENTAVOS).nullable(),
}).strict()

const corpoAvaliar = z.object({ conversaId: z.string().regex(UUID), decisaoId: z.string().regex(UUID).optional() }).strict()

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

function invalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const i = e.issues[0]!
  return reply.code(422).send({ erro: 'qualidade.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: [i.path.join('.')] })
}

interface LinhaAvaliacao {
  id: string; decisao_id: string; conversa_id: string; canal_id: string; sessao_id: string | null; origem: string; tipo: string
  gatilho: string; violacoes: unknown; pior_gravidade: string | null; notas: Record<string, number> | null
  justificativas: Record<string, string> | null; nota_media: string | null; acao: string | null; modelo: string | null
  custo_centavos: string; erro: string | null; criado_em_txt: string; criado_em: Date
}

function dto(l: LinhaAvaliacao): AvaliacaoQualidadeDto {
  const notas = l.notas && l.justificativas
    ? Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, { nota: Number(l.notas![c] ?? 0), justificativa: l.justificativas![c] ?? '' }]))
    : null
  return {
    id: l.id, decisaoId: l.decisao_id, conversaId: l.conversa_id, canalId: l.canal_id, sessaoId: l.sessao_id,
    origem: l.origem as AvaliacaoQualidadeDto['origem'], tipo: l.tipo as AvaliacaoQualidadeDto['tipo'],
    gatilho: l.gatilho as AvaliacaoQualidadeDto['gatilho'],
    violacoes: Array.isArray(l.violacoes) ? (l.violacoes as AvaliacaoQualidadeDto['violacoes']) : [],
    piorGravidade: l.pior_gravidade as GravidadeQualidade | null,
    notas: notas as AvaliacaoQualidadeDto['notas'],
    notaMedia: l.nota_media === null ? null : Number(l.nota_media),
    acao: l.acao as AvaliacaoQualidadeDto['acao'], modelo: l.modelo, custoCentavos: Number(l.custo_centavos), erro: l.erro,
    criadoEm: l.criado_em.toISOString(),
  }
}

/** Uma célula de CSV: aspas dobradas e proteção contra fórmula (=, +, -, @ no início). */
export function celulaCsv(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function rotasQualidade(app: FastifyInstance, opts: OpcoesRotasQualidade = {}): Promise<void> {
  const juiz = () => opts.juiz ? { porta: opts.juiz, modelo: undefined, motivoIndisponivel: null } : juizDoAmbiente()

  app.get<{ Querystring: Record<string, string> }>('/v1/agente/qualidade', { preHandler: exigirTenant }, async (req, reply) => {
    const f = filtros.safeParse(req.query ?? {})
    if (!f.success) return invalido(reply, f.error)
    const c = lerCursor(f.data.cursor)
    if (c === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido' })
    const linhas = await req.comTenant((tx) => tx<LinhaAvaliacao[]>`
      SELECT a.id, a.decisao_id, a.conversa_id, a.canal_id, a.sessao_id, a.origem, a.tipo, a.gatilho, a.violacoes, a.pior_gravidade,
             a.notas, a.justificativas, a.nota_media::text AS nota_media, a.acao, a.modelo, a.custo_centavos::text AS custo_centavos,
             a.erro, a.criado_em, a.criado_em::text AS criado_em_txt
        FROM agente_avaliacao a
       WHERE a.tenant_id = tenant_atual()
         ${f.data.canalId ? tx`AND a.canal_id = ${f.data.canalId}` : tx``}
         ${f.data.tipo ? tx`AND a.tipo = ${f.data.tipo}` : tx``}
         ${f.data.gravidade ? tx`AND a.pior_gravidade = ${f.data.gravidade}` : tx``}
         ${f.data.origem ? tx`AND a.origem = ${f.data.origem}` : tx``}
         ${f.data.comAchado ? tx`AND (a.pior_gravidade IS NOT NULL OR a.tipo = 'juiz')` : tx``}
         ${c ? tx`AND (a.criado_em, a.id) < (${c.em}::text::timestamptz, ${c.id})` : tx``}
       ORDER BY a.criado_em DESC, a.id DESC
       LIMIT 21`)
    const { pagina, proximoCursor } = paginar(linhas)
    return reply.send({ itens: pagina.map(dto), proximoCursor })
  })

  app.get<{ Querystring: { canalId?: string; dias?: string } }>('/v1/agente/qualidade/resumo', { preHandler: exigirTenant }, async (req, reply) => {
    const canalId = req.query.canalId
    if (canalId !== undefined && !UUID.test(canalId)) return reply.code(422).send({ erro: 'qualidade.campo_invalido', campos: ['canalId'] })
    const dias = Math.min(90, Math.max(1, Math.floor(Number(req.query.dias ?? 7)) || 7))
    const j = juiz()
    const r = await req.comTenant(async (tx) => {
      const filtroCanal = canalId ? tx`AND canal_id = ${canalId}` : tx``
      const [g] = await tx<{ regras: number; critica: number; alta: number; media: number; pausas: number; nao_envie: number; julgadas: number; media_nota: string | null }[]>`
        SELECT count(*) FILTER (WHERE tipo = 'regras')::int AS regras,
               count(*) FILTER (WHERE pior_gravidade = 'CRITICA')::int AS critica,
               count(*) FILTER (WHERE pior_gravidade = 'ALTA')::int AS alta,
               count(*) FILTER (WHERE pior_gravidade = 'MEDIA')::int AS media,
               count(*) FILTER (WHERE acao = 'pausa_humano')::int AS pausas,
               count(*) FILTER (WHERE acao = 'nao_envie')::int AS nao_envie,
               count(*) FILTER (WHERE tipo = 'juiz' AND nota_media IS NOT NULL)::int AS julgadas,
               round(avg(nota_media) FILTER (WHERE tipo = 'juiz'), 2)::text AS media_nota
          FROM agente_avaliacao
         WHERE tenant_id = tenant_atual() AND criado_em > now() - make_interval(days => ${dias}) ${filtroCanal}`
      const criterios = await tx<{ criterio: string; media: string | null }[]>`
        SELECT k AS criterio, round(avg((notas->>k)::numeric), 2)::text AS media
          FROM agente_avaliacao, unnest(${CRITERIOS_RUBRICA as unknown as string[]}::text[]) AS k
         WHERE tenant_id = tenant_atual() AND tipo = 'juiz' AND notas IS NOT NULL
           AND criado_em > now() - make_interval(days => ${dias}) ${filtroCanal}
         GROUP BY k`
      const regras = await tx<{ regra: string; n: number }[]>`
        SELECT v->>'regra' AS regra, count(*)::int AS n
          FROM agente_avaliacao, jsonb_array_elements(violacoes) v
         WHERE tenant_id = tenant_atual() AND tipo = 'regras' AND NOT coalesce((v->>'corrigida')::boolean, false)
           AND criado_em > now() - make_interval(days => ${dias}) ${filtroCanal}
         GROUP BY 1 ORDER BY 2 DESC`
      let cfg: { amostra: string | null; teto: string | null; modo: ModoAgente } | undefined
      let gasto = 0
      if (canalId) {
        [cfg] = await tx<{ amostra: string | null; teto: string | null; modo: ModoAgente }[]>`
          SELECT qualidade_amostra::text AS amostra, qualidade_teto_mes_centavos::text AS teto, modo
            FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
        gasto = await gastoJuizNoMes(tx, canalId)
      } else {
        const ini = await inicioDoMesDoTenant(tx)
        const [t] = await tx<{ total: string }[]>`
          SELECT coalesce(sum(custo_centavos), 0)::text AS total FROM agente_avaliacao
           WHERE tenant_id = tenant_atual() AND tipo = 'juiz' AND criado_em >= ${ini}`
        gasto = Number(t?.total ?? 0)
      }
      return { g: g!, criterios, regras, cfg, gasto }
    })
    const teto = canalId ? tetoJuizEfetivo(r.cfg?.teto ?? null) : null
    const mediaPorCriterio = r.g.julgadas > 0
      ? Object.fromEntries(CRITERIOS_RUBRICA.map((c) => {
        const m = r.criterios.find((x) => x.criterio === c)?.media
        return [c, m === null || m === undefined ? null : Number(m)]
      })) as Record<CriterioRubrica, number | null>
      : null
    const resumo: ResumoQualidadeDto = {
      periodoDias: dias,
      turnosAvaliados: r.g.regras,
      porGravidade: { CRITICA: r.g.critica, ALTA: r.g.alta, MEDIA: r.g.media },
      pausas: r.g.pausas,
      naoEnvie: r.g.nao_envie,
      julgadas: r.g.julgadas,
      notaMedia: r.g.media_nota === null ? null : Number(r.g.media_nota),
      mediaPorCriterio,
      porRegra: r.regras.filter((x) => (REGRAS_QUALIDADE as readonly string[]).includes(x.regra))
        .map((x) => ({ regra: x.regra as ResumoQualidadeDto['porRegra'][number]['regra'], quantidade: x.n })),
      amostra: r.cfg?.amostra === null || r.cfg?.amostra === undefined ? null : Number(r.cfg.amostra),
      amostraPadrao: r.cfg ? AMOSTRA_PADRAO_POR_MODO[r.cfg.modo] ?? 0 : AMOSTRA_PADRAO_POR_MODO.sombra,
      juiz: {
        disponivel: !!j.porta,
        motivoIndisponivel: j.motivoIndisponivel,
        gastoMesCentavos: r.gasto,
        tetoMesCentavos: teto,
        pausadoPorTeto: teto !== null && r.gasto >= teto,
      },
    }
    return reply.send(resumo)
  })

  app.get<{ Querystring: { canalId?: string; inicio?: string } }>(
    '/v1/agente/qualidade/amostra-semanal.csv',
    { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor', 'supervisor')] },
    async (req, reply) => {
      const { canalId, inicio } = req.query
      if (canalId !== undefined && !UUID.test(canalId)) return reply.code(422).send({ erro: 'qualidade.campo_invalido', campos: ['canalId'] })
      if (inicio !== undefined && !DATA.test(inicio)) return reply.code(422).send({ erro: 'qualidade.campo_invalido', campos: ['inicio'] })
      const dados = await req.comTenant(async (tx) => {
        // A semana: segunda 00:00 no fuso da loja (ou a segunda do `inicio`), 7 dias.
        const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
        const fuso = fusoSeguro(t?.fuso)
        const [sem] = await tx<{ ini: Date; fim: Date; rotulo: string }[]>`
          SELECT ini, ini + interval '7 days' AS fim, to_char(ini AT TIME ZONE ${fuso}, 'IYYY-"W"IW') AS rotulo
            FROM (SELECT date_trunc('week', coalesce(${inicio ?? null}::date::timestamp, now() AT TIME ZONE ${fuso})) AT TIME ZONE ${fuso} AS ini) s`
        // Uma linha por conversa e número na semana: pior gravidade que escapou, menor nota, regras e justificativas.
        const conversas = await tx<{
          canal_id: string; canal_nome: string; conversa_id: string; pior: string | null; menor_nota: string | null
          violacoes: unknown[] | null; justificativas: string[] | null; avaliacoes: number
        }[]>`
          SELECT a.canal_id, cc.nome_amigavel AS canal_nome, a.conversa_id,
                 (array_agg(a.pior_gravidade ORDER BY CASE a.pior_gravidade WHEN 'CRITICA' THEN 3 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 1 ELSE 0 END DESC))[1] AS pior,
                 min(a.nota_media)::text AS menor_nota,
                 (SELECT jsonb_agg(v) FROM agente_avaliacao a2, jsonb_array_elements(a2.violacoes) v
                   WHERE a2.tenant_id = a.tenant_id AND a2.conversa_id = a.conversa_id AND a2.canal_id = a.canal_id
                     AND a2.criado_em >= ${sem!.ini} AND a2.criado_em < ${sem!.fim}
                     AND NOT coalesce((v->>'corrigida')::boolean, false)) AS violacoes,
                 array_remove(array_agg(a.justificativas::text) FILTER (WHERE a.tipo = 'juiz' AND a.justificativas IS NOT NULL), NULL) AS justificativas,
                 count(*)::int AS avaliacoes
            FROM agente_avaliacao a
            JOIN canal_conectado cc ON cc.tenant_id = a.tenant_id AND cc.id = a.canal_id
           WHERE a.tenant_id = tenant_atual() AND a.criado_em >= ${sem!.ini} AND a.criado_em < ${sem!.fim}
             -- Juiz que falhou não é avaliação: não põe a conversa na amostra (P16 filtra igual).
             AND a.erro IS NULL
             ${canalId ? tx`AND a.canal_id = ${canalId}` : tx``}
           GROUP BY a.tenant_id, a.canal_id, cc.nome_amigavel, a.conversa_id
           -- O teto de linhas nunca corta uma CRÍTICA: as piores vêm primeiro.
           ORDER BY max(CASE a.pior_gravidade WHEN 'CRITICA' THEN 3 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 1 ELSE 0 END) DESC,
                    min(a.nota_media) ASC NULLS LAST, a.conversa_id
           LIMIT 5000`
        return { sem: sem!, conversas }
      })
      const porCanal = new Map<string, Array<(typeof dados.conversas)[number]>>()
      for (const c of dados.conversas) porCanal.set(c.canal_id, [...(porCanal.get(c.canal_id) ?? []), c])
      const cab = ['semana', 'numero', 'ordem', 'motivo', 'conversa_id', 'pior_gravidade', 'menor_nota', 'avaliacoes', 'violacoes', 'justificativas_juiz']
      const linhas = [cab.join(';')]
      const canais = [...porCanal.entries()].sort((a, b) => (a[1][0]!.canal_nome < b[1][0]!.canal_nome ? -1 : 1))
      for (const [, itens] of canais) {
        const amostra = ordenarAmostraSemanal(itens.map((i) => ({
          ...i, conversaId: i.conversa_id, piorGravidade: (i.pior as GravidadeQualidade | null), menorNota: i.menor_nota === null ? null : Number(i.menor_nota),
        })), dados.sem.rotulo)
        amostra.forEach((i, idx) => {
          const viol = (i.violacoes ?? []).map((v) => {
            const x = v as { regra?: string; gravidade?: string; trecho?: string }
            const rot = ROTULO_REGRA_QUALIDADE[x.regra as keyof typeof ROTULO_REGRA_QUALIDADE] ?? x.regra
            return `${x.gravidade}: ${rot}${x.trecho ? ` — ${mascararTextoQualidade(x.trecho)}` : ''}`
          }).join(' | ')
          const just = (i.justificativas ?? []).flatMap((t) => {
            try { return Object.entries(JSON.parse(t) as Record<string, string>).map(([k, v]) => `${k}: ${mascararTextoQualidade(v)}`) } catch { return [] }
          }).join(' | ')
          linhas.push([dados.sem.rotulo, mascararTextoQualidade(i.canal_nome), idx + 1, i.motivo, i.conversa_id, i.piorGravidade ?? '', i.menorNota ?? '', i.avaliacoes, viol, just]
            .map(celulaCsv).join(';'))
        })
      }
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="qualidade-amostra-${dados.sem.rotulo}.csv"`)
        .header('cache-control', 'no-store')
        .send(`﻿${linhas.join('\r\n')}\r\n`)
    },
  )

  app.post<{ Body: unknown }>(
    '/v1/agente/qualidade/avaliar',
    { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin', 'gestor', 'supervisor')] },
    async (req, reply) => {
      const p = corpoAvaliar.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const j = juiz()
      if (!j.porta) return reply.code(503).send({ erro: 'qualidade.juiz_indisponivel', mensagem: j.motivoIndisponivel ?? 'Juiz de qualidade indisponível.' })
      const porta = j.porta
      const { conversaId, decisaoId } = p.data
      // Passo 1 (tx curta): a sessão do ITEM (decisaoId) ou, sem ele, a mais recente da conversa.
      const s = await req.comTenant(async (tx) => {
        const [l] = await tx<{ sessao_id: string; canal_id: string; canal_nome: string; modo: string | null; turnos: number; politicas: string | null; teto: string | null; decisao_id: string | null }[]>`
          SELECT s.id AS sessao_id, s.canal_id, cc.nome_amigavel AS canal_nome, s.modo, s.turnos, ac.politicas,
                 ac.qualidade_teto_mes_centavos::text AS teto,
                 (SELECT d.id FROM agente_decisao d WHERE d.tenant_id = s.tenant_id AND d.sessao_id = s.id AND d.resposta IS NOT NULL
                    AND d.desfecho IN ('respondeu', 'sugeriu', 'handoff', 'superada') ORDER BY d.criado_em DESC, d.id DESC LIMIT 1) AS decisao_id
            FROM agente_sessao s
            JOIN canal_conectado cc ON cc.tenant_id = s.tenant_id AND cc.id = s.canal_id
            LEFT JOIN agente_config ac ON ac.tenant_id = s.tenant_id AND ac.canal_id = s.canal_id
           WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
             ${decisaoId ? tx`AND s.id = (SELECT sessao_id FROM agente_decisao WHERE tenant_id = tenant_atual() AND id = ${decisaoId})` : tx``}
           ORDER BY s.iniciada_em DESC LIMIT 1`
        return l ?? null
      })
      if (!s || !s.decisao_id) return reply.code(404).send({ erro: 'qualidade.sem_sessao', mensagem: 'O agente ainda não atuou nesta conversa.' })
      // Passos 2 e 3: o juiz roda FORA de transação; a gravação é outra tx curta.
      const d = await julgarSessao((fn) => req.comTenant(fn), {
        tenantId: req.tenantId!, sessaoId: s.sessao_id, decisaoId: s.decisao_id, conversaId, canalId: s.canal_id,
        canalNome: s.canal_nome, modo: s.modo ?? 'sombra', turnos: s.turnos, gatilho: 'manual', politicas: s.politicas,
        tetoMesCentavos: tetoJuizEfetivo(s.teto),
      }, { porta, modelo: j.modelo })
      const linha = await req.comTenant(async (tx) => (await tx<LinhaAvaliacao[]>`
        SELECT a.id, a.decisao_id, a.conversa_id, a.canal_id, a.sessao_id, a.origem, a.tipo, a.gatilho, a.violacoes, a.pior_gravidade,
               a.notas, a.justificativas, a.nota_media::text AS nota_media, a.acao, a.modelo, a.custo_centavos::text AS custo_centavos,
               a.erro, a.criado_em, a.criado_em::text AS criado_em_txt
          FROM agente_avaliacao a WHERE a.tenant_id = tenant_atual() AND a.decisao_id = ${s.decisao_id} AND a.tipo = 'juiz'`)[0])
      const r = { desfecho: d, avaliacao: linha ? dto(linha) : null }
      if (r.desfecho === 'teto') return reply.code(409).send({ erro: 'qualidade.teto_atingido', mensagem: 'O avaliador chegou ao teto do mês neste número.' })
      if (r.desfecho === 'falhou') return reply.code(502).send({ erro: 'qualidade.juiz_falhou', mensagem: r.avaliacao?.erro ?? 'O avaliador não respondeu.', avaliacao: r.avaliacao })
      if (r.desfecho === 'sem_falas') return reply.code(422).send({ erro: 'qualidade.sem_falas', mensagem: 'Não há fala do agente para avaliar nesta conversa.' })
      return reply.send({ desfecho: r.desfecho, avaliacao: r.avaliacao })
    },
  )

  app.get<{ Params: { id: string } }>('/v1/canais/:id/agente/qualidade', { preHandler: exigirTenant }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const r = await req.comTenant(async (tx) => {
      const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      if (!canal) return null
      const [cfg] = await tx<{ amostra: string | null; teto: string | null; modo: ModoAgente }[]>`
        SELECT qualidade_amostra::text AS amostra, qualidade_teto_mes_centavos::text AS teto, modo
          FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
      return { cfg, gasto: await gastoJuizNoMes(tx, req.params.id) }
    })
    if (!r) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const teto = r.cfg?.teto === null || r.cfg?.teto === undefined ? null : Number(r.cfg.teto)
    return reply.send({
      amostra: r.cfg?.amostra === null || r.cfg?.amostra === undefined ? null : Number(r.cfg.amostra),
      amostraPadrao: AMOSTRA_PADRAO_POR_MODO[r.cfg?.modo ?? 'desligado'] ?? 0,
      modo: r.cfg?.modo ?? 'desligado',
      tetoMesCentavos: teto,
      tetoMesPadraoCentavos: tetoJuizDoAmbiente(),
      tetoMesEfetivoCentavos: tetoJuizEfetivo(teto),
      gastoMesCentavos: r.gasto,
    })
  })

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/canais/:id/agente/qualidade', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const p = corpoConfig.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const ok = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!canal) return false
        const [antes] = await tx<{ amostra: string | null; teto: string | null }[]>`
          SELECT qualidade_amostra::text AS amostra, qualidade_teto_mes_centavos::text AS teto
            FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id}`
        await tx`
          INSERT INTO agente_config (tenant_id, canal_id, qualidade_amostra, qualidade_teto_mes_centavos)
          VALUES (tenant_atual(), ${req.params.id}, ${p.data.amostra}, ${p.data.tetoMesCentavos})
          ON CONFLICT (tenant_id, canal_id) DO UPDATE
             SET qualidade_amostra = EXCLUDED.qualidade_amostra, qualidade_teto_mes_centavos = EXCLUDED.qualidade_teto_mes_centavos,
                 atualizado_em = now()`
        const atorId = req.atorStaff ? null : await garantirUsuarioId(tx, req)
        const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v))
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'agente.qualidade_alterada', entidade: 'agente_config', entidadeId: req.params.id,
          dados: { antes: { amostra: num(antes?.amostra), tetoMesCentavos: num(antes?.teto) }, depois: p.data },
        })
        return true
      })
      if (!ok) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      return reply.send({ ok: true, ...p.data, tetoMesEfetivoCentavos: tetoJuizEfetivo(p.data.tetoMesCentavos) })
    },
  )
}
