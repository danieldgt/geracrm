import {
  avaliarFase, diasUteisEntre, ehModoAgente, faseDoModo, indisponivel, janelaDaFase, medido, semanaDaData, deslocarSemana,
  FONTES_DA_FASE, MODO_DA_FASE, ROTULO_FASE,
  type FaseAgente, type FonteMedida, type GoLiveDto, type MedidasFase, type MetricaSlaHandoff, type ModoAgente,
} from '@geracrm/shared'
import { emSavepoint, type Sql } from '../../../db/index.js'
import { momentoNoFuso } from '../../plataforma/fuso.js'
import { respostaHumanaDoAtendimento } from '../sla-handoff.js'
import { concordancia } from './revisao-humana.js'
import { metricasSugestoes } from './sugestao.js'
import { lerFatosDoModo, modoEfetivoDoCanal } from './pipeline/modo-efetivo.js'

/**
 * GO-LIVE (raia P19): COLETA as medidas de cada critério de fase e entrega à
 * avaliação PURA (`avaliarFase`, shared). Aqui só há leitura — o painel nunca
 * muda o modo (isso é a tela da P14, com confirmação e auditoria).
 *
 * ⚠️ Cada fonte roda no próprio SAVEPOINT: uma fonte que falha vira critério
 *    "indisponível" com o motivo, e as outras seguem (degrada, não quebra).
 * ⚠️ Só as fontes da fase atual são lidas (`FONTES_DA_FASE`).
 * ⚠️ Tudo sob RLS do tenant (tx de `req.comTenant`), filtrado pelo número.
 */

const DIA_MS = 86_400_000
const MAX_SEMANAS_CONCORDANCIA = 13

export interface ContextoColeta {
  readonly canalId: string
  readonly agora: Date
  readonly fuso: string | null
  /** O modo de `agente_decisao` que a fase produz. */
  readonly modo: ModoAgente | 'simulacao'
  /** Início da janela das medidas. */
  readonly desde: Date
  /** Início da janela do "0 CRÍTICA" (14 dias no recorte, 30 no amplo). */
  readonly desdeCritica: Date
  readonly janelaDias: number
}

type Coletor<K extends FonteMedida> = (tx: Sql, c: ContextoColeta) => Promise<MedidasFase[K]>
export type Coletores = { readonly [K in FonteMedida]: Coletor<K> }

/** As fontes padrão. Exportadas para o teste trocar uma por uma que falha. */
export const COLETORES: Coletores = {
  async douradas() {
    return indisponivel('Os evals (suíte do CI e pnpm agente:avaliar) não gravam resultado no banco — confira a última rodada antes de avançar.')
  },
  async smoke() {
    return indisponivel('O smoke (pnpm agente:smoke) roda por script e não grava resultado no banco — rode e confira antes de avançar.')
  },
  async playground() {
    return indisponivel('O playground guarda uma conversa por número e apaga as decisões ao reiniciar: a contagem de conversas testadas não fica no banco — confira à mão.')
  },

  async volume(tx, c) {
    const [r] = await tx<{ turnos: number; conversas: number }[]>`
      SELECT count(*)::int AS turnos, count(DISTINCT d.conversa_id)::int AS conversas
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde}`
    return medido({ turnos: r?.turnos ?? 0, conversas: r?.conversas ?? 0 })
  },

  async criticas(tx, c) {
    // O que ESCAPOU (P12): `pior_gravidade` já ignora as marcas corrigidas pelo pipeline.
    const [r] = await tx<{ n: number }[]>`
      SELECT count(DISTINCT a.decisao_id)::int AS n FROM agente_avaliacao a
       WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId}
         AND a.pior_gravidade = 'CRITICA' AND a.criado_em >= ${c.desdeCritica}`
    return medido(r?.n ?? 0)
  },

  async notaJuiz(tx, c) {
    const [r] = await tx<{ media: string | null; n: number }[]>`
      SELECT round(avg(a.nota_media), 2)::text AS media, count(*)::int AS n FROM agente_avaliacao a
       WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId} AND a.tipo = 'juiz'
         AND a.nota_media IS NOT NULL AND a.erro IS NULL AND a.criado_em >= ${c.desde}`
    return medido({ media: r?.media == null ? null : Number(r.media), avaliadas: r?.n ?? 0 })
  },

  async concordancia(tx, c) {
    const semanas = semanasDaJanela(c.desde, c.agora, c.fuso)
    const t = (await concordancia(tx, { semanas, canalId: c.canalId })).total
    return medido({
      valor: t.concordancia, comparaveis: t.conversasComparaveis,
      falsosNegativosCritica: t.falsosNegativosCritica, atingeMeta: t.atingeMeta,
    })
  },

  async similaridadeSombra(tx, c) {
    const m = await metricasSugestoes(tx, c.janelaDias, c.canalId)
    return medido({ comparados: m.sombra.comparados, taxaAcima: m.sombra.taxaAcimaDoLimiar })
  },

  async sugestoes(tx, c) {
    const a = (await metricasSugestoes(tx, c.janelaDias, c.canalId)).assistido
    return medido({ geradas: a.geradas, usadas: a.enviadas + a.editadas, taxaUso: a.taxaUso, taxaSemEdicao: a.taxaSemEdicao })
  },

  async custoPorConversa(tx, c) {
    const [r] = await tx<{ custo: string; conversas: number }[]>`
      SELECT coalesce(sum(d.custo_centavos), 0)::text AS custo, count(DISTINCT d.conversa_id)::int AS conversas
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde}`
    const conversas = r?.conversas ?? 0
    return medido({ centavos: conversas ? Math.round(Number(r!.custo) / conversas) : null, conversas })
  },

  async numerosBloqueados(tx, c) {
    // R$ sem fonte (numeros_bloqueados) + número de negócio sem fonte substituído (P7).
    const [r] = await tx<{ turnos: number; com: number }[]>`
      SELECT count(*)::int AS turnos,
             count(*) FILTER (WHERE jsonb_array_length(d.numeros_bloqueados) > 0
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.guardrails) g
                            WHERE g->>'etapa' = 'numeros-ampliados' AND g->>'acao' IN ('substituido', 'bloqueado')))::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.resposta IS NOT NULL AND d.criado_em >= ${c.desde}`
    return medido({ turnos: r?.turnos ?? 0, comBloqueio: r?.com ?? 0 })
  },

  async latenciaPrimeira(tx, c) {
    // A 1ª resposta ENVIADA de cada sessão do agente na janela.
    const [r] = await tx<{ p95: number | null; n: number }[]>`
      SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latencia_ms)::int AS p95, count(*)::int AS n
        FROM (SELECT DISTINCT ON (d.sessao_id) d.latencia_ms
                FROM agente_decisao d
               WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
                 AND d.enviada AND d.sessao_id IS NOT NULL AND d.criado_em >= ${c.desde}
               ORDER BY d.sessao_id, d.criado_em) s
       WHERE s.latencia_ms IS NOT NULL`
    return medido({ p95Ms: r?.p95 ?? null, amostras: r?.n ?? 0 })
  },

  async handoff(tx, c) {
    const [r] = await tx<{ conversas: number; com: number }[]>`
      SELECT count(DISTINCT d.conversa_id)::int AS conversas,
             count(DISTINCT d.conversa_id) FILTER (WHERE d.desfecho = 'handoff')::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde}`
    return medido({ conversas: r?.conversas ?? 0, comHandoff: r?.com ?? 0 })
  },

  async optOut(tx, c) {
    // O gatilho de opt-out (P4) marca a decisão: `gatilhos-entrada/opt_out` (ou o pedido de exclusão LGPD).
    const [r] = await tx<{ conversas: number; com: number }[]>`
      SELECT count(DISTINCT d.conversa_id)::int AS conversas,
             count(DISTINCT d.conversa_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM jsonb_array_elements(d.guardrails) g
                WHERE g->>'etapa' = 'gatilhos-entrada' AND g->>'codigo' IN ('opt_out', 'lgpd_exclusao')))::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
         AND d.criado_em >= ${c.desde}`
    return medido({ conversas: r?.conversas ?? 0, comOptOut: r?.com ?? 0 })
  },

  async conversao(tx, c) {
    // Coorte do AGENTE: conversas do número em que ele atuou em autônomo na janela.
    // Coorte HUMANA: as demais conversas do número com cliente falando na janela
    // (fora do recorte, ou atendidas só por gente). Sem a conversa de simulação.
    // Convertida: pedido confirmado pelo cliente ou efetivado, criado na janela.
    const [r] = await tx<{ ag: number; ag_c: number; hu: number; hu_c: number }[]>`
      WITH ag AS (
        SELECT DISTINCT d.conversa_id AS id FROM agente_decisao d
         WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
           AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde}),
      hu AS (
        SELECT cv.id FROM conversa cv
          LEFT JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
         WHERE cv.tenant_id = tenant_atual() AND cv.canal_id = ${c.canalId} AND cv.ultima_entrante_em >= ${c.desde}
           AND ct.origem_carga IS DISTINCT FROM 'simulacao'
           AND NOT EXISTS (SELECT 1 FROM ag WHERE ag.id = cv.id)),
      cv AS (
        SELECT DISTINCT p.conversa_id AS id FROM pedido p
         WHERE p.tenant_id = tenant_atual() AND p.conversa_id IS NOT NULL AND p.criado_em >= ${c.desde}
           AND (p.confirmado_em IS NOT NULL OR p.estado = 'efetivado'))
      SELECT (SELECT count(*) FROM ag)::int AS ag,
             (SELECT count(*) FROM ag JOIN cv USING (id))::int AS ag_c,
             (SELECT count(*) FROM hu)::int AS hu,
             (SELECT count(*) FROM hu JOIN cv USING (id))::int AS hu_c`
    return medido({
      agente: { conversas: r?.ag ?? 0, convertidas: r?.ag_c ?? 0 },
      humano: { conversas: r?.hu ?? 0, convertidas: r?.hu_c ?? 0 },
    })
  },

  async pedidosErrados(tx, c) {
    // Proxy de "confirmado errado": pedido montado pelo agente, CONFIRMADO pelo cliente
    // e cancelado depois (alguém desfez o que o agente fechou). Não há registro de
    // "erro do pedido" no domínio; o cancelamento após a confirmação é o sinal que existe.
    const [r] = await tx<{ confirmados: number; cancelados: number }[]>`
      SELECT count(*)::int AS confirmados,
             count(*) FILTER (WHERE p.estado = 'cancelado' AND p.cancelado_em >= p.confirmado_em)::int AS cancelados
        FROM pedido p
        JOIN conversa cv ON cv.tenant_id = p.tenant_id AND cv.id = p.conversa_id
       WHERE p.tenant_id = tenant_atual() AND cv.canal_id = ${c.canalId} AND p.origem = 'agente'
         AND p.confirmado_em IS NOT NULL AND p.confirmado_em >= ${c.desde}`
    return medido({ confirmados: r?.confirmados ?? 0, cancelados: r?.cancelados ?? 0 })
  },

  async slaHandoff(tx, c) {
    // A mesma régua do bloco `slaHandoff` de /v1/performance (P18), só deste número.
    const [h] = await tx<{ medidos: number; cumpridos: number; estourados: number; pendentes: number; respondidos: number }[]>`
      SELECT count(*) FILTER (WHERE resp IS NOT NULL OR estourado_em IS NOT NULL OR vence <= now())::int AS medidos,
             count(*) FILTER (WHERE resp IS NOT NULL AND resp <= vence)::int AS cumpridos,
             count(*) FILTER (WHERE (resp IS NOT NULL AND resp > vence)
                                 OR (resp IS NULL AND (estourado_em IS NOT NULL OR vence <= now())))::int AS estourados,
             count(*) FILTER (WHERE resp IS NULL AND estourado_em IS NULL AND vence > now() AND estado <> 'encerrado')::int AS pendentes,
             count(*) FILTER (WHERE resp IS NOT NULL)::int AS respondidos
        FROM (SELECT a.sla_vence_em AS vence, a.sla_estourado_em AS estourado_em, a.estado,
                     coalesce(a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)}) AS resp
                FROM atendimento a
               WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId}
                 AND a.sla_vence_em IS NOT NULL AND a.sla_inicio_em >= ${c.desde}) s`
    const m: MetricaSlaHandoff = {
      medidos: h?.medidos ?? 0, cumpridos: h?.cumpridos ?? 0, estourados: h?.estourados ?? 0,
      pendentes: h?.pendentes ?? 0, respondidos: h?.respondidos ?? 0,
      pctCumprido: h?.medidos ? Math.round((h.cumpridos / h.medidos) * 100) : null,
    }
    // Sem handoff decidido na janela não há o que medir: indisponível, com o motivo.
    if (m.medidos === 0) {
      return indisponivel(m.pendentes > 0
        ? `Nenhum handoff com SLA decidido na janela (${m.pendentes} ainda no prazo).`
        : 'Nenhum handoff com SLA na janela.')
    }
    return medido(m)
  },
}

/** As semanas ISO (no fuso da loja) que a janela toca, da mais antiga à atual. */
export function semanasDaJanela(desde: Date, agora: Date, fuso: string | null): string[] {
  const fim = semanaDaData(momentoNoFuso(agora, fuso).data)
  if (!fim) return []
  const ini = semanaDaData(momentoNoFuso(desde, fuso).data) ?? fim
  const semanas: string[] = [fim]
  let s = fim
  while (s !== ini && semanas.length < MAX_SEMANAS_CONCORDANCIA) {
    const anterior = deslocarSemana(s, -1)
    if (!anterior) break
    semanas.unshift(anterior)
    s = anterior
  }
  return semanas
}

/**
 * Quando a fase começou: a última mudança AUDITADA de modo/recorte do número,
 * ou do teto do tenant (que também muda a fase). ⚠️ Conservador: qualquer
 * mudança dessas recomeça a contagem. Sem auditoria (configuração anterior à
 * P14), estima pela 1ª decisão no modo da fase nos últimos 90 dias.
 */
async function inicioDaFase(tx: Sql, canalId: string, modo: ModoAgente | 'simulacao', agora: Date): Promise<{ inicio: Date | null; estimado: boolean }> {
  const [a] = await tx<{ em: Date | null }[]>`
    SELECT max(criado_em) AS em FROM auditoria
     WHERE tenant_id = tenant_atual() AND acao = 'agente.config_alterada'
       AND ((entidade = 'agente_config' AND entidade_id = ${canalId}
             AND (dados->'campos' ?| array['modo', 'recorte'] OR dados->>'criacao' = 'true'))
            OR entidade = 'agente_tenant')`
  if (a?.em) return { inicio: new Date(a.em), estimado: false }
  const [d] = await tx<{ em: Date | null }[]>`
    SELECT min(criado_em) AS em FROM agente_decisao
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND modo = ${modo}
       AND criado_em >= ${new Date(agora.getTime() - 90 * DIA_MS)}`
  return { inicio: d?.em ? new Date(d.em) : null, estimado: true }
}

/**
 * O painel de go-live de um número. null = número inexistente (ou de outro
 * tenant: invisível pelo RLS).
 */
export async function coletarGoLive(
  tx: Sql, p: { canalId: string; agora: Date }, coletores: Coletores = COLETORES,
): Promise<GoLiveDto | null> {
  const [canal] = await tx<{ id: string; fuso: string | null }[]>`
    SELECT cc.id, (SELECT fuso FROM tenant WHERE id = tenant_atual()) AS fuso
      FROM canal_conectado cc WHERE cc.tenant_id = tenant_atual() AND cc.id = ${p.canalId}`
  if (!canal) return null

  const [cfg] = await tx<{ modo: string; recorte: unknown }[]>`
    SELECT modo, recorte FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId}`
  const modoNumero: ModoAgente = cfg && ehModoAgente(cfg.modo) ? cfg.modo : 'desligado'
  const fatos = await lerFatosDoModo(tx, p.agora, p.canalId)
  const fase: FaseAgente = faseDoModo({ modoNumero, modoTenant: fatos.modoTenant, recorte: cfg?.recorte ?? null })
  const agora = await modoEfetivoDoCanal(tx, { canalId: p.canalId, agora: p.agora })

  const modo = MODO_DA_FASE[fase]
  const { inicio, estimado } = await inicioDaFase(tx, p.canalId, modo, p.agora)
  const dias = inicio ? Math.max(0, Math.floor((p.agora.getTime() - inicio.getTime()) / DIA_MS)) : 0
  const diasUteis = inicio ? diasUteisEntre(momentoNoFuso(inicio, canal.fuso).data, momentoNoFuso(p.agora, canal.fuso).data) : 0
  const janela = janelaDaFase(fase, dias)
  const ctx: ContextoColeta = {
    canalId: p.canalId, agora: p.agora, fuso: canal.fuso, modo,
    desde: new Date(p.agora.getTime() - janela.dias * DIA_MS),
    desdeCritica: new Date(p.agora.getTime() - janela.diasCritica * DIA_MS),
    janelaDias: janela.dias,
  }

  const medidas: Partial<Record<FonteMedida, MedidasFase[FonteMedida]>> = {}
  for (const fonte of FONTES_DA_FASE[fase]) {
    try {
      medidas[fonte] = await emSavepoint(tx, (sp) => (coletores[fonte] as Coletor<typeof fonte>)(sp, ctx))
    } catch (e) {
      // Degrada visível: o critério diz que a fonte falhou; os outros seguem.
      console.warn(JSON.stringify({ evento: 'go_live.fonte_falhou', fonte, canalId: p.canalId, erro: e instanceof Error ? e.message.slice(0, 200) : 'desconhecido' }))
      medidas[fonte] = indisponivel('A fonte não respondeu agora. Tente de novo; se persistir, avise o suporte.')
    }
  }

  const r = avaliarFase({ fase, diasCorridos: dias, diasUteis, medidas: medidas as Partial<MedidasFase> })
  return {
    ...r,
    canalId: p.canalId, rotuloFase: ROTULO_FASE[fase],
    dias, diasUteis, inicioFase: inicio ? inicio.toISOString() : null, inicioEstimado: estimado,
    janelaDias: janela.dias,
    modoAgora: { modo: agora.modo, origem: agora.origem, motivo: agora.motivo },
    alvosProposta: true,
  }
}
