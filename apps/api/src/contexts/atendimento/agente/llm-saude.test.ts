import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import type { SaudeDetalhada } from '@geracrm/shared'
import { rotasSaudeDetalhada } from '../../plataforma/rotas-saude-detalhada.js'
import type { DepsSaude } from '../../plataforma/saude-detalhada.js'
import { RoteadorLlm, type LadoLlm } from './llm-reserva.js'
import { EstadoLlmProcesso } from './llm-estado.js'
import type { MotivoFalhaLlm } from './porta.js'
import type { PedidoDeLaco, ResultadoLaco } from './porta-llm.js'

/**
 * P5 × P8: o estado REAL do provedor (roteador + estado do processo, relógio
 * falso, fornecedores falsos) lido pela saúde detalhada de verdade. Reserva
 * ativa e modelo bloqueado deixam a saúde em `degradado` (200); vencida a
 * janela, volta a `ok`. Nenhuma rede.
 */
const pedido: PedidoDeLaco = {
  sistema: [{ texto: 's' }], mensagens: [{ papel: 'cliente', texto: 'oi' }], ferramentas: [],
  executar: async () => ({ ok: true, saida: null }), esquemaSaida: {},
  limites: { maxRodadas: 1, maxTokensSaida: 10, prazoMs: 1_000 },
}
function lado(nome: string, modelo: string, passo: MotivoFalhaLlm | 'ok'): LadoLlm {
  return {
    modelo,
    porta: {
      nome, capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar(): Promise<ResultadoLaco> {
        const rastro = { chamadas: [], rodadas: 1, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, modelo, latenciaMs: 1, parouPor: 'fim' as const }
        return passo === 'ok' ? { ok: true, saida: {}, rastro } : { ok: false, motivo: passo, rastro }
      },
    },
  }
}

const EM_DIA: Omit<DepsSaude, 'estadoDoLlm' | 'agora'> = {
  encerrando: () => false,
  uptimeSeg: () => 3_600,
  pingBanco: async () => 4,
  lerFilas: async () => ({
    agente: { vencidas: 0, maisAntigaHaSeg: null, executando: 0, executandoMaisAntigaHaSeg: null },
    retornos: { vencidos: 0, maisAntigoHaSeg: null },
  }),
  lerTranscricao: async () => ({ pendentes: 0, maisAntigaHaSeg: null }),
  lerEmbeddings: async () => ({ semantica: 'ligada', pendentes: 0 }),
  idadeBatimento: () => 1,
  configuracao: { workers: true, transcricao: true, embeddingModelo: 'bge-m3' },
}

async function saude(estado: EstadoLlmProcesso, agora: number): Promise<SaudeDetalhada> {
  const app = Fastify()
  await app.register(rotasSaudeDetalhada, { ...EM_DIA, agora: () => new Date(agora), estadoDoLlm: () => estado.retrato() })
  await app.ready()
  try {
    const r = await app.inject({ method: 'GET', url: '/saude/detalhada' })
    expect(r.statusCode).toBe(200)
    return r.json() as SaudeDetalhada
  } finally { await app.close() }
}

describe('Saúde detalhada lendo o estado real do provedor de IA', () => {
  it('dado o principal caindo 2× com reserva, então degradado com llm_reserva_ativo; vencida a janela, volta a ok', async () => {
    let agora = Date.parse('2026-10-17T12:00:00Z')
    const estado = new EstadoLlmProcesso({ agora: () => agora, log: () => {} })
    const llm = new RoteadorLlm({ principal: lado('claude', 'opus', 'indisponivel'), reserva: lado('groq', 'llama', 'ok'), janelaMs: 30 * 60_000, estado })

    expect((await saude(estado, agora)).status).toBe('ok')
    await llm.rodar(pedido); await llm.rodar(pedido)

    const s = await saude(estado, agora)
    expect(s.status).toBe('degradado')
    expect(s.motivos).toContain('llm_reserva_ativo')
    expect(s.componentes.llm).toMatchObject({ situacao: 'reserva', reservaRestanteSeg: 1_800, falhasSeguidas: 2 })

    agora += 31 * 60_000
    const depois = await saude(estado, agora)
    expect(depois.status).toBe('ok')
    expect(depois.componentes.llm).toMatchObject({ situacao: 'principal', reservaRestanteSeg: null })
  })

  it('dado 403 num modelo do catálogo, então degradado com modelo_bloqueado (só a contagem, sem o nome)', async () => {
    const agora = Date.parse('2026-10-17T12:00:00Z')
    const estado = new EstadoLlmProcesso({ agora: () => agora, log: () => {} })
    const llm = new RoteadorLlm({ principal: lado('groq', 'modelo-sigiloso-p5', 'acesso_negado'), padrao: lado('claude', 'opus', 'ok'), estado })
    expect((await llm.rodar(pedido)).ok).toBe(true)

    const s = await saude(estado, agora)
    expect(s.status).toBe('degradado')
    expect(s.motivos).toContain('modelo_bloqueado')
    expect(s.componentes.llm).toMatchObject({ situacao: 'principal', modelosBloqueados: 1 })
    expect(JSON.stringify(s)).not.toContain('modelo-sigiloso-p5')
  })
})
