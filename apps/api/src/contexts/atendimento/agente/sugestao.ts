import { randomUUID } from 'node:crypto'
import {
  PRAZO_COPILOTO_MS, LIMIAR_SIMILARIDADE_SOMBRA, marcaGuardrail,
  avisosDaSugestao, bloqueadaPelaQualidade, classificarUso, envioIgualAoBloqueado, motivoDoBloqueio, naoEnvieAssim,
  pedeConfirmarOptOut, similaridadeTextos, taxaSombra, taxasDaSugestao, textoDaSugestao,
  type ContagensSugestao, type MarcaGuardrail, type MetricasSugestoes, type ModoAgente,
  type OrigemSugestao, type SugestaoVigente,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno, type ResultadoTurnoVendedor } from './vendedor.js'
import { ligacoesPadrao } from './ferramentas/ligacoes.js'
import { modoEfetivoSeguro } from './pipeline/modo-efetivo.js'

/**
 * SUGESTÃO DO ASSISTIDO E COPILOTO — o lado do VENDEDOR (raia P13; playbook AM §6.1, §6.2, §6.4).
 *
 * A sugestão é uma `agente_decisao`:
 *   - modo `assistido`: o turno do agente decidiu e NÃO enviou (vendedor.ts grava e publica
 *     `agente.sugestao` pelo outbox, payload só com ids);
 *   - modo `copiloto`: o vendedor clicou "Sugerir resposta" — o MESMO turno, com `copiloto: true`
 *     (sem portão, sem envio, sem sessão, sem atendimento).
 *
 * O texto já passou pelo pipeline inteiro (filtro P2, números P7, pergunta P3, rede de R$); as
 * MARCAS de guardrail viram avisos por gravidade (CRÍTICA = "não envie assim", ADR-031).
 *
 * Métrica (fonte da verdade = banco, 0103): o envio com `sugestaoDecisaoId` grava enviada × editada
 * (ou superada, se reescrita por cima) + similaridade; descartar grava `descartada`; responder sem
 * usar marca `superada`. Em SOMBRA, as mensagens humanas que respondem à entrante de uma decisão
 * gravam `sombra_similaridade`.
 */

/** Predicado SQL de "esta decisão (alias d) é uma sugestão mostrável" — o MESMO no GET, no uso e nas métricas. */
const ehSugestao = (tx: Sql) => tx`d.modo IN ('assistido', 'copiloto') AND d.desfecho IN ('sugeriu', 'handoff')
  AND jsonb_typeof(d.resposta->'mensagens') = 'array' AND jsonb_array_length(d.resposta->'mensagens') > 0`

/**
 * Mensagem (alias m) saliente escrita por uma PESSOA: não sistema e sem marcador de automação
 * (`automatica`: agente, ausência, automação do CRM, retorno…).
 */
const ehHumana = (tx: Sql) => tx`m.direcao = 'saliente' AND m.tipo <> 'sistema' AND NOT (m.conteudo ? 'automatica')`

interface LinhaSugestao {
  id: string
  modo: OrigemSugestao
  resposta: { mensagens?: unknown; handoff?: { motivo?: unknown; resumo?: unknown } | null } | null
  guardrails: unknown
  handoff_motivo: string | null
  criado_em: Date
  pedida_por: string | null
  pedida_por_nome: string | null
}

function marcasDe(v: unknown): MarcaGuardrail[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((x) => { const p = marcaGuardrail.safeParse(x); return p.success ? [p.data] : [] })
}

function mensagensDe(resposta: LinhaSugestao['resposta']): string[] {
  const ms = resposta?.mensagens
  return Array.isArray(ms) ? ms.filter((m): m is string => typeof m === 'string') : []
}

function paraVigente(l: LinhaSugestao, euId: string | null): SugestaoVigente {
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
    pedidaPor: l.pedida_por ? { nome: l.pedida_por_nome, porMim: l.pedida_por === euId } : null,
    handoff: h && typeof h.motivo === 'string'
      ? { motivo: h.motivo, resumo: typeof h.resumo === 'string' ? h.resumo : '' }
      : l.handoff_motivo ? { motivo: l.handoff_motivo, resumo: '' } : null,
  }
}

const COLUNAS = (tx: Sql) => tx`d.id, d.modo, d.resposta, d.guardrails, d.handoff_motivo, d.criado_em,
  d.sugestao_pedida_por AS pedida_por,
  (SELECT u.nome FROM usuario u WHERE u.tenant_id = d.tenant_id AND u.id = d.sugestao_pedida_por) AS pedida_por_nome`

/**
 * A sugestão VIGENTE da conversa (sob tenant): a mais nova ainda pendente, desde que nenhuma
 * pessoa tenha respondido depois dela (inclusive por outro caminho — app, celular).
 */
export async function lerSugestaoVigente(tx: Sql, conversaId: string, euId: string | null = null): Promise<SugestaoVigente | null> {
  const [l] = await tx<LinhaSugestao[]>`
    SELECT ${COLUNAS(tx)}
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${conversaId}
       AND d.sugestao_estado IS NULL AND ${ehSugestao(tx)}
       -- Copiloto só aparece DEPOIS de carimbado com quem pediu: a decisão é gravada pelo turno
       -- (vendedor.ts, raia P0) e o carimbo vem logo em seguida; sem este filtro, nesse intervalo
       -- outro vendedor leria "Sugestão que você pediu".
       AND (d.modo <> 'copiloto' OR d.sugestao_pedida_por IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = d.tenant_id AND m.conversa_id = d.conversa_id
                          AND m.criado_em > d.criado_em AND ${ehHumana(tx)})
     ORDER BY d.criado_em DESC, d.id DESC
     LIMIT 1`
  return l ? paraVigente(l, euId) : null
}

export async function lerSugestaoPorId(tx: Sql, decisaoId: string, euId: string | null = null): Promise<SugestaoVigente | null> {
  const [l] = await tx<LinhaSugestao[]>`
    SELECT ${COLUNAS(tx)}
      FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${decisaoId} AND ${ehSugestao(tx)}`
  return l ? paraVigente(l, euId) : null
}

// ── modo para o copiloto ────────────────────────────────────────────────────

/** A conversa e o número dela (sob tenant); `configurado` = existe `agente_config` no número. */
export async function lerConversaParaSugestao(tx: Sql, conversaId: string): Promise<{ canalId: string; contatoId: string; configurado: boolean } | null> {
  const [c] = await tx<{ canal_id: string; contato_id: string; configurado: boolean }[]>`
    SELECT c.canal_id, c.contato_id,
           EXISTS (SELECT 1 FROM agente_config ac WHERE ac.tenant_id = c.tenant_id AND ac.canal_id = c.canal_id) AS configurado
      FROM conversa c WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
  return c ? { canalId: c.canal_id, contatoId: c.contato_id, configurado: c.configurado } : null
}

/**
 * O modo que vale para o copiloto: o MODO EFETIVO do número para este contato (P14 —
 * `modoEfetivoSeguro`: teto do tenant, número e recorte; falha fechada → sombra). `null` = o número
 * não tem agente configurado (a tela diz "configure", não "desligado").
 *
 * ⚠️ Só `desligado` cala o copiloto (kill switch). Fora do recorte o modo cai para `foraDoRecorte`
 *    (padrão sombra) e o copiloto CONTINUA disponível: é o vendedor pedindo, nada sai sozinho.
 */
export async function modoDoCopiloto(
  tenantId: string, p: { canalId: string; contatoId: string; configurado: boolean; agora: Date },
): Promise<ModoAgente | null> {
  if (!p.configurado) return null
  return (await modoEfetivoSeguro(tenantId, { canalId: p.canalId, contatoId: p.contatoId, agora: p.agora })).modo
}

// ── copiloto sob demanda ────────────────────────────────────────────────────

export type ResultadoCopiloto =
  | { readonly tipo: 'ok'; readonly sugestao: SugestaoVigente }
  | { readonly tipo: 'conversa_inexistente' }
  | { readonly tipo: 'sem_configuracao' }
  | { readonly tipo: 'desligado' }
  | { readonly tipo: 'em_andamento' }
  | { readonly tipo: 'ocupado' }
  | { readonly tipo: 'indisponivel'; readonly detalhe: string }
  | { readonly tipo: 'sem_sugestao'; readonly motivo: string; readonly resumo: string | null }

export interface OpcoesCopiloto {
  /** Porta do modelo (testes). Em produção, a do número/ambiente, escolhida pelo turno. */
  readonly llm?: DepsTurno['llm']
  readonly prazoMs?: number
  readonly agora?: Date
}

const TEMPO_ESGOTADO = Symbol('tempo_esgotado')

/** Folga da concessão além do prazo do copiloto: o turno pode seguir depois do 502. */
const FOLGA_CONCESSAO_MS = 60_000

/**
 * Teto de copilotos rodando ao mesmo tempo NESTE processo (inclusive os que seguem depois do
 * prazo). Cada turno usa conexões do pool entre as chamadas ao modelo; o teto fica bem abaixo de
 * `DB_POOL_MAX` (padrão 10) para o inbox nunca ficar sem conexão. Acima dele: 503 `copiloto.ocupado`.
 */
export const MAX_COPILOTOS_SIMULTANEOS = Math.max(1, Number(process.env.COPILOTO_MAX_SIMULTANEOS ?? 3))
let copilotosAtivos = 0

/** Quantos copilotos este processo está rodando agora (observabilidade e testes). */
export function copilotosEmAndamento(): number { return copilotosAtivos }

/**
 * CONCESSÃO POR CONVERSA ENTRE INSTÂNCIAS (tabela `copiloto_geracao`, 0103): uma linha com TTL, sem
 * conexão presa e sem transação aberta durante o modelo. Pega se a linha não existe ou expirou;
 * devolve a função que solta (DELETE pelo token — nunca apaga a concessão de outro), ou null.
 */
async function pegarConcessao(tenantId: string, conversaId: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const token = randomUUID()
  const pegou = await comTenantServico(tenantId, async (tx) => (await tx<{ token: string }[]>`
    INSERT INTO copiloto_geracao (tenant_id, conversa_id, token, expira_em)
    VALUES (tenant_atual(), ${conversaId}, ${token}, now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT (tenant_id, conversa_id) DO UPDATE
       SET token = EXCLUDED.token, expira_em = EXCLUDED.expira_em, criado_em = now()
     WHERE copiloto_geracao.expira_em < now()
    RETURNING token`).length > 0)
  if (!pegou) return null
  return async () => {
    await comTenantServico(tenantId, (tx) => tx`
      DELETE FROM copiloto_geracao WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND token = ${token}`)
  }
}

/**
 * Gera uma sugestão sob demanda. O turno roda com `copiloto: true` — nada vai ao cliente, nenhuma
 * sessão abre ou muda, nenhum atendimento nasce; grava a `agente_decisao` (modo `copiloto`), que é
 * a própria sugestão e a sua auditoria, e marca quem pediu.
 *
 * ⚠️ NÃO é 100% só leitura HOJE: a ferramenta `memoria_anotar` (P0c/P3) ainda grava em
 *    `cliente_memoria` quando o modelo a chama no copiloto. A raia P17 (dona de
 *    `ferramentas/montar.ts` e `memoria/ferramenta-memoria.ts`) fecha isso para simulação e
 *    copiloto — o teste está em `rotas-sugestao.test.ts` como `skip` apontando a P17.
 * ⚠️ Kill switch: agente `desligado` no número (ou teto do tenant) → não chama o modelo.
 * ⚠️ Prazo de 20 s (PRAZO_COPILOTO_MS): passou, a tela recebe "indisponível"; se o turno ainda
 *    terminar com sugestão, ela é publicada (`agente.sugestao`) e aparece no painel.
 */
export async function gerarCopiloto(
  tenantId: string, conversaId: string, opcoes: OpcoesCopiloto = {}, pedidoPor: string | null = null,
): Promise<ResultadoCopiloto> {
  const agora = opcoes.agora ?? new Date()
  const conv = await comTenantServico(tenantId, (tx) => lerConversaParaSugestao(tx, conversaId))
  if (!conv) return { tipo: 'conversa_inexistente' }
  // ⚠️ Kill switch ANTES de qualquer custo: desligado → o modelo nem é chamado.
  const modo = await modoDoCopiloto(tenantId, { ...conv, agora })
  if (modo === null) return { tipo: 'sem_configuracao' }
  if (modo === 'desligado') return { tipo: 'desligado' }

  // Teto do processo ANTES da concessão: recusar aqui não deixa linha para trás.
  if (copilotosAtivos >= MAX_COPILOTOS_SIMULTANEOS) return { tipo: 'ocupado' }
  copilotosAtivos++
  let soltarConcessao: (() => Promise<void>) | null
  try {
    soltarConcessao = await pegarConcessao(tenantId, conversaId, (opcoes.prazoMs ?? PRAZO_COPILOTO_MS) + FOLGA_CONCESSAO_MS)
  } catch (e) {
    copilotosAtivos--
    throw e
  }
  if (!soltarConcessao) { copilotosAtivos--; return { tipo: 'em_andamento' } }
  const concessao = soltarConcessao
  const soltar = async (): Promise<void> => {
    copilotosAtivos--
    await concessao()
  }

  let entrantes: string[]
  try {
    // As entrantes ainda sem resposta são "o que o cliente disse agora"; sem nenhuma, o turno
    // sugere a retomada a partir do histórico.
    entrantes = await comTenantServico(tenantId, async (tx) => (await tx<{ id: string }[]>`
      SELECT m.id FROM mensagem m
       WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId} AND m.direcao = 'entrante'
         AND m.criado_em > coalesce((SELECT max(s.criado_em) FROM mensagem s
                                      WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
                                        AND s.direcao = 'saliente' AND s.tipo <> 'sistema'), '-infinity'::timestamptz)
       ORDER BY m.criado_em DESC LIMIT 10`).map((e) => e.id).reverse())
  } catch (e) {
    await soltar()
    throw e
  }

  let esgotou = false
  let relogio: ReturnType<typeof setTimeout> | undefined
  const turno = conduzirTurnoVendedor(
    { tenant_id: tenantId, id: randomUUID(), conversa_id: conversaId, canal_id: conv.canalId, mensagens_ids: entrantes, tentativas: 1, executar_em: agora },
    { ligacoes: ligacoesPadrao, copiloto: true, agora, ...(opcoes.llm ? { llm: opcoes.llm } : {}) },
  )
  // O turno segue sozinho depois do prazo. Quando termina: marca quem pediu; se já tinha
  // estourado o prazo e saiu sugestão, publica para o painel; e só então solta a trava.
  const fim = turno.then(async (r) => {
    if (!r.decisaoId || (r.desfecho !== 'sugeriu' && r.desfecho !== 'handoff')) return r
    await comTenantServico(tenantId, async (tx) => {
      if (pedidoPor) await tx`UPDATE agente_decisao SET sugestao_pedida_por = ${pedidoPor} WHERE tenant_id = tenant_atual() AND id = ${r.decisaoId!}`
      if (esgotou && await lerSugestaoPorId(tx, r.decisaoId!)) await publicarSugestaoMudou(tx, conversaId, r.decisaoId!)
    })
    return r
  })
  void fim.catch(() => undefined).finally(() => void soltar().catch(() => undefined))

  let r: ResultadoTurnoVendedor | typeof TEMPO_ESGOTADO
  try {
    r = await Promise.race([
      fim,
      new Promise<typeof TEMPO_ESGOTADO>((res) => { relogio = setTimeout(() => { esgotou = true; res(TEMPO_ESGOTADO) }, opcoes.prazoMs ?? PRAZO_COPILOTO_MS) }),
    ])
  } catch (e) {
    return { tipo: 'indisponivel', detalhe: e instanceof Error ? e.message.slice(0, 200) : 'erro' }
  } finally {
    clearTimeout(relogio)
  }
  if (r === TEMPO_ESGOTADO) return { tipo: 'indisponivel', detalhe: 'tempo_esgotado' }
  if (r.desfecho === 'falha') return { tipo: 'indisponivel', detalhe: r.motivo ?? 'falha' }
  if (r.decisaoId && (r.desfecho === 'sugeriu' || r.desfecho === 'handoff')) {
    const s = await comTenantServico(tenantId, (tx) => lerSugestaoPorId(tx, r.decisaoId!, pedidoPor))
    if (s) return { tipo: 'ok', sugestao: s }
  }
  return { tipo: 'sem_sugestao', motivo: r.handoff?.motivo ?? String(r.motivo ?? r.desfecho), resumo: r.handoff?.resumo ?? null }
}

// ── desfecho da sugestão ────────────────────────────────────────────────────

export type ResultadoUso =
  | { readonly registrada: true; readonly estado: 'enviada' | 'editada' | 'superada'; readonly similaridade: number }
  | { readonly registrada: false; readonly motivo: 'nao_encontrada' | 'ja_decidida' }

/**
 * O vendedor ENVIOU a partir da sugestão (sob tenant, depois do envio ok). Compara com o texto
 * sugerido no servidor — a tela não decide se editou (`classificarUso`): igual → enviada; editada
 * com similaridade < 0,2 → `superada` (ele escreveu outra coisa por cima; não conta como uso).
 * Idempotente: decidir de novo não muda nada.
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
  const { estado, similaridade } = classificarUso(textoDaSugestao(mensagensDe(d.resposta)), p.textoEnviado)
  await tx`
    UPDATE agente_decisao
       SET sugestao_estado = ${estado}, sugestao_mensagem_id = ${estado === 'superada' ? null : p.mensagemId},
           sugestao_usada_em = ${p.agora}, sugestao_similaridade = ${similaridade}
     WHERE tenant_id = tenant_atual() AND id = ${p.decisaoId} AND sugestao_estado IS NULL`
  return { registrada: true, estado, similaridade }
}

/**
 * P12 × P13: a sugestão `regras-qualidade/nao_envie` NÃO sai igual (sob tenant, ANTES de gravar ou
 * despachar qualquer coisa) — nem idêntica, nem com as mesmas palavras (`envioIgualAoBloqueado`).
 * Reescrita passa: a responsabilidade é de quem reescreveu. Id inexistente, de outra conversa ou
 * de outro tenant → não bloqueia (o envio nunca depende disso).
 */
export async function envioBloqueadoPelaQualidade(tx: Sql, p: { conversaId: string; decisaoId: string; texto: string }): Promise<boolean> {
  const [d] = await tx<{ resposta: LinhaSugestao['resposta']; guardrails: unknown }[]>`
    SELECT d.resposta, d.guardrails FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.id = ${p.decisaoId} AND d.conversa_id = ${p.conversaId}
       AND ${ehSugestao(tx)}`
  if (!d || !bloqueadaPelaQualidade(marcasDe(d.guardrails))) return false
  return envioIgualAoBloqueado(textoDaSugestao(mensagensDe(d.resposta)), p.texto)
}

/** O vendedor respondeu a conversa: toda SUGESTÃO ainda pendente nela vira `superada`. Devolve os ids. */
export async function superarPendentes(tx: Sql, conversaId: string, agora: Date): Promise<string[]> {
  const r = await tx<{ id: string }[]>`
    UPDATE agente_decisao d SET sugestao_estado = 'superada', sugestao_usada_em = ${agora}
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${conversaId}
       AND d.sugestao_estado IS NULL AND ${ehSugestao(tx)}
    RETURNING d.id`
  return r.map((x) => x.id)
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

/**
 * Evento de tempo real: a sugestão da conversa mudou. Payload SÓ com ids (ADR-007) — e o
 * `decisaoId` é sempre um id já RESOLVIDO no banco (sob RLS), nunca o que veio no corpo da requisição.
 */
export async function publicarSugestaoMudou(tx: Sql, conversaId: string, decisaoId: string): Promise<void> {
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'agente.sugestao', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, decisaoId })}::text::jsonb)`
}

/** Janela em que uma decisão de sombra ainda é comparável com a resposta humana. */
const JANELA_SOMBRA_HORAS = 24

/**
 * SOMBRA × HUMANO (sob tenant), chamada a cada mensagem humana enviada.
 *
 * Pareamento pela ENTRANTE, não pela hora: a última mensagem do cliente (E) define a "pergunta";
 * a decisão de sombra comparável é a mais nova cujo `mensagens_ids` contém E; a "resposta humana" é
 * a JUNÇÃO de todas as mensagens humanas depois de E (até a próxima entrante — por construção,
 * ainda não há nenhuma). A cada nova mensagem humana a similaridade é RECALCULADA sobre o conjunto.
 * Sem decisão para E (o turno de sombra ainda não rodou, ou o cliente já mandou outra coisa) → nada.
 *
 * ⚠️ SINAL A CALIBRAR: Jaccard de palavras entre textos escritos de forma independente é proxy de
 *    "o robô diria o mesmo", não prova. O limiar 0,6 do critério de fase (ADR-031) é PROPOSTA; o
 *    registro e a calibração com dados reais ficam no ADR-031 (P20).
 */
export async function registrarSimilaridadeSombra(tx: Sql, p: { conversaId: string; agora: Date }): Promise<{ decisaoId: string; similaridade: number } | null> {
  const [e] = await tx<{ id: string; criado_em: Date }[]>`
    SELECT m.id, m.criado_em FROM mensagem m
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${p.conversaId} AND m.direcao = 'entrante'
     ORDER BY m.criado_em DESC, m.id DESC LIMIT 1`
  if (!e || new Date(e.criado_em).getTime() < p.agora.getTime() - JANELA_SOMBRA_HORAS * 3_600_000) return null
  const [d] = await tx<{ id: string; resposta: LinhaSugestao['resposta'] }[]>`
    SELECT d.id, d.resposta FROM agente_decisao d
     WHERE d.tenant_id = tenant_atual() AND d.conversa_id = ${p.conversaId}
       AND d.modo = 'sombra' AND d.desfecho = 'sugeriu' AND ${e.id}::uuid = ANY(d.mensagens_ids)
       AND jsonb_typeof(d.resposta->'mensagens') = 'array' AND jsonb_array_length(d.resposta->'mensagens') > 0
     ORDER BY d.criado_em DESC, d.id DESC
     LIMIT 1
     FOR UPDATE OF d`
  if (!d) return null
  const humanas = await tx<{ texto: string | null }[]>`
    SELECT coalesce(m.conteudo->>'texto', m.conteudo->>'legenda') AS texto FROM mensagem m
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${p.conversaId}
       AND m.criado_em > ${e.criado_em} AND ${ehHumana(tx)} AND m.apagada_em IS NULL
     ORDER BY m.criado_em, m.id`
  const textoHumano = humanas.map((h) => h.texto?.trim() ?? '').filter(Boolean).join('\n\n')
  if (!textoHumano) return null
  const similaridade = similaridadeTextos(textoDaSugestao(mensagensDe(d.resposta)), textoHumano)
  await tx`UPDATE agente_decisao SET sombra_similaridade = ${similaridade} WHERE tenant_id = tenant_atual() AND id = ${d.id}`
  return { decisaoId: d.id, similaridade }
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
