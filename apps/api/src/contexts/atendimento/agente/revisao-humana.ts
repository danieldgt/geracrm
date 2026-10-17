import { randomUUID } from 'node:crypto'
import {
  CRITERIOS_RUBRICA, calcularConcordancia, mascararTextoQualidade, ordenarAmostraSemanal, segundaDaSemana, semanaDaData,
  somarConcordancia,
  type ConcordanciaNumeroDto, type RevisaoValidada, type CriterioRubrica, type DecisaoRevisao, type DetalheRevisaoDto,
  type FalaRevisao, type GravidadeQualidade, type ItemAmostraRevisaoDto, type MotivoAmostra, type NotasDoJuiz,
  type NotasHumanas, type OrigemAvaliacao, type RevisaoDto, type RevisaoParaSomar, type SomaConcordancia,
  type VereditoRevisao, type ViolacaoQualidade,
} from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'
import { fusoSeguro, momentoNoFuso } from '../../plataforma/fuso.js'
import { transcricaoDaSessao } from './qualidade/avaliacao.js'

/**
 * REVISÃO HUMANA E CONCORDÂNCIA (ADR-031 §5, raia P16) — o lado do banco.
 * Tudo roda DENTRO de `req.comTenant` (RLS): nenhuma função aceita tenant.
 *
 *   semanaDaLoja       — a semana ISO (AAAA-Www) e o intervalo [ini, fim) no fuso da loja
 *   amostraDaSemana    — as 20 conversas do número, na ordem da P12 (a MESMA do CSV)
 *   itensDaAmostra     — a amostra com a avaliação a revisar, notas do juiz e "revisada ou não"
 *   detalheParaRevisar — transcrição mascarada (em sombra, a SUGESTÃO), notas e violações
 *   gravarRevisao      — upsert por (avaliação, revisor) com a concordância congelada
 *   concordancia       — a soma por número de uma ou mais semanas (a P19 consome)
 */

const peso = (col: string): string => `CASE ${col} WHEN 'CRITICA' THEN 3 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 1 ELSE 0 END`
const PESO_SQL = peso('pior_gravidade')
const PESO_A = peso('a.pior_gravidade')

export interface SemanaDaLoja {
  readonly semana: string
  /** Segunda-feira, AAAA-MM-DD. */
  readonly inicio: string
  readonly ini: Date
  readonly fim: Date
  readonly fuso: string
}

/**
 * A semana no fuso da loja: a pedida (AAAA-Www) ou a de hoje. null = semana inválida.
 * O rótulo é a semente das aleatórias — o mesmo do CSV da P12 para a mesma semana.
 */
export async function semanaDaLoja(tx: Sql, semana: string | undefined, agora = new Date()): Promise<SemanaDaLoja | null> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const rotulo = semana ?? semanaDaData(momentoNoFuso(agora, fuso).data)
  const inicio = rotulo ? segundaDaSemana(rotulo) : null
  if (!rotulo || !inicio) return null
  const [s] = await tx<{ ini: Date; fim: Date }[]>`
    SELECT (${inicio}::date::timestamp AT TIME ZONE ${fuso}) AS ini,
           ((${inicio}::date + 7)::timestamp AT TIME ZONE ${fuso}) AS fim`
  return { semana: rotulo, inicio, ini: s!.ini, fim: s!.fim, fuso }
}

interface LinhaConversa {
  conversa_id: string; pior: string | null; menor_nota: string | null
  juiz_id: string | null; regras_id: string | null; origem: string
}

export type ItemDaAmostra = LinhaConversa & {
  readonly conversaId: string; readonly piorGravidade: GravidadeQualidade | null; readonly menorNota: number | null
  readonly motivo: MotivoAmostra
}

/**
 * As conversas do número na semana, na ordem da P12 (`ordenarAmostraSemanal`), com
 * a avaliação representativa: a do JUIZ com a menor nota (a que pôs a conversa na
 * amostra), ou — sem juiz — a de REGRAS mais grave. A consulta espelha a do CSV
 * (mesma ordenação e teto) para a amostra das duas sair igual.
 */
export async function amostraDaSemana(tx: Sql, canalId: string, s: SemanaDaLoja): Promise<ItemDaAmostra[]> {
  const linhas = await tx<LinhaConversa[]>`
    SELECT a.conversa_id,
           (array_agg(a.pior_gravidade ORDER BY ${tx.unsafe(PESO_A)} DESC))[1] AS pior,
           min(a.nota_media)::text AS menor_nota,
           (array_agg(a.id ORDER BY a.nota_media ASC, a.criado_em DESC, a.id) FILTER (WHERE a.tipo = 'juiz' AND a.notas IS NOT NULL))[1] AS juiz_id,
           (array_agg(a.id ORDER BY ${tx.unsafe(PESO_A)} DESC, a.criado_em DESC, a.id) FILTER (WHERE a.tipo = 'regras'))[1] AS regras_id,
           (array_agg(a.origem ORDER BY a.criado_em DESC))[1] AS origem
      FROM agente_avaliacao a
     WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${canalId}
       AND a.criado_em >= ${s.ini} AND a.criado_em < ${s.fim}
     GROUP BY a.conversa_id
     ORDER BY max(${tx.unsafe(PESO_A)}) DESC, min(a.nota_media) ASC NULLS LAST, a.conversa_id
     LIMIT 5000`
  return ordenarAmostraSemanal(linhas.map((l) => ({
    ...l, conversaId: l.conversa_id, piorGravidade: l.pior as GravidadeQualidade | null,
    menorNota: l.menor_nota === null ? null : Number(l.menor_nota),
  })), s.semana)
}

interface LinhaRevisao {
  id: string; avaliacao_id: string; revisor_id: string; revisor_nome: string; conversa_id: string; semana: string
  motivo: string | null; notas: Record<string, number>; gravidade: string | null; veredito: string; decisao: string
  responsavel: string | null; prazo: string | null; observacao: string | null; notas_llm: Record<string, number> | null
  gravidade_sistema: string | null; concordancia: Record<string, boolean | null>; concorda: boolean | null
  falso_negativo_critica: boolean; atualizado_em: Date
}

const COLUNAS_REVISAO = `r.id, r.avaliacao_id, r.revisor_id, u.nome AS revisor_nome, r.conversa_id, r.semana, r.motivo, r.notas,
  r.gravidade, r.veredito, r.decisao, r.responsavel, to_char(r.prazo, 'YYYY-MM-DD') AS prazo, r.observacao, r.notas_llm,
  r.gravidade_sistema, r.concordancia, r.concorda, r.falso_negativo_critica, r.atualizado_em`

function notasDoJuiz(n: Record<string, unknown> | null | undefined): NotasDoJuiz | null {
  if (!n) return null
  const out: Partial<Record<CriterioRubrica, number>> = {}
  for (const c of CRITERIOS_RUBRICA) if (typeof n[c] === 'number') out[c] = n[c] as number
  return out
}

function revisaoDto(l: LinhaRevisao): RevisaoDto {
  const porCriterio = Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, l.concordancia[c] ?? null])) as Record<CriterioRubrica, boolean | null>
  return {
    id: l.id, avaliacaoId: l.avaliacao_id, revisorId: l.revisor_id, revisorNome: l.revisor_nome, semana: l.semana,
    motivo: l.motivo as MotivoAmostra | null, notas: l.notas as NotasHumanas,
    gravidade: l.gravidade as GravidadeQualidade | null, veredito: l.veredito as VereditoRevisao,
    decisao: l.decisao as DecisaoRevisao, responsavel: l.responsavel, prazo: l.prazo, observacao: l.observacao,
    notasLlm: notasDoJuiz(l.notas_llm), gravidadeSistema: l.gravidade_sistema as GravidadeQualidade | null,
    porCriterio, concordaGravidade: l.concordancia['gravidade'] === true, concorda: l.concorda,
    falsoNegativoCritica: l.falso_negativo_critica, atualizadoEm: l.atualizado_em.toISOString(),
  }
}

/** A amostra pronta para a tela: avaliação a revisar, notas do juiz, a revisão de QUEM PEDE e quantos revisaram. */
export async function itensDaAmostra(tx: Sql, canalId: string, s: SemanaDaLoja, revisorId: string): Promise<ItemAmostraRevisaoDto[]> {
  const amostra = await amostraDaSemana(tx, canalId, s)
  if (amostra.length === 0) return []
  const conversas = amostra.map((i) => i.conversaId)
  const ids = amostra.map((i) => i.juiz_id ?? i.regras_id).filter((x): x is string => !!x)
  const notas = await tx<{ id: string; notas: Record<string, number> | null }[]>`
    SELECT id, notas FROM agente_avaliacao WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
  const minhas = await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.semana = ${s.semana} AND r.canal_id = ${canalId}
       AND r.revisor_id = ${revisorId} AND r.conversa_id = ANY(${conversas}::uuid[])
     ORDER BY r.atualizado_em DESC`
  const contagem = await tx<{ conversa_id: string; n: number }[]>`
    SELECT conversa_id, count(DISTINCT revisor_id)::int AS n FROM agente_revisao
     WHERE tenant_id = tenant_atual() AND semana = ${s.semana} AND canal_id = ${canalId} AND conversa_id = ANY(${conversas}::uuid[])
     GROUP BY conversa_id`
  const notasPorId = new Map(notas.map((n) => [n.id, n.notas]))
  return amostra.map((i, idx) => {
    // Revisão de quem pede: a da avaliação representativa, ou a de outra avaliação da mesma conversa
    // na semana (a representativa pode ter mudado depois — chegou um juiz com nota menor).
    const rep = (i.juiz_id ?? i.regras_id)!
    const minha = minhas.find((m) => m.conversa_id === i.conversaId && m.avaliacao_id === rep)
      ?? minhas.find((m) => m.conversa_id === i.conversaId)
    const avaliacaoId = minha?.avaliacao_id ?? rep
    return {
      ordem: idx + 1, motivo: i.motivo, conversaId: i.conversaId, canalId, avaliacaoId,
      origem: i.origem as OrigemAvaliacao, piorGravidade: i.piorGravidade, menorNota: i.menorNota,
      notasJuiz: minha ? notasDoJuiz(minha.notas_llm) : notasDoJuiz(notasPorId.get(rep)),
      revisao: minha ? revisaoDto(minha) : null,
      revisoes: contagem.find((c) => c.conversa_id === i.conversaId)?.n ?? 0,
    }
  })
}

interface LinhaAvaliacao {
  id: string; conversa_id: string; canal_id: string; sessao_id: string | null; origem: string; tipo: string
  notas: Record<string, number> | null; justificativas: Record<string, string> | null; semana: string
  ini: Date; fim: Date
}

/** A avaliação e a semana dela no fuso da loja (a semana é a da AVALIAÇÃO, não a de hoje). */
async function avaliacaoComSemana(tx: Sql, avaliacaoId: string): Promise<LinhaAvaliacao | null> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const [a] = await tx<LinhaAvaliacao[]>`
    SELECT a.id, a.conversa_id, a.canal_id, a.sessao_id, a.origem, a.tipo, a.notas, a.justificativas,
           to_char(a.criado_em AT TIME ZONE ${fuso}, 'IYYY-"W"IW') AS semana,
           (date_trunc('week', a.criado_em AT TIME ZONE ${fuso}) AT TIME ZONE ${fuso}) AS ini,
           ((date_trunc('week', a.criado_em AT TIME ZONE ${fuso}) + interval '7 days') AT TIME ZONE ${fuso}) AS fim
      FROM agente_avaliacao a WHERE a.tenant_id = tenant_atual() AND a.id = ${avaliacaoId}`
  return a ?? null
}

/** Pior gravidade que as regras registraram na conversa na semana (a que escapou; corrigidas não contam). */
async function gravidadeDoSistema(tx: Sql, a: LinhaAvaliacao): Promise<GravidadeQualidade | null> {
  const [g] = await tx<{ pior: string | null }[]>`
    SELECT (array_agg(pior_gravidade ORDER BY ${tx.unsafe(PESO_SQL)} DESC))[1] AS pior
      FROM agente_avaliacao
     WHERE tenant_id = tenant_atual() AND conversa_id = ${a.conversa_id} AND canal_id = ${a.canal_id}
       AND criado_em >= ${a.ini} AND criado_em < ${a.fim} AND pior_gravidade IS NOT NULL`
  return (g?.pior ?? null) as GravidadeQualidade | null
}

const AUTOR: ReadonlyArray<[string, FalaRevisao['autor']]> = [
  ['AGENTE (sugestão): ', 'sugestao'], ['AGENTE: ', 'agente'], ['CLIENTE: ', 'cliente'], ['VENDEDOR HUMANO: ', 'humano'],
]

/** A transcrição do juiz (já mascarada) em falas. Em sombra/assistido a fala do agente é a SUGESTÃO decidida. */
export function falasDaTranscricao(texto: string): { falas: FalaRevisao[]; cortada: boolean } {
  const falas: FalaRevisao[] = []
  let cortada = false
  for (const linha of texto.split('\n')) {
    if (linha === '[…]') { cortada = true; continue }
    const a = AUTOR.find(([p]) => linha.startsWith(p))
    if (a) falas.push({ autor: a[1], texto: mascararTextoQualidade(linha.slice(a[0].length)) })
    else if (falas.length > 0) {
      const ult = falas[falas.length - 1]!
      falas[falas.length - 1] = { ...ult, texto: `${ult.texto} ${mascararTextoQualidade(linha)}` }
    }
  }
  return { falas, cortada }
}

/** O que a tela mostra ao lado do formulário. null = avaliação não existe (ou é de outro tenant). */
export async function detalheParaRevisar(tx: Sql, avaliacaoId: string, revisorId: string): Promise<DetalheRevisaoDto | null> {
  const a = await avaliacaoComSemana(tx, avaliacaoId)
  if (!a) return null
  const t = a.sessao_id ? await transcricaoDaSessao(tx, a.sessao_id) : null
  const { falas, cortada } = t ? falasDaTranscricao(t.texto) : { falas: [], cortada: false }
  const violacoes = await tx<{ v: ViolacaoQualidade }[]>`
    SELECT v FROM agente_avaliacao a2, jsonb_array_elements(a2.violacoes) v
     WHERE a2.tenant_id = tenant_atual() AND a2.conversa_id = ${a.conversa_id} AND a2.canal_id = ${a.canal_id}
       AND a2.criado_em >= ${a.ini} AND a2.criado_em < ${a.fim} AND a2.tipo = 'regras'
       AND NOT coalesce((v->>'corrigida')::boolean, false)
     ORDER BY a2.criado_em
     LIMIT 50`
  const [minha] = await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.avaliacao_id = ${a.id} AND r.revisor_id = ${revisorId}`
  return {
    avaliacaoId: a.id, conversaId: a.conversa_id, canalId: a.canal_id, semana: a.semana, origem: a.origem as OrigemAvaliacao,
    transcricao: falas, cortada,
    notasJuiz: a.tipo === 'juiz' ? notasDoJuiz(a.notas) : null,
    justificativas: a.tipo === 'juiz' && a.justificativas
      ? Object.fromEntries(Object.entries(a.justificativas).map(([k, v]) => [k, mascararTextoQualidade(String(v))]))
      : null,
    gravidadeSistema: await gravidadeDoSistema(tx, a),
    violacoes: violacoes.map(({ v }) => ({ ...v, trecho: mascararTextoQualidade(v.trecho ?? '') })),
    revisao: minha ? revisaoDto(minha) : null,
  }
}

export type ResultadoGravacao =
  | { readonly tipo: 'gravada'; readonly criada: boolean; readonly revisao: RevisaoDto }
  | { readonly tipo: 'nao_encontrada' }

/**
 * Grava (ou regrava) a revisão do revisor sobre a avaliação. A concordância é
 * calculada AQUI e congelada com o que o sistema disse — notas do juiz DESTA
 * avaliação e a pior gravidade das regras na conversa naquela semana.
 */
export async function gravarRevisao(tx: Sql, corpo: RevisaoValidada, revisorId: string): Promise<ResultadoGravacao> {
  const a = await avaliacaoComSemana(tx, corpo.avaliacaoId)
  if (!a) return { tipo: 'nao_encontrada' }
  const notasLlm = a.tipo === 'juiz' ? notasDoJuiz(a.notas) : null
  const gravidadeSistema = await gravidadeDoSistema(tx, a)
  const r = calcularConcordancia({
    notasLlm, notasHumanas: corpo.notas, gravidadeSistema, gravidadeHumana: corpo.gravidade,
  })
  // Motivo da amostra daquela semana (null = a conversa não está na amostra; a revisão vale igual).
  const semana: SemanaDaLoja = { semana: a.semana, inicio: '', ini: a.ini, fim: a.fim, fuso: '' }
  const motivo = (await amostraDaSemana(tx, a.canal_id, semana)).find((i) => i.conversaId === a.conversa_id)?.motivo ?? null
  const concordancia = { ...r.porCriterio, gravidade: r.gravidade }
  const [l] = await tx<{ id: string; criada: boolean }[]>`
    INSERT INTO agente_revisao (tenant_id, id, avaliacao_id, revisor_id, conversa_id, canal_id, semana, motivo, notas, gravidade,
                                veredito, decisao, responsavel, prazo, observacao, notas_llm, gravidade_sistema, concordancia,
                                concorda, falso_negativo_critica)
    VALUES (tenant_atual(), ${randomUUID()}, ${a.id}, ${revisorId}, ${a.conversa_id}, ${a.canal_id}, ${a.semana}, ${motivo},
            ${JSON.stringify(corpo.notas)}::text::jsonb, ${corpo.gravidade}, ${corpo.veredito}, ${corpo.decisao},
            ${corpo.responsavel}, ${corpo.prazo}, ${corpo.observacao},
            ${notasLlm ? JSON.stringify(notasLlm) : null}::text::jsonb, ${gravidadeSistema},
            ${JSON.stringify(concordancia)}::text::jsonb, ${r.concorda}, ${r.falsoNegativoCritica})
    ON CONFLICT (tenant_id, avaliacao_id, revisor_id) DO UPDATE SET
      motivo = EXCLUDED.motivo, notas = EXCLUDED.notas, gravidade = EXCLUDED.gravidade, veredito = EXCLUDED.veredito,
      decisao = EXCLUDED.decisao, responsavel = EXCLUDED.responsavel, prazo = EXCLUDED.prazo, observacao = EXCLUDED.observacao,
      notas_llm = EXCLUDED.notas_llm, gravidade_sistema = EXCLUDED.gravidade_sistema, concordancia = EXCLUDED.concordancia,
      concorda = EXCLUDED.concorda, falso_negativo_critica = EXCLUDED.falso_negativo_critica, atualizado_em = now()
    RETURNING id, (xmax = 0) AS criada`
  const [linha] = await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.id = ${l!.id}`
  return { tipo: 'gravada', criada: l!.criada, revisao: revisaoDto(linha!) }
}

/**
 * A concordância das semanas pedidas, por número (e no total). É o contrato da
 * P19: `concordancia >= META_CONCORDANCIA` com `comparaveis >= MIN_REVISADAS_CONCORDANCIA`
 * e `falsosNegativosCritica === 0` (= `atingeMeta`). Sem papel aqui — quem chama decide.
 */
export async function concordancia(
  tx: Sql, p: { readonly semanas: readonly string[]; readonly canalId?: string | undefined },
): Promise<{ total: SomaConcordancia; porNumero: ConcordanciaNumeroDto[] }> {
  const linhas = await tx<{ canal_id: string; concordancia: Record<string, boolean | null>; concorda: boolean | null; motivo: string | null; falso_negativo_critica: boolean }[]>`
    SELECT canal_id, concordancia, concorda, motivo, falso_negativo_critica FROM agente_revisao
     WHERE tenant_id = tenant_atual() AND semana = ANY(${p.semanas as string[]}::text[])
       ${p.canalId ? tx`AND canal_id = ${p.canalId}` : tx``}`
  const canais = await tx<{ id: string; nome: string }[]>`
    SELECT id, nome_amigavel AS nome FROM canal_conectado
     WHERE tenant_id = tenant_atual()
       AND ${p.canalId ? tx`id = ${p.canalId}` : tx`id = ANY(${[...new Set(linhas.map((l) => l.canal_id))]}::uuid[])`}
     ORDER BY nome_amigavel, id`
  const paraSomar = (l: (typeof linhas)[number]): RevisaoParaSomar => ({
    concorda: l.concorda, motivo: l.motivo as MotivoAmostra | null, falsoNegativoCritica: l.falso_negativo_critica,
    gravidade: l.concordancia['gravidade'] === true,
    porCriterio: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, l.concordancia[c] ?? null])),
  })
  return {
    total: somarConcordancia(linhas.map(paraSomar)),
    porNumero: canais.map((c) => ({
      canalId: c.id, nome: mascararTextoQualidade(c.nome),
      ...somarConcordancia(linhas.filter((l) => l.canal_id === c.id).map(paraSomar)),
    })),
  }
}

/**
 * A planilha da semana do número (o modelo da AM, `planilha-revisao.csv`): uma
 * linha por item da amostra × revisor (sem revisão, uma linha com as colunas
 * humanas vazias). Textos livres saem mascarados.
 */
export async function planilhaDaSemana(tx: Sql, canalId: string, s: SemanaDaLoja): Promise<{ cabecalho: string[]; linhas: unknown[][] }> {
  const amostra = await amostraDaSemana(tx, canalId, s)
  const [canal] = await tx<{ nome: string }[]>`SELECT nome_amigavel AS nome FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
  const conversas = amostra.map((i) => i.conversaId)
  const ids = amostra.map((i) => i.juiz_id ?? i.regras_id).filter((x): x is string => !!x)
  const notas = conversas.length === 0 ? [] : await tx<{ id: string; notas: Record<string, number> | null }[]>`
    SELECT id, notas FROM agente_avaliacao WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
  const revs = conversas.length === 0 ? [] : await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.semana = ${s.semana} AND r.canal_id = ${canalId} AND r.conversa_id = ANY(${conversas}::uuid[])
     ORDER BY u.nome, r.revisor_id`
  const sn = (b: boolean | null | undefined): string => (b === true ? 'S' : b === false ? 'N' : '')
  const cabecalho = [
    'semana', 'numero', 'ordem', 'motivo', 'conversa_id', 'avaliacao_id', 'origem', 'gravidade_sistema', 'menor_nota', 'revisor',
    ...CRITERIOS_RUBRICA.map((c) => `nota_juiz_${c}`), ...CRITERIOS_RUBRICA.map((c) => `nota_humana_${c}`),
    'gravidade_humana', 'veredito', ...CRITERIOS_RUBRICA.map((c) => `concorda_${c}`), 'concorda_gravidade', 'concorda',
    'falso_negativo_critica', 'decisao', 'responsavel', 'prazo', 'observacao',
  ]
  const linhas: unknown[][] = []
  const nome = mascararTextoQualidade(canal?.nome ?? '')
  amostra.forEach((i, idx) => {
    const rep = (i.juiz_id ?? i.regras_id)!
    const comum = [s.semana, nome, idx + 1, i.motivo, i.conversaId]
    const daConversa = revs.filter((r) => r.conversa_id === i.conversaId)
    if (daConversa.length === 0) {
      const nj = notasDoJuiz(notas.find((n) => n.id === rep)?.notas)
      linhas.push([...comum, rep, i.origem, i.piorGravidade ?? '', i.menorNota ?? '', '',
        ...CRITERIOS_RUBRICA.map((c) => nj?.[c] ?? ''), ...CRITERIOS_RUBRICA.map(() => ''), '', '',
        ...CRITERIOS_RUBRICA.map(() => ''), '', '', '', '', '', '', ''])
      return
    }
    for (const r of daConversa) {
      const d = revisaoDto(r)
      linhas.push([...comum, d.avaliacaoId, i.origem, d.gravidadeSistema ?? '', i.menorNota ?? '', mascararTextoQualidade(d.revisorNome),
        ...CRITERIOS_RUBRICA.map((c) => d.notasLlm?.[c] ?? ''), ...CRITERIOS_RUBRICA.map((c) => d.notas[c]),
        d.gravidade ?? '', d.veredito, ...CRITERIOS_RUBRICA.map((c) => sn(d.porCriterio[c])), sn(d.concordaGravidade), sn(d.concorda),
        d.falsoNegativoCritica ? 'S' : 'N', d.decisao, mascararTextoQualidade(d.responsavel ?? ''), d.prazo ?? '',
        mascararTextoQualidade(d.observacao ?? '')])
    }
  })
  return { cabecalho, linhas }
}
