import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import Anthropic from '@anthropic-ai/sdk'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import { MAX_TENTATIVAS, type Tarefa } from '../fila.js'
import { LlmClaudeFerramentas } from '../claude-ferramentas.js'
import { LlmOpenRouterFerramentas, type PresetCompat } from '../openrouter-ferramentas.js'
import { classeDaFalhaLlm, ehFalhaDeProvedor, type MotivoFalhaLlm } from '../porta.js'
import { RoteadorLlm } from '../llm-reserva.js'
import { EstadoLlmProcesso } from '../llm-estado.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import {
  AVISO_INSTABILIDADE, AVISO_TRANSFERENCIA, JANELA_SEGUIDA_MS, REAGENDAR_INSTABILIDADE_MS, TIPO_ALERTA_LLM, decidirFalha,
} from './falha-llm.js'
import type { EntradaFalha } from './tipos.js'

/**
 * RESILIÊNCIA DO LLM (ADR-030, raia P5): a tabela de classificação dos
 * adaptadores, a política pura, e o turno de verdade (banco real, WhatsApp
 * falso, fornecedores falsos) passando pela política e pela reserva.
 * Nenhum teste aqui chama fornecedor.
 */

// ── 1. Classificação: adaptador → motivo → classe ───────────────────────────

const pedido: PedidoDeLaco = {
  sistema: [{ texto: 's' }], mensagens: [{ papel: 'cliente', texto: 'oi' }], ferramentas: [],
  executar: async () => ({ ok: true, saida: null }), esquemaSaida: {},
  limites: { maxRodadas: 2, maxTokensSaida: 100, prazoMs: 5_000 },
}

function claudeQueLanca(erro: unknown): LlmClaudeFerramentas {
  return new LlmClaudeFerramentas({ apiKey: 'k', cliente: { messages: { create: async () => { throw erro } } } as never })
}
const erroAnthropic = (status: number, tipo: string, mensagem: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: tipo, message: mensagem } }, mensagem, new Headers())

function compatQueResponde(preset: PresetCompat, resposta: Response): LlmOpenRouterFerramentas {
  return new LlmOpenRouterFerramentas({ preset, apiKey: 'k', modelos: ['m'], buscar: (async () => resposta) as unknown as typeof fetch })
}
const corpoErro = (code: string) => JSON.stringify({ error: { code, message: 'x' } })

describe('Classificação: Claude (SDK) → motivo → classe', () => {
  const casos: [string, unknown, MotivoFalhaLlm, string][] = [
    ['401', erroAnthropic(401, 'authentication_error', 'invalid x-api-key'), 'credencial_invalida', 'fatal'],
    ['403 modelo sem acesso', erroAnthropic(403, 'permission_error', 'no access to model'), 'acesso_negado', 'fatal'],
    ['404 modelo inexistente', erroAnthropic(404, 'not_found_error', 'model: x'), 'acesso_negado', 'fatal'],
    ['402 billing', erroAnthropic(402, 'billing_error', 'billing'), 'limite_de_custo', 'fatal'],
    ['400 credit balance', erroAnthropic(400, 'invalid_request_error', 'Your credit balance is too low'), 'limite_de_custo', 'fatal'],
    ['429', erroAnthropic(429, 'rate_limit_error', 'slow down'), 'limite_de_taxa', 'transitoria'],
    ['500', erroAnthropic(500, 'api_error', 'boom'), 'indisponivel', 'transitoria'],
    ['529 overloaded', erroAnthropic(529, 'overloaded_error', 'Overloaded'), 'indisponivel', 'transitoria'],
    ['conexão', new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'indisponivel', 'transitoria'],
    ['tempo esgotado', new Anthropic.APIConnectionTimeoutError(), 'indisponivel', 'transitoria'],
    ['400 pedido inválido', erroAnthropic(400, 'invalid_request_error', 'messages: bad'), 'requisicao_invalida', 'requisicao'],
    ['413 grande demais', erroAnthropic(413, 'request_too_large', 'too large'), 'requisicao_invalida', 'requisicao'],
  ]
  it.each(casos)('%s', async (_nome, erro, motivo, classe) => {
    const r = await claudeQueLanca(erro).rodar(pedido)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe(motivo)
    expect(classeDaFalhaLlm(r.motivo)).toBe(classe)
  })
})

describe.each(['openrouter', 'groq', 'gemini'] as const)('Classificação: %s (fio OpenAI) → motivo → classe', (preset) => {
  const casos: [string, Response, MotivoFalhaLlm, string][] = [
    ['401', new Response('{}', { status: 401 }), 'credencial_invalida', 'fatal'],
    ['403', new Response('{}', { status: 403 }), 'acesso_negado', 'fatal'],
    ['404', new Response('{}', { status: 404 }), 'acesso_negado', 'fatal'],
    ['402', new Response('{}', { status: 402 }), 'limite_de_custo', 'fatal'],
    ['429 cota esgotada', new Response(corpoErro('insufficient_quota'), { status: 429 }), 'limite_de_custo', 'fatal'],
    ['429 taxa', new Response(corpoErro('rate_limit_exceeded'), { status: 429 }), 'limite_de_taxa', 'transitoria'],
    ['408', new Response('{}', { status: 408 }), 'indisponivel', 'transitoria'],
    ['503', new Response('{}', { status: 503 }), 'indisponivel', 'transitoria'],
    ['529', new Response('{}', { status: 529 }), 'indisponivel', 'transitoria'],
    ['400', new Response('{"error":{"message":"messages: bad"}}', { status: 400 }), 'requisicao_invalida', 'requisicao'],
    ['429 Gemini (erro em array, RESOURCE_EXHAUSTED)', new Response(JSON.stringify([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }]), { status: 429 }), 'limite_de_custo', 'fatal'],
    ['429 só com texto de cota', new Response('You exceeded your current quota, please check your plan and billing details', { status: 429 }), 'limite_de_custo', 'fatal'],
    ['200 com error.code 429 de cota', new Response(JSON.stringify({ error: { code: 429, message: 'credit limit reached' } }), { status: 200 }), 'limite_de_custo', 'fatal'],
    ['200 com error.code 429 de taxa', new Response(JSON.stringify({ error: { code: 429, message: 'slow down' } }), { status: 200 }), 'limite_de_taxa', 'transitoria'],
    ['200 com error.code 403 (OpenRouter repassa)', new Response(JSON.stringify({ error: { code: 403, message: 'no access' } }), { status: 200 }), 'acesso_negado', 'fatal'],
  ]
  it.each(casos)('%s', async (_nome, resposta, motivo, classe) => {
    const r = await compatQueResponde(preset, resposta).rodar(pedido)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe(motivo)
    expect(classeDaFalhaLlm(r.motivo)).toBe(classe)
  })
})

describe('Recusa de formato não é modelo inexistente', () => {
  it('404 "No endpoints found that can handle the requested parameters" desce o formato e segue — não vira acesso_negado', async () => {
    const corpos: Record<string, unknown>[] = []
    const respostas = [
      new Response(JSON.stringify({ error: { message: 'No endpoints found that can handle the requested parameters.', code: 404 } }), { status: 404 }),
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"mensagens":["oi"],"confianca":0.9}' } }] }), { status: 200 }),
    ]
    let i = 0
    const buscar = (async (_u: unknown, init?: RequestInit) => { corpos.push(JSON.parse(String(init?.body))); return respostas[i++]! }) as unknown as typeof fetch
    const r = await new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['a/x'], buscar }).rodar(pedido)
    expect(r.ok).toBe(true)
    expect((corpos[0]!['response_format'] as { type: string }).type).toBe('json_schema')
    expect((corpos[1]!['response_format'] as { type: string }).type).toBe('json_object')
  })
})

describe('Classes e reserva', () => {
  it('só fatal e transitória contam para a reserva; formato e motivo desconhecido têm classe definida', () => {
    expect(['credencial_invalida', 'acesso_negado', 'limite_de_custo', 'limite_de_taxa', 'indisponivel'].every(ehFalhaDeProvedor)).toBe(true)
    expect(['conteudo_recusado', 'requisicao_invalida', 'resposta_inesperada', 'formato'].some(ehFalhaDeProvedor)).toBe(false)
    expect(classeDaFalhaLlm('formato')).toBe('formato')
    expect(classeDaFalhaLlm('algo_novo')).toBe('fatal')
  })
})

// ── 2. A política, pura ─────────────────────────────────────────────────────

const AGORA = new Date('2026-10-17T14:00:00Z')
const entrada = (p: Partial<EntradaFalha> = {}): EntradaFalha => ({ motivo: 'indisponivel', detalhe: 'x', executouFerramentas: false, estado: {}, tentativas: 1, ...p })

describe('Política de falha (pura)', () => {
  it('sombra, assistido, simulação e copiloto só registram — qualquer classe', () => {
    for (const modo of ['sombra', 'assistido', 'simulacao', 'copiloto'] as const) {
      for (const motivo of ['credencial_invalida', 'indisponivel', 'formato', 'requisicao_invalida']) {
        expect(decidirFalha(modo, entrada({ motivo }), AGORA)).toMatchObject({ acao: 'registrar', avisoCliente: null })
      }
    }
  })
  it('autônomo, fatal → handoff na hora com aviso sem prazo', () => {
    const d = decidirFalha('autonomo', entrada({ motivo: 'credencial_invalida' }), AGORA)
    expect(d).toMatchObject({ acao: 'handoff', classe: 'fatal', avisoCliente: AVISO_TRANSFERENCIA })
    expect(AVISO_TRANSFERENCIA).not.toMatch(/\d|minuto|hora|já|logo|breve/i)
  })
  it('autônomo, formato e requisição → handoff com aviso', () => {
    expect(decidirFalha('autonomo', entrada({ motivo: 'formato' }), AGORA)).toMatchObject({ acao: 'handoff', classe: 'formato', avisoCliente: AVISO_TRANSFERENCIA })
    expect(decidirFalha('autonomo', entrada({ motivo: 'conteudo_recusado' }), AGORA)).toMatchObject({ acao: 'handoff', classe: 'requisicao' })
  })
  it('autônomo, transitória 1ª → aviso de instabilidade + reagenda 30 s, e conta no estado', () => {
    const d = decidirFalha('autonomo', entrada(), AGORA)
    expect(d).toMatchObject({ acao: 'aviso_e_reagendar', avisoCliente: AVISO_INSTABILIDADE, reagendarEmMs: REAGENDAR_INSTABILIDADE_MS })
    expect(d.estado).toEqual({ falha: { transitorias: 1, ultimaEm: AGORA.toISOString() } })
  })
  it('autônomo, transitória 2ª seguida (estado recente) → handoff com aviso', () => {
    const estado = { falha: { transitorias: 1, ultimaEm: new Date(AGORA.getTime() - 60_000).toISOString() } }
    expect(decidirFalha('autonomo', entrada({ estado }), AGORA)).toMatchObject({ acao: 'handoff', avisoCliente: AVISO_TRANSFERENCIA, estado: { falha: { transitorias: 2 } } })
  })
  it('transitória antiga (fora da janela) não conta como seguida', () => {
    const estado = { falha: { transitorias: 1, ultimaEm: new Date(AGORA.getTime() - JANELA_SEGUIDA_MS - 1).toISOString() } }
    expect(decidirFalha('autonomo', entrada({ estado }), AGORA).acao).toBe('aviso_e_reagendar')
  })
  it('⚠️ tarefa já repetida (tentativas > 1) ou última tentativa da fila → handoff, nunca outro "já te respondo"', () => {
    expect(decidirFalha('autonomo', entrada({ tentativas: 2 }), AGORA).acao).toBe('handoff')
    expect(decidirFalha('autonomo', entrada({ tentativas: MAX_TENTATIVAS }), AGORA).acao).toBe('handoff')
  })
  it('⚠️ transitória com ferramenta já executada → handoff (repetir o turno duplicaria o efeito)', () => {
    expect(decidirFalha('autonomo', entrada({ executouFerramentas: true }), AGORA)).toMatchObject({ acao: 'handoff', avisoCliente: AVISO_TRANSFERENCIA })
  })
})

// ── 3. O turno de verdade ───────────────────────────────────────────────────

const T = 'f5f50000-0000-4000-8000-000000000005'
const PV = 'f5f50000-1111-4000-8000-000000000005'
const PLANO = 'f5f50000-3333-4000-8000-000000000005'
const MODELO = 'f5f50000-4444-4000-8000-000000000005'
const CANAL = 'f5f50000-5555-4000-8000-000000000005'
const CONTATO = 'f5f50000-6666-4000-8000-000000000005'
const CONVERSA = 'f5f50000-7777-4000-8000-000000000005'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

/** Fornecedor falso com roteiro (o último passo se repete). */
function fornecedor(nome: string, roteiro: (MotivoFalhaLlm | 'ok' | 'fora_do_formato' | { motivo: MotivoFalhaLlm; ferramentas: number })[]) {
  let i = 0
  const contagem = { chamadas: 0 }
  const porta: PortaLlmFerramentas = {
    nome, capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      contagem.chamadas += 1
      const passo = roteiro[Math.min(i++, roteiro.length - 1)]!
      const rastro = (chamadas = 0) => ({
        chamadas: Array.from({ length: chamadas }, () => ({ nome: 'pedido_itens', entrada: {}, saida: {}, ms: 1 })),
        rodadas: 1, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, modelo: nome, latenciaMs: 1, parouPor: 'fim' as const,
      })
      if (passo === 'ok') return { ok: true, saida: { mensagens: [`Oi! Aqui é a ${nome}.`], confianca: 0.9 }, rastro: rastro() }
      if (passo === 'fora_do_formato') return { ok: true, saida: { qualquer: 'coisa' }, rastro: rastro() }
      if (typeof passo === 'string') return { ok: false, motivo: passo, detalhe: 'simulada', rastro: rastro() }
      return { ok: false, motivo: passo.motivo, detalhe: 'simulada', rastro: rastro(passo.ferramentas) }
    },
  }
  return { porta, contagem }
}

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja P5"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`
const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[], tentativas = 1): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas, executar_em: new Date() })
const turno = async (llm: PortaLlmFerramentas, extra: Partial<DepsTurno> & { tentativas?: number } = {}) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente('oi, tem camiseta?')], extra.tentativas), { llm, ligacoes, enviar: enviarFalso, ...extra })
const decisoes = async () => dono<{ desfecho: string; falha_tipo: string | null; enviada: boolean; erro: string | null }[]>`
  SELECT desfecho, falha_tipo, enviada, erro FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em`
const atendimentos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]!.n
const alertasAbertos = async () => dono<{ tipo: string; severidade: string; mensagem: string }[]>`
  SELECT tipo, severidade, mensagem FROM alerta WHERE tenant_id = ${T} AND resolvido_em IS NULL`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-falha-llm', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-falha-llm', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Falha LLM', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente P5', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990555', '5585999990555', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Turno: derrubar o principal vira reserva', () => {
  it('dado o principal fora do ar, então a 1ª falha avisa e reagenda; a 2ª liga a reserva e o cliente é respondido por ela', async () => {
    await configurar('autonomo')
    let relogio = Date.parse('2026-10-17T14:00:00Z')
    const estado = new EstadoLlmProcesso({ agora: () => relogio, log: () => {} })
    const principal = fornecedor('claude', ['indisponivel'])
    const reserva = fornecedor('groq', ['ok'])
    const llm = new RoteadorLlm({ principal: { porta: principal.porta, modelo: 'opus' }, reserva: { porta: reserva.porta, modelo: 'llama' }, estado })

    const id = await mensagemDoCliente('oi, tem camiseta?')
    const r1 = await conduzirTurnoVendedor(tarefaPara([id], 1), { llm, ligacoes, enviar: enviarFalso })
    expect(r1).toMatchObject({ desfecho: 'falha', reagendarEmMs: REAGENDAR_INSTABILIDADE_MS })
    expect(enviados).toEqual([AVISO_INSTABILIDADE])
    expect(await atendimentos()).toBe(0)
    // "Tentar de novo" ainda não é falha final: sem alerta por enquanto.
    expect(await alertasAbertos()).toEqual([])

    relogio += REAGENDAR_INSTABILIDADE_MS
    const r2 = await conduzirTurnoVendedor(tarefaPara([id], 2), { llm, ligacoes, enviar: enviarFalso })
    expect(r2.desfecho).toBe('respondeu')
    expect(enviados).toEqual([AVISO_INSTABILIDADE, 'Oi! Aqui é a groq.'])
    expect(r2.rastro?.provedor).toBe('groq')
    expect(estado.retrato().situacao).toBe('reserva')
    expect(await atendimentos()).toBe(0)
  })
})

describe('Turno: a política, com LLM falso', () => {
  it('autônomo + fatal → handoff na hora, aviso ao cliente, atendimento na fila e alerta crítico com evento', async () => {
    await configurar('autonomo')
    const r = await turno(fornecedor('claude', ['credencial_invalida']).porta)
    expect(r).toMatchObject({ desfecho: 'handoff', motivo: 'modelo_indisponivel' })
    expect(enviados).toEqual([AVISO_TRANSFERENCIA])
    expect(await atendimentos()).toBe(1)
    const [d] = await decisoes()
    expect(d).toMatchObject({ desfecho: 'falha', falha_tipo: 'fatal', enviada: true })
    const [a] = await alertasAbertos()
    expect(a).toMatchObject({ tipo: TIPO_ALERTA_LLM, severidade: 'critico' })
    expect(a!.mensagem).toContain('fatal: credencial_invalida')
    const [ev] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND tipo = 'alerta.novo'`
    expect(ev!.n).toBe(1)
  })

  it('transitória só UMA vez: a 1ª tentativa da tarefa avisa e reagenda; a repetição entrega ao humano com aviso', async () => {
    await configurar('autonomo')
    // ⚠️ Sem o worker de verdade: ele pega tarefa de QUALQUER tenant, e os
    //    arquivos de teste rodam em paralelo no mesmo banco. A devolução à fila
    //    com o atraso pedido já é coberta em pipeline.test.ts (Ponto 9).
    const llm = fornecedor('claude', ['indisponivel']).porta
    const id = await mensagemDoCliente('oi')
    const tarefa = tarefaPara([id], 1)

    const r1 = await conduzirTurnoVendedor(tarefa, { llm, ligacoes, enviar: enviarFalso })
    expect(r1).toMatchObject({ desfecho: 'falha', reagendarEmMs: REAGENDAR_INSTABILIDADE_MS })
    expect(enviados).toEqual([AVISO_INSTABILIDADE])
    expect(await atendimentos()).toBe(0)
    const [s] = await dono<{ estado: string; estado_agente: { falha?: { transitorias: number } } }[]>`
      SELECT estado, estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s).toMatchObject({ estado: 'ativa', estado_agente: { falha: { transitorias: 1 } } })

    const r2 = await conduzirTurnoVendedor({ ...tarefa, tentativas: 2 }, { llm, ligacoes, enviar: enviarFalso })
    expect(r2).toMatchObject({ desfecho: 'handoff', motivo: 'modelo_indisponivel' })
    expect(r2.reagendarEmMs).toBeUndefined()
    expect(enviados).toEqual([AVISO_INSTABILIDADE, AVISO_TRANSFERENCIA])
    expect(await atendimentos()).toBe(1)
    expect((await decisoes()).map((d) => d.falha_tipo)).toEqual(['transitoria', 'transitoria'])
    expect(await alertasAbertos()).toHaveLength(1)
  })

  it('a contagem vale entre tarefas: nova mensagem logo depois de uma instabilidade não ganha outro "já te respondo"', async () => {
    await configurar('autonomo')
    const llm = fornecedor('claude', ['indisponivel']).porta
    expect((await turno(llm)).desfecho).toBe('falha')
    const r = await turno(llm)
    expect(r.desfecho).toBe('handoff')
    expect(enviados).toEqual([AVISO_INSTABILIDADE, AVISO_TRANSFERENCIA])
  })

  it('⚠️ transitória com ferramenta já executada: a reserva NÃO repete e o turno entrega ao humano sem reagendar', async () => {
    await configurar('autonomo')
    const estado = new EstadoLlmProcesso({ log: () => {} })
    const principal = fornecedor('claude', ['indisponivel', { motivo: 'indisponivel', ferramentas: 1 }])
    const reserva = fornecedor('groq', ['ok'])
    const llm = new RoteadorLlm({ principal: { porta: principal.porta, modelo: 'opus' }, reserva: { porta: reserva.porta, modelo: 'llama' }, estado })
    await llm.rodar(pedido) // 1ª falha do processo (outra conversa)

    const r = await turno(llm)
    expect(r.desfecho).toBe('handoff')
    expect(r.reagendarEmMs).toBeUndefined()
    expect(reserva.contagem.chamadas).toBe(0)
    expect(enviados).toEqual([AVISO_TRANSFERENCIA])
  })

  it('autônomo + fora do formato → handoff com aviso', async () => {
    await configurar('autonomo')
    const r = await turno(fornecedor('claude', ['fora_do_formato']).porta)
    expect(r.desfecho).toBe('handoff')
    expect(enviados).toEqual([AVISO_TRANSFERENCIA])
    expect((await decisoes())[0]!.falha_tipo).toBe('formato')
  })

  it('sombra: só registra — nada ao cliente, nenhum atendimento, alerta como aviso', async () => {
    await configurar('sombra')
    const r = await turno(fornecedor('claude', ['credencial_invalida']).porta)
    expect(r.desfecho).toBe('falha')
    expect(r.reagendarEmMs).toBeUndefined()
    expect(enviados).toEqual([])
    expect(await atendimentos()).toBe(0)
    expect(await alertasAbertos()).toMatchObject([{ tipo: TIPO_ALERTA_LLM, severidade: 'aviso' }])
  })

  it('um alerta aberto por vez: a falha seguinte só atualiza o texto e sobe para crítico; nenhum evento novo', async () => {
    await configurar('sombra')
    await turno(fornecedor('claude', ['credencial_invalida']).porta)
    // A sessão encerrada pela falha em sombra seguraria o portão; outra conversa, na prática.
    await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
    await configurar('autonomo')
    expect((await turno(fornecedor('claude', ['acesso_negado']).porta)).desfecho).toBe('handoff')
    const abertos = await alertasAbertos()
    expect(abertos).toHaveLength(1)
    expect(abertos[0]).toMatchObject({ severidade: 'critico' })
    expect(abertos[0]!.mensagem).toContain('acesso_negado')
    const [ev] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND tipo = 'alerta.novo'`
    expect(ev!.n).toBe(1)
  })

  it('isolamento: o alerta do tenant não aparece para outro tenant (RLS sob o papel da aplicação)', async () => {
    await configurar('autonomo')
    await turno(fornecedor('claude', ['credencial_invalida']).porta)
    const outro = 'f5f50000-9999-4000-8000-000000000005'
    const vistos = await comTenantServico(outro, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM alerta WHERE tipo = ${TIPO_ALERTA_LLM}`)
    expect(vistos[0]!.n).toBe(0)
  })
})
