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
 *
 * RISCOS ACEITOS (decisão do coordenador na revisão adversarial da P16; a P20 leva
 * ao guia de revisão semanal):
 *   1. A ORDEM da amostra revela a gravidade: as CRÍTICAs vêm primeiro, depois ALTA
 *      ou nota ≤ 3. É o protocolo da revisão (ADR-031 §5) — o revisor deve
 *      começar pelo que é grave. A cegueira cobre motivo, gravidade e notas, não
 *      a posição na lista.
 *   2. O CSV da aba Qualidade (P12, gestor/supervisor) traz motivo, gravidade e
 *      justificativas do juiz da mesma semana. Ele não é a ferramenta de revisão;
 *      o guia orienta revisar pela aba Revisão antes de abrir o CSV.
 */

const peso = (col: string): string => `CASE ${col} WHEN 'CRITICA' THEN 3 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 1 ELSE 0 END`
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
 * (mesma ordenação, filtro e teto) para a amostra das duas sair igual.
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
       -- Juiz que falhou não é avaliação: não põe a conversa na amostra (o CSV da P12 filtra igual).
       AND a.erro IS NULL
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
  const notasPorId = new Map(notas.map((n) => [n.id, n.notas !== null]))
  return amostra.map((i, idx) => {
    // Revisão de quem pede: a da avaliação representativa, ou a de outra avaliação da mesma conversa
    // na semana (a representativa pode ter mudado depois — chegou um juiz com nota menor).
    const rep = (i.juiz_id ?? i.regras_id)!
    const minha = minhas.find((m) => m.conversa_id === i.conversaId && m.avaliacao_id === rep)
      ?? minhas.find((m) => m.conversa_id === i.conversaId)
    const avaliacaoId = minha?.avaliacao_id ?? rep
    // CEGO até a 1ª revisão de quem pede: nada do que o sistema achou sai do servidor.
    const cego = !minha
    const comJuiz = minha ? minha.notas_llm !== null : notasPorId.get(rep) === true
    return {
      ordem: idx + 1, motivo: cego ? null : i.motivo, conversaId: i.conversaId, canalId, avaliacaoId,
      origem: i.origem as OrigemAvaliacao, cego, comJuiz,
      piorGravidade: cego ? null : i.piorGravidade, menorNota: cego ? null : i.menorNota,
      notasJuiz: minha ? notasDoJuiz(minha.notas_llm) : null,
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

/**
 * O recorte do que o revisor lê: a MESMA sessão da transcrição mostrada (e, por
 * segurança, a semana). Sem sessão, a conversa na semana. Alias fixo `av`.
 */
function recorte(tx: Sql, a: LinhaAvaliacao) {
  return tx`av.tenant_id = tenant_atual() AND av.conversa_id = ${a.conversa_id} AND av.canal_id = ${a.canal_id}
    AND av.criado_em >= ${a.ini} AND av.criado_em < ${a.fim}
    ${a.sessao_id ? tx`AND av.sessao_id = ${a.sessao_id}` : tx``}`
}

/** Pior gravidade que as regras registraram na sessão mostrada (a que escapou; corrigidas não contam). */
async function gravidadeDoSistema(tx: Sql, a: LinhaAvaliacao): Promise<GravidadeQualidade | null> {
  const [g] = await tx<{ pior: string | null }[]>`
    SELECT (array_agg(av.pior_gravidade ORDER BY ${tx.unsafe(peso('av.pior_gravidade'))} DESC))[1] AS pior
      FROM agente_avaliacao av
     WHERE ${recorte(tx, a)} AND av.pior_gravidade IS NOT NULL`
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
    SELECT v FROM agente_avaliacao av, jsonb_array_elements(av.violacoes) v
     WHERE ${recorte(tx, a)} AND av.tipo = 'regras'
       AND NOT coalesce((v->>'corrigida')::boolean, false)
     ORDER BY av.criado_em
     LIMIT 50`
  const [minha] = await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.avaliacao_id = ${a.id} AND r.revisor_id = ${revisorId}`
  // CEGO até a 1ª revisão de quem pede desta avaliação: sem notas, justificativas nem gravidades do sistema.
  const cego = !minha
  const comJuiz = a.tipo === 'juiz' && a.notas !== null
  return {
    avaliacaoId: a.id, conversaId: a.conversa_id, canalId: a.canal_id, semana: a.semana, origem: a.origem as OrigemAvaliacao,
    transcricao: falas, cortada, cego, comJuiz,
    notasJuiz: !cego && comJuiz ? notasDoJuiz(a.notas) : null,
    justificativas: !cego && comJuiz && a.justificativas
      ? Object.fromEntries(Object.entries(a.justificativas).map(([k, v]) => [k, mascararTextoQualidade(String(v))]))
      : null,
    gravidadeSistema: cego ? null : await gravidadeDoSistema(tx, a),
    violacoes: violacoes.map(({ v }) => ({ ...v, gravidade: cego ? null : v.gravidade, trecho: mascararTextoQualidade(v.trecho ?? '') })),
    revisao: minha ? revisaoDto(minha) : null,
  }
}

export type ResultadoGravacao =
  | { readonly tipo: 'gravada'; readonly criada: boolean; readonly revisao: RevisaoDto }
  | { readonly tipo: 'nao_encontrada' }
  | { readonly tipo: 'fora_da_amostra' }

/**
 * Grava a revisão do revisor sobre a avaliação. A concordância é calculada AQUI
 * e congelada com o que o sistema disse — notas do juiz DESTA avaliação e a pior
 * gravidade das regras na sessão mostrada.
 *
 * ⚠️ A 1ª gravação é IMUTÁVEL no que mede (notas, gravidade, concordância,
 *    concorda, falso negativo): depois dela o revisor vê o juiz, e regravar a
 *    nota inflaria a métrica. Regravar só muda veredito, decisão, responsável,
 *    prazo e observação.
 * ⚠️ Só avaliação da AMOSTRA da semana: a representativa da conversa (ou uma
 *    que o revisor já revisou). Fora dela → `fora_da_amostra` (o denominador
 *    não aceita conversa escolhida a dedo).
 */
export async function gravarRevisao(tx: Sql, corpo: RevisaoValidada, revisorId: string): Promise<ResultadoGravacao> {
  const a = await avaliacaoComSemana(tx, corpo.avaliacaoId)
  if (!a) return { tipo: 'nao_encontrada' }
  const semana: SemanaDaLoja = { semana: a.semana, inicio: '', ini: a.ini, fim: a.fim, fuso: '' }
  const item = (await amostraDaSemana(tx, a.canal_id, semana)).find((i) => i.conversaId === a.conversa_id)
  const [ja] = await tx<{ id: string }[]>`
    SELECT id FROM agente_revisao WHERE tenant_id = tenant_atual() AND avaliacao_id = ${a.id} AND revisor_id = ${revisorId}`
  if (!item || (!ja && (item.juiz_id ?? item.regras_id) !== a.id)) return { tipo: 'fora_da_amostra' }
  const motivo = item.motivo
  const notasLlm = a.tipo === 'juiz' ? notasDoJuiz(a.notas) : null
  const gravidadeSistema = await gravidadeDoSistema(tx, a)
  const r = calcularConcordancia({
    notasLlm, notasHumanas: corpo.notas, gravidadeSistema, gravidadeHumana: corpo.gravidade,
  })
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
    -- Regravar: SÓ os campos editáveis. O que mede (notas, gravidade, concordância, FN) fica o da 1ª gravação.
    ON CONFLICT (tenant_id, avaliacao_id, revisor_id) DO UPDATE SET
      veredito = EXCLUDED.veredito, decisao = EXCLUDED.decisao, responsavel = EXCLUDED.responsavel,
      prazo = EXCLUDED.prazo, observacao = EXCLUDED.observacao, atualizado_em = now()
    RETURNING id, (xmax = 0) AS criada`
  const [linha] = await tx<LinhaRevisao[]>`
    SELECT ${tx.unsafe(COLUNAS_REVISAO)}
      FROM agente_revisao r JOIN usuario u ON u.tenant_id = r.tenant_id AND u.id = r.revisor_id
     WHERE r.tenant_id = tenant_atual() AND r.id = ${l!.id}`
  return { tipo: 'gravada', criada: l!.criada, revisao: revisaoDto(linha!) }
}

/**
 * A concordância das semanas pedidas, por número (e no total). É o contrato da
 * P19: `atingeMeta` = `concordancia >= META_CONCORDANCIA` com
 * `conversasComparaveis >= MIN_REVISADAS_CONCORDANCIA` (conversas DISTINTAS) e
 * `falsosNegativosCritica === 0`. Uma revisão por (conversa, semana): a 1ª
 * comparável. Sem papel aqui — quem chama decide.
 */
export async function concordancia(
  tx: Sql, p: { readonly semanas: readonly string[]; readonly canalId?: string | undefined },
): Promise<{ total: SomaConcordancia; porNumero: ConcordanciaNumeroDto[] }> {
  const linhas = await tx<{
    canal_id: string; conversa_id: string; semana: string; criado_em: Date; concordancia: Record<string, boolean | null>
    concorda: boolean | null; motivo: string | null; falso_negativo_critica: boolean
  }[]>`
    SELECT canal_id, conversa_id, semana, criado_em, concordancia, concorda, motivo, falso_negativo_critica FROM agente_revisao
     WHERE tenant_id = tenant_atual() AND semana = ANY(${p.semanas as string[]}::text[])
       ${p.canalId ? tx`AND canal_id = ${p.canalId}` : tx``}`
  const canais = await tx<{ id: string; nome: string }[]>`
    SELECT id, nome_amigavel AS nome FROM canal_conectado
     WHERE tenant_id = tenant_atual()
       AND ${p.canalId ? tx`id = ${p.canalId}` : tx`id = ANY(${[...new Set(linhas.map((l) => l.canal_id))]}::uuid[])`}
     ORDER BY nome_amigavel, id`
  // A soma conta UMA revisão por (conversa, semana) — a 1ª comparável (shared `umaPorConversa`).
  const paraSomar = (l: (typeof linhas)[number]): RevisaoParaSomar => ({
    conversaId: l.conversa_id, semana: l.semana, criadoEm: l.criado_em.toISOString(),
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
 * ⚠️ Cega como a tela: conversa que QUEM EXPORTA ainda não revisou sai sem
 *    motivo, gravidade, nota, notas do juiz nem as revisões dos outros.
 */
export async function planilhaDaSemana(tx: Sql, canalId: string, s: SemanaDaLoja, revisorId: string): Promise<{ cabecalho: string[]; linhas: unknown[][] }> {
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
    const daConversa = revs.filter((r) => r.conversa_id === i.conversaId)
    const cego = !daConversa.some((r) => r.revisor_id === revisorId)
    const comum = [s.semana, nome, idx + 1, cego ? '' : i.motivo, i.conversaId]
    if (cego) {
      linhas.push([...comum, rep, i.origem, '', '', '',
        ...CRITERIOS_RUBRICA.map(() => ''), ...CRITERIOS_RUBRICA.map(() => ''), '', '',
        ...CRITERIOS_RUBRICA.map(() => ''), '', '', '', '', '', '', ''])
      return
    }
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
