import { randomUUID } from 'node:crypto'
import {
  MODOS_AGENTE, PRAZO_COPILOTO_MS, LIMIAR_SIMILARIDADE_SOMBRA, marcaGuardrail,
  avisosDaSugestao, bloqueadaPelaQualidade, motivoDoBloqueio, foiEditada, naoEnvieAssim, pedeConfirmarOptOut, similaridadeTextos, taxaSombra, taxasDaSugestao, textoDaSugestao,
  type ContagensSugestao, type DesfechoSugestao, type MarcaGuardrail, type MetricasSugestoes, type ModoAgente,
  type OrigemSugestao, type SugestaoVigente,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno, type ResultadoTurnoVendedor } from './vendedor.js'
import { ligacoesPadrao } from './ferramentas/ligacoes.js'

/**
 * SUGESTÃO DO ASSISTIDO E COPILOTO — o lado do VENDEDOR (raia P13; playbook AM §6.1, §6.2, §6.4).
 *
 * A sugestão é uma `agente_decisao`:
 *   - modo `assistido`: o turno do agente decidiu e NÃO enviou (vendedor.ts grava e publica
 *     `agente.sugestao` pelo outbox, payload só com ids);
 *   - modo `copiloto`: o vendedor clicou "Sugerir resposta" — o MESMO turno, com `copiloto: true`
 *     (sem portão, sem envio, sem sessão, sem atendimento; só a decisão de auditoria).
 *
 * O texto já passou pelo pipeline inteiro (filtro P2, números P7, pergunta P3, rede de R$); as
 * MARCAS de guardrail viram avisos por gravidade (CRÍTICA = "não envie assim", ADR-031).
 *
 * Métrica (fonte da verdade = banco, 0103): o envio com `sugestaoDecisaoId` grava enviada × editada
 * + similaridade; descartar grava `descartada`; responder sem usar marca `superada`. Em SOMBRA, a
 * primeira mensagem humana depois de uma decisão grava `sombra_similaridade`.
 */

/** Predicado SQL de "esta decisão (alias d) é uma sugestão mostrável" — o MESMO no GET e nas métricas. */
const ehSugestao = (tx: Sql) => tx`d.modo IN ('assistido', 'copiloto') AND d.desfecho IN ('sugeriu', 'handoff')
  AND jsonb_typeof(d.resposta->'mensagens') = 'array' AND jsonb_array_length(d.resposta->'mensagens') > 0`

/** Mensagem (alias m) saliente escrita por uma PESSOA: não sistema, não automática do agente/ausência. */
const ehHumana = (tx: Sql) => tx`m.direcao = 'saliente' AND m.tipo <> 'sistema' AND NOT (m.conteudo ? 'automatica')`

interface LinhaSugestao {
  id: string
  modo: OrigemSugestao
  resposta: { mensagens?: unknown; handoff?: { motivo?: unknown; resumo?: unknown } | null } | null
  guardrails: unknown
  handoff_motivo: string | null
  criado_em: Date
}

function marcasDe(v: unknown): MarcaGuardrail[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((x) => { const p = marcaGuardrail.safeParse(x); return p.success ? [p.data] : [] })
}

function mensagensDe(resposta: LinhaSugestao['resposta']): string[] {
  const ms = resposta?.mensagens
  return Array.isArray(ms) ? ms.filter((m): m is string => typeof m === 'string') : []
}

function paraVigente(l: LinhaSugestao): SugestaoVigente {
  const marcas = marcasDe(l.guardrails)
  const h = l.resposta?.handoff
  return {
    decisaoId: l.id,
    origem: l.modo,
    texto: textoDaSugestao(mensagensDe(l.resposta)),
    criadaEm: new Date(l.criado_em).toISOString(),
    avisos: avisosDaSugestao(marcas),
    naoEnvie: naoEnvieAssim(marcas),
    bloqueada: bloqueadaPelaQualidade(marcas),
    motivoBloqueio: motivoDoBloqueio(marcas),
    optOutAConfirmar: pedeConfirmarOptOut(marcas),
    handoff: h && typeof h.motivo === 'string'
      ? { motivo: h.motivo, resumo: typeof h.resumo === 'string' ? h.resumo : '' }
      : l.handoff_motivo ? { motivo: l.handoff_motivo, resumo: '' } : null,
  }
}

/**
 * A sugestão VIGENTE da conversa (sob tenant): a mais nova ainda pendente, desde que nenhuma
 * pessoa tenha respondido depois dela (inclusive por outro caminho — app, celular).
 */
export async function lerSugestaoVigente(tx: Sql, conversaId: string): Promise<SugestaoVigente | null> {
  const [l] = await tx<LinhaSugestao[]>`
    SELECT d.id, d.modo, d.resposta, d.guardrails, d.handoff_motivo, d.criado_em
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${conversaId}
       AND d.sugestao_estado IS NULL AND ${ehSugestao(tx)}
       AND NOT EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = d.tenant_id AND m.conversa_id = d.conversa_id
                          AND m.criado_em > d.criado_em AND ${ehHumana(tx)})
     ORDER BY d.criado_em DESC, d.id DESC
     LIMIT 1`
  return l ? paraVigente(l) : null
}

export async function lerSugestaoPorId(tx: Sql, decisaoId: string): Promise<SugestaoVigente | null> {
  const [l] = await tx<LinhaSugestao[]>`
    SELECT d.id, d.modo, d.resposta, d.guardrails, d.handoff_motivo, d.criado_em
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${decisaoId} AND ${ehSugestao(tx)}`
  return l ? paraVigente(l) : null
}

// ── modo para o copiloto ────────────────────────────────────────────────────

const ORDEM_MODO: Readonly<Record<ModoAgente, number>> = { desligado: 0, sombra: 1, assistido: 2, autonomo: 3 }
const ehModo = (v: unknown): v is ModoAgente => typeof v === 'string' && (MODOS_AGENTE as readonly string[]).includes(v)

/**
 * O modo que vale para o copiloto neste número (sob tenant). `null` = agente não configurado.
 *
 * TODO(P14): trocar por `modoEfetivoSeguro(tenantId, { canalId, contatoId, agora })` de
 * `pipeline/modo-efetivo.ts` quando a P14 entrar (recorte incluído). Até lá: o mais restritivo
 * entre `agente_config.modo` e `agente_tenant.modo_maximo` — este lido com tolerância (a tabela
 * só existe depois da 0104). Nunca lança: erro ao ler o teto do tenant → `sombra` (como a P14).
 */
export async function modoParaCopiloto(tx: Sql, canalId: string): Promise<ModoAgente | null> {
  const [cfg] = await tx<{ modo: string }[]>`
    SELECT modo FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
  if (!cfg || !ehModo(cfg.modo)) return null
  let teto: ModoAgente = 'autonomo'
  try {
    const [existe] = await tx<{ ok: boolean }[]>`SELECT to_regclass('agente_tenant') IS NOT NULL AS ok`
    if (existe?.ok) {
      const [t] = await tx<{ modo: string | null }[]>`
        SELECT to_jsonb(t)->>'modo_maximo' AS modo FROM agente_tenant t WHERE t.tenant_id = tenant_atual()`
      if (t && ehModo(t.modo)) teto = t.modo
    }
  } catch {
    teto = 'sombra'
  }
  return ORDEM_MODO[teto] < ORDEM_MODO[cfg.modo] ? teto : cfg.modo
}

// ── copiloto sob demanda ────────────────────────────────────────────────────

export type ResultadoCopiloto =
  | { readonly tipo: 'ok'; readonly sugestao: SugestaoVigente }
  | { readonly tipo: 'conversa_inexistente' }
  | { readonly tipo: 'sem_configuracao' }
  | { readonly tipo: 'desligado' }
  | { readonly tipo: 'em_andamento' }
  | { readonly tipo: 'indisponivel'; readonly detalhe: string }
  | { readonly tipo: 'sem_sugestao'; readonly motivo: string; readonly resumo: string | null }

export interface OpcoesCopiloto {
  /** Porta do modelo (testes). Em produção, a do número/ambiente, escolhida pelo turno. */
  readonly llm?: DepsTurno['llm']
  readonly prazoMs?: number
  readonly agora?: Date
}

/** Uma geração por conversa por vez neste processo (custo; playbook §6.2). */
const emAndamento = new Set<string>()

const TEMPO_ESGOTADO = Symbol('tempo_esgotado')

/**
 * Gera uma sugestão sob demanda. SÓ LEITURA: o turno roda com `copiloto: true` — nada vai ao
 * cliente, nenhuma sessão abre ou muda, nenhum atendimento nasce; fica só a `agente_decisao`
 * (modo `copiloto`) que é a própria sugestão e a sua auditoria.
 *
 * ⚠️ Kill switch: agente `desligado` no número (ou teto do tenant) → não chama o modelo.
 * ⚠️ Prazo de 20 s (PRAZO_COPILOTO_MS): passou, a tela recebe "indisponível" e o turno, se ainda
 *    terminar, só grava a decisão — nunca envia nada (copiloto não envia por construção).
 */
export async function gerarCopiloto(tenantId: string, conversaId: string, opcoes: OpcoesCopiloto = {}): Promise<ResultadoCopiloto> {
  const agora = opcoes.agora ?? new Date()
  const preparo = await comTenantServico(tenantId, async (tx) => {
    const [c] = await tx<{ canal_id: string }[]>`
      SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${conversaId}`
    if (!c) return { tipo: 'conversa_inexistente' as const }
    const modo = await modoParaCopiloto(tx, c.canal_id)
    if (modo === null) return { tipo: 'sem_configuracao' as const }
    if (modo === 'desligado') return { tipo: 'desligado' as const }
    // As entrantes ainda sem resposta são "o que o cliente disse agora"; sem nenhuma, o turno
    // sugere a retomada a partir do histórico.
    const entrantes = await tx<{ id: string }[]>`
      SELECT m.id FROM mensagem m
       WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.direcao = 'entrante'
         AND m.criado_em > coalesce((SELECT max(s.criado_em) FROM mensagem s
                                      WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
                                        AND s.direcao = 'saliente' AND s.tipo <> 'sistema'), '-infinity'::timestamptz)
       ORDER BY m.criado_em DESC LIMIT 10`
    return { tipo: 'ok' as const, canalId: c.canal_id, ids: entrantes.map((e) => e.id).reverse() }
  })
  if (preparo.tipo !== 'ok') return preparo

  const chave = `${tenantId}:${conversaId}`
  if (emAndamento.has(chave)) return { tipo: 'em_andamento' }
  emAndamento.add(chave)
  let r: ResultadoTurnoVendedor | typeof TEMPO_ESGOTADO
  let relogio: ReturnType<typeof setTimeout> | undefined
  const turno = conduzirTurnoVendedor(
    { tenant_id: tenantId, id: randomUUID(), conversa_id: conversaId, canal_id: preparo.canalId, mensagens_ids: preparo.ids, tentativas: 1, executar_em: agora },
    { ligacoes: ligacoesPadrao, copiloto: true, agora, ...(opcoes.llm ? { llm: opcoes.llm } : {}) },
  )
  // O turno segue sozinho depois do prazo; a trava por conversa só sai quando ele termina.
  void turno.catch(() => undefined).finally(() => emAndamento.delete(chave))
  try {
    r = await Promise.race([
      turno,
      new Promise<typeof TEMPO_ESGOTADO>((res) => { relogio = setTimeout(() => res(TEMPO_ESGOTADO), opcoes.prazoMs ?? PRAZO_COPILOTO_MS) }),
    ])
  } catch (e) {
    return { tipo: 'indisponivel', detalhe: e instanceof Error ? e.message.slice(0, 200) : 'erro' }
  } finally {
    clearTimeout(relogio)
  }
  if (r === TEMPO_ESGOTADO) return { tipo: 'indisponivel', detalhe: 'tempo_esgotado' }
  if (r.desfecho === 'falha') return { tipo: 'indisponivel', detalhe: r.motivo ?? 'falha' }
  if (r.decisaoId && (r.desfecho === 'sugeriu' || r.desfecho === 'handoff')) {
    const s = await comTenantServico(tenantId, (tx) => lerSugestaoPorId(tx, r.decisaoId!))
    if (s) return { tipo: 'ok', sugestao: s }
  }
  return { tipo: 'sem_sugestao', motivo: r.handoff?.motivo ?? String(r.motivo ?? r.desfecho), resumo: r.handoff?.resumo ?? null }
}

// ── desfecho da sugestão ────────────────────────────────────────────────────

export type ResultadoUso =
  | { readonly registrada: true; readonly estado: Extract<DesfechoSugestao, 'enviada' | 'editada'>; readonly similaridade: number }
  | { readonly registrada: false; readonly motivo: 'nao_encontrada' | 'ja_decidida' }

/**
 * O vendedor ENVIOU a partir da sugestão (sob tenant, depois do envio ok). Compara com o texto
 * sugerido no servidor — a tela não decide se editou. Idempotente: decidir de novo não muda nada.
 */
export async function registrarUsoDaSugestao(tx: Sql, p: {
  conversaId: string; decisaoId: string; textoEnviado: string; mensagemId: string; agora: Date
}): Promise<ResultadoUso> {
  const [d] = await tx<{ resposta: LinhaSugestao['resposta']; sugestao_estado: string | null }[]>`
    SELECT d.resposta, d.sugestao_estado FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${p.decisaoId} AND d.conversa_id = ${p.conversaId}
       AND ${ehSugestao(tx)}
     FOR UPDATE`
  if (!d) return { registrada: false, motivo: 'nao_encontrada' }
  if (d.sugestao_estado !== null) return { registrada: false, motivo: 'ja_decidida' }
  const sugerido = textoDaSugestao(mensagensDe(d.resposta))
  const estado = foiEditada(sugerido, p.textoEnviado) ? 'editada' as const : 'enviada' as const
  const similaridade = similaridadeTextos(sugerido, p.textoEnviado)
  await tx`
    UPDATE agente_decisao
       SET sugestao_estado = ${estado}, sugestao_mensagem_id = ${p.mensagemId},
           sugestao_usada_em = ${p.agora}, sugestao_similaridade = ${similaridade}
     WHERE tenant_id = tenant_atual() AND id = ${p.decisaoId} AND sugestao_estado IS NULL`
  return { registrada: true, estado, similaridade }
}

/**
 * P12 × P13: a sugestão `regras-qualidade/nao_envie` NÃO sai inalterada (sob tenant, ANTES de
 * gravar ou despachar qualquer coisa). Texto editado passa — a responsabilidade é de quem reescreveu.
 * Id inexistente, de outra conversa ou de outro tenant → não bloqueia (o envio nunca depende disso).
 */
export async function envioBloqueadoPelaQualidade(tx: Sql, p: { conversaId: string; decisaoId: string; texto: string }): Promise<boolean> {
  const [d] = await tx<{ resposta: LinhaSugestao['resposta']; guardrails: unknown }[]>`
    SELECT d.resposta, d.guardrails FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${p.decisaoId} AND d.conversa_id = ${p.conversaId}
       AND ${ehSugestao(tx)}`
  if (!d || !bloqueadaPelaQualidade(marcasDe(d.guardrails))) return false
  return !foiEditada(textoDaSugestao(mensagensDe(d.resposta)), p.texto)
}

/** O vendedor respondeu a conversa: toda sugestão ainda pendente nela vira `superada`. */
export async function superarPendentes(tx: Sql, conversaId: string, agora: Date): Promise<number> {
  const r = await tx`
    UPDATE agente_decisao d SET sugestao_estado = 'superada', sugestao_usada_em = ${agora}
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${conversaId}
       AND d.modo IN ('assistido', 'copiloto') AND d.sugestao_estado IS NULL`
  return r.count
}

export type ResultadoDescarte =
  | { readonly ok: true; readonly conversaId: string }
  | { readonly ok: false; readonly motivo: 'nao_encontrada' | 'ja_decidida'; readonly estado?: string }

export async function descartarSugestao(tx: Sql, decisaoId: string, agora: Date): Promise<ResultadoDescarte> {
  const [d] = await tx<{ conversa_id: string; sugestao_estado: string | null }[]>`
    SELECT d.conversa_id, d.sugestao_estado FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${decisaoId} AND ${ehSugestao(tx)}
     FOR UPDATE`
  if (!d) return { ok: false, motivo: 'nao_encontrada' }
  if (d.sugestao_estado !== null) return { ok: false, motivo: 'ja_decidida', estado: d.sugestao_estado }
  await tx`
    UPDATE agente_decisao SET sugestao_estado = 'descartada', sugestao_usada_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${decisaoId} AND sugestao_estado IS NULL`
  return { ok: true, conversaId: d.conversa_id }
}

/** Evento de tempo real: a sugestão da conversa mudou. Payload SÓ com ids (ADR-007). */
export async function publicarSugestaoMudou(tx: Sql, conversaId: string, decisaoId: string): Promise<void> {
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'agente.sugestao', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, decisaoId })}::text::jsonb)`
}

/** Janela em que uma decisão de sombra ainda é comparável com a resposta humana. */
const JANELA_SOMBRA_HORAS = 24

/**
 * SOMBRA × HUMANO: a 1ª mensagem que uma pessoa manda depois de uma decisão de sombra é comparada
 * com o que o robô teria dito (sob tenant). Só a decisão mais nova, só se nenhuma outra mensagem
 * humana veio entre ela e esta, e só uma vez por decisão.
 */
export async function registrarSimilaridadeSombra(tx: Sql, p: {
  conversaId: string; mensagemId: string; textoHumano: string; agora: Date
}): Promise<{ decisaoId: string; similaridade: number } | null> {
  const [d] = await tx<{ id: string; resposta: LinhaSugestao['resposta'] }[]>`
    SELECT d.id, d.resposta FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${p.conversaId}
       AND d.modo = 'sombra' AND d.desfecho = 'sugeriu' AND d.sombra_similaridade IS NULL
       AND jsonb_typeof(d.resposta->'mensagens') = 'array' AND jsonb_array_length(d.resposta->'mensagens') > 0
       AND d.criado_em > ${p.agora}::timestamptz - make_interval(hours => ${JANELA_SOMBRA_HORAS})
       AND NOT EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = d.tenant_id AND m.conversa_id = d.conversa_id
                          AND m.criado_em > d.criado_em AND m.id <> ${p.mensagemId} AND ${ehHumana(tx)})
     ORDER BY d.criado_em DESC, d.id DESC
     LIMIT 1
     FOR UPDATE OF d`
  if (!d) return null
  const robo = textoDaSugestao(mensagensDe(d.resposta))
  const similaridade = similaridadeTextos(robo, p.textoHumano)
  const r = await tx`
    UPDATE agente_decisao SET sombra_similaridade = ${similaridade}
     WHERE tenant_id = tenant_atual() AND id = ${d.id} AND sombra_similaridade IS NULL`
  return r.count ? { decisaoId: d.id, similaridade } : null
}

// ── métricas (do banco) ─────────────────────────────────────────────────────

/** Métricas de sugestão e de sombra (sob tenant). Agregados — nunca lista. Fonte da P19. */
export async function metricasSugestoes(tx: Sql, dias: number, canalId: string | null): Promise<MetricasSugestoes> {
  const filtroCanal = canalId ? tx`AND d.canal_id = ${canalId}` : tx``
  const linhas = await tx<{
    modo: OrigemSugestao; geradas: number; enviadas: number; editadas: number; descartadas: number; superadas: number
    pendentes: number; criticas: number; sim_editadas: string | null
  }[]>`
    SELECT d.modo,
           count(*)::int AS geradas,
           count(*) FILTER (WHERE d.sugestao_estado = 'enviada')::int AS enviadas,
           count(*) FILTER (WHERE d.sugestao_estado = 'editada')::int AS editadas,
           count(*) FILTER (WHERE d.sugestao_estado = 'descartada')::int AS descartadas,
           count(*) FILTER (WHERE d.sugestao_estado = 'superada')::int AS superadas,
           count(*) FILTER (WHERE d.sugestao_estado IS NULL)::int AS pendentes,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(d.guardrails) g
                                           WHERE g->>'gravidade' = 'CRITICA'))::int AS criticas,
           round(avg(d.sugestao_similaridade) FILTER (WHERE d.sugestao_estado = 'editada'), 3)::text AS sim_editadas
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND ${ehSugestao(tx)}
       AND d.criado_em >= now() - make_interval(days => ${dias}) ${filtroCanal}
     GROUP BY d.modo`
  const [s] = await tx<{ comparados: number; media: string | null; acima: number }[]>`
    SELECT count(*)::int AS comparados,
           round(avg(d.sombra_similaridade), 3)::text AS media,
           count(*) FILTER (WHERE d.sombra_similaridade >= ${LIMIAR_SIMILARIDADE_SOMBRA})::int AS acima
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.modo = 'sombra' AND d.sombra_similaridade IS NOT NULL
       AND d.criado_em >= now() - make_interval(days => ${dias}) ${filtroCanal}`
  const de = (origem: OrigemSugestao) => {
    const l = linhas.find((x) => x.modo === origem)
    const c: ContagensSugestao = {
      geradas: l?.geradas ?? 0, enviadas: l?.enviadas ?? 0, editadas: l?.editadas ?? 0, descartadas: l?.descartadas ?? 0,
      superadas: l?.superadas ?? 0, pendentes: l?.pendentes ?? 0, criticas: l?.criticas ?? 0,
      similaridadeMediaEditadas: l?.sim_editadas == null ? null : Number(l.sim_editadas),
    }
    return { ...c, ...taxasDaSugestao(c) }
  }
  const sombra = { comparados: s?.comparados ?? 0, similaridadeMedia: s?.media == null ? null : Number(s.media), acimaDoLimiar: s?.acima ?? 0 }
  return {
    dias, canalId,
    assistido: de('assistido'),
    copiloto: de('copiloto'),
    sombra: { ...sombra, taxaAcimaDoLimiar: taxaSombra(sombra), limiar: LIMIAR_SIMILARIDADE_SOMBRA },
  }
}
