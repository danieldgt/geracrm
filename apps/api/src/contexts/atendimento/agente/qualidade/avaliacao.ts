import { randomUUID } from 'node:crypto'
import {
  CODIGO_NAO_ENVIE, ETAPA_REGRAS_QUALIDADE, REGRAS_QUALIDADE, mascararTextoQualidade, piorGravidade,
  type AcaoAvaliacao, type GatilhoAvaliacao, type GravidadeQualidade, type MarcaGuardrail, type OrigemAvaliacao,
  type RegraQualidade,
} from '@geracrm/shared'
import type { Sql } from '../../../../db/index.js'
import { fusoSeguro } from '../../../plataforma/fuso.js'
import { custoDoLaco } from '../custo.js'
import { textoDaMensagem } from '../vendedor.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'
import { julgarTranscricao } from './juiz.js'
import { abrirAlertaTetoJuiz, logQualidade } from './alerta.js'

/**
 * AVALIAÇÕES DE QUALIDADE (ADR-031 §4) — o que vira `agente_avaliacao`.
 *
 *   regras — uma por decisão com resposta (100%), lida das MARCAS do turno
 *            (`agente_decisao.guardrails`): as da etapa `regras-qualidade` são o
 *            que escapou (contam para a pior gravidade); as das outras etapas
 *            entram como `corrigida: true` (o pipeline consertou antes de sair).
 *   juiz   — rubrica de 5 critérios sobre a transcrição da sessão.
 *
 * Idempotência: UNIQUE (tenant, decisão, tipo) + `ON CONFLICT DO NOTHING`.
 */

// ── regras: das marcas para a avaliação ─────────────────────────────────────

export interface ViolacaoGravada {
  readonly regra: RegraQualidade
  readonly gravidade: GravidadeQualidade
  readonly trecho: string
  readonly detalhe?: string | undefined
  readonly corrigida: boolean
}

const ACOES_QUE_CORRIGEM = new Set(['removido', 'reescrito', 'anexado', 'substituido', 'bloqueado', 'handoff'])
/** Etapa (das outras raias) → regra de qualidade equivalente, para o que foi corrigido antes de sair. */
const REGRA_DA_ETAPA: Readonly<Record<string, RegraQualidade>> = {
  'filtro-saida': 'palavra_proibida',
  'numeros-ampliados': 'numero_sem_fonte',
  'guardrail-reais': 'numero_sem_fonte',
  'rede-final': 'numero_sem_fonte',
  'pergunta-repetida': 'pergunta_repetida',
}
const ehGravidade = (g: string): g is GravidadeQualidade => g === 'CRITICA' || g === 'ALTA' || g === 'MEDIA'

export interface AvaliacaoDeRegras {
  readonly violacoes: readonly ViolacaoGravada[]
  readonly piorGravidade: GravidadeQualidade | null
  readonly acao: AcaoAvaliacao | null
}

/** Pura: as marcas de um turno → a avaliação de regras. */
export function avaliacaoDasMarcas(marcas: readonly MarcaGuardrail[]): AvaliacaoDeRegras {
  const violacoes: ViolacaoGravada[] = []
  let pausou = false, naoEnvie = false
  for (const m of marcas) {
    if (m.etapa === ETAPA_REGRAS_QUALIDADE) {
      if (m.codigo === 'qualidade_violacao_critica') { pausou = true; continue }
      if (m.codigo === CODIGO_NAO_ENVIE) { naoEnvie = true; continue }
      if ((REGRAS_QUALIDADE as readonly string[]).includes(m.codigo) && ehGravidade(m.gravidade)) {
        violacoes.push({ regra: m.codigo as RegraQualidade, gravidade: m.gravidade, trecho: mascararTextoQualidade(m.trecho ?? ''), corrigida: false })
      }
      continue
    }
    const regra = REGRA_DA_ETAPA[m.etapa]
    if (!regra || !ehGravidade(m.gravidade) || !ACOES_QUE_CORRIGEM.has(m.acao)) continue
    violacoes.push({ regra, gravidade: m.gravidade, trecho: mascararTextoQualidade(m.trecho ?? ''), detalhe: m.codigo, corrigida: true })
  }
  const pior = piorGravidade(violacoes.filter((v) => !v.corrigida))
  const acao: AcaoAvaliacao | null = pausou ? 'pausa_humano' : naoEnvie ? 'nao_envie' : pior ? 'registrado' : null
  return { violacoes, piorGravidade: pior, acao }
}

/** Autônomo fala com o cliente; os demais modos só sugerem. */
export function origemDoModo(modo: string): OrigemAvaliacao {
  return modo === 'autonomo' ? 'agente' : 'sugestao'
}

/** Modos cujas decisões a qualidade mede (simulação é o playground: fica de fora). */
export const MODOS_AVALIADOS = ['sombra', 'assistido', 'autonomo', 'copiloto'] as const

interface DecisaoParaRegras {
  readonly tenant_id: string
  readonly id: string
  readonly conversa_id: string
  readonly canal_id: string
  readonly sessao_id: string | null
  readonly modo: string
  readonly guardrails: MarcaGuardrail[] | null
  readonly criado_em: Date
}

/** Grava as avaliações de regras de decisões ainda sem avaliação (como DONO acha; grava sob o tenant). */
export async function registrarRegrasPendentes(
  dono: Sql, comTenant: <T>(tenantId: string, fn: (tx: Sql) => Promise<T>) => Promise<T>,
  p: { readonly agora: Date; readonly lote: number; readonly somenteTenant?: string | undefined },
): Promise<number> {
  const desde = new Date(p.agora.getTime() - 7 * 86_400_000)
  const pendentes = await dono<DecisaoParaRegras[]>`
    SELECT d.tenant_id, d.id, d.conversa_id, d.canal_id, d.sessao_id, d.modo, d.guardrails, d.criado_em
      FROM agente_decisao d
     WHERE d.criado_em > ${desde} AND d.criado_em <= ${p.agora}
       ${p.somenteTenant ? dono`AND d.tenant_id = ${p.somenteTenant}` : dono``}
       AND d.modo IN ${dono(MODOS_AVALIADOS as unknown as string[])}
       AND d.resposta IS NOT NULL
       AND d.desfecho IN ('respondeu', 'sugeriu', 'handoff', 'superada')
       AND NOT EXISTS (SELECT 1 FROM agente_avaliacao a
                        WHERE a.tenant_id = d.tenant_id AND a.decisao_id = d.id AND a.tipo = 'regras')
     ORDER BY d.criado_em
     LIMIT ${p.lote}`
  const porTenant = new Map<string, DecisaoParaRegras[]>()
  for (const d of pendentes) porTenant.set(d.tenant_id, [...(porTenant.get(d.tenant_id) ?? []), d])
  let gravadas = 0
  for (const [tenantId, ds] of porTenant) {
    gravadas += await comTenant(tenantId, async (tx) => {
      let n = 0
      for (const d of ds) {
        const a = avaliacaoDasMarcas(Array.isArray(d.guardrails) ? d.guardrails : [])
        const r = await tx`
          INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho,
                                        violacoes, pior_gravidade, acao, criado_em)
          VALUES (tenant_atual(), ${randomUUID()}, ${d.id}, ${d.conversa_id}, ${d.canal_id}, ${d.sessao_id}, ${origemDoModo(d.modo)},
                  'regras', 'turno', ${JSON.stringify(a.violacoes)}::text::jsonb, ${a.piorGravidade}, ${a.acao}, ${d.criado_em})
          ON CONFLICT (tenant_id, decisao_id, tipo) DO NOTHING`
        n += r.count
      }
      return n
    })
  }
  return gravadas
}

// ── transcrição da sessão ───────────────────────────────────────────────────

const MAX_FALAS_TRANSCRICAO = 60
const MAX_CARACTERES_TRANSCRICAO = 24_000

/**
 * A transcrição que o juiz lê, MASCARADA, sob o tenant:
 *   CLIENTE          — mensagens entrantes;
 *   VENDEDOR HUMANO  — salientes sem marcador automático;
 *   AGENTE           — o que o agente enviou (autônomo) e, em sombra/assistido,
 *                      a SUGESTÃO registrada na decisão (não foi enviada, mas é
 *                      ela que se avalia — "0 CRÍTICA" também na sombra).
 * Do início da sessão (com 2 h de contexto antes) até agora; fica o fim se passar do limite.
 */
export async function transcricaoDaSessao(tx: Sql, sessaoId: string): Promise<{ texto: string; falasDoAgente: number } | null> {
  const [s] = await tx<{ conversa_id: string; iniciada_em: Date; encerrada_em: Date | null }[]>`
    SELECT conversa_id, iniciada_em, encerrada_em FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
  if (!s) return null
  const desde = new Date(s.iniciada_em.getTime() - 2 * 3_600_000)
  // Fim da sessão + 1 min (o turno do handoff grava junto); ativa = até agora.
  const ate = s.encerrada_em ? new Date(s.encerrada_em.getTime() + 60_000) : new Date()
  const linhasBrutas = await tx<{ autor: string; tipo: string; conteudo: Record<string, unknown> | null; em: Date }[]>`
    SELECT autor, tipo, conteudo, em FROM (
      SELECT CASE WHEN m.direcao = 'entrante' THEN 'CLIENTE'
                  WHEN m.conteudo->>'automatica' = 'agente' THEN 'AGENTE'
                  ELSE 'VENDEDOR HUMANO' END AS autor,
             m.tipo AS tipo, m.conteudo AS conteudo, m.criado_em AS em
        FROM mensagem m
       WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${s.conversa_id}
         AND m.criado_em >= ${desde} AND m.criado_em <= ${ate}
         AND (m.direcao = 'entrante' OR NOT (m.conteudo ? 'automatica') OR m.conteudo->>'automatica' = 'agente')
      UNION ALL
      SELECT 'AGENTE (sugestão)', 'sugestao', d.resposta, d.criado_em
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.sessao_id = ${sessaoId}
         -- Sugestão = o que o agente decidiu SEM falar com o cliente; o autônomo entra pela mensagem enviada.
         AND d.modo <> 'autonomo' AND d.resposta IS NOT NULL AND d.desfecho IN ('respondeu', 'sugeriu', 'handoff', 'superada')
    ) f
    ORDER BY em DESC LIMIT ${MAX_FALAS_TRANSCRICAO}`
  const falas = [...linhasBrutas].reverse().map((l) => {
    const c = l.conteudo ?? {}
    const texto = l.tipo === 'sugestao'
      ? (Array.isArray(c['mensagens']) ? (c['mensagens'] as unknown[]).filter((x): x is string => typeof x === 'string').join(' ') : '')
      : textoDaMensagem(l.tipo, c)
    return { autor: l.autor, texto }
  })
  const linhas = falas.filter((f) => f.texto.trim()).map((f) => `${f.autor}: ${mascararTextoQualidade(f.texto.replace(/\s+/g, ' ').trim())}`)
  const falasDoAgente = falas.filter((f) => f.autor.startsWith('AGENTE') && f.texto.trim()).length
  let texto = linhas.join('\n')
  if (texto.length > MAX_CARACTERES_TRANSCRICAO) texto = `[…]\n${texto.slice(-MAX_CARACTERES_TRANSCRICAO)}`
  return { texto, falasDoAgente }
}

// ── teto do juiz ────────────────────────────────────────────────────────────

/** Padrão do teto mensal do juiz por número: R$ 20,00. */
export const TETO_JUIZ_PADRAO_CENTAVOS = 2000

export function tetoJuizDoAmbiente(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.IA_QUALIDADE_TETO_MES_CENTAVOS)
  return Number.isFinite(v) && v >= 0 && env.IA_QUALIDADE_TETO_MES_CENTAVOS?.trim() ? Math.floor(v) : TETO_JUIZ_PADRAO_CENTAVOS
}

/** O teto que vale para o número: o configurado ou o do ambiente. 0 = juiz desligado. */
export function tetoJuizEfetivo(configurado: number | string | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (configurado === null || configurado === undefined) return tetoJuizDoAmbiente(env)
  const n = Number(configurado)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : tetoJuizDoAmbiente(env)
}

/** Início do mês corrente no fuso do TENANT — fuso validado em TS (`fusoSeguro`), nunca cru no SQL. Sob tenant. */
export async function inicioDoMesDoTenant(tx: Sql): Promise<Date> {
  const [t] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(t?.fuso)
  const [l] = await tx<{ ini: Date }[]>`SELECT date_trunc('month', now() AT TIME ZONE ${fuso}) AT TIME ZONE ${fuso} AS ini`
  return l!.ini
}

/** Gasto do juiz no mês corrente (fuso do tenant) neste número. Sob tenant. */
export async function gastoJuizNoMes(tx: Sql, canalId: string): Promise<number> {
  const ini = await inicioDoMesDoTenant(tx)
  const [l] = await tx<{ total: string }[]>`
    SELECT coalesce(sum(custo_centavos), 0)::text AS total FROM agente_avaliacao
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND tipo = 'juiz' AND criado_em >= ${ini}`
  return Number(l?.total ?? 0)
}

// ── julgar uma sessão ───────────────────────────────────────────────────────

export interface AlvoDoJuiz {
  readonly tenantId: string
  readonly sessaoId: string
  readonly decisaoId: string
  readonly conversaId: string
  readonly canalId: string
  readonly canalNome: string
  readonly modo: string
  readonly turnos: number
  readonly gatilho: GatilhoAvaliacao
  readonly politicas: string | null
  readonly tetoMesCentavos: number
}

export type DesfechoJuiz = 'avaliada' | 'falhou' | 'teto' | 'sem_falas' | 'ja_avaliada'

/** Roda `fn` numa transação CURTA sob o tenant (worker: `comTenantServico`; rota: `req.comTenant`). */
export type ComTransacao = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>

type Preparo =
  | { readonly tipo: 'pronto'; readonly transcricao: string }
  | { readonly tipo: Exclude<DesfechoJuiz, 'avaliada' | 'falhou'> }

/** Passo 1 (tx curta): já julgada? teto? transcrição. Sem falas do agente → registra e para. */
async function prepararJulgamento(tx: Sql, alvo: AlvoDoJuiz): Promise<Preparo> {
  const [ja] = await tx<{ id: string }[]>`
    SELECT id FROM agente_avaliacao WHERE tenant_id = tenant_atual() AND decisao_id = ${alvo.decisaoId} AND tipo = 'juiz' AND erro IS NULL`
  if (ja) return { tipo: 'ja_avaliada' }
  if (alvo.tetoMesCentavos <= 0) return { tipo: 'teto' }
  const gasto = await gastoJuizNoMes(tx, alvo.canalId)
  if (gasto >= alvo.tetoMesCentavos) {
    if (await abrirAlertaTetoJuiz(tx, alvo.canalNome, alvo.tetoMesCentavos)) {
      logQualidade('warn', 'juiz_no_teto', { tenantId: alvo.tenantId, canalId: alvo.canalId, gasto, teto: alvo.tetoMesCentavos })
    }
    return { tipo: 'teto' }
  }
  const t = await transcricaoDaSessao(tx, alvo.sessaoId)
  if (!t || t.falasDoAgente === 0) {
    // Nada do agente para julgar (ex.: o único turno foi pausado): registra para não voltar a cada passada.
    await tx`
      INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, turnos, erro)
      VALUES (tenant_atual(), ${randomUUID()}, ${alvo.decisaoId}, ${alvo.conversaId}, ${alvo.canalId}, ${alvo.sessaoId},
              ${origemDoModo(alvo.modo)}, 'juiz', ${alvo.gatilho}, ${alvo.turnos}, 'sem falas do agente para avaliar')
      ON CONFLICT (tenant_id, decisao_id, tipo) DO NOTHING`
    return { tipo: 'sem_falas' }
  }
  return { tipo: 'pronto', transcricao: t.texto }
}

/**
 * Julga UMA sessão em TRÊS passos — o modelo NUNCA dentro de transação (até
 * 45 s segurando conexão e locks do pool):
 *   1. tx curta: já julgada? teto do mês? transcrição (mascarada);
 *   2. o juiz, sem transação; custo pelo catálogo (P6) pelo provedor que de
 *      fato respondeu — reserva incluída;
 *   3. tx curta: grava com ON CONFLICT (outro processo pode ter gravado no
 *      meio) e RECONFERE o teto (alerta quando este julgamento o atingiu).
 * Falha do juiz fica registrada (com `erro`), sem nota: não repete a cada
 * passada; o POST manual refaz.
 */
export async function julgarSessao(comTx: ComTransacao, alvo: AlvoDoJuiz, juiz: { porta: PortaLlmFerramentas; modelo?: string | undefined }): Promise<DesfechoJuiz> {
  const prep = await comTx((tx) => prepararJulgamento(tx, alvo))
  if (prep.tipo !== 'pronto') return prep.tipo

  const r = await julgarTranscricao(juiz.porta, { transcricao: prep.transcricao, roteiro: alvo.politicas, modelo: juiz.modelo })
  const custo = r.uso && r.modelo
    ? await custoDoLaco({ provedor: r.provedor, modelo: r.modelo, uso: r.uso, tenantId: alvo.tenantId })
    : 0
  if (!r.ok) logQualidade('warn', 'juiz_falhou', { tenantId: alvo.tenantId, sessaoId: alvo.sessaoId, erro: r.erro })

  return comTx(async (tx) => {
    const comum = {
      id: randomUUID(), decisao: alvo.decisaoId, conversa: alvo.conversaId, canal: alvo.canalId, sessao: alvo.sessaoId,
      origem: origemDoModo(alvo.modo), gatilho: alvo.gatilho, modelo: r.modelo, custo, turnos: alvo.turnos,
    }
    // Refazer (POST manual) substitui uma tentativa que falhou.
    await tx`DELETE FROM agente_avaliacao WHERE tenant_id = tenant_atual() AND decisao_id = ${alvo.decisaoId} AND tipo = 'juiz' AND erro IS NOT NULL`
    if (!r.ok) {
      await tx`
        INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho, modelo, custo_centavos, turnos, erro)
        VALUES (tenant_atual(), ${comum.id}, ${comum.decisao}, ${comum.conversa}, ${comum.canal}, ${comum.sessao}, ${comum.origem}, 'juiz',
                ${comum.gatilho}, ${comum.modelo}, ${comum.custo}, ${comum.turnos}, ${r.erro})
        ON CONFLICT (tenant_id, decisao_id, tipo) DO UPDATE SET custo_centavos = agente_avaliacao.custo_centavos + EXCLUDED.custo_centavos`
      if (custo > 0) await alertarSeChegouAoTeto(tx, alvo)
      return 'falhou' as const
    }
    const notas = Object.fromEntries(Object.entries(r.notas).map(([c, n]) => [c, n.nota]))
    const justificativas = Object.fromEntries(Object.entries(r.notas).map(([c, n]) => [c, mascararTextoQualidade(n.justificativa)]))
    const ins = await tx<{ inserida: boolean }[]>`
      INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, sessao_id, origem, tipo, gatilho,
                                    notas, justificativas, nota_media, modelo, custo_centavos, turnos)
      VALUES (tenant_atual(), ${comum.id}, ${comum.decisao}, ${comum.conversa}, ${comum.canal}, ${comum.sessao}, ${comum.origem}, 'juiz',
              ${comum.gatilho}, ${JSON.stringify(notas)}::text::jsonb, ${JSON.stringify(justificativas)}::text::jsonb, ${r.notaMedia},
              ${comum.modelo}, ${comum.custo}, ${comum.turnos})
      -- Concorrência (POST × worker): o outro já gravou. A nota dele fica; o custo DESTE julgamento,
      -- que foi pago, soma na linha — conta no teto do mês.
      ON CONFLICT (tenant_id, decisao_id, tipo) DO UPDATE SET custo_centavos = agente_avaliacao.custo_centavos + EXCLUDED.custo_centavos
      RETURNING (xmax = 0) AS inserida`
    await alertarSeChegouAoTeto(tx, alvo)
    return ins[0]?.inserida ? 'avaliada' as const : 'ja_avaliada' as const
  })
}

/** O julgamento que acabou de gravar levou o número ao teto do mês: avisa já (o worker para de escolhê-lo). */
async function alertarSeChegouAoTeto(tx: Sql, alvo: AlvoDoJuiz): Promise<void> {
  if (await gastoJuizNoMes(tx, alvo.canalId) < alvo.tetoMesCentavos) return
  if (await abrirAlertaTetoJuiz(tx, alvo.canalNome, alvo.tetoMesCentavos)) {
    logQualidade('warn', 'juiz_no_teto', { tenantId: alvo.tenantId, canalId: alvo.canalId, teto: alvo.tetoMesCentavos })
  }
}
