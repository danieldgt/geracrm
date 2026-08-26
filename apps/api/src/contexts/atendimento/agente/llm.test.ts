import { describe, it, expect } from 'vitest'
import { LlmClaude } from './claude.js'
import { LlmOpenRouter } from './openrouter.js'
import { criarLlm, configLlmDoAmbiente, faltaParaLlm, llmDoAmbiente } from './fabrica.js'
import type { PedidoDeTurno } from './porta.js'

/**
 * ⚠️ O fornecedor é SEMPRE falso aqui. Chamar a API real no CI custa dinheiro,
 * é lento e falha quando a rede oscila — e um teste que às vezes falha por rede
 * é um teste que alguém marca como `skip` (skill `geracrm-ia`).
 */
function respostaFalsa(corpo: unknown, status = 200): { fetch: typeof fetch; corpoEnviado: () => unknown } {
  let enviado: unknown = null
  const f = (async (_url: string, init?: RequestInit) => {
    enviado = JSON.parse(String(init?.body ?? '{}'))
    return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response
  }) as unknown as typeof fetch
  return { fetch: f, corpoEnviado: () => enviado }
}

const RESPOSTA_BOA = {
  stop_reason: 'tool_use',
  usage: { input_tokens: 1200, output_tokens: 80 },
  content: [{
    type: 'tool_use',
    name: 'responder_ao_lead',
    input: {
      texto: 'Oi! Já anotei aqui. Você compra para revenda ou consumo?',
      proximoPasso: 'continuar',
      extraido: { cidade: 'Boa Vista' },
    },
  }],
}

const PEDIDO: PedidoDeTurno = {
  historico: [{ de: 'cliente', texto: 'boa noite, vocês vendem no atacado?' }],
  lead: {
    nome: 'Daniel', jaEhCliente: true, comprasNoUltimoAno: 4,
    ultimaCompraEm: '2026-07-10', cidade: null, temCnpj: true,
  },
  politicas: 'Entrega em 3 dias úteis. Pagamento via PIX ou cartão.',
  maxCaracteres: 300,
}

describe('Adaptador Claude — o caminho normal', () => {
  it('devolve a proposta e o custo do turno', async () => {
    const { fetch } = respostaFalsa(RESPOSTA_BOA)
    const r = await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dados.proximoPasso).toBe('continuar')
    expect(r.dados.extraidoBruto).toMatchObject({ cidade: 'Boa Vista' })
    // ⚠️ Custo medido por turno: sem isso não há como precificar plano nem
    //    detectar abuso.
    expect(r.custo).toMatchObject({ tokensEntrada: 1200, tokensSaida: 80 })
  })

  it('⚠️ próximo passo desconhecido vira "continuar" — não se confia no modelo', async () => {
    const { fetch } = respostaFalsa({
      ...RESPOSTA_BOA,
      content: [{ type: 'tool_use', input: { texto: 'oi', proximoPasso: 'fechar_pedido' } }],
    })
    const r = await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    expect(r.ok && r.dados.proximoPasso).toBe('continuar')
  })
})

describe('⚠️ O que vai (e o que NÃO vai) para o fornecedor', () => {
  it('leva as políticas curadas e o que já sabemos do lead', async () => {
    const { fetch, corpoEnviado } = respostaFalsa(RESPOSTA_BOA)
    await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    const sistema = String((corpoEnviado() as { system: string }).system)
    expect(sistema).toContain('Entrega em 3 dias úteis')
    expect(sistema).toContain('JÁ É CLIENTE')
    // A regra que impede o agente de soar como formulário.
    expect(sistema).toContain('NÃO pergunte o que já sabemos')
  })

  /**
   * ⚠️ O contexto do lead carrega `temCnpj: boolean`, nunca o número. CNPJ e
   * endereço não melhoram a resposta e sairiam do nosso perímetro à toa — a
   * conversa já é tratamento de dado pessoal por si só.
   */
  it('não manda CNPJ nem endereço do cliente', async () => {
    const { fetch, corpoEnviado } = respostaFalsa(RESPOSTA_BOA)
    await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    const tudo = JSON.stringify(corpoEnviado())
    expect(tudo).not.toMatch(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/)
    expect(tudo).toContain('CNPJ já cadastrado')  // o fato, não o número
  })

  it('a instrução proíbe preço e promessa fora das políticas', async () => {
    const { fetch, corpoEnviado } = respostaFalsa(RESPOSTA_BOA)
    await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    const sistema = String((corpoEnviado() as { system: string }).system)
    expect(sistema).toContain('NUNCA fale preço')
    expect(sistema).toContain('NUNCA prometa')
  })
})

describe('⚠️ Falha do fornecedor é resultado tipificado, nunca exceção', () => {
  const casos: ReadonlyArray<readonly [number, string]> = [
    [401, 'credencial_invalida'],
    [403, 'credencial_invalida'],
    [429, 'limite_de_taxa'],
    [529, 'limite_de_taxa'],   // "overloaded" da Anthropic — recuar igual
    [500, 'indisponivel'],
    [400, 'resposta_inesperada'],
  ]

  for (const [status, motivo] of casos) {
    it(`HTTP ${status} vira ${motivo}`, async () => {
      const { fetch } = respostaFalsa({ error: { message: 'x' } }, status)
      const r = await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.motivo).toBe(motivo)
    })
  }

  it('queda de rede vira indisponivel — o cliente vai para a fila humana', async () => {
    const f = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const r = await new LlmClaude({ apiKey: 'k' }, { buscar: f }).conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('indisponivel')
  })

  /** Recusa de conteúdo não é erro de rede: repetir não resolve. */
  it('recusa do modelo tem motivo próprio', async () => {
    const { fetch } = respostaFalsa({ stop_reason: 'refusal', content: [] })
    const r = await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('conteudo_recusado')
  })

  it('resposta sem bloco de ferramenta não vira mensagem em branco', async () => {
    const { fetch } = respostaFalsa({ content: [{ type: 'text', text: 'oi' }] })
    const r = await new LlmClaude({ apiKey: 'k' }, { buscar: fetch }).conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('resposta_inesperada')
  })
})

describe('Fábrica', () => {
  it('diz o NOME da variável que falta, não "IA indisponível"', () => {
    expect(faltaParaLlm({})[0]).toContain('ANTHROPIC_API_KEY')
    expect(faltaParaLlm({ ANTHROPIC_API_KEY: '  ' })[0]).toContain('ANTHROPIC_API_KEY')
    expect(faltaParaLlm({ ANTHROPIC_API_KEY: 'k' })).toEqual([])
  })

  it('sem chave, não monta configuração', () => {
    expect(configLlmDoAmbiente({})).toBeNull()
    expect(configLlmDoAmbiente({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ provedor: 'claude' })
  })

  it('modelo é opcional e configurável por ambiente', () => {
    expect(configLlmDoAmbiente({ ANTHROPIC_API_KEY: 'k', IA_MODELO: 'claude-haiku-4-5-20251001' })?.modelo)
      .toBe('claude-haiku-4-5-20251001')
  })

  it('a chave do OpenRouter também serve', () => {
    const cfg = configLlmDoAmbiente({ OPENROUTER_API_KEY: 'k', IA_MODELO: 'anthropic/claude-sonnet-4.5' })
    expect(cfg).toMatchObject({ provedor: 'openrouter', modelo: 'anthropic/claude-sonnet-4.5' })
    expect(criarLlm(cfg).nome).toBe('openrouter')
  })

  /**
   * ⚠️ No OpenRouter o modelo é OBRIGATÓRIO: o catálogo muda e cada modelo tem
   * identificador próprio. Chutar um padrão daria um 400 sobre modelo
   * inexistente — erro que não se parece com "faltou configurar" e manda a
   * pessoa procurar no lugar errado.
   */
  it('OpenRouter sem IA_MODELO reclama do MODELO, não da chave', () => {
    expect(faltaParaLlm({ OPENROUTER_API_KEY: 'k' })).toEqual(['IA_MODELO'])
  })

  /** ⚠️ Com as duas chaves, o DIRETO ganha: um intermediário a menos no caminho. */
  it('com as duas chaves, prefere o direto — e IA_PROVEDOR manda quando existe', () => {
    const duas = { ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'b', IA_MODELO: 'x/y' }
    expect(configLlmDoAmbiente(duas)?.provedor).toBe('claude')
    expect(configLlmDoAmbiente({ ...duas, IA_PROVEDOR: 'openrouter' })?.provedor).toBe('openrouter')
  })

  /**
   * ⚠️ Sem chave NÃO lança: devolve falha nomeada. Lançar aqui derrubaria a
   * ingestão de uma mensagem do cliente que já está salva no banco — e o produto
   * perderia a mensagem por não ter uma chave de IA.
   */
  it('sem chave, o adaptador falha nomeado em vez de estourar', async () => {
    const llm = llmDoAmbiente({})
    const r = await llm.conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('credencial_invalida')
  })

  it('provedor desconhecido também degrada em vez de quebrar', async () => {
    const llm = criarLlm({ provedor: 'gemini' as never, apiKey: 'k' })
    expect((await llm.conversar(PEDIDO)).ok).toBe(false)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter — o segundo adaptador. Formato do fio é outro; o contrato é o mesmo.
// ─────────────────────────────────────────────────────────────────────────────
const RESPOSTA_OR = {
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      tool_calls: [{
        function: {
          name: 'responder_ao_lead',
          // ⚠️ Argumentos vêm como STRING de JSON, não como objeto.
          arguments: '{"texto":"Oi! Compra para revenda?","proximoPasso":"continuar","extraido":{"cidade":"Manaus"}}',
        },
      }],
    },
  }],
  usage: { prompt_tokens: 900, completion_tokens: 40 },
}

const orFalso = (corpo: unknown, status = 200) => {
  const { fetch, corpoEnviado } = respostaFalsa(corpo, status)
  return { llm: new LlmOpenRouter({ apiKey: 'k', modelo: 'anthropic/claude-sonnet-4.5' }, { buscar: fetch }), corpoEnviado }
}

describe('Adaptador OpenRouter', () => {
  it('lê a chamada de ferramenta e o custo, com os nomes do formato OpenAI', async () => {
    const r = await orFalso(RESPOSTA_OR).llm.conversar(PEDIDO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dados.texto).toContain('revenda')
    expect(r.dados.extraidoBruto).toMatchObject({ cidade: 'Manaus' })
    expect(r.custo).toMatchObject({ tokensEntrada: 900, tokensSaida: 40 })
  })

  it('a instrução vai como PRIMEIRA MENSAGEM, não como campo à parte', async () => {
    const { llm, corpoEnviado } = orFalso(RESPOSTA_OR)
    await llm.conversar(PEDIDO)
    const msgs = (corpoEnviado() as { messages: { role: string; content: string }[] }).messages
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[0]?.content).toContain('Entrega em 3 dias úteis')
  })

  /**
   * ⚠️ A invariante que justifica `instrucao.ts` existir: dois prompts
   * diferentes fariam o agente se comportar de um jeito num cliente e de outro
   * noutro, dependendo de qual fornecedor estava configurado — e ninguém
   * conseguiria reproduzir o relato.
   */
  it('manda EXATAMENTE a mesma instrução que o adaptador direto', async () => {
    const { fetch: f1, corpoEnviado: c1 } = respostaFalsa(RESPOSTA_BOA)
    await new LlmClaude({ apiKey: 'k' }, { buscar: f1 }).conversar(PEDIDO)
    const { llm, corpoEnviado: c2 } = orFalso(RESPOSTA_OR)
    await llm.conversar(PEDIDO)

    const doClaude = (c1() as { system: string }).system
    const doOpenRouter = (c2() as { messages: { content: string }[] }).messages[0]!.content
    expect(doOpenRouter).toBe(doClaude)
  })

  /** ⚠️ Crédito acabado não é chave inválida nem limite de taxa: alguém precisa recarregar. */
  it('402 vira limite_de_custo, dizendo que faltou crédito', async () => {
    const r = await orFalso({ error: { message: 'Insufficient credits' } }, 402).llm.conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('limite_de_custo')
      expect(r.detalhe).toContain('sem créditos')
    }
  })

  /**
   * ⚠️ O OpenRouter devolve HTTP 200 com `error` dentro quando o roteamento
   * falha. Ler só o status daria "resposta_inesperada" para algo que é
   * indisponibilidade — e o log mandaria alguém procurar bug no nosso parser.
   */
  it('erro DENTRO de um 200 é reconhecido como falha do fornecedor', async () => {
    const r = await orFalso({ error: { message: 'No allowed providers', code: 503 } }).llm.conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('indisponivel')
  })

  it('argumentos truncados viram falha nomeada, não exceção', async () => {
    const truncado = { choices: [{ message: { tool_calls: [{ function: { arguments: '{"texto":"oi"' } }] } }] }
    const r = await orFalso(truncado).llm.conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('resposta_inesperada')
  })

  it('filtro de conteúdo tem motivo próprio', async () => {
    const r = await orFalso({ choices: [{ finish_reason: 'content_filter', message: {} }] }).llm.conversar(PEDIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('conteudo_recusado')
  })
})

describe('⚠️ IA_MODELO com vários modelos = cadeia de fallback', () => {
  /**
   * Colar a lista do catálogo é o que a pessoa naturalmente faz — aconteceu em
   * produção em 26/08. Recusar produziria um 400 sobre "modelo inexistente" com
   * a lista inteira dentro do nome, que é impossível de entender.
   */
  const comLista = (corpo: unknown) => {
    const { fetch, corpoEnviado } = respostaFalsa(corpo)
    return {
      llm: new LlmOpenRouter(
        { apiKey: 'k', modelo: ' a/um , b/dois ,c/tres ' }, { buscar: fetch }),
      corpoEnviado,
    }
  }

  it('manda o primeiro em model e a lista inteira em models', async () => {
    const { llm, corpoEnviado } = comLista(RESPOSTA_OR)
    await llm.conversar(PEDIDO)
    const c = corpoEnviado() as { model: string; models: string[] }
    expect(c.model).toBe('a/um')
    expect(c.models).toEqual(['a/um', 'b/dois', 'c/tres'])
  })

  it('com um modelo só, NÃO manda models — nada a rotear', async () => {
    const { fetch, corpoEnviado } = respostaFalsa(RESPOSTA_OR)
    await new LlmOpenRouter({ apiKey: 'k', modelo: 'a/um' }, { buscar: fetch }).conversar(PEDIDO)
    expect(corpoEnviado()).not.toHaveProperty('models')
  })

  /**
   * ⚠️ Sem isto, a conta de quem caiu no fallback ficaria atribuída ao primeiro
   * da lista — e a medição de custo por modelo, que é o que decide qual manter,
   * apontaria para o modelo errado.
   */
  it('o custo reporta quem REALMENTE respondeu, não o primeiro da lista', async () => {
    const { llm } = comLista({ ...RESPOSTA_OR, model: 'c/tres' })
    const r = await llm.conversar(PEDIDO)
    expect(r.ok && r.custo.modelo).toBe('c/tres')
  })
})

describe('⚠️ O fornecedor aceita no máximo 3 modelos', () => {
  /**
   * Medido em produção: lista de 7 devolveu "'models' array must have 3 items or
   * fewer". Cortamos no cliente para o erro não chegar ao cliente final — e a
   * ORDEM de IA_MODELO passa a decidir quem fica.
   */
  it('lista longa é cortada nos três primeiros, na ordem escrita', async () => {
    const { fetch, corpoEnviado } = respostaFalsa(RESPOSTA_OR)
    await new LlmOpenRouter(
      { apiKey: 'k', modelo: 'a/1,b/2,c/3,d/4,e/5,f/6,g/7' }, { buscar: fetch },
    ).conversar(PEDIDO)
    const c = corpoEnviado() as { model: string; models: string[] }
    expect(c.models).toEqual(['a/1', 'b/2', 'c/3'])
    expect(c.model).toBe('a/1')
  })
})

describe('⚠️ Numa cadeia, a falha precisa dizer QUEM falhou', () => {
  /**
   * Com três modelos rodando por trás, "não usou a ferramenta" não diz qual sai
   * da lista — e a pessoa fica trocando no escuro. Medido em produção: o
   * roteamento varia entre execuções porque modelos grátis são limitados.
   */
  const chamar = (corpo: unknown) =>
    new LlmOpenRouter({ apiKey: 'k', modelo: 'a/1,b/2' },
      { buscar: respostaFalsa(corpo).fetch }).conversar(PEDIDO)

  it('modelo que responde em TEXTO é nomeado, com o que ele disse', async () => {
    const r = await chamar({
      model: 'b/2',
      choices: [{ finish_reason: 'stop', message: { content: 'Claro, temos atacado!' } }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.detalhe).toContain('b/2')
      expect(r.detalhe).toContain('sem usar a ferramenta')
      expect(r.detalhe).toContain('Claro, temos atacado!')
    }
  })

  /** ⚠️ Usar a ferramenta e vir sem texto é OUTRO problema, com outra ação. */
  it('ferramenta sem texto tem mensagem própria', async () => {
    const r = await chamar({
      model: 'a/1',
      choices: [{ message: { tool_calls: [{ function: { arguments: '{"proximoPasso":"continuar"}' } }] } }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detalhe).toContain('sem preencher o texto')
  })
})
