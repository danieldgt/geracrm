import { randomUUID } from 'node:crypto'
import { fusoSeguro } from '../../plataforma/fuso.js'
import { sql, comTenantServico, type Sql } from '../../../db/index.js'
import type { UsoDoLaco } from './porta-llm.js'

/**
 * CUSTO DO AGENTE (ADR-032, raia P6).
 *
 * 1. PREÇO pelo catálogo `modelo_ia` (0093/0099), nunca por tabela fixa: o id
 *    que o fornecedor devolve passa por `normalizarIdModelo` (prefixo de
 *    provedor/região, ARN, versão, data, sufixo `:free`…) e é procurado no
 *    catálogo, preferindo a entrada do MESMO provedor.
 *      - modelo `gratuito` do mesmo provedor, ou variante `:free` → custa 0;
 *      - desconhecido → MAIOR preço do catálogo + alerta `preco_desconhecido`
 *        (errar para cima é seguro; errar em silêncio, não).
 *    Cache de 10 min no processo: o turno não vai ao banco por preço.
 * 2. CENTAVOS: US$ × câmbio do ambiente (`IA_CAMBIO_BRL`, padrão 5,5 — o mesmo
 *    que a estimativa antiga usava), arredondado a centavo inteiro.
 * 3. ORÇAMENTO MENSAL do tenant (`agente_orcamento`): SÓ ALERTA, a 80% e a 100%,
 *    uma vez por mês cada (mês no fuso do tenant). Quem corta é o teto do
 *    número (diário, `vendedor.ts`) e o da sessão (`pipeline/teto-conversa.ts`).
 *
 * ⚠️ Estimativa, não fatura: a fatura é a do fornecedor.
 */

// ── preço ────────────────────────────────────────────────────────────────────

/** US$ por milhão de tokens. */
export interface PrecoUsdPorMilhao {
  readonly entrada: number
  readonly saida: number
  readonly cacheLeitura: number
  readonly cacheEscrita: number
}

export type OrigemPreco = 'catalogo' | 'gratuito' | 'desconhecido'

export interface PrecoResolvido {
  readonly preco: PrecoUsdPorMilhao
  readonly origem: OrigemPreco
  /** Código da entrada do catálogo usada; null quando gratuito por id ou desconhecido. */
  readonly codigo: string | null
  /** O id depois de `normalizarIdModelo` — o que aparece no alerta. */
  readonly idNormalizado: string
}

/** Uma linha de `modelo_ia`, só o que o preço precisa. */
export interface LinhaPreco {
  readonly codigo: string
  readonly provedor: string
  readonly modelo: string
  readonly gratuito: boolean
  readonly entrada: number
  readonly saida: number
  /** null = cobra como entrada. */
  readonly cacheLeitura: number | null
  readonly cacheEscrita: number | null
}

const ZERO: PrecoUsdPorMilhao = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }

/**
 * Reserva quando o catálogo não pôde ser lido (banco fora no boot): os preços
 * de lista da Anthropic. Só existe para o custo não virar 0 por falha de leitura.
 */
const CATALOGO_RESERVA: readonly LinhaPreco[] = [
  { codigo: 'claude-opus-5-5', provedor: 'claude', modelo: 'claude-opus-5-5', gratuito: false, entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 },
  { codigo: 'claude-sonnet-5-5', provedor: 'claude', modelo: 'claude-sonnet-5-5', gratuito: false, entrada: 2, saida: 10, cacheLeitura: 0.2, cacheEscrita: 2.5 },
  { codigo: 'claude-haiku-4-5', provedor: 'claude', modelo: 'claude-haiku-4-5', gratuito: false, entrada: 1, saida: 5, cacheLeitura: 0.1, cacheEscrita: 1.25 },
]

/** Sufixo de variante do OpenRouter (`:free`, `:nitro`, `:floor`, `:beta`, `:thinking`…). */
const SUFIXO_VARIANTE = /:([a-z][a-z-]*)$/
/** Prefixo de inference profile do Bedrock: `us.` `eu.` `apac.` `jp.` `global.` `us-gov.` + `anthropic.`. */
const PREFIXO_PERFIL = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?anthropic\./

/**
 * O id que o FORNECEDOR devolve → o id base do modelo, para achar o preço.
 *
 *   'openai/gpt-oss-120b'                                  → 'gpt-oss-120b'
 *   'us.anthropic.claude-sonnet-5-5-20260101-v1:0'         → 'claude-sonnet-5-5'
 *   'arn:aws:bedrock:…:inference-profile/global.anthropic.claude-opus-5-5' → 'claude-opus-5-5'
 *   'qwen/qwen3-coder:free'                                → 'qwen3-coder'
 *   'claude-haiku-4-5@20251001' · 'claude-sonnet-5.5'      → 'claude-haiku-4-5' · 'claude-sonnet-5-5'
 *   'models/gemini-2.5-flash'                              → 'gemini-2-5-flash'
 *
 * Puro e idempotente; o catálogo passa pela MESMA função (os dois lados casam).
 * ⚠️ ARN de *application* inference profile (id opaco) não tem como ser
 *    mapeado: cai em desconhecido, com alerta.
 */
export function normalizarIdModelo(id: string): string {
  let v = id.trim().toLowerCase()
  // ARN e caminho de fornecedor (`openai/…`, `models/…`, `meta-llama/…`): fica o último segmento.
  if (v.includes('/')) v = v.slice(v.lastIndexOf('/') + 1)
  v = v.replace(/-v\d+:\d+$/, '') // versão do Bedrock (-v1:0) — só com ':N', para não juntar deepseek-v2/v3
  v = v.replace(SUFIXO_VARIANTE, '') // :free, :nitro…
  v = v.replace(PREFIXO_PERFIL, '') // us.anthropic. / anthropic.
  v = v.replace(/@\d{8}$/, '') // Vertex: claude-…@20251001
  v = v.replace(/-\d{4}-\d{2}-\d{2}$/, '') // -2025-10-01
  v = v.replace(/-\d{8}$/, '') // -20251001
  v = v.replace(/-latest$/, '')
  v = v.replace(/(\d)\.(\d)/g, '$1-$2') // claude-sonnet-5.5 ≡ claude-sonnet-5-5
  return v
}

/** Variante gratuita pelo próprio id (`…:free`) — o fornecedor não cobra. */
export function ehVarianteGratuita(id: string): boolean {
  return /:free$/i.test(id.trim())
}

function precoDaLinha(l: LinhaPreco): PrecoUsdPorMilhao {
  return { entrada: l.entrada, saida: l.saida, cacheLeitura: l.cacheLeitura ?? l.entrada, cacheEscrita: l.cacheEscrita ?? l.entrada }
}

/** O maior preço do catálogo, componente a componente (desconhecido = pior caso). */
export function maiorPreco(catalogo: readonly LinhaPreco[]): PrecoUsdPorMilhao {
  const fonte = catalogo.length > 0 ? catalogo : CATALOGO_RESERVA
  return fonte.map(precoDaLinha).reduce((a, b) => ({
    entrada: Math.max(a.entrada, b.entrada), saida: Math.max(a.saida, b.saida),
    cacheLeitura: Math.max(a.cacheLeitura, b.cacheLeitura), cacheEscrita: Math.max(a.cacheEscrita, b.cacheEscrita),
  }), ZERO)
}

/**
 * Resolve o preço contra um catálogo em memória. Puro (o teste usa direto).
 *
 * Ordem: simulado → 0; `:free` → 0; entrada do MESMO provedor (gratuita → 0,
 * senão o preço dela); sem provedor informado e um único candidato → ele; o
 * mesmo modelo noutro provedor → o MAIOR preço de lista entre os candidatos,
 * sem o "gratuito" (o plano grátis é do provedor, não do modelo); nada → o
 * maior preço do catálogo, origem `desconhecido`.
 */
export function resolverPreco(
  catalogo: readonly LinhaPreco[], p: { provedor: string | null; modelo: string },
): PrecoResolvido {
  const idNormalizado = normalizarIdModelo(p.modelo)
  if (p.provedor === 'simulado' || idNormalizado === 'simulado') return { preco: ZERO, origem: 'gratuito', codigo: null, idNormalizado }
  if (ehVarianteGratuita(p.modelo)) return { preco: ZERO, origem: 'gratuito', codigo: null, idNormalizado }

  // ⚠️ Linha `…:free` do catálogo só vale para id também `:free` (que já saiu
  //    acima como gratuito): o mesmo modelo SEM `:free` é o pago, e não pode
  //    herdar o preço zero da variante gratuita.
  const candidatos = catalogo.filter((l) => !ehVarianteGratuita(l.modelo)
    && (normalizarIdModelo(l.modelo) === idNormalizado || normalizarIdModelo(l.codigo) === idNormalizado))
  const doProvedor = p.provedor ? candidatos.filter((l) => l.provedor === p.provedor) : candidatos
  const unico = doProvedor.length === 1 ? doProvedor[0]! : null
  if (unico) {
    return unico.gratuito
      ? { preco: ZERO, origem: 'gratuito', codigo: unico.codigo, idNormalizado }
      : { preco: precoDaLinha(unico), origem: 'catalogo', codigo: unico.codigo, idNormalizado }
  }
  const pool = doProvedor.length > 1 ? doProvedor : candidatos
  if (pool.length > 0) {
    const caro = [...pool].sort((a, b) => b.saida - a.saida || b.entrada - a.entrada)[0]!
    return { preco: maiorPreco(pool), origem: 'catalogo', codigo: caro.codigo, idNormalizado }
  }
  return { preco: maiorPreco(catalogo), origem: 'desconhecido', codigo: null, idNormalizado }
}

/** Cache do catálogo no processo. */
export const VALIDADE_CACHE_PRECOS_MS = 10 * 60 * 1000
let cache: { linhas: readonly LinhaPreco[]; em: number } | null = null

/** Lê o catálogo inteiro (global, sem tenant — inclui inativos: decisão antiga ainda precisa de preço). */
async function lerCatalogo(): Promise<readonly LinhaPreco[]> {
  const linhas = await sql<{
    codigo: string; provedor: string; modelo: string; gratuito: boolean
    custo_entrada_usd_milhao: string; custo_saida_usd_milhao: string
    custo_cache_leitura_usd_milhao: string | null; custo_cache_escrita_usd_milhao: string | null
  }[]>`
    SELECT codigo, provedor, modelo, gratuito, custo_entrada_usd_milhao, custo_saida_usd_milhao,
           custo_cache_leitura_usd_milhao, custo_cache_escrita_usd_milhao
      FROM modelo_ia`
  return linhas.map((l) => ({
    codigo: l.codigo, provedor: l.provedor, modelo: l.modelo, gratuito: l.gratuito,
    entrada: Number(l.custo_entrada_usd_milhao), saida: Number(l.custo_saida_usd_milhao),
    cacheLeitura: l.custo_cache_leitura_usd_milhao === null ? null : Number(l.custo_cache_leitura_usd_milhao),
    cacheEscrita: l.custo_cache_escrita_usd_milhao === null ? null : Number(l.custo_cache_escrita_usd_milhao),
  }))
}

/**
 * O catálogo com cache de 10 min. Falha de leitura NÃO zera custo: usa o cache
 * velho, ou a reserva com os preços da Anthropic (e tenta de novo na próxima).
 */
export async function catalogoDePrecos(agoraMs = Date.now()): Promise<readonly LinhaPreco[]> {
  if (cache && agoraMs - cache.em < VALIDADE_CACHE_PRECOS_MS) return cache.linhas
  try {
    const linhas = await lerCatalogo()
    cache = { linhas, em: agoraMs }
    return linhas
  } catch (e) {
    avisar('catalogo_precos_indisponivel', { erro: (e as Error).message })
    return cache?.linhas ?? CATALOGO_RESERVA
  }
}

/**
 * PREÇO DO MODELO pelo catálogo (cache 10 min). ⚠️ Contrato público: a raia P12
 * (juiz amostrado) usa isto para o custo da avaliação — nunca tabela própria.
 */
export async function precoDoModelo(p: { provedor: string | null; modelo: string }): Promise<PrecoResolvido> {
  return resolverPreco(await catalogoDePrecos(), p)
}

/** Esquece o catálogo em cache e os alertas já abertos neste processo (testes, e após editar o catálogo). */
export function limparCacheDeCusto(): void {
  cache = null
  alertasDePrecoAbertos.clear()
  ultimaVerificacaoMensal.clear()
}

// ── centavos ─────────────────────────────────────────────────────────────────

/** Câmbio US$→R$ do ambiente — o mesmo `IA_CAMBIO_BRL` (padrão 5,5) que sempre valeu. */
export function cambioBrl(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.IA_CAMBIO_BRL)
  return Number.isFinite(v) && v > 0 ? v : 5.5
}

/** Uso × preço × câmbio → centavos INTEIROS de real. Puro. */
export function centavosDoUso(preco: PrecoUsdPorMilhao, uso: UsoDoLaco, cambio = cambioBrl()): number {
  const usd = (uso.entrada * preco.entrada + uso.saida * preco.saida
    + uso.cacheLeitura * preco.cacheLeitura + uso.cacheEscrita * preco.cacheEscrita) / 1_000_000
  return Math.round(usd * cambio * 100)
}

/**
 * CUSTO DE UM LAÇO, em centavos. O turno sempre chama por aqui.
 *
 * Preço desconhecido → maior preço + log; com `tenantId`, abre também o alerta
 * `preco_desconhecido` do tenant (uma vez por modelo por processo; o índice de
 * `alerta` deduplica entre processos). Sem `tenantId`, o alerta sai na próxima
 * verificação mensal do tenant (`verificarOrcamentoMensal`), que relê os
 * modelos usados no mês.
 */
export async function custoDoLaco(p: {
  provedor: string | null; modelo: string; uso: UsoDoLaco; tenantId?: string | undefined
}): Promise<number> {
  const r = await precoDoModelo(p)
  if (r.origem === 'desconhecido') {
    avisar('preco_desconhecido', { provedor: p.provedor, modelo: p.modelo, idNormalizado: r.idNormalizado })
    if (p.tenantId) {
      await comTenantServico(p.tenantId, (tx) => abrirAlertaPrecoDesconhecido(tx, p.tenantId!, [r.idNormalizado]))
        .catch((e: Error) => avisar('alerta_preco_desconhecido_falhou', { erro: e.message }))
    }
  }
  return centavosDoUso(r.preco, p.uso)
}

const alertasDePrecoAbertos = new Set<string>()

/** Abre (ou mantém aberto) o alerta `preco_desconhecido` do tenant. Chamar sob tenant. */
export async function abrirAlertaPrecoDesconhecido(tx: Sql, tenantId: string, ids: readonly string[]): Promise<boolean> {
  const novos = ids.filter((id) => !alertasDePrecoAbertos.has(`${tenantId}:${id}`))
  if (novos.length === 0) return false
  const mensagem = `Modelo de IA sem preço no catálogo (${novos.join(', ').slice(0, 200)}): o custo está sendo estimado `
    + 'pelo MAIOR preço do catálogo, e os tetos podem disparar antes da hora. Cadastre o preço em modelo_ia.'
  const nova = await tx<{ id: string }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, 'preco_desconhecido', 'aviso', ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
    RETURNING id`
  if (nova.length > 0) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  }
  for (const id of novos) alertasDePrecoAbertos.add(`${tenantId}:${id}`)
  return nova.length > 0
}

// ── teto por sessão ──────────────────────────────────────────────────────────

/** Padrão do teto por sessão quando nem o número nem o ambiente dizem: R$ 3,00. */
export const TETO_SESSAO_PADRAO_CENTAVOS = 300

/** `IA_TETO_SESSAO_CENTAVOS` (inteiro ≥ 0; 0 desliga) ou o padrão. */
export function tetoSessaoDoAmbiente(env: NodeJS.ProcessEnv = process.env): number {
  const bruto = env.IA_TETO_SESSAO_CENTAVOS?.trim()
  if (!bruto) return TETO_SESSAO_PADRAO_CENTAVOS
  const v = Number(bruto)
  return Number.isInteger(v) && v >= 0 ? v : TETO_SESSAO_PADRAO_CENTAVOS
}

/**
 * O teto que vale para a sessão: `agente_config.teto_sessao_centavos` do número
 * (leitura tolerante de `cfgExtra`) ou o do ambiente. `null` = sem teto (0).
 */
export function tetoSessaoEfetivo(cfgExtra: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): number | null {
  const bruto = cfgExtra['teto_sessao_centavos']
  const doNumero = bruto === null || bruto === undefined ? null : Number(bruto)
  const v = doNumero !== null && Number.isFinite(doNumero) && doNumero >= 0 ? Math.trunc(doNumero) : tetoSessaoDoAmbiente(env)
  return v === 0 ? null : v
}

/**
 * Custo acumulado da sessão. 0 sem sessão. Chamar sob tenant.
 *
 * ⚠️ Soma `agente_decisao.custo_centavos` da sessão — inclusive dos turnos que
 *    FALHARAM (o laço gastou e não respondeu), que `agente_sessao.custo_centavos`
 *    não acumula. Fica o MAIOR dos dois: decisão antiga sem `sessao_id` ainda
 *    conta pela sessão. Filtra pela conversa para usar o índice
 *    `agente_decisao_por_conversa`.
 */
export async function custoDaSessao(tx: Sql, sessaoId: string | null, conversaId: string): Promise<number> {
  if (!sessaoId) return 0
  const [l] = await tx<{ custo: string }[]>`
    SELECT greatest(
             (SELECT coalesce(sum(custo_centavos), 0) FROM agente_decisao
               WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND sessao_id = ${sessaoId}),
             (SELECT coalesce(max(custo_centavos), 0) FROM agente_sessao
               WHERE tenant_id = tenant_atual() AND id = ${sessaoId}))::text AS custo`
  return Number(l?.custo ?? 0)
}

// ── orçamento mensal do tenant ───────────────────────────────────────────────

export interface SituacaoMensal {
  /** 'YYYY-MM' no fuso do tenant. */
  readonly mes: string
  readonly gastoCentavos: number
  readonly mensalCentavos: number | null
  readonly alertado80: boolean
  readonly alertado100: boolean
  /** Modelos usados no mês sem preço no catálogo (ids normalizados). */
  readonly modelosSemPreco: readonly string[]
}

/**
 * Gasto do mês corrente do tenant (fuso do tenant), somado POR NÚMERO para usar
 * o índice `agente_decisao_custo_dia (tenant_id, canal_id, criado_em)` — a
 * soma direta por tenant varreria o histórico inteiro. Chamar sob tenant.
 *
 * TODO(P20): `array_agg(DISTINCT modelo)` lê o heap (o índice só INCLUI
 *   `custo_centavos`). Se a soma do mês pesar, criar índice
 *   `(tenant_id, canal_id, criado_em) INCLUDE (custo_centavos, modelo)` em
 *   migration própria (CONCURRENTLY fora da transação do runner).
 */
export async function situacaoMensal(tx: Sql, agora: Date, custoExtraCentavos = 0): Promise<SituacaoMensal> {
  // ⚠️ Fuso validado em TS (fuso.ts): um fuso inválido no AT TIME ZONE derrubava a consulta.
  const [tf] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
  const fuso = fusoSeguro(tf?.fuso)
  const [l] = await tx<{
    mes: string; gasto: string; modelos: string[] | null
    mensal: string | null; a80: string | null; a100: string | null
  }[]>`
    WITH t AS (SELECT ${fuso}::text AS fuso),
         janela AS (
           SELECT to_char(${agora}::timestamptz AT TIME ZONE t.fuso, 'YYYY-MM') AS mes,
                  date_trunc('month', ${agora}::timestamptz AT TIME ZONE t.fuso) AT TIME ZONE t.fuso AS inicio
             FROM t),
         por_canal AS (
           SELECT x.gasto, x.modelos
             FROM canal_conectado c, janela j,
                  LATERAL (SELECT coalesce(sum(d.custo_centavos), 0) AS gasto,
                                  array_agg(DISTINCT d.modelo) FILTER (WHERE d.modelo IS NOT NULL AND d.custo_centavos > 0) AS modelos
                             FROM agente_decisao d
                            WHERE d.tenant_id = c.tenant_id AND d.canal_id = c.id AND d.criado_em >= j.inicio) x
            WHERE c.tenant_id = tenant_atual())
    SELECT j.mes,
           (SELECT coalesce(sum(gasto), 0) FROM por_canal)::text AS gasto,
           (SELECT array_agg(DISTINCT m) FROM por_canal, unnest(por_canal.modelos) AS m) AS modelos,
           o.mensal_centavos::text AS mensal, o.alertado_80_mes AS a80, o.alertado_100_mes AS a100
      FROM janela j
      LEFT JOIN agente_orcamento o ON o.tenant_id = tenant_atual()`
  const mes = l?.mes ?? agora.toISOString().slice(0, 7)
  const catalogo = await catalogoDePrecos()
  const modelosSemPreco = [...new Set((l?.modelos ?? [])
    .map((m) => resolverPreco(catalogo, { provedor: null, modelo: m }))
    .filter((r) => r.origem === 'desconhecido')
    .map((r) => r.idNormalizado))]
  return {
    mes,
    gastoCentavos: Number(l?.gasto ?? 0) + custoExtraCentavos,
    mensalCentavos: l?.mensal === null || l?.mensal === undefined ? null : Number(l.mensal),
    alertado80: l?.a80 === mes,
    alertado100: l?.a100 === mes,
    modelosSemPreco,
  }
}

/** Qual limiar do mês o gasto atingiu. Puro, em inteiros (sem ponto flutuante em dinheiro). */
export function limiarAtingido(gastoCentavos: number, mensalCentavos: number | null): 0 | 80 | 100 {
  if (mensalCentavos === null || mensalCentavos <= 0) return 0
  if (gastoCentavos >= mensalCentavos) return 100
  if (gastoCentavos * 100 >= mensalCentavos * 80) return 80
  return 0
}

export interface ResultadoVerificacaoMensal {
  /** Limiar que ALERTOU nesta chamada (0 = nenhum alerta novo). */
  readonly alertou: 0 | 80 | 100
  readonly situacao: SituacaoMensal
}

/**
 * Verifica o orçamento do mês e alerta a 80% e a 100%, UMA vez por mês cada.
 * Só avisa — não corta nada.
 *
 * ⚠️ "Uma vez" é garantido pelo banco, não pela memória: o UPDATE só vence se
 *    `alertado_X_mes` ainda não é o mês corrente — dois processos concorrentes
 *    e um restart não duplicam. Salto direto para 100% marca os dois limiares
 *    e alerta só o de 100%.
 * ⚠️ Também abre `preco_desconhecido` para modelos do mês sem preço — é o que
 *    torna o alerta visível mesmo quando o turno não informa o tenant ao custo.
 * Chamar sob tenant.
 */
export async function verificarOrcamentoMensal(
  tx: Sql, tenantId: string, agora: Date, custoExtraCentavos = 0,
): Promise<ResultadoVerificacaoMensal> {
  const situacao = await situacaoMensal(tx, agora, custoExtraCentavos)
  if (situacao.modelosSemPreco.length > 0) await abrirAlertaPrecoDesconhecido(tx, tenantId, situacao.modelosSemPreco)

  const limiar = limiarAtingido(situacao.gastoCentavos, situacao.mensalCentavos)
  if (limiar === 0) return { alertou: 0, situacao }
  if (limiar === 80 && situacao.alertado80) return { alertou: 0, situacao }
  if (limiar === 100 && situacao.alertado100) return { alertou: 0, situacao }

  const venceu = limiar === 100
    ? await tx`
        UPDATE agente_orcamento SET alertado_100_mes = ${situacao.mes}, alertado_80_mes = ${situacao.mes}
         WHERE tenant_id = tenant_atual() AND alertado_100_mes IS DISTINCT FROM ${situacao.mes}
        RETURNING tenant_id`
    : await tx`
        UPDATE agente_orcamento SET alertado_80_mes = ${situacao.mes}
         WHERE tenant_id = tenant_atual() AND alertado_80_mes IS DISTINCT FROM ${situacao.mes}
        RETURNING tenant_id`
  if (venceu.length === 0) return { alertou: 0, situacao }

  const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const mensagem = limiar === 100
    ? `Orçamento mensal de IA atingido: ${reais(situacao.gastoCentavos)} de ${reais(situacao.mensalCentavos!)} em ${situacao.mes}. `
      + 'O agente continua atendendo — quem corta é o teto do número e o da conversa. Revise o orçamento ou os tetos.'
    : `80% do orçamento mensal de IA usado: ${reais(situacao.gastoCentavos)} de ${reais(situacao.mensalCentavos!)} em ${situacao.mes}.`
  const tipo = limiar === 100 ? 'agente_orcamento_100' : 'agente_orcamento_80'
  // Alerta de mês anterior ainda aberto é reaproveitado com o texto novo (o
  // índice só deixa um aberto por tipo) — senão o mês novo não apareceria.
  await tx`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, ${tipo}, ${limiar === 100 ? 'critico' : 'aviso'}, ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL
    DO UPDATE SET mensagem = EXCLUDED.mensagem, severidade = EXCLUDED.severidade, criado_em = now()`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  await notificarAdmins(tx, `IA: ${limiar}% do orçamento do mês`)
  return { alertou: limiar, situacao }
}

/** Teto de quem recebe a notificação pessoal — visível, como em `notificacao.ts`. */
const TETO_DESTINATARIOS = 20

/**
 * Sino dos ADMINS do tenant; sem admin atribuído (modo fundador, `papel.ts`),
 * todos os usuários ativos. Notificação sem conversa (`conversa_id NULL`).
 */
async function notificarAdmins(tx: Sql, titulo: string): Promise<void> {
  const admins = await tx<{ id: string }[]>`
    SELECT DISTINCT u.id FROM usuario u
      JOIN usuario_filial uf ON uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id AND uf.papel = 'admin'
     WHERE u.tenant_id = tenant_atual() AND u.ativo
     LIMIT ${TETO_DESTINATARIOS}`
  const destinatarios = admins.length > 0 ? admins : await tx<{ id: string }[]>`
    SELECT id FROM usuario WHERE tenant_id = tenant_atual() AND ativo LIMIT ${TETO_DESTINATARIOS}`
  for (const { id } of destinatarios) {
    await tx`
      INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id)
      VALUES (tenant_atual(), ${randomUUID()}, ${id}, 'agente.orcamento', ${titulo}, NULL)`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'notificacao.nova', 'usuario', ${id}, ${JSON.stringify({ usuarioId: id })}::text::jsonb)`
  }
}

/** Intervalo mínimo entre verificações mensais do mesmo tenant no processo. */
export const INTERVALO_VERIFICACAO_MENSAL_MS = 60_000
const ultimaVerificacaoMensal = new Map<string, number>()

/**
 * A verificação mensal no caminho do turno: no máximo uma por minuto por tenant
 * e NUNCA derruba o turno (alerta é acessório; falhar aqui só vira log).
 * `forcar` ignora o intervalo — o turno que acabou de gastar passa por aqui.
 */
export async function verificarOrcamentoNoTurno(
  tenantId: string, agora: Date, opcoes: { custoExtraCentavos?: number; forcar?: boolean } = {},
): Promise<void> {
  const ms = agora.getTime()
  const ultima = ultimaVerificacaoMensal.get(tenantId)
  if (!opcoes.forcar && ultima !== undefined && ms - ultima < INTERVALO_VERIFICACAO_MENSAL_MS && ms >= ultima) return
  ultimaVerificacaoMensal.set(tenantId, ms)
  try {
    await comTenantServico(tenantId, (tx) => verificarOrcamentoMensal(tx, tenantId, agora, opcoes.custoExtraCentavos ?? 0))
  } catch (e) {
    avisar('verificacao_orcamento_falhou', { erro: (e as Error).message })
  }
}

// ── log ──────────────────────────────────────────────────────────────────────

const avisados = new Set<string>()
/** Log estruturado, uma vez por (evento, conteúdo) no processo. Nunca dado de cliente aqui. */
function avisar(evento: string, dados: Record<string, unknown>): void {
  const chave = `${evento}:${JSON.stringify(dados)}`
  if (avisados.has(chave)) return
  if (avisados.size > 500) avisados.clear()
  avisados.add(chave)
  console.warn(JSON.stringify({ nivel: 'warn', contexto: 'agente.custo', evento, ...dados }))
}
