import {
  CARDS_COCKPIT, FRACAO_AMARELO, cardDeAgenda,
  type AgrupamentoCockpit, type CardCockpit, type FaixaAguardando, type GrupoCockpit, type ItemCockpit,
  type PorFaixa, type RespostaCockpit,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { instanteLocal, partesLocais } from '../atendimento/expediente.js'
import { fragmentoForaDaSimulacao, fragmentoNaFila, respostaHumanaDoAtendimento } from '../atendimento/sla-handoff.js'
import { fusoSeguro } from './fuso.js'
import { condicaoContato, condicaoConversa, condicaoEvento, condicaoOportunidade, type Escopo } from './escopo.js'

/**
 * COCKPIT DO GESTOR (raia D1) — o lado com banco. Uma consulta de BASE por card; os números e a lista
 * saem da MESMA consulta, então o card nunca diz 7 e a lista mostra 6.
 *
 * ⚠️ Tudo sob RLS do tenant e DENTRO do escopo de quem chama (D3): `condicaoConversa` /
 *    `condicaoContato` / `condicaoOportunidade` são as mesmas das telas.
 * ⚠️ Toda consulta tem estado e/ou tempo: fila = estado; SLA/reuniões = janela do dia; esquecidos e
 *    sem próximo passo = estado do funil/qualificação. Nenhuma varre a tabela sem recorte.
 * ⚠️ "Hoje" é o dia do TENANT (fuso dele). O relógio vem de quem chama (`agora`) — nunca `now()` do
 *    banco —, então a mesma chamada dá o mesmo número no teste e na tela.
 */

export interface ContextoCockpit {
  readonly escopo: Escopo
  readonly agora: Date
  readonly inicioDia: Date
  readonly fimDia: Date
  readonly dias: number
  readonly agendaAtiva: boolean
}

/** Janela [início, fim) do dia de `agora` no fuso do tenant. */
export async function janelaDoDia(tx: Sql, agora: Date): Promise<{ inicioDia: Date; fimDia: Date }> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const hoje = partesLocais(agora, fuso).data
  const [y, m, d] = hoje.split('-').map(Number) as [number, number, number]
  const amanha = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  return { inicioDia: instanteLocal(hoje, '00:00', fuso), fimDia: instanteLocal(amanha, '00:00', fuso) }
}

/** A filial de uma pessoa (a primeira, por id) — só quando o item não traz filial própria. */
const filialDaPessoa = (tx: Sql, coluna: string) => tx`(
  SELECT esc_uf.filial_id FROM usuario_filial esc_uf
   WHERE esc_uf.tenant_id = tenant_atual() AND esc_uf.usuario_id = ${tx.unsafe(coluna)} AND esc_uf.filial_id IS NOT NULL
   ORDER BY esc_uf.filial_id LIMIT 1)`

/** A conversa mais recente do contato (para abrir no trilho). Só na lista — o card não precisa. */
const conversaDoContato = (tx: Sql, coluna: string) => tx`(
  SELECT esc_cv.id FROM conversa esc_cv
   WHERE esc_cv.tenant_id = tenant_atual() AND esc_cv.contato_id = ${tx.unsafe(coluna)}
   ORDER BY esc_cv.ultima_mensagem_em DESC NULLS LAST, esc_cv.id LIMIT 1)`

/** Faixa do cronômetro do SLA — a régua de `faixaDoCronometro` (verde → 2/3 → vermelho), em SQL. */
function faixaSql(tx: Sql, agora: Date) {
  return tx`CASE
    WHEN a.sla_vence_em IS NULL THEN 'ok'
    WHEN a.sla_estourado_em IS NOT NULL OR ${agora}::timestamptz >= a.sla_vence_em
         OR a.sla_vence_em <= coalesce(a.sla_inicio_em, a.sla_vence_em) THEN 'estourado'
    WHEN extract(epoch FROM (${agora}::timestamptz - a.sla_inicio_em))
         / extract(epoch FROM (a.sla_vence_em - a.sla_inicio_em)) >= ${FRACAO_AMARELO}::float8 THEN 'atencao'
    ELSE 'ok' END`
}

/**
 * A consulta de BASE do card. Colunas fixas: id, tipo, contato_id, conversa_id, contato_nome,
 * responsavel_id, filial_id, desde, faixa, evento_status, evento_versao. `completa` acrescenta o que só
 * a lista precisa (a conversa para o trilho) — o card conta sem pagar por isso.
 */
export function baseDoCard(tx: Sql, card: CardCockpit, ctx: ContextoCockpit, completa: boolean) {
  const { escopo, agora } = ctx
  switch (card) {
    case 'aguardandoHumano':
      // Candidatos por índice (cliente falou por último OR atendimento na fila); a régua exata é a da fila.
      return tx`
        SELECT cv.id, 'conversa'::text AS tipo, cv.contato_id, cv.id AS conversa_id, ct.nome AS contato_nome,
               coalesce(a.atendente_id, a.responsavel_id) AS responsavel_id,
               coalesce(ct.filial_id, cc.filial_id, ${filialDaPessoa(tx, 'coalesce(a.atendente_id, a.responsavel_id)')}) AS filial_id,
               coalesce(a.sla_inicio_em, cv.ultima_entrante_em, cv.ultima_mensagem_em, cv.criado_em) AS desde,
               ${faixaSql(tx, agora)} AS faixa, NULL::text AS evento_status, NULL::int AS evento_versao
          FROM conversa cv
          JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
          LEFT JOIN atendimento a ON a.tenant_id = cv.tenant_id AND a.conversa_id = cv.id AND a.estado <> 'encerrado'
          LEFT JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
         WHERE cv.tenant_id = tenant_atual() AND NOT cv.arquivada
           AND cv.id IN (
                 SELECT f.id FROM conversa f
                  WHERE f.tenant_id = tenant_atual() AND f.ultima_direcao = 'entrante' AND NOT f.arquivada
                 UNION
                 SELECT fa.conversa_id FROM atendimento fa
                  WHERE fa.tenant_id = tenant_atual() AND fa.estado = 'na_fila' AND fa.atendente_id IS NULL)
           AND ${fragmentoNaFila(tx)} AND ${condicaoConversa(tx, escopo)}`

    case 'slaEstouradoHoje':
      // Prazo caiu hoje (no fuso do tenant), já passou e não houve resposta humana a tempo.
      return tx`
        SELECT a.id, 'conversa'::text AS tipo, cv.contato_id, cv.id AS conversa_id, ct.nome AS contato_nome,
               coalesce(a.atendente_id, a.responsavel_id) AS responsavel_id,
               coalesce(ct.filial_id, cc.filial_id, ${filialDaPessoa(tx, 'coalesce(a.atendente_id, a.responsavel_id)')}) AS filial_id,
               a.sla_vence_em AS desde, 'estourado'::text AS faixa, NULL::text AS evento_status, NULL::int AS evento_versao
          FROM atendimento a
          JOIN conversa cv ON cv.tenant_id = a.tenant_id AND cv.id = a.conversa_id
          JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
          LEFT JOIN canal_conectado cc ON cc.tenant_id = cv.tenant_id AND cc.id = cv.canal_id
         WHERE a.tenant_id = tenant_atual()
           AND a.sla_vence_em >= ${ctx.inicioDia} AND a.sla_vence_em < ${ctx.fimDia} AND a.sla_vence_em <= ${agora}
           AND (coalesce(a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)}) IS NULL
                OR coalesce(a.sla_respondido_em, ${respostaHumanaDoAtendimento(tx)}) > a.sla_vence_em)
           AND ${fragmentoForaDaSimulacao(tx)} AND ${condicaoConversa(tx, escopo)}`

    case 'esquecidos': {
      const limite = new Date(agora.getTime() - ctx.dias * 86_400_000)
      return tx`
        SELECT c.id, 'contato'::text AS tipo, c.id AS contato_id,
               ${completa ? tx`${conversaDoContato(tx, 'c.id')}` : tx`NULL::uuid`} AS conversa_id, c.nome AS contato_nome,
               coalesce(ca.usuario_id, o.responsavel_id) AS responsavel_id,
               coalesce(c.filial_id, ${filialDaPessoa(tx, 'coalesce(ca.usuario_id, o.responsavel_id)')}) AS filial_id,
               tq.toque AS desde, NULL::text AS faixa, NULL::text AS evento_status, NULL::int AS evento_versao
          FROM contato c
          LEFT JOIN oportunidade o ON o.tenant_id = c.tenant_id AND o.contato_id = c.id AND o.estado = 'aberta'
          LEFT JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
          CROSS JOIN LATERAL (
            SELECT coalesce(greatest(c.ultimo_toque_em, (SELECT max(cv.ultima_mensagem_em) FROM conversa cv
                                                          WHERE cv.tenant_id = c.tenant_id AND cv.contato_id = c.id)),
                            c.criado_em) AS toque) tq
         WHERE c.tenant_id = tenant_atual() AND c.ativo AND c.origem_carga IS DISTINCT FROM 'simulacao'
           AND c.id IN (
                 SELECT o2.contato_id FROM oportunidade o2 WHERE o2.tenant_id = tenant_atual() AND o2.estado = 'aberta'
                 UNION
                 SELECT q.id FROM contato q WHERE q.tenant_id = tenant_atual() AND q.ativo AND q.qualificado)
           AND tq.toque < ${limite} AND ${condicaoContato(tx, escopo, 'c')}`
    }

    case 'reunioesHoje':
    case 'naoCompareceuHoje':
      return tx`
        SELECT e.id, 'evento'::text AS tipo, e.contato_id,
               ${completa ? tx`CASE WHEN e.contato_id IS NULL THEN NULL ELSE ${conversaDoContato(tx, 'e.contato_id')} END` : tx`NULL::uuid`} AS conversa_id,
               coalesce(ct.nome, e.titulo) AS contato_nome, e.responsavel_id,
               coalesce(ct.filial_id, ${filialDaPessoa(tx, 'e.responsavel_id')}) AS filial_id,
               e.inicio AS desde, NULL::text AS faixa, e.status AS evento_status, e.versao AS evento_versao
          FROM evento_agenda e
          LEFT JOIN contato ct ON ct.tenant_id = e.tenant_id AND ct.id = e.contato_id
         WHERE e.tenant_id = tenant_atual() AND e.inicio >= ${ctx.inicioDia} AND e.inicio < ${ctx.fimDia}
           AND ${card === 'reunioesHoje' ? tx`e.status <> 'cancelado'` : tx`e.status = 'nao_compareceu'`}
           AND ${condicaoEvento(tx, escopo)}`

    case 'semProximoPasso':
      // "Em funil" = oportunidade aberta; a regra é a de `semProximoPasso` (tarefa aberta futura OU, com
      // a Agenda ligada, evento futuro).
      return tx`
        SELECT c.id, 'contato'::text AS tipo, c.id AS contato_id,
               ${completa ? tx`${conversaDoContato(tx, 'c.id')}` : tx`NULL::uuid`} AS conversa_id, c.nome AS contato_nome,
               coalesce(o.responsavel_id, ca.usuario_id) AS responsavel_id,
               coalesce(c.filial_id, ${filialDaPessoa(tx, 'coalesce(o.responsavel_id, ca.usuario_id)')}) AS filial_id,
               o.entrou_etapa_em AS desde, NULL::text AS faixa, NULL::text AS evento_status, NULL::int AS evento_versao
          FROM oportunidade o
          JOIN contato c ON c.tenant_id = o.tenant_id AND c.id = o.contato_id
          LEFT JOIN carteira_atribuicao ca ON ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
         WHERE o.tenant_id = tenant_atual() AND o.estado = 'aberta' AND c.ativo
           AND NOT EXISTS (SELECT 1 FROM tarefa t WHERE t.tenant_id = o.tenant_id AND t.contato_id = o.contato_id
                              AND t.estado = 'aberta' AND t.vence_em >= ${agora})
           ${ctx.agendaAtiva
             ? tx`AND NOT EXISTS (SELECT 1 FROM evento_agenda ev WHERE ev.tenant_id = o.tenant_id AND ev.contato_id = o.contato_id
                                     AND ev.status = 'agendado' AND ev.inicio >= ${agora})`
             : tx``}
           AND ${condicaoOportunidade(tx, escopo, 'o')}`
  }
}

// ───────────────────────────── os números ─────────────────────────────

interface LinhaContagem { responsavel_id: string | null; filial_id: string | null; faixa: string | null; n: number }

const chaveDoGrupo = (agrupar: AgrupamentoCockpit, l: { responsavel_id: string | null; filial_id: string | null }): string =>
  (agrupar === 'vendedor' ? l.responsavel_id : l.filial_id) ?? 'sem'

const somar = (m: Map<string, number>, k: string, n: number): void => { m.set(k, (m.get(k) ?? 0) + n) }

export async function montarCockpit(tx: Sql, ctx: ContextoCockpit, agrupar: AgrupamentoCockpit): Promise<RespostaCockpit> {
  const cards = CARDS_COCKPIT.filter((c) => ctx.agendaAtiva || !cardDeAgenda(c))
  const porCard = new Map<CardCockpit, Map<string, number>>()
  const totais = new Map<CardCockpit, number>()
  const faixas: Record<FaixaAguardando, number> = { ok: 0, atencao: 0, estourado: 0 }
  const ids = new Set<string>()

  for (const card of cards) {
    const linhas = await tx<LinhaContagem[]>`
      SELECT x.responsavel_id, x.filial_id, x.faixa, count(*)::int AS n
        FROM (${baseDoCard(tx, card, ctx, false)}) x
       GROUP BY x.responsavel_id, x.filial_id, x.faixa`
    const grupos = new Map<string, number>()
    let total = 0
    for (const l of linhas) {
      const k = chaveDoGrupo(agrupar, l)
      if (k !== 'sem') ids.add(k)
      somar(grupos, k, l.n)
      total += l.n
      if (card === 'aguardandoHumano' && (l.faixa === 'ok' || l.faixa === 'atencao' || l.faixa === 'estourado')) faixas[l.faixa] += l.n
    }
    porCard.set(card, grupos)
    totais.set(card, total)
  }

  const rotulos = await rotulosDosGrupos(tx, agrupar, [...ids])
  const chaves = new Set<string>()
  for (const g of porCard.values()) for (const k of g.keys()) chaves.add(k)
  const valor = (card: CardCockpit, k: string): number | null =>
    porCard.has(card) ? (porCard.get(card)!.get(k) ?? 0) : null
  const grupos: GrupoCockpit[] = [...chaves].map((k) => ({
    chave: k,
    rotulo: k === 'sem' ? (agrupar === 'vendedor' ? 'Sem responsável' : 'Sem filial') : (rotulos.get(k) ?? 'Removido'),
    aguardandoHumano: valor('aguardandoHumano', k) ?? 0,
    slaEstouradoHoje: valor('slaEstouradoHoje', k) ?? 0,
    esquecidos: valor('esquecidos', k) ?? 0,
    reunioesHoje: valor('reunioesHoje', k),
    naoCompareceuHoje: valor('naoCompareceuHoje', k),
    semProximoPasso: valor('semProximoPasso', k) ?? 0,
  })).sort((a, b) => (a.chave === 'sem' ? 1 : b.chave === 'sem' ? -1 : a.rotulo.localeCompare(b.rotulo, 'pt-BR')))

  const porFaixa: PorFaixa = { ...faixas }
  return {
    agrupar, dias: ctx.dias, geradoEm: ctx.agora.toISOString(),
    cards: {
      aguardandoHumano: { total: totais.get('aguardandoHumano') ?? 0, porFaixa },
      slaEstouradoHoje: totais.get('slaEstouradoHoje') ?? 0,
      esquecidos: totais.get('esquecidos') ?? 0,
      reunioesHoje: ctx.agendaAtiva ? (totais.get('reunioesHoje') ?? 0) : null,
      naoCompareceuHoje: ctx.agendaAtiva ? (totais.get('naoCompareceuHoje') ?? 0) : null,
      semProximoPasso: totais.get('semProximoPasso') ?? 0,
    },
    grupos,
  }
}

async function rotulosDosGrupos(tx: Sql, agrupar: AgrupamentoCockpit, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const linhas = agrupar === 'vendedor'
    ? await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
    : await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM filial WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
  return new Map(linhas.map((l) => [l.id, l.nome]))
}

// ───────────────────────────── a lista do card ─────────────────────────────

export interface FiltroItens {
  readonly card: CardCockpit
  readonly agrupar: AgrupamentoCockpit
  /** `sem`, um uuid ou undefined (todos). */
  readonly grupo?: string | undefined
  readonly faixa?: FaixaAguardando | undefined
  readonly cursor: { em: string; id: string } | null
  readonly limite: number
}

interface LinhaItem {
  id: string; tipo: string; contato_id: string | null; conversa_id: string | null; contato_nome: string | null
  responsavel_id: string | null; responsavel_nome: string | null; desde: Date; desde_txt: string
  faixa: string | null; evento_status: string | null; evento_versao: number | null
}

/** Mais antigo primeiro (o mais urgente), por cursor (desde, id) — `limite + 1` linhas para saber se há mais. */
export async function listarItens(tx: Sql, ctx: ContextoCockpit, f: FiltroItens): Promise<{ linhas: LinhaItem[] }> {
  const coluna = f.agrupar === 'vendedor' ? tx`x.responsavel_id` : tx`x.filial_id`
  const grupo = f.grupo === undefined ? tx`` : f.grupo === 'sem' ? tx`AND ${coluna} IS NULL` : tx`AND ${coluna} = ${f.grupo}::uuid`
  const faixa = f.faixa ? tx`AND x.faixa = ${f.faixa}` : tx``
  // ⚠️ `::text::timestamptz`: o cursor guarda microssegundos; o cast direto o passaria por Date (ms).
  const cursor = f.cursor ? tx`AND (x.desde, x.id) > (${f.cursor.em}::text::timestamptz, ${f.cursor.id}::uuid)` : tx``
  const linhas = await tx<LinhaItem[]>`
    SELECT x.id, x.tipo, x.contato_id, x.conversa_id, x.contato_nome, x.responsavel_id, u.nome AS responsavel_nome,
           x.desde, x.desde::text AS desde_txt, x.faixa, x.evento_status, x.evento_versao
      FROM (${baseDoCard(tx, f.card, ctx, true)}) x
      LEFT JOIN usuario u ON u.tenant_id = tenant_atual() AND u.id = x.responsavel_id
     WHERE true ${grupo} ${faixa} ${cursor}
     ORDER BY x.desde, x.id
     LIMIT ${f.limite + 1}`
  return { linhas }
}

export function paraItem(l: LinhaItem): ItemCockpit {
  const evento = l.tipo === 'evento'
  return {
    tipo: l.tipo as ItemCockpit['tipo'], id: l.id,
    rotulo: l.contato_nome ?? 'Sem contato',
    contatoId: l.contato_id, contato: l.contato_nome, conversaId: l.conversa_id,
    responsavelId: l.responsavel_id, responsavel: l.responsavel_nome,
    desde: l.desde.toISOString(),
    faixa: l.faixa === 'ok' || l.faixa === 'atencao' || l.faixa === 'estourado' ? l.faixa : null,
    eventoStatus: evento ? l.evento_status : null, eventoVersao: evento ? l.evento_versao : null,
    link: evento ? '/agenda' : l.contato_id ? `/contato/${l.contato_id}` : '/contatos',
  }
}
