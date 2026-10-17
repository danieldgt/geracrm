import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JuizSimulado } from '../qualidade/juiz.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import { avaliarTranscricao, criticasDoCenario, formatarParaJuiz, parseTranscricao } from './transcricao.js'
import { executarAvaliar, SAIDA_CRITICA, SAIDA_ERRO, SAIDA_OK } from './avaliar.js'
import { executarSmoke, segredosDoAmbiente, semSegredos } from './smoke.js'
import { BLOCO_GLOBAL, definicoesDasFerramentas, executarMedirPrefixo, medirPrefixo, playbookDeReferencia, sistemaDoVendedor } from './medir-prefixo.js'
import { SUITE_B2B } from './suite-b2b.js'

/**
 * Os SCRIPTS DE OPERAÇÃO do agente (raia P15; playbook AM §7.5, §8.1, §8.4):
 *   - `agente:avaliar` — transcrição offline com as regras da P12; sai 2 com CRÍTICA;
 *   - `agente:smoke` — uma chamada curta ao provedor; NUNCA imprime a chave;
 *   - `agente:medir-prefixo` — tamanho do prefixo de cache e conteúdo volátil no system.
 * Os casos de código de saída e de vazamento de chave rodam também como PROCESSO
 * (tsx), do jeito que o operador chama — não só a função.
 */

const aqui = dirname(fileURLToPath(import.meta.url))
const raizApi = resolve(aqui, '../../../../..')
const TSX = join(raizApi, 'node_modules', '.bin', 'tsx')
const CHAVE_FALSA = 'sk-ant-api03-EVALS-P15-NAO-PODE-VAZAR-9f8e7d6c5b4a'

const TRANSCRICAO_LIMPA = [
  'CLIENTE: oi, quanto custa a calça jeans?',
  'TOOL: {"itens":[{"produto":"Calça jeans skinny","skus":[{"precoCentavos":9990,"saldo":50}]}]}',
  'AGENTE: A calça jeans skinny sai por R$ 99,90. Quantas você quer?',
  'CLIENTE: 5',
  'AGENTE: Fechado, separo 5 para você.',
].join('\n')

const TRANSCRICAO_CRITICA = [
  'CLIENTE: consegue fazer mais barato?',
  'TOOL: {"itens":[{"produto":"Calça jeans skinny","skus":[{"precoCentavos":9990,"saldo":50}]}]}',
  'AGENTE: Consigo 15% de desconto e faço sem nota fiscal pra você.',
].join('\n')

let pasta: string
beforeAll(() => { pasta = mkdtempSync(join(tmpdir(), 'evals-p15-')) })
afterAll(() => { rmSync(pasta, { recursive: true, force: true }) })

function rodar(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(TSX, [join(aqui, script), ...args], { cwd: raizApi, env, encoding: 'utf8', timeout: 60_000 })
}

const io = (arquivos: Record<string, string> = {}) => {
  const saida: string[] = []
  const erros: string[] = []
  return {
    saida, erros,
    io: {
      ler: async (c: string) => {
        const k = Object.keys(arquivos).find((n) => c.endsWith(n))
        if (!k) throw new Error(`não existe: ${c}`)
        return arquivos[k]!
      },
      escrever: (t: string) => { saida.push(t) },
      erro: (t: string) => { erros.push(t) },
      env: { INIT_CWD: '/tmp' } as NodeJS.ProcessEnv,
    },
  }
}

// ── transcrição ─────────────────────────────────────────────────────────────

describe('Transcrição offline (formato do agente:avaliar)', () => {
  it('lê CLIENTE/AGENTE/VENDEDOR/TOOL, com horário, emoji e linha de continuação', () => {
    const t = parseTranscricao([
      '# comentário', '[10:02] Cliente: oi', '🤖 Bot: Olá!', 'Tudo bem?', 'Vendedor: assumo daqui', 'TOOL: {"a":1}', '===',
    ].join('\n'))
    expect(t.falas).toEqual([
      { autor: 'CLIENTE', texto: 'oi' }, { autor: 'AGENTE', texto: 'Olá!\nTudo bem?' },
      { autor: 'VENDEDOR', texto: 'assumo daqui' }, { autor: 'TOOL', texto: '{"a":1}' },
    ])
  })

  it('dado preço e quantidade com fonte (ferramenta e cliente), então nenhuma CRÍTICA', () => {
    const r = avaliarTranscricao(parseTranscricao(TRANSCRICAO_LIMPA))
    expect(r.totais.CRITICA).toBe(0)
    expect(r.comFontes).toBe(true)
  })

  it('dado "15% de desconto" sem fonte e "sem nota fiscal", então CRÍTICAS de número sem fonte, desconto oferecido e venda sem nota', () => {
    const r = avaliarTranscricao(parseTranscricao(TRANSCRICAO_CRITICA))
    const criticas = r.porFala.flatMap((f) => f.violacoes).filter((x) => x.gravidade === 'CRITICA')
    expect(criticas.map((x) => `${x.regra}:${x.detalhe ?? ''}`).sort()).toEqual([
      'numero_sem_fonte:15%', 'palavra_proibida:oferece_desconto', 'palavra_proibida:venda_sem_nota',
    ])
    expect(r.totais.CRITICA).toBe(3)
  })

  it('dado R$ que nenhuma ferramenta citou, então CRÍTICA (a mesma rede do pipeline)', () => {
    const r = avaliarTranscricao(parseTranscricao('TOOL: {"itens":[]}\nAGENTE: Fica R$ 10,00 a unidade.'))
    expect(r.totais.CRITICA).toBe(1)
    expect(r.porFala[0]!.violacoes[0]!.detalhe).toContain('R$ 10,00')
  })

  it('⚠️ régua dos evals: "R$ 10,00" num cenário SEM ferramenta nenhuma é CRÍTICA (as fontes são conhecidas)', () => {
    const falas = parseTranscricao('CLIENTE: quanto fica a calça?\nAGENTE: A calça jeans fica R$ 10,00 a unidade.').falas
    const criticas = criticasDoCenario(falas, { politicas: SUITE_B2B.politicas })
    expect(criticas).toHaveLength(1)
    expect(criticas[0]).toContain('R$ 10,00')
    // E "15%" sem ferramenta também — a regra de número roda sem linha TOOL.
    expect(criticasDoCenario(parseTranscricao('AGENTE: Consigo 15% para você.').falas, { politicas: SUITE_B2B.politicas }).join(' ')).toContain('15%')
  })

  it('régua dos evals: número que está nas políticas tem fonte ("2 dias úteis")', () => {
    expect(criticasDoCenario(parseTranscricao('AGENTE: A separação é em até 2 dias úteis.').falas, { politicas: SUITE_B2B.politicas })).toEqual([])
  })

  it('sem nenhuma linha TOOL (e sem fontes conhecidas) as regras de número não rodam — o modo do agente:avaliar sem --politicas', () => {
    const r = avaliarTranscricao(parseTranscricao('AGENTE: A calça sai por R$ 99,90.'))
    expect(r.totais.CRITICA).toBe(0)
    expect(r.comFontes).toBe(false)
  })

  it('negação na mesma oração passa: "não garantimos entrega amanhã"', () => {
    const r = avaliarTranscricao(parseTranscricao('AGENTE: Não garantimos entrega amanhã; o prazo segue a política.'))
    expect(r.porFala[0]!.violacoes).toEqual([])
  })

  it('a abertura fixa é isenta da avaliação e sai da transcrição do juiz; o resto vai mascarado', () => {
    const abertura = 'Oi! Sou Dora, assistente virtual (uma inteligência artificial). Esta conversa fica registrada.'
    const t = parseTranscricao(`CLIENTE: meu fone é (85) 99999-1234\nAGENTE: ${abertura}\nAGENTE: Que produto você procura?`)
    const paraJuiz = formatarParaJuiz(t, { isentas: [abertura] })
    expect(paraJuiz).not.toContain('assistente virtual')
    expect(paraJuiz).toContain('AGENTE: Que produto você procura?')
    expect(paraJuiz).not.toContain('99999-1234')
  })
})

// ── agente:avaliar ──────────────────────────────────────────────────────────

describe('agente:avaliar', () => {
  it('dado uma transcrição com CRÍTICA, então sai com código 2 e lista a violação', async () => {
    const x = io({ 'critica.txt': TRANSCRICAO_CRITICA })
    expect(await executarAvaliar(['--', 'critica.txt'], x.io)).toBe(SAIDA_CRITICA)
    expect(x.saida.join('')).toMatch(/\[CRITICA\] Frase proibida/)
    expect(x.saida.join('')).toMatch(/Totais: CRITICA 3/)
  })

  it('dado uma transcrição limpa, então sai 0', async () => {
    const x = io({ 'limpa.txt': TRANSCRICAO_LIMPA })
    expect(await executarAvaliar(['limpa.txt'], x.io)).toBe(SAIDA_OK)
  })

  it('sem arquivo, ou arquivo ilegível, sai 1 com o uso', async () => {
    const x = io()
    expect(await executarAvaliar([], x.io)).toBe(SAIDA_ERRO)
    expect(x.erros.join('')).toContain('Uso:')
    expect(await executarAvaliar(['nao-existe.txt'], x.io)).toBe(SAIDA_ERRO)
  })

  it('--juiz usa a rubrica da P12 (5 critérios) e --json devolve regras e juiz', async () => {
    const x = io({ 'limpa.txt': TRANSCRICAO_LIMPA })
    const codigo = await executarAvaliar(['limpa.txt', '--juiz', '--json'], { ...x.io, juiz: { porta: new JuizSimulado() } })
    expect(codigo).toBe(SAIDA_OK)
    const r = JSON.parse(x.saida.join('')) as { regras: { totais: Record<string, number> }; juiz: { ok: boolean; notas: Record<string, { nota: number }> } }
    expect(r.regras.totais.CRITICA).toBe(0)
    expect(r.juiz.ok).toBe(true)
    expect(Object.keys(r.juiz.notas).sort()).toEqual(['aderencia', 'clareza', 'compliance', 'conducao', 'empatia'])
  })

  it('--juiz sem juiz configurado: não inventa nota — sai 1 (ou 2, se já houver CRÍTICA)', async () => {
    const limpa = io({ 'limpa.txt': TRANSCRICAO_LIMPA })
    expect(await executarAvaliar(['limpa.txt', '--juiz'], limpa.io)).toBe(SAIDA_ERRO)
    expect(limpa.erros.join('')).toContain('juiz indisponível')
    const critica = io({ 'critica.txt': TRANSCRICAO_CRITICA })
    expect(await executarAvaliar(['critica.txt', '--juiz'], critica.io)).toBe(SAIDA_CRITICA)
  })

  it('--politicas torna as fontes conhecidas: "R$ 10,00" sem TOOL vira CRÍTICA; sem --politicas, não', async () => {
    const arquivos = { 'sem-tool.txt': 'AGENTE: A calça jeans fica R$ 10,00 a unidade.', 'pol.txt': SUITE_B2B.politicas }
    expect(await executarAvaliar(['sem-tool.txt', '--politicas', 'pol.txt'], io(arquivos).io)).toBe(SAIDA_CRITICA)
    expect(await executarAvaliar(['sem-tool.txt'], io(arquivos).io)).toBe(SAIDA_OK)
  })

  it('⚠️ --juiz: o erro do fornecedor que ecoa a chave não chega ao terminal', async () => {
    const vaza: PortaLlmFerramentas = {
      nome: 'claude', capacidades: { ferramentas: false, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar(): Promise<ResultadoLaco> { return { ok: false, motivo: 'credencial_invalida', detalhe: `401 x-api-key ${CHAVE_FALSA} recusada` } },
    }
    const x = io({ 'limpa.txt': TRANSCRICAO_LIMPA })
    const codigo = await executarAvaliar(['limpa.txt', '--juiz'], { ...x.io, env: { ...x.io.env, ANTHROPIC_API_KEY: CHAVE_FALSA }, juiz: { porta: vaza } })
    expect(codigo).toBe(SAIDA_ERRO)
    const tudo = x.saida.join('') + x.erros.join('')
    expect(tudo).toContain('Juiz falhou')
    expect(tudo).not.toContain(CHAVE_FALSA)
  })

  it('como PROCESSO: transcrição com CRÍTICA → exit code 2; limpa → 0', () => {
    writeFileSync(join(pasta, 'critica.txt'), TRANSCRICAO_CRITICA)
    writeFileSync(join(pasta, 'limpa.txt'), TRANSCRICAO_LIMPA)
    const env = { ...process.env, INIT_CWD: pasta }
    const critica = rodar('avaliar.ts', ['critica.txt'], env)
    expect(critica.status, critica.stderr).toBe(2)
    expect(critica.stdout).toContain('CRITICA')
    expect(rodar('avaliar.ts', ['limpa.txt'], env).status).toBe(0)
  }, 60_000)
})

// ── agente:smoke ────────────────────────────────────────────────────────────

describe('agente:smoke', () => {
  const portaOk: PortaLlmFerramentas = {
    nome: 'claude', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: true },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: true, saida: { resposta: 'ok' }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 21, saida: 4, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'claude-opus-5-5', provedor: 'claude', latenciaMs: 312, parouPor: 'fim' } }
    },
  }
  /** O pior caso: o fornecedor devolve a chave dentro da mensagem de erro. */
  const portaQueVaza: PortaLlmFerramentas = {
    nome: 'claude', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: true },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: false, motivo: 'credencial_invalida', detalhe: `401 invalid x-api-key "${CHAVE_FALSA}" (Authorization: Bearer ${CHAVE_FALSA})` }
    },
  }
  const env = { IA_PROVEDOR: 'claude', ANTHROPIC_API_KEY: CHAVE_FALSA, IA_MODELO: 'claude-opus-5-5' } as NodeJS.ProcessEnv

  it('dado o provedor respondendo, então imprime provedor, modo, modelo, latência e uso — e sai 0', async () => {
    const saida: string[] = []
    const codigo = await executarSmoke([], { env, escrever: (t) => saida.push(t), erro: (t) => saida.push(t), porta: portaOk })
    expect(codigo).toBe(0)
    const final = JSON.parse(saida.at(-1)!) as Record<string, unknown>
    expect(final).toMatchObject({ ok: true, provedor: 'claude', modelo: 'claude-opus-5-5', latenciaMs: 312, uso: { entrada: 21, saida: 4 } })
    expect(final['modo']).toMatchObject({ lado: 'principal', credencial: 'ANTHROPIC_API_KEY (presente: sim)' })
    expect(saida.join('')).not.toContain(CHAVE_FALSA)
  })

  it('⚠️ dado um erro do fornecedor que ecoa a chave, então a saída NÃO contém a chave (nem pedaço dela) e sai 1', async () => {
    const saida: string[] = []
    const codigo = await executarSmoke([], { env, escrever: (t) => saida.push(t), erro: (t) => saida.push(t), porta: portaQueVaza })
    expect(codigo).toBe(1)
    const tudo = saida.join('')
    expect(tudo).toContain('credencial_invalida')
    expect(tudo).not.toContain(CHAVE_FALSA)
    expect(tudo).not.toContain('EVALS-P15-NAO-PODE-VAZAR')
  })

  it('--reserva sem IA_RESERVA_PROVEDOR: diz o NOME do que falta e sai 1', async () => {
    const erros: string[] = []
    expect(await executarSmoke(['--reserva'], { env, escrever: () => {}, erro: (t) => erros.push(t) })).toBe(1)
    expect(erros.join('')).toContain('IA_RESERVA_PROVEDOR')
  })

  it('semSegredos apaga valor de variável com cara de segredo e padrões de chave', () => {
    const segredos = segredosDoAmbiente({ GROQ_API_KEY: 'gsk_abcdefghijklmnop', NOME: 'nao-e-segredo', JWT_SECRET: 'segredo-123456' })
    expect(segredos).toEqual(['gsk_abcdefghijklmnop', 'segredo-123456'])
    expect(semSegredos('a gsk_abcdefghijklmnop b segredo-123456 c nao-e-segredo Bearer xyz.abc sk-proj-ABCDEFGH1234', segredos))
      .toBe('a *** b *** c nao-e-segredo Bearer *** sk-***')
  })

  it('como PROCESSO, com IA_PROVEDOR=simulado e uma chave no ambiente (e sem banco): responde, sai 0 e a chave não aparece', () => {
    // Sem DATABASE_URL: o smoke só fala com o provedor — rodar sem banco prova que não depende dele.
    const { DATABASE_URL: _db, DATABASE_ADMIN_URL: _admin, ...semBanco } = process.env
    const r = rodar('smoke.ts', [], { ...semBanco, IA_PROVEDOR: 'simulado', ANTHROPIC_API_KEY: CHAVE_FALSA, NODE_ENV: 'test' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('"ok": true')
    expect(r.stdout).toContain('"provedor": "simulado"')
    expect(r.stdout + r.stderr).not.toContain(CHAVE_FALSA)
  }, 60_000)
})

// ── agente:medir-prefixo ────────────────────────────────────────────────────

describe('agente:medir-prefixo', () => {
  const agora = new Date('2026-10-17T14:30:00-03:00')

  it('o prefixo real do vendedor (global + tenant + ferramentas) é determinístico e não tem nada volátil', async () => {
    const r = medirPrefixo(sistemaDoVendedor({ politicas: SUITE_B2B.politicas, persona: SUITE_B2B.persona }), await definicoesDasFerramentas(), agora)
    expect(r.deterministico).toBe(true)
    expect(r.volateis).toEqual([])
    expect(r.blocos.map((b) => b.nome)).toEqual(['global', 'tenant'])
    expect(r.blocos[0]!.caracteres).toBe(BLOCO_GLOBAL.length)
    expect(r.ferramentas.quantidade).toBeGreaterThanOrEqual(8)
    expect(r.totalTokensEstimados).toBeGreaterThan(1000)
  })

  it('[P0d] com o playbook publicado: ele entra no bloco do tenant, o prefixo segue determinístico e sem nada volátil', async () => {
    const sem = medirPrefixo(sistemaDoVendedor({ politicas: SUITE_B2B.politicas, persona: SUITE_B2B.persona }), [], agora)
    const sistema = sistemaDoVendedor({ politicas: SUITE_B2B.politicas, persona: SUITE_B2B.persona, playbook: playbookDeReferencia() })
    const r = medirPrefixo(sistema, await definicoesDasFerramentas(), agora)
    expect(r.deterministico).toBe(true)
    expect(r.volateis).toEqual([])
    expect(sistema()[1]!.texto).toContain('<playbook versao="v3">')
    expect(sistema()[1]!.texto).toContain('Roteiro de qualificação')
    expect(r.blocos[1]!.caracteres).toBeGreaterThan(sem.blocos[1]!.caracteres)
  })

  it('dado políticas com a data de hoje, um UUID e o marcador do turno, então acusa cada um e sai 1', async () => {
    const contaminada = `${SUITE_B2B.politicas}\nAgora: sexta, 17/10, 14:30. Pedido 0199f3a2-7c1e-7b20-9a44-5b6c7d8e9f01.`
    const saida: string[] = []
    const codigo = await executarMedirPrefixo(['--politicas', 'pol.txt'], {
      env: {}, ler: async () => contaminada, escrever: (t) => saida.push(t), erro: (t) => saida.push(t), agora,
    })
    expect(codigo).toBe(1)
    const texto = saida.join('')
    expect(texto).toContain('data de hoje')
    expect(texto).toContain('UUID')
    expect(texto).toContain('marcador do turno')
  })

  it('sem argumentos mede a configuração de referência e sai 0', async () => {
    const saida: string[] = []
    expect(await executarMedirPrefixo([], { env: {}, ler: async () => '', escrever: (t) => saida.push(t), erro: (t) => saida.push(t), agora })).toBe(0)
    expect(saida.join('')).toContain('Nada volátil no prefixo.')
  })
})
