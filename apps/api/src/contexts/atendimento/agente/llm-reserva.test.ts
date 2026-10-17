import { describe, it, expect, beforeEach } from 'vitest'
import { RoteadorLlm, type LadoLlm } from './llm-reserva.js'
import { EstadoLlmProcesso, type LogAlertaLlm } from './llm-estado.js'
import type { MotivoFalhaLlm } from './porta.js'
import type { PedidoDeLaco, ResultadoLaco, RastroDoLaco } from './porta-llm.js'
import {
  criarLlmDoCatalogo, faltaParaReserva, janelaDaReservaMs, llmFerramentasDoAmbiente, reservaDoAmbiente,
} from './fabrica-ferramentas.js'

/**
 * RESERVA DE PROVEDOR E FALLBACK DE MODELO (ADR-030 §2–3) — relógio falso,
 * fornecedores falsos. Nenhum teste aqui toca rede.
 */
const pedido: PedidoDeLaco = {
  sistema: [{ texto: 'sistema' }], mensagens: [{ papel: 'cliente', texto: 'oi' }], ferramentas: [],
  executar: async () => ({ ok: true, saida: null }), esquemaSaida: {},
  limites: { maxRodadas: 3, maxTokensSaida: 100, prazoMs: 1_000 },
}

const rastro = (modelo: string, chamadas = 0): RastroDoLaco => ({
  chamadas: Array.from({ length: chamadas }, () => ({ nome: 'pedido_itens', entrada: {}, saida: {}, ms: 1 })),
  rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo, latenciaMs: 2, parouPor: 'fim',
})

/** Fornecedor falso: responde o roteiro, um item por chamada (o último se repete). */
function fornecedor(nome: string, modelo: string, roteiro: (MotivoFalhaLlm | 'ok' | { motivo: MotivoFalhaLlm; ferramentas: number })[]) {
  const chamadas: number[] = []
  let i = 0
  const lado: LadoLlm = {
    modelo,
    porta: {
      nome, capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar(): Promise<ResultadoLaco> {
        chamadas.push(i)
        const passo = roteiro[Math.min(i++, roteiro.length - 1)]!
        if (passo === 'ok') return { ok: true, saida: { mensagens: [`${nome} respondeu`], confianca: 0.9 }, rastro: rastro(modelo) }
        if (typeof passo === 'string') return { ok: false, motivo: passo, detalhe: 'simulada', rastro: rastro(modelo) }
        return { ok: false, motivo: passo.motivo, detalhe: 'simulada', rastro: rastro(modelo, passo.ferramentas) }
      },
    },
  }
  return { lado, get chamadas() { return chamadas.length } }
}

let agora = 0
let logs: { nivel: string; campos: Record<string, unknown> }[] = []
const log: LogAlertaLlm = (nivel, campos) => { logs.push({ nivel, campos: { ...campos } }) }
let estado: EstadoLlmProcesso
const MIN = 60_000
beforeEach(() => {
  agora = 1_000_000; logs = []
  estado = new EstadoLlmProcesso({ agora: () => agora, log })
})
const alertas = () => logs.map((l) => l.campos['alerta'])

describe('Reserva de provedor com janela', () => {
  it('dado o principal caindo 2× seguidas, quando a 2ª falha sem ferramenta, então refaz JÁ na reserva e liga a janela', async () => {
    const principal = fornecedor('claude', 'claude-opus-5-5', ['indisponivel'])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, janelaMs: 30 * MIN, estado })

    const r1 = await llm.rodar(pedido)
    expect(r1).toMatchObject({ ok: false, motivo: 'indisponivel' })
    expect(reserva.chamadas).toBe(0)

    const r2 = await llm.rodar(pedido)
    expect(r2.ok).toBe(true)
    expect(r2.rastro?.provedor).toBe('groq')
    // A tentativa perdida no principal entra no custo do turno.
    expect(r2.rastro?.uso.entrada).toBe(20)
    expect(alertas()).toContain('llm_reserva_ativo')
    expect(estado.retrato()).toMatchObject({ situacao: 'reserva', falhasSeguidas: 2 })
    expect(estado.retrato().reservaAteEm?.getTime()).toBe(agora + 30 * MIN)
  })

  it('com a reserva ativa, tudo vai para ela; vencida a janela, volta sozinho ao principal', async () => {
    const principal = fornecedor('claude', 'opus', ['indisponivel', 'indisponivel', 'ok'])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, janelaMs: 30 * MIN, estado })
    await llm.rodar(pedido); await llm.rodar(pedido)
    expect(principal.chamadas).toBe(2)

    agora += 29 * MIN
    expect((await llm.rodar(pedido)).rastro?.provedor).toBe('groq')
    expect(principal.chamadas).toBe(2)

    agora += 2 * MIN
    const r = await llm.rodar(pedido)
    expect(r.rastro?.provedor).toBe('claude')
    expect(principal.chamadas).toBe(3)
    expect(alertas()).toContain('llm_reserva_encerrado')
    expect(estado.retrato()).toMatchObject({ situacao: 'principal', falhasSeguidas: 0 })
  })

  it('⚠️ dado que o laço JÁ executou ferramenta, quando a falha liga a reserva, então NÃO repete a chamada (efeito em dobro)', async () => {
    const principal = fornecedor('claude', 'opus', ['indisponivel', { motivo: 'indisponivel', ferramentas: 1 }])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, estado })
    await llm.rodar(pedido)
    const r = await llm.rodar(pedido)
    expect(r).toMatchObject({ ok: false, motivo: 'indisponivel' })
    expect(reserva.chamadas).toBe(0)
    // ...mas a reserva ficou ligada para as próximas.
    expect(estado.retrato().situacao).toBe('reserva')
    expect((await llm.rodar(pedido)).rastro?.provedor).toBe('groq')
  })

  it('sucesso do principal zera a contagem: falhas intercaladas nunca ligam a reserva', async () => {
    const principal = fornecedor('claude', 'opus', ['indisponivel', 'ok', 'indisponivel', 'ok'])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, estado })
    for (let i = 0; i < 4; i++) await llm.rodar(pedido)
    expect(reserva.chamadas).toBe(0)
    expect(estado.retrato().situacao).toBe('principal')
  })

  it('erro de requisição e de formato não contam para a reserva', async () => {
    const principal = fornecedor('claude', 'opus', ['requisicao_invalida', 'resposta_inesperada', 'conteudo_recusado'])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, estado })
    for (let i = 0; i < 3; i++) await llm.rodar(pedido)
    expect(reserva.chamadas).toBe(0)
    expect(estado.retrato().falhasSeguidas).toBe(0)
  })

  it('fatal também conta (chave revogada, sem crédito): a reserva liga do mesmo jeito', async () => {
    const principal = fornecedor('claude', 'opus', ['credencial_invalida', 'limite_de_custo'])
    const reserva = fornecedor('groq', 'llama', ['ok'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, estado })
    await llm.rodar(pedido)
    expect((await llm.rodar(pedido)).ok).toBe(true)
  })

  it('sem reserva configurada: conta as falhas (aparecem na saúde) e repassa o erro', async () => {
    const principal = fornecedor('claude', 'opus', ['indisponivel'])
    const llm = new RoteadorLlm({ principal: principal.lado, estado })
    for (let i = 0; i < 3; i++) expect((await llm.rodar(pedido)).ok).toBe(false)
    expect(estado.retrato()).toMatchObject({ situacao: 'principal', falhasSeguidas: 3, ultimaFalha: { motivo: 'indisponivel', origem: 'principal' } })
    expect(alertas()).not.toContain('llm_reserva_ativo')
  })

  it('a reserva também caindo: devolve a falha dela e loga llm_reserva_falhou', async () => {
    const principal = fornecedor('claude', 'opus', ['indisponivel'])
    const reserva = fornecedor('groq', 'llama', ['limite_de_taxa'])
    const llm = new RoteadorLlm({ principal: principal.lado, reserva: reserva.lado, estado })
    await llm.rodar(pedido)
    expect(await llm.rodar(pedido)).toMatchObject({ ok: false, motivo: 'limite_de_taxa' })
    expect(alertas()).toContain('llm_reserva_falhou')
  })

  it('⚠️ a reserva é POR PRINCIPAL: o Groq fora do ar não desvia quem está no Claude', async () => {
    const groq = fornecedor('groq', 'llama', ['indisponivel'])
    const claude = fornecedor('claude', 'opus', ['ok'])
    const reserva = fornecedor('openrouter', 'x/y', ['ok'])
    const noGroq = new RoteadorLlm({ principal: groq.lado, reserva: reserva.lado, estado })
    const noClaude = new RoteadorLlm({ principal: claude.lado, reserva: reserva.lado, estado })
    await noGroq.rodar(pedido); await noGroq.rodar(pedido)
    expect((await noClaude.rodar(pedido)).rastro?.provedor).toBe('claude')
    const r = estado.retrato()
    expect(r.situacao).toBe('reserva')
    expect(r.principais.find((p) => p.principal === 'groq:llama')).toMatchObject({ situacao: 'reserva', ativacoes: 1 })
    expect(r.principais.find((p) => p.principal === 'claude:opus')).toMatchObject({ situacao: 'principal' })
  })
})

describe('Fallback de modelo no 403/404', () => {
  it('dado acesso negado ao modelo do catálogo, então refaz no IA_MODELO, bloqueia o modelo por 1 h e loga modelo_bloqueado', async () => {
    const escolhido = fornecedor('groq', 'llama-4-preview', ['acesso_negado'])
    const padrao = fornecedor('claude', 'opus', ['ok'])
    const llm = new RoteadorLlm({ principal: escolhido.lado, padrao: padrao.lado, estado })

    const r = await llm.rodar(pedido)
    expect(r.ok).toBe(true)
    expect(r.rastro?.provedor).toBe('claude')
    expect(alertas()).toEqual(['modelo_bloqueado'])
    expect(estado.retrato().modelosBloqueados).toEqual([{ modelo: 'groq:llama-4-preview', ateEm: new Date(agora + 60 * MIN) }])

    // Durante a hora, nem tenta o bloqueado.
    await llm.rodar(pedido)
    expect(escolhido.chamadas).toBe(1)
    expect(padrao.chamadas).toBe(2)
    // Depois da hora, tenta de novo (e se ainda negar, bloqueia de novo).
    agora += 61 * MIN
    await llm.rodar(pedido)
    expect(escolhido.chamadas).toBe(2)
    expect(estado.retrato().falhasSeguidas).toBe(0)
  })

  it('⚠️ acesso negado NÃO marca a credencial como inválida: o sucesso no padrão não conta falha de provedor', async () => {
    const escolhido = fornecedor('groq', 'preview', ['acesso_negado'])
    const padrao = fornecedor('claude', 'opus', ['ok'])
    const reserva = fornecedor('openrouter', 'x/y', ['ok'])
    const llm = new RoteadorLlm({ principal: escolhido.lado, padrao: padrao.lado, reserva: reserva.lado, estado })
    for (let i = 0; i < 3; i++) await llm.rodar(pedido)
    expect(reserva.chamadas).toBe(0)
  })

  it('sem padrão diferente (o próprio IA_MODELO negado), a falha segue como fatal de provedor', async () => {
    const principal = fornecedor('claude', 'opus', ['acesso_negado'])
    const llm = new RoteadorLlm({ principal: principal.lado, padrao: principal.lado, estado })
    expect(await llm.rodar(pedido)).toMatchObject({ ok: false, motivo: 'acesso_negado' })
    expect(estado.retrato()).toMatchObject({ falhasSeguidas: 1, modelosBloqueados: [] })
  })
})

describe('Fábrica: IA_RESERVA_* no ambiente', () => {
  it('sem IA_RESERVA_PROVEDOR, não há reserva e nada falta', () => {
    expect(reservaDoAmbiente({ ANTHROPIC_API_KEY: 'k' })).toBeNull()
    expect(faltaParaReserva({})).toEqual([])
  })
  it('nomeia o que falta: chave do fornecedor, modelo no openrouter, provedor inválido', () => {
    expect(faltaParaReserva({ IA_RESERVA_PROVEDOR: 'groq' })).toEqual(['GROQ_API_KEY'])
    expect(faltaParaReserva({ IA_RESERVA_PROVEDOR: 'openrouter', OPENROUTER_API_KEY: 'k' })).toEqual(['IA_RESERVA_MODELO'])
    expect(faltaParaReserva({ IA_RESERVA_PROVEDOR: 'bedrock' })[0]).toMatch(/inválido/)
  })
  it('pronta: usa o modelo padrão do fornecedor quando IA_RESERVA_MODELO falta', () => {
    const r = reservaDoAmbiente({ IA_RESERVA_PROVEDOR: 'groq', GROQ_API_KEY: 'k' })
    expect(r).toMatchObject({ modelo: 'llama-3.3-70b-versatile' })
    expect(r?.porta.nome).toBe('groq')
  })
  it('janela: 30 min por padrão; aceita 1–1440', () => {
    expect(janelaDaReservaMs({})).toBe(30 * MIN)
    expect(janelaDaReservaMs({ IA_RESERVA_JANELA_MIN: '5' })).toBe(5 * MIN)
    expect(janelaDaReservaMs({ IA_RESERVA_JANELA_MIN: '0' })).toBe(30 * MIN)
    expect(janelaDaReservaMs({ IA_RESERVA_JANELA_MIN: 'abc' })).toBe(30 * MIN)
  })
  it('modelos reais saem no roteador com o nome do principal; o simulado não', () => {
    const doAmbiente = llmFerramentasDoAmbiente({ ANTHROPIC_API_KEY: 'k', IA_RESERVA_PROVEDOR: 'groq', GROQ_API_KEY: 'g' })
    expect(doAmbiente).toBeInstanceOf(RoteadorLlm)
    expect(doAmbiente.nome).toBe('claude')
    expect((doAmbiente as RoteadorLlm).reservaConfigurada).toBe(true)
    expect(criarLlmDoCatalogo({ provedor: 'groq', modelo: 'llama' }, { GROQ_API_KEY: 'g' })).toBeInstanceOf(RoteadorLlm)
    expect(llmFerramentasDoAmbiente({ IA_PROVEDOR: 'simulado' })).not.toBeInstanceOf(RoteadorLlm)
  })
})
