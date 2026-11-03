import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { projetarMes, alertaDoOrcamento } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { exigirPapel } from '../plataforma/papel.js'
import { auditar } from '../plataforma/auditoria.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { atorDaRequisicao, garantirUsuarioId } from './rotas-fila.js'
import {
  CATEGORIAS_WHATSAPP, CAMBIO_PADRAO_MILESIMOS, custoTranscricao, custoWhatsapp,
  limitesDoMes, mesValido, precosEfetivos,
} from './consumo.js'

/**
 * PREÇOS DO WHATSAPP E CONSUMO (F2, #79-#81).
 *
 *   GET/PUT /v1/config/precos-whatsapp — preço por mensagem por categoria da Meta (centavos).
 *   GET     /v1/consumo?mes=YYYY-MM    — quanto custaram WhatsApp, IA e transcrição no mês.
 *
 * ⚠️ Tenant sempre do token. Dinheiro em centavos inteiros. O consumo lê a view `consumo_diario`
 *    (MV filtrada por tenant) e completa o dia de HOJE direto das tabelas (`consumo_base`).
 * ⚠️ WhatsApp e transcrição são precificados na leitura, com o preço VIGENTE; IA usa o custo fato
 *    gravado em cada turno (preço do catálogo `modelo_ia`, ADR-032).
 * ⚠️ Estimativa, não fatura: a fatura é a da Meta e dos provedores.
 */

const MAX_PRECO_CENTAVOS = 10_000 // R$ 100 por mensagem: acima disso é erro de digitação
const NIL = '00000000-0000-0000-0000-000000000000'

const corpoPrecos = z.object({
  precos: z.object({
    marketing: z.number().int().min(0).max(MAX_PRECO_CENTAVOS),
    utility: z.number().int().min(0).max(MAX_PRECO_CENTAVOS),
    authentication: z.number().int().min(0).max(MAX_PRECO_CENTAVOS),
    service: z.number().int().min(0).max(MAX_PRECO_CENTAVOS),
  }).strict(),
  cambioUsdBrlMilesimos: z.number().int().min(1000).max(20_000),
}).strict()

/** `exigirPapel` lê o papel pela linha de `usuario`; garantir a linha antes evita 403 a quem abriu a tela direto. */
async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId && !req.atorStaff) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}

function invalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  // Mapa campo → mensagem: o formato de 422 que o console liga ao campo (ErroApi.campos).
  const campos: Record<string, string> = {}
  for (const i of e.issues) campos[i.path.join('.') || 'corpo'] ??= i.message
  const i = e.issues[0]!
  return reply.code(422).send({ erro: 'preco.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos })
}

interface LinhaConsumo {
  dia: string; fonte: string; categoria: string; modelo: string
  campanha_id: string; quantidade: string; custo: string
}

export async function rotasConsumo(app: FastifyInstance): Promise<void> {
  app.get('/v1/config/precos-whatsapp', { preHandler: exigirTenant }, async (req, reply) => {
    const linhas = await req.comTenant((tx) => tx<{
      categoria: string; centavos: number; cambio: number; atualizado_em: Date
    }[]>`
      SELECT categoria, centavos_por_mensagem AS centavos, cambio_usd_brl_milesimos AS cambio, atualizado_em
        FROM preco_whatsapp WHERE tenant_id = tenant_atual()`)
    const efetivos = precosEfetivos(linhas.map((l) => ({ categoria: l.categoria, centavos: l.centavos })))
    return reply.send({
      itens: CATEGORIAS_WHATSAPP.map((categoria) => ({
        categoria, centavosPorMensagem: efetivos[categoria],
        padrao: !linhas.some((l) => l.categoria === categoria),
      })),
      cambioUsdBrlMilesimos: linhas[0]?.cambio ?? CAMBIO_PADRAO_MILESIMOS,
      atualizadoEm: linhas.reduce<Date | null>((m, l) => (m === null || l.atualizado_em > m ? l.atualizado_em : m), null),
    })
  })

  app.put<{ Body: unknown }>(
    '/v1/config/precos-whatsapp', { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] },
    async (req, reply) => {
      const p = corpoPrecos.safeParse(req.body ?? {})
      if (!p.success) return invalido(reply, p.error)
      const { precos, cambioUsdBrlMilesimos } = p.data
      await req.comTenant(async (tx) => {
        const atorId = await atorDaRequisicao(tx, req)
        const antes = await tx<{ categoria: string; centavos: number }[]>`
          SELECT categoria, centavos_por_mensagem AS centavos FROM preco_whatsapp WHERE tenant_id = tenant_atual()`
        for (const categoria of CATEGORIAS_WHATSAPP) {
          await tx`
            INSERT INTO preco_whatsapp (tenant_id, categoria, centavos_por_mensagem, cambio_usd_brl_milesimos, atualizado_em, atualizado_por)
            VALUES (tenant_atual(), ${categoria}, ${precos[categoria]}, ${cambioUsdBrlMilesimos}, now(), ${atorId})
            ON CONFLICT (tenant_id, categoria) DO UPDATE
               SET centavos_por_mensagem = EXCLUDED.centavos_por_mensagem,
                   cambio_usd_brl_milesimos = EXCLUDED.cambio_usd_brl_milesimos,
                   atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`
        }
        await auditar(tx, {
          atorId, atorStaff: req.atorStaff ?? false, acao: 'whatsapp.precos_alterados', entidade: 'preco_whatsapp',
          dados: { antes: precosEfetivos(antes), depois: precos, cambioUsdBrlMilesimos },
        })
      })
      return reply.send({ ok: true, precos, cambioUsdBrlMilesimos })
    },
  )

  app.get<{ Querystring: { mes?: string } }>('/v1/consumo', { preHandler: exigirTenant }, async (req, reply) => {
    if (req.query.mes !== undefined && !mesValido(req.query.mes)) {
      return reply.code(422).send({ erro: 'consumo.mes_invalido', mensagem: 'Use o formato AAAA-MM.', campos: { mes: 'Use o formato AAAA-MM.' } })
    }
    const r = await req.comTenant(async (tx) => {
      // ⚠️ Fuso validado em TS (fuso.ts); "hoje" e a fronteira do mês são do TENANT, não do servidor.
      const [tf] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
      const fuso = fusoSeguro(tf?.fuso)
      const [h] = await tx<{ hoje: string }[]>`
        SELECT to_char((now() AT TIME ZONE ${fuso}::text)::date, 'YYYY-MM-DD') AS hoje`
      const hoje = h!.hoje
      const mes = req.query.mes ?? hoje.slice(0, 7)
      const lim = limitesDoMes(mes)
      const hojeNoMes = hoje >= lim.inicio && hoje < lim.fim

      const linhas = await tx<LinhaConsumo[]>`
        SELECT dia::text AS dia, fonte, categoria, modelo, campanha_id::text AS campanha_id,
               quantidade::text AS quantidade, custo_centavos::text AS custo
          FROM consumo_diario
         WHERE dia >= ${lim.inicio}::date AND dia < ${lim.fim}::date AND dia < ${hoje}::date
        ${hojeNoMes ? tx`
        UNION ALL
        SELECT b.dia::text, b.fonte, b.categoria, b.modelo, b.campanha_id::text,
               b.quantidade::text, b.custo_centavos::text
          FROM consumo_base((${hoje}::date::timestamp AT TIME ZONE ${fuso}::text)) b
         WHERE b.tenant_id = tenant_atual() AND b.dia >= ${lim.inicio}::date AND b.dia < ${lim.fim}::date` : tx``}`

      const precoLinhas = await tx<{ categoria: string; centavos: number }[]>`
        SELECT categoria, centavos_por_mensagem AS centavos FROM preco_whatsapp WHERE tenant_id = tenant_atual()`
      const [orc] = await tx<{ mensal: string | null }[]>`
        SELECT mensal_centavos::text AS mensal FROM agente_orcamento WHERE tenant_id = tenant_atual()`

      const caras = await tx<{ conversa_id: string; nome: string | null; custo: string }[]>`
        SELECT d.conversa_id, ct.nome, sum(d.custo_centavos)::text AS custo
          FROM agente_decisao d
          JOIN conversa cv ON cv.tenant_id = d.tenant_id AND cv.id = d.conversa_id
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE d.tenant_id = tenant_atual()
           AND d.criado_em >= (${lim.inicio}::date::timestamp AT TIME ZONE ${fuso}::text)
           AND d.criado_em <  (${lim.fim}::date::timestamp AT TIME ZONE ${fuso}::text)
         GROUP BY d.conversa_id, ct.nome
        HAVING sum(d.custo_centavos) > 0
         ORDER BY sum(d.custo_centavos) DESC, d.conversa_id
         LIMIT 10`

      const idsCampanha = [...new Set(linhas.filter((l) => l.fonte === 'whatsapp' && l.campanha_id !== NIL).map((l) => l.campanha_id))]
      const campanhas = idsCampanha.length === 0 ? [] : await tx<{ id: string; nome: string }[]>`
        SELECT id, nome FROM campanha WHERE tenant_id = tenant_atual() AND id IN ${tx(idsCampanha)}`

      return { mes, hoje, lim, linhas, precoLinhas, orcamento: orc?.mensal ?? null, caras, campanhas }
    })

    const preco = precosEfetivos(r.precoLinhas)
    const soma = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0)
    const wa = r.linhas.filter((l) => l.fonte === 'whatsapp')
    const ia = r.linhas.filter((l) => l.fonte === 'ia')
    const tr = r.linhas.filter((l) => l.fonte === 'transcricao')

    const porCategoria = CATEGORIAS_WHATSAPP.map((categoria) => {
      const mensagens = soma(wa.filter((l) => l.categoria === categoria), (l) => Number(l.quantidade))
      return { categoria, mensagens, custoCentavos: custoWhatsapp(mensagens, preco[categoria]) }
    })
    const totalWa = soma(porCategoria, (c) => c.custoCentavos)
    const custoLinhaWa = (l: LinhaConsumo) => custoWhatsapp(Number(l.quantidade), preco[l.categoria as keyof typeof preco] ?? 0)

    const agrupar = (chave: (l: LinhaConsumo) => string) => {
      const m = new Map<string, { turnos: number; custoCentavos: number }>()
      for (const l of ia) {
        const k = chave(l)
        const a = m.get(k) ?? { turnos: 0, custoCentavos: 0 }
        a.turnos += Number(l.quantidade); a.custoCentavos += Number(l.custo)
        m.set(k, a)
      }
      return [...m.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.custoCentavos - a.custoCentavos || a.k.localeCompare(b.k))
    }
    const totalIa = soma(ia, (l) => Number(l.custo))
    const orcamento = r.orcamento === null ? null : Number(r.orcamento)

    const segundos = soma(tr, (l) => Number(l.quantidade))
    const totalTr = custoTranscricao(segundos)

    // Série diária: todos os dias do mês, com zero onde não houve consumo.
    const serie = new Map<string, { whatsappCentavos: number; iaCentavos: number; transcricaoCentavos: number }>()
    const dias = r.lim.dias
    for (let d = 1; d <= dias; d += 1) serie.set(`${r.mes}-${String(d).padStart(2, '0')}`, { whatsappCentavos: 0, iaCentavos: 0, transcricaoCentavos: 0 })
    for (const l of r.linhas) {
      const s = serie.get(l.dia)
      if (!s) continue
      if (l.fonte === 'whatsapp') s.whatsappCentavos += custoLinhaWa(l)
      else if (l.fonte === 'ia') s.iaCentavos += Number(l.custo)
      else if (l.fonte === 'transcricao') s.transcricaoCentavos += custoTranscricao(Number(l.quantidade))
    }

    const nomeCampanha = new Map(r.campanhas.map((c) => [c.id, c.nome]))
    const porCampanha = new Map<string, { mensagens: number; custoCentavos: number }>()
    for (const l of wa) {
      if (l.campanha_id === NIL) continue
      const a = porCampanha.get(l.campanha_id) ?? { mensagens: 0, custoCentavos: 0 }
      a.mensagens += Number(l.quantidade); a.custoCentavos += custoLinhaWa(l)
      porCampanha.set(l.campanha_id, a)
    }

    return reply.send({
      mes: r.mes,
      whatsapp: { porCategoria, totalCentavos: totalWa },
      ia: {
        porFinalidade: agrupar((l) => l.categoria).map((x) => ({ finalidade: x.k, turnos: x.turnos, custoCentavos: x.custoCentavos })),
        porModelo: agrupar((l) => l.modelo || 'desconhecido').map((x) => ({ modelo: x.k, turnos: x.turnos, custoCentavos: x.custoCentavos })),
        totalCentavos: totalIa,
        orcamentoCentavos: orcamento,
        projecaoCentavos: projetarMes(totalIa, r.mes, r.hoje),
        alerta: alertaDoOrcamento(totalIa, orcamento),
      },
      transcricao: { minutos: Math.round(segundos / 6) / 10, custoCentavos: totalTr },
      serieDiaria: [...serie.entries()].map(([dia, v]) => ({ dia, ...v })),
      porCampanha: [...porCampanha.entries()]
        .map(([id, v]) => ({ campanhaId: id, nome: nomeCampanha.get(id) ?? 'Campanha removida', ...v }))
        .sort((a, b) => b.custoCentavos - a.custoCentavos || b.mensagens - a.mensagens || a.campanhaId.localeCompare(b.campanhaId))
        .slice(0, 10),
      conversasMaisCaras: r.caras.map((c) => ({ conversaId: c.conversa_id, contatoNome: c.nome ?? 'Sem nome', custoCentavos: Number(c.custo) })),
      precosPadrao: r.precoLinhas.length === 0,
    })
  })
}
