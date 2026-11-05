import type { Sql } from '../../db/index.js'
import type { PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoConversa, type Escopo } from './escopo.js'
import { diasDoPeriodo } from './relatorios-vendas.js'

/**
 * RELATÓRIO WHATSAPP (raia E2) — `GET /v1/relatorios/whatsapp?inicio&fim&limiteMin=5`.
 *
 * Só canais WhatsApp (oficial e não-oficial); Instagram e TikTok ficam fora. Período no fuso do tenant;
 * escopo da D3 pela CONVERSA (`condicaoConversa`, alias `cv`).
 *
 * ⚠️ A 1ª resposta lê os MARCOS já gravados em `atendimento` (0012) — a mesma fonte de
 * `rotas-performance.ts` — e a ressalva dela vale aqui: a resposta automática NÃO conta como humana.
 *   humano      = `primeira_resposta_humana_em - primeira_entrante_em` (resposta de GENTE);
 *   automatico  = `primeira_resposta_em - primeira_entrante_em`, só quando a 1ª resposta foi sem autor
 *                 (agente, ausência, automação): veio antes da humana, ou não houve humana.
 * Coorte: atendimentos CRIADOS no período com `primeira_entrante_em`.
 * `pctNoLimite` = respondidos por gente em até `limiteMin` minutos / atendimentos da coorte (0..1; null sem coorte).
 *
 * Mensagens: `tipo = 'sistema'` (handoff, devolução, notas internas) NÃO é mensagem de ninguém e fica fora de tudo.
 * `enviadas` exclui as que FALHARAM (`status = 'falhou'`: não chegaram ao cliente) — elas vão no cartão `falhas`.
 * 1ª resposta anterior à chegada (relógio/dado inconsistente) é descartada: nunca há tempo negativo.
 * O escopo é aplicado UMA vez por conversa (CTE `vis`, materializada fora do escopo "tudo"), não por mensagem.
 *
 * Mensagens por dia: `mensagem` é particionada por `criado_em`; a consulta sempre leva o intervalo do período
 * (máx. 366 dias) — poda de partição + índice (tenant_id, criado_em). Sem view materializada nesta leva: o
 * escopo por conversa não cabe numa MV (sem RLS) e o período é sempre limitado. Reavaliar se o volume pedir.
 */
export const LIMITE_MIN_PADRAO = 5
export const LIMITE_MIN_MAX = 1440

/** Valida `limiteMin` (inteiro 1..1440). Ausente = padrão. null = inválido. */
export function lerLimiteMin(v: string | undefined): number | null {
  if (v === undefined) return LIMITE_MIN_PADRAO
  if (!/^\d{1,4}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= LIMITE_MIN_MAX ? n : null
}

export interface DiaMensagens { readonly dia: string; readonly recebidas: number; readonly enviadas: number }
export interface PrimeiraResposta {
  readonly autor: 'humano' | 'automatico'
  readonly atendimentos: number
  readonly p50Seg: number | null
  readonly p95Seg: number | null
}
export interface CartoesWhatsapp {
  readonly recebidas: number
  readonly enviadas: number
  readonly enviadasHumanas: number
  readonly enviadasAutomaticas: number
  /** Saídas que falharam (status 'falhou'): fora de `enviadas`. */
  readonly falhas: number
  readonly conversasIniciadas: number
  readonly atendimentos: number
  readonly respondidasNoLimite: number
  readonly pctNoLimite: number | null
}


const arred = (v: number | null): number | null => (v === null ? null : Math.round(v))

/** Conversas WhatsApp visíveis no escopo (alias `vis`). Fora do escopo "tudo" materializa; no "tudo" o planner inlina. */
function conversasVisiveis(tx: Sql, escopo: Escopo) {
  const materializar = escopo.tipo === 'tudo' ? tx`NOT MATERIALIZED` : tx`MATERIALIZED`
  return tx`vis AS ${materializar} (
    SELECT cv.id, cv.criado_em
      FROM conversa cv
      JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
     WHERE cv.tenant_id = tenant_atual() AND cc.tipo LIKE 'whatsapp%'
       AND ${condicaoConversa(tx, escopo)})`
}

export async function relatorioWhatsapp(
  tx: Sql, p: PeriodoResolvido, escopo: Escopo, limiteMin: number,
): Promise<{ cartoes: CartoesWhatsapp; porDia: DiaMensagens[]; primeiraResposta: PrimeiraResposta[] }> {
  const dias = await tx<{ dia: string; recebidas: number; enviadas: number; humanas: number; falhas: number }[]>`
    WITH ${conversasVisiveis(tx, escopo)}
    SELECT to_char(m.criado_em AT TIME ZONE ${p.fuso}::text, 'YYYY-MM-DD') AS dia,
           count(*) FILTER (WHERE m.direcao = 'entrante')::int AS recebidas,
           count(*) FILTER (WHERE m.direcao = 'saliente' AND m.status IS DISTINCT FROM 'falhou')::int AS enviadas,
           count(*) FILTER (WHERE m.direcao = 'saliente' AND m.status IS DISTINCT FROM 'falhou'
                              AND m.enviada_por_id IS NOT NULL)::int AS humanas,
           count(*) FILTER (WHERE m.direcao = 'saliente' AND m.status = 'falhou')::int AS falhas
      FROM mensagem m
      JOIN vis ON vis.id = m.conversa_id
     WHERE m.tenant_id = tenant_atual() AND m.criado_em >= ${p.desde} AND m.criado_em < ${p.ate}
       AND m.tipo <> 'sistema'
     GROUP BY 1`
  const porDia = new Map(dias.map((d) => [d.dia, d]))

  const [iniciadas] = await tx<{ n: number }[]>`
    WITH ${conversasVisiveis(tx, escopo)}
    SELECT count(*)::int AS n FROM vis WHERE vis.criado_em >= ${p.desde} AND vis.criado_em < ${p.ate}`

  const [r] = await tx<{
    base: number; no_limite: number
    n_h: number; h50: number | null; h95: number | null
    n_a: number; a50: number | null; a95: number | null
  }[]>`
    WITH ${conversasVisiveis(tx, escopo)},
    coorte AS (
      SELECT a.primeira_entrante_em AS entrou,
             CASE WHEN a.primeira_resposta_em >= a.primeira_entrante_em THEN a.primeira_resposta_em END AS qualquer,
             CASE WHEN a.primeira_resposta_humana_em >= a.primeira_entrante_em THEN a.primeira_resposta_humana_em END AS humana
        FROM atendimento a
        JOIN vis ON vis.id = a.conversa_id
       WHERE a.tenant_id = tenant_atual() AND a.criado_em >= ${p.desde} AND a.criado_em < ${p.ate}
         AND a.primeira_entrante_em IS NOT NULL
    )
    SELECT count(*)::int AS base,
           count(*) FILTER (WHERE humana IS NOT NULL
                              AND humana - entrou <= (${limiteMin} || ' minutes')::interval)::int AS no_limite,
           count(*) FILTER (WHERE humana IS NOT NULL)::int AS n_h,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (humana - entrou))) FILTER (WHERE humana IS NOT NULL) AS h50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (humana - entrou))) FILTER (WHERE humana IS NOT NULL) AS h95,
           count(*) FILTER (WHERE qualquer IS NOT NULL AND (humana IS NULL OR qualquer < humana))::int AS n_a,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (qualquer - entrou)))
             FILTER (WHERE qualquer IS NOT NULL AND (humana IS NULL OR qualquer < humana)) AS a50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (qualquer - entrou)))
             FILTER (WHERE qualquer IS NOT NULL AND (humana IS NULL OR qualquer < humana)) AS a95
      FROM coorte`

  const serie = diasDoPeriodo(p.inicio, p.fim).map((dia): DiaMensagens => ({
    dia, recebidas: porDia.get(dia)?.recebidas ?? 0, enviadas: porDia.get(dia)?.enviadas ?? 0,
  }))
  const recebidas = serie.reduce((s, d) => s + d.recebidas, 0)
  const enviadas = serie.reduce((s, d) => s + d.enviadas, 0)
  const humanas = dias.reduce((s, d) => s + d.humanas, 0)
  const falhas = dias.reduce((s, d) => s + d.falhas, 0)
  const base = r?.base ?? 0
  const noLimite = r?.no_limite ?? 0
  return {
    cartoes: {
      recebidas, enviadas, enviadasHumanas: humanas, enviadasAutomaticas: enviadas - humanas, falhas,
      conversasIniciadas: iniciadas?.n ?? 0, atendimentos: base, respondidasNoLimite: noLimite,
      pctNoLimite: base > 0 ? Math.round((noLimite / base) * 10_000) / 10_000 : null,
    },
    porDia: serie,
    primeiraResposta: [
      { autor: 'humano', atendimentos: r?.n_h ?? 0, p50Seg: arred(r?.h50 ?? null), p95Seg: arred(r?.h95 ?? null) },
      { autor: 'automatico', atendimentos: r?.n_a ?? 0, p50Seg: arred(r?.a50 ?? null), p95Seg: arred(r?.a95 ?? null) },
    ],
  }
}
