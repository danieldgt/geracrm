import { describe, it, expect } from 'vitest'
import { LlmOpenRouterFerramentas, interpretarSaida } from './openrouter-ferramentas.js'
import { paraMensagens } from './claude-ferramentas.js'
import { faltaParaLlmFerramentas, llmFerramentasDoAmbiente } from './fabrica-ferramentas.js'
import type { PedidoDeLaco } from './porta-llm.js'

/** Os adaptadores com laço: fio, rodadas, mapeamento de erro — com fetch falso. */
const pedidoBase = (executar: PedidoDeLaco['executar']): PedidoDeLaco => ({
  sistema: [{ texto: 'global', cachear: true }, { texto: 'tenant', cachear: true }],
  mensagens: [{ papel: 'cliente', texto: 'tem camiseta?' }, { papel: 'operador', texto: 'agora: 10h' }],
  ferramentas: [{ nome: 'catalogo_buscar', descricao: 'busca', esquema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'], additionalProperties: false } }],
  executar,
  esquemaSaida: { type: 'object', properties: { mensagens: { type: 'array' }, confianca: { type: 'number' } }, required: ['mensagens', 'confianca'] },
  limites: { maxRodadas: 4, maxTokensSaida: 800, prazoMs: 5000 },
})

function fetchDeRespostas(respostas: unknown[], capturar: Record<string, unknown>[] = []): typeof fetch {
  let i = 0
  return (async (_url: unknown, init?: RequestInit) => {
    capturar.push(JSON.parse(String(init?.body)))
    const r = respostas[i++]
    if (r instanceof Response) return r
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('OpenRouter com ferramentas', () => {
  it('roda uma rodada de ferramenta e devolve a saída JSON final, com rastro e uso', async () => {
    const corpos: Record<string, unknown>[] = []
    const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['a/x', 'b/y'], buscar: fetchDeRespostas([
      { model: 'a/x', usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'catalogo_buscar', arguments: '{"consulta":"camiseta"}' } }] } }] },
      { model: 'a/x', usage: { prompt_tokens: 150, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } }, choices: [{ finish_reason: 'stop', message: { content: '{"mensagens":["Temos!"],"confianca":0.9}' } }] },
    ], corpos) })
    const executadas: string[] = []
    const r = await llm.rodar(pedidoBase(async (nome) => { executadas.push(nome); return { ok: true, saida: { itens: [] } } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.saida).toEqual({ mensagens: ['Temos!'], confianca: 0.9 })
    expect(executadas).toEqual(['catalogo_buscar'])
    expect(r.rastro.chamadas[0]).toMatchObject({ nome: 'catalogo_buscar', entrada: { consulta: 'camiseta' } })
    expect(r.rastro.uso).toEqual({ entrada: 250, saida: 30, cacheLeitura: 50, cacheEscrita: 0 })
    expect(r.rastro.rodadas).toBe(2)
    // O fio: models (cadeia), response_format json_schema, tools strict, operador como system.
    expect(corpos[0]).toMatchObject({ model: 'a/x', models: ['a/x', 'b/y'], route: 'fallback' })
    expect((corpos[0]!['response_format'] as { type: string }).type).toBe('json_schema')
    expect((corpos[0]!['tools'] as { function: { strict: boolean } }[])[0]!.function.strict).toBe(true)
    const msgs = corpos[0]!['messages'] as { role: string; content: string }[]
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'system', content: 'agora: 10h' })
    // Segunda chamada leva o tool result embrulhado em dados_externos.
    const msgs2 = corpos[1]!['messages'] as { role: string; content: string }[]
    expect(msgs2.find((m) => m.role === 'tool')?.content).toContain('<dados_externos>')
  })

  it('mapeia 401 → credencial_invalida, 402 → limite_de_custo, 429 → limite_de_taxa, 503 → indisponivel', async () => {
    for (const [status, motivo] of [[401, 'credencial_invalida'], [402, 'limite_de_custo'], [429, 'limite_de_taxa'], [503, 'indisponivel']] as const) {
      const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['a/x'], buscar: fetchDeRespostas([new Response('erro', { status })]) })
      const r = await llm.rodar(pedidoBase(async () => ({ ok: true, saida: {} })))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.motivo).toBe(motivo)
    }
  })

  it('resposta que não é JSON vira UMA mensagem com confiança baixa (modelo gratuito que ignorou o formato)', async () => {
    const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['a/x'], buscar: fetchDeRespostas([
      { choices: [{ finish_reason: 'stop', message: { content: 'Olá! Temos sim.' } }] },
    ]) })
    const r = await llm.rodar(pedidoBase(async () => ({ ok: true, saida: {} })))
    expect(r).toMatchObject({ ok: true, saida: { mensagens: ['Olá! Temos sim.'], confianca: 0.6 } })
  })

  it('no teto de rodadas pede a resposta final sem ferramentas (tool_choice none)', async () => {
    const corpos: Record<string, unknown>[] = []
    const chamada = { id: 'c', type: 'function', function: { name: 'catalogo_buscar', arguments: '{}' } }
    const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['a/x'], buscar: fetchDeRespostas([
      { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [chamada] } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '{"mensagens":["ok"],"confianca":0.5}' } }] },
    ], corpos) })
    const p = { ...pedidoBase(async () => ({ ok: true, saida: {} })), limites: { maxRodadas: 2, maxTokensSaida: 100, prazoMs: 5000 } }
    const r = await llm.rodar(p)
    expect(r.ok).toBe(true)
    expect(corpos[1]!['tool_choice']).toBe('none')
    if (r.ok) expect(r.rastro.parouPor).toBe('max_rodadas')
  })
})

describe('OpenRouter — modelos gratuitos que não seguem o formato', () => {
  it('texto cru vira uma mensagem com confiança baixa; JSON com outro nome de campo é mapeado; cerca markdown é removida', () => {
    expect(interpretarSaida('Oi! Temos camisetas sim.')).toEqual({ mensagens: ['Oi! Temos camisetas sim.'], confianca: 0.6 })
    expect(interpretarSaida('```json\n{"resposta":"Temos sim","confianca":0.8}\n```')).toMatchObject({ mensagens: ['Temos sim'], confianca: 0.8 })
    expect(interpretarSaida('Claro: {"mensagens":["A","B"],"confianca":0.9} fim')).toMatchObject({ mensagens: ['A', 'B'], confianca: 0.9 })
    expect(interpretarSaida('   ')).toBeNull()
  })
  it('normaliza mensagens que vêm como objetos, nulos, string única ou "messages"; confiança em texto ou em %', () => {
    expect(interpretarSaida('{"mensagens":[{"texto":"Oi"},null,{"content":"Tudo bem?"}],"confianca":"0,8"}')).toMatchObject({ mensagens: ['Oi', 'Tudo bem?'], confianca: 0.8 })
    expect(interpretarSaida('{"mensagens":"Só uma","confianca":85}')).toMatchObject({ mensagens: ['Só uma'], confianca: 0.85 })
    expect(interpretarSaida('{"messages":["a","b","c","d"]}')).toMatchObject({ mensagens: ['a', 'b', 'c'], confianca: 0.7 })
    expect(interpretarSaida('["x","y"]')).toMatchObject({ mensagens: ['x', 'y'] })
  })
  it('slots: {} some; nulo, chave inventada e vazio caem fora; número vira texto', () => {
    expect(interpretarSaida('{"mensagens":["Oi"],"confianca":0.9,"slots":{}}')).not.toHaveProperty('slots')
    expect(interpretarSaida('{"mensagens":["Oi"],"confianca":0.9,"slots":{"tipoCompra":null,"cidade":" Fortaleza ","volume":120,"inventada":"x","prazo":""}}'))
      .toMatchObject({ slots: { cidade: 'Fortaleza', volume: '120' } })
    expect(interpretarSaida('{"mensagens":["Oi"],"confianca":0.9,"slots":"nenhum"}')).not.toHaveProperty('slots')
  })

  it('erro de gramática do fornecedor de trás (200 com `error`, "Unimplemented keys: propertyNames") desce o formato em vez de falhar', async () => {
    const corpos: Record<string, unknown>[] = []
    const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['openrouter/free'], buscar: fetchDeRespostas([
      { error: { message: 'Upstream error from Nvidia: ValueError: Grammar error: Unimplemented keys: ["propertyNames"]', code: 502 } },
      { choices: [{ finish_reason: 'stop', message: { content: '{"mensagens":["Temos camisas sim"],"confianca":0.8,"slots":{}}' } }] },
    ], corpos) })
    const r = await llm.rodar(pedidoBase(async () => ({ ok: true, saida: {} })))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.saida).toMatchObject({ mensagens: ['Temos camisas sim'], confianca: 0.8 })
      expect(r.rastro.rodadas).toBe(1)
    }
    expect((corpos[0]!['response_format'] as { type: string }).type).toBe('json_schema')
    expect((corpos[1]!['response_format'] as { type: string }).type).toBe('json_object')
  })

  it('400 por response_format desce para json_object e depois para nenhum, sem gastar rodada', async () => {
    const corpos: Record<string, unknown>[] = []
    const llm = new LlmOpenRouterFerramentas({ apiKey: 'k', modelos: ['x/free'], buscar: fetchDeRespostas([
      new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 }),
      new Response('{"error":{"message":"response_format not supported by this model"}}', { status: 400 }),
      { choices: [{ finish_reason: 'stop', message: { content: 'Olá, posso ajudar?' } }] },
    ], corpos) })
    const r = await llm.rodar(pedidoBase(async () => ({ ok: true, saida: {} })))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.saida).toEqual({ mensagens: ['Olá, posso ajudar?'], confianca: 0.6 })
      expect(r.rastro.rodadas).toBe(1)
    }
    expect((corpos[0]!['response_format'] as { type: string }).type).toBe('json_schema')
    expect((corpos[1]!['response_format'] as { type: string }).type).toBe('json_object')
    expect(corpos[2]!['response_format']).toBeUndefined()
    // O esquema também foi escrito no system, para o modelo que ignora o parâmetro.
    const sys = (corpos[2]!['messages'] as { role: string; content: string }[])[0]!
    expect(sys.content).toContain('formato_obrigatorio')
  })

  it('preset groq: URL do Groq, sem cadeia models e sem strict', async () => {
    const corpos: Record<string, unknown>[] = []
    const urls: string[] = []
    const buscar = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url)); corpos.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"mensagens":["ok"],"confianca":0.9}' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const llm = new LlmOpenRouterFerramentas({ preset: 'groq', apiKey: 'k', modelos: ['llama-3.3-70b-versatile', 'outro'], buscar })
    expect(llm.nome).toBe('groq')
    const r = await llm.rodar(pedidoBase(async () => ({ ok: true, saida: {} })))
    expect(r.ok).toBe(true)
    expect(urls[0]).toContain('api.groq.com')
    expect(corpos[0]!['models']).toBeUndefined()
    expect((corpos[0]!['tools'] as { function: { strict?: boolean } }[])[0]!.function.strict).toBeUndefined()
  })
})

describe('Claude — tradução das mensagens', () => {
  it('junta falas consecutivas, garante user primeiro e põe o operador como system no fim', () => {
    const m = paraMensagens([
      { papel: 'nos', texto: 'Voltamos às 9h.' },
      { papel: 'cliente', texto: 'oi' }, { papel: 'cliente', texto: 'tem camiseta?' },
      { papel: 'operador', texto: 'agora: 10h' },
    ])
    expect(m[0]).toEqual({ role: 'user', content: '[início da conversa]' })
    expect(m[1]).toEqual({ role: 'assistant', content: 'Voltamos às 9h.' })
    expect(m[2]).toEqual({ role: 'user', content: 'oi\ntem camiseta?' })
    expect(m[3]).toEqual({ role: 'system', content: 'agora: 10h' })
  })
})

describe('Fábrica', () => {
  it('sem chave → diz o que falta; simulado fora de produção → ok; openrouter exige IA_MODELO', () => {
    expect(faltaParaLlmFerramentas({})).toEqual(['ANTHROPIC_API_KEY (ou IA_PROVEDOR=simulado fora de produção)'])
    expect(faltaParaLlmFerramentas({ IA_PROVEDOR: 'simulado' })).toEqual([])
    expect(faltaParaLlmFerramentas({ IA_PROVEDOR: 'simulado', NODE_ENV: 'production' })).toHaveLength(1)
    expect(faltaParaLlmFerramentas({ IA_PROVEDOR: 'openrouter', OPENROUTER_API_KEY: 'k' })).toEqual(['IA_MODELO'])
    expect(faltaParaLlmFerramentas({ IA_PROVEDOR: 'openrouter', OPENROUTER_API_KEY: 'k', IA_MODELO: 'a/x' })).toEqual([])
    expect(llmFerramentasDoAmbiente({ IA_PROVEDOR: 'openrouter', OPENROUTER_API_KEY: 'k', IA_MODELO: 'a/x,b/y' }).nome).toBe('openrouter')
    expect(llmFerramentasDoAmbiente({ ANTHROPIC_API_KEY: 'k' }).nome).toBe('claude')
    expect(llmFerramentasDoAmbiente({ IA_PROVEDOR: 'simulado' }).nome).toBe('simulado')
    expect(faltaParaLlmFerramentas({ IA_PROVEDOR: 'groq' })).toEqual(['GROQ_API_KEY'])
    expect(llmFerramentasDoAmbiente({ IA_PROVEDOR: 'groq', GROQ_API_KEY: 'k' }).nome).toBe('groq')
    expect(llmFerramentasDoAmbiente({ IA_PROVEDOR: 'gemini', GEMINI_API_KEY: 'k' }).nome).toBe('gemini')
  })
})
