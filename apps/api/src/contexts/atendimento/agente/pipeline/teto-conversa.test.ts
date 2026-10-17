import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco, UsoDoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { limparCacheDeCusto } from '../custo.js'
import { AVISO_TETO_CONVERSA, etapaTetoConversa } from './teto-conversa.js'
import type { ContextoPipeline } from './tipos.js'

/**
 * TETO DE CUSTO POR CONVERSA (ADR-032, raia P6) — o turno de verdade, banco
 * real, WhatsApp e LLM falsos. "Sessão em loop vai ao humano"; "Groq gratuito
 * custa 0".
 */
const T = 'c0fe0000-0000-4000-8000-000000000001'
const PV = 'c0fe0000-1111-4000-8000-000000000001'
const PLANO = 'c0fe0000-3333-4000-8000-000000000001'
const MODELO = 'c0fe0000-4444-4000-8000-000000000001'
const CANAL = 'c0fe0000-5555-4000-8000-000000000001'
const CONTATO = 'c0fe0000-6666-4000-8000-000000000001'
const CONVERSA = 'c0fe0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

let chamadas = 0
/** LLM falso com fornecedor, modelo e uso escolhidos — o custo sai do catálogo de verdade. */
function llm(provedor: string, modelo: string, uso: UsoDoLaco): PortaLlmFerramentas {
  return { nome: provedor, capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      chamadas++
      return { ok: true, saida: { mensagens: ['Temos sim!'], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso, modelo, provedor, latenciaMs: 1, parouPor: 'fim' } }
    } }
}
const POUCO: UsoDoLaco = { entrada: 1000, saida: 100, cacheLeitura: 0, cacheEscrita: 0 }
/** Sonnet: 100k de entrada = US$ 0,20 × 5,5 = 110 centavos. */
const CARO: UsoDoLaco = { entrada: 100_000, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }

const configurar = (modo: string, teto: number | null) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, teto_sessao_centavos)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja Teto"}'::jsonb, '{}'::jsonb, ${teto})
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo, teto_sessao_centavos = EXCLUDED.teto_sessao_centavos`

const tarefa = async (texto: string): Promise<Tarefa> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() }
}
const turno = async (porta: PortaLlmFerramentas) => conduzirTurnoVendedor(await tarefa('quero 10 caixas'), { llm: porta, ligacoes, enviar: enviarFalso })
const ultimaDecisao = async () => (await dono<{ desfecho: string; handoff_motivo: string | null; enviada: boolean; custo: string; guardrails: { codigo: string }[] }[]>`
  SELECT desfecho, handoff_motivo, enviada, custo_centavos::text AS custo, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const sessao = async () => (await dono<{ id: string; estado: string; custo: string }[]>`
  SELECT id, estado, custo_centavos::text AS custo FROM agente_sessao WHERE tenant_id = ${T} ORDER BY iniciada_em DESC LIMIT 1`)[0]
const atendimentos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]!.n
/** Sessão ativa que já gastou `centavos` (o loop patológico). */
const sessaoQueGastou = async (centavos: number) => {
  await turno(llm('claude', 'claude-sonnet-5-5', POUCO))
  await dono`UPDATE agente_sessao SET custo_centavos = ${centavos} WHERE tenant_id = ${T}`
  enviados.length = 0; chamadas = 0
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teto', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teto', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Teto', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Teto', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990888', '5585999990888', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  limparCacheDeCusto()
  enviados.length = 0; chamadas = 0
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'agente_orcamento']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'agente_orcamento', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Custo do turno pelo catálogo', () => {
  it('Groq gratuito custa 0 — mesmo com uso enorme, o teto não dispara', async () => {
    await configurar('autonomo', 50)
    const r = await turno(llm('groq', 'openai/gpt-oss-120b', { entrada: 5_000_000, saida: 500_000, cacheLeitura: 0, cacheEscrita: 0 }))
    expect(r.desfecho).toBe('respondeu')
    expect((await ultimaDecisao()).custo).toBe('0')
    expect((await sessao())!.custo).toBe('0')
  })

  it('Sonnet custa pelo catálogo: 100k de entrada = 110 centavos', async () => {
    await configurar('autonomo', null)
    await turno(llm('claude', 'claude-sonnet-5-5', CARO))
    expect((await ultimaDecisao()).custo).toBe('110')
  })
})

describe('Teto(pré): sessão já no teto nem chama o modelo', () => {
  it('autônomo → handoff limite_de_custo_conversa COM aviso ao cliente, sem chamar o LLM', async () => {
    await configurar('autonomo', 100)
    await sessaoQueGastou(100)
    const r = await turno(llm('claude', 'claude-sonnet-5-5', POUCO))
    expect(chamadas).toBe(0)
    expect(r.desfecho).toBe('handoff')
    expect(r.handoff?.motivo).toBe('limite_de_custo_conversa')
    expect(enviados).toEqual([AVISO_TETO_CONVERSA])
    const d = await ultimaDecisao()
    expect(d.handoff_motivo).toBe('limite_de_custo_conversa')
    expect(d.guardrails.map((g) => g.codigo)).toContain('limite_de_custo_conversa')
    expect(await atendimentos()).toBe(1)
  })

  it('sombra → silêncio, sem modelo e sem mensagem', async () => {
    await configurar('sombra', 100)
    await sessaoQueGastou(150)
    const r = await turno(llm('claude', 'claude-sonnet-5-5', POUCO))
    expect(chamadas).toBe(0)
    expect(r.desfecho).toBe('silencio')
    expect(enviados).toEqual([])
    expect(await atendimentos()).toBe(0)
  })

  it('abaixo do teto segue normal; teto 0 desliga', async () => {
    await configurar('autonomo', 100)
    await sessaoQueGastou(90) // + ~2 centavos deste turno, abaixo de 100
    expect((await turno(llm('claude', 'claude-sonnet-5-5', POUCO))).desfecho).toBe('respondeu')
    await configurar('autonomo', 0)
    await dono`UPDATE agente_sessao SET custo_centavos = 1000000 WHERE tenant_id = ${T}`
    expect((await turno(llm('claude', 'claude-sonnet-5-5', POUCO))).desfecho).toBe('respondeu')
  })
})

describe('Teto(pós): o turno que passa do teto responde e transfere em silêncio', () => {
  it('autônomo: a resposta sai, o handoff é sem aviso, a sessão acumula o custo', async () => {
    await configurar('autonomo', 100)
    const r = await turno(llm('claude', 'claude-sonnet-5-5', CARO)) // 110 ≥ 100
    expect(r.desfecho).toBe('handoff')
    expect(r.handoff?.motivo).toBe('limite_de_custo_conversa')
    expect(enviados).toEqual(['Temos sim!']) // respondeu, e só isso
    const d = await ultimaDecisao()
    expect(d).toMatchObject({ desfecho: 'handoff', handoff_motivo: 'limite_de_custo_conversa', enviada: true, custo: '110' })
    expect(await atendimentos()).toBe(1)
    const s = await sessao()
    expect(s).toMatchObject({ estado: 'entregue', custo: '110' })
  })

  it('soma o acumulado da sessão (sobrevive a restart: está no banco)', async () => {
    await configurar('autonomo', 150)
    await sessaoQueGastou(60)
    const r = await turno(llm('claude', 'claude-sonnet-5-5', CARO)) // 60 + 110 ≥ 150
    expect(r.desfecho).toBe('handoff')
    expect(enviados).toEqual(['Temos sim!'])
  })

  it('assistido: sugere e encerra a sessão sem entregar (nada sai para o cliente)', async () => {
    await configurar('assistido', 100)
    const r = await turno(llm('claude', 'claude-sonnet-5-5', CARO))
    expect(r.desfecho).toBe('handoff')
    expect(enviados).toEqual([])
    expect(await atendimentos()).toBe(0)
  })
})

/** LLM que falha DEPOIS de gastar (o laço rodou e a saída não veio). */
function llmQueFalhaGastando(uso: UsoDoLaco): PortaLlmFerramentas {
  return { nome: 'claude', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      chamadas++
      return { ok: false, motivo: 'indisponivel', detalhe: 'simulada',
        rastro: { chamadas: [], rodadas: 1, uso, modelo: 'claude-sonnet-5-5', provedor: 'claude', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

describe('Turnos com FALHA contam no teto da sessão', () => {
  it('assistido: falhas caras em loop acumulam na sessão e o teto(pré) para de chamar o modelo', async () => {
    await configurar('assistido', 300)
    await turno(llm('claude', 'claude-sonnet-5-5', POUCO)) // abre a sessão
    const s = (await sessao())!
    for (let i = 0; i < 3; i++) await turno(llmQueFalhaGastando(CARO)) // 3 × 110 = 330 ≥ 300
    expect((await sessao())!.id).toBe(s.id)
    expect(Number((await sessao())!.custo)).toBeLessThan(300) // a sessão em si não somou as falhas…
    chamadas = 0
    const r = await turno(llm('claude', 'claude-sonnet-5-5', POUCO))
    expect(chamadas).toBe(0) // …mas o teto soma as decisões e barra
    expect(r.desfecho).toBe('silencio')
  })
})

describe('Orçamento mensal pelo teto: antes → depois no MESMO instante', () => {
  const ctxEm = async (agora: Date): Promise<ContextoPipeline> => ({
    tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'autonomo', agora,
    cfgExtra: { teto_sessao_centavos: 0 }, persona: {} as ContextoPipeline['persona'], estado: {}, historico: [], entrantes: [],
    primeiraResposta: false, foraDoExpediente: false,
  })
  const gastar = (centavos: number, quando: Date) => dono`
    INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, modelo, custo_centavos, criado_em)
    VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, ${CANAL}, 'autonomo', 'respondeu', 'claude-sonnet-5-5', ${centavos}, ${quando})`
  const tiposDeAlerta = async () => (await dono<{ tipo: string }[]>`
    SELECT tipo FROM alerta WHERE tenant_id = ${T} AND resolvido_em IS NULL AND tipo LIKE 'agente_orcamento%' ORDER BY tipo`).map((a) => a.tipo)

  /** Turno completo do ponto de vista do teto: antes e depois com o mesmo `agora`. */
  const turnoDoTeto = async (agora: Date, custo: number) => {
    const ctx = await ctxEm(agora)
    await etapaTetoConversa.antes(ctx)
    await etapaTetoConversa.depois(ctx, { custoCentavos: custo })
    await gastar(custo, agora) // o vendedor persiste depois do teto(pós)
  }

  it('o depois do turno que cruza 80% e depois 100% alerta na hora, sem esperar o intervalo', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${T}, 1000)`
    const agora = new Date()
    await gastar(700, agora)
    await turnoDoTeto(agora, 150) // 850 → 80%
    expect(await tiposDeAlerta()).toEqual(['agente_orcamento_80'])
    await turnoDoTeto(agora, 200) // 1050 → 100%
    expect(await tiposDeAlerta()).toEqual(['agente_orcamento_100', 'agente_orcamento_80'])
  })

  it('no último minuto do mês (fuso da loja) o turno conta no mês que está acabando', async () => {
    await dono`INSERT INTO agente_orcamento (tenant_id, mensal_centavos) VALUES (${T}, 1000)`
    const [l] = await dono<{ ultimo: Date }[]>`
      SELECT ((date_trunc('month', now() AT TIME ZONE coalesce(fuso, 'America/Sao_Paulo')) + interval '1 month' - interval '30 seconds')
               AT TIME ZONE coalesce(fuso, 'America/Sao_Paulo')) AS ultimo
        FROM tenant WHERE id = ${T}`
    const ultimo = l!.ultimo
    await gastar(790, new Date(ultimo.getTime() - 60_000))
    await turnoDoTeto(ultimo, 20) // 810 → 80%, mesmo a 30 s da virada
    expect(await tiposDeAlerta()).toEqual(['agente_orcamento_80'])
    await turnoDoTeto(ultimo, 200) // 1010 → 100%
    expect(await tiposDeAlerta()).toEqual(['agente_orcamento_100', 'agente_orcamento_80'])
    // Virou o mês: o gasto do mês novo começa do zero — nada alerta.
    const virada = new Date(ultimo.getTime() + 60_000)
    await turnoDoTeto(virada, 10)
    const [o] = await dono<{ a80: string; a100: string }[]>`SELECT alertado_80_mes AS a80, alertado_100_mes AS a100 FROM agente_orcamento WHERE tenant_id = ${T}`
    expect(o!.a80).toBe(o!.a100) // ainda o mês que acabou
  })
})
