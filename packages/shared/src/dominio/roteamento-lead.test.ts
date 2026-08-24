import { describe, it, expect } from 'vitest'
import {
  rotearLead, EXPLICACAO, type ContextoRoteamento, type PoliticaAgente, type ModoEntrada,
} from './roteamento-lead.js'

/** Contexto neutro: nada verdadeiro, nada que autorize o agente. */
const base: ContextoRoteamento = {
  politicaAgente: 'autonomo',
  modoEntrada: null,
  clienteAltoValor: false,
  donoCarteiraId: null,
  foraDoEscopo: false,
  veioDeAnuncio: false,
  foraDoExpediente: false,
}
const com = (p: Partial<ContextoRoteamento>): ContextoRoteamento => ({ ...base, ...p })

describe('A ordem das regras', () => {
  it('1 — o kill switch precede tudo', () => {
    const d = rotearLead(com({ politicaAgente: 'desligado', veioDeAnuncio: true, modoEntrada: 'inbound_wa' }))
    expect(d).toMatchObject({ destino: 'fila_humana', motivo: 'agente_desligado', regra: 1 })
  })

  it('2 — campanha outbound manda para humano mesmo sendo lead de anúncio', () => {
    const d = rotearLead(com({ veioDeAnuncio: true, modoEntrada: 'outbound_formulario' }))
    expect(d).toMatchObject({ destino: 'fila_humana', motivo: 'campanha_outbound', regra: 2 })
  })

  // ⚠️ A regra que existe para proteger relação, não para automatizar.
  it('3 — cliente de alto valor nunca é triado por robô, mesmo vindo de anúncio', () => {
    const d = rotearLead(com({ clienteAltoValor: true, veioDeAnuncio: true, modoEntrada: 'inbound_wa' }))
    expect(d).toMatchObject({ destino: 'fila_humana', motivo: 'cliente_alto_valor', regra: 3 })
  })

  it('3 — e é atribuído ao dono da carteira quando há um', () => {
    const d = rotearLead(com({ clienteAltoValor: true, donoCarteiraId: 'vendedora-1' }))
    expect(d.atribuirA).toBe('vendedora-1')
    expect(d.copiloto).toBe(true)
  })

  it('4 — quem já tem dono de carteira vai para o dono', () => {
    const d = rotearLead(com({ donoCarteiraId: 'vendedora-2', veioDeAnuncio: true, modoEntrada: 'inbound_wa' }))
    expect(d).toMatchObject({ motivo: 'tem_dono_de_carteira', regra: 4, atribuirA: 'vendedora-2' })
  })

  it('5 — assunto fora do escopo vai para humano', () => {
    const d = rotearLead(com({ foraDoEscopo: true, veioDeAnuncio: true }))
    expect(d).toMatchObject({ motivo: 'fora_do_escopo', regra: 5 })
  })

  it('6 — política copiloto: a pessoa envia, com sugestão de IA', () => {
    const d = rotearLead(com({ politicaAgente: 'copiloto', veioDeAnuncio: true, modoEntrada: 'inbound_wa' }))
    expect(d).toMatchObject({ destino: 'fila_humana', motivo: 'politica_copiloto', regra: 6, copiloto: true })
  })

  it('7 — o caso central: lead de anúncio em conversa inbound vai para o agente', () => {
    const d = rotearLead(com({ veioDeAnuncio: true, modoEntrada: 'inbound_wa' }))
    expect(d).toMatchObject({ destino: 'agente', motivo: 'lead_de_anuncio', regra: 7 })
  })

  it('8 — fora do expediente o agente atende', () => {
    const d = rotearLead(com({ foraDoExpediente: true }))
    expect(d).toMatchObject({ destino: 'agente', motivo: 'fora_do_expediente', regra: 8 })
  })

  it('9 — sem nada que autorize, o padrão é humano', () => {
    const d = rotearLead(base)
    expect(d).toMatchObject({ destino: 'fila_humana', motivo: 'padrao_humano', regra: 9 })
  })
})

/**
 * ⚠️ As propriedades abaixo valem para TODA combinação de entradas, não só para
 * os casos que alguém lembrou de escrever. É o que separa "testei os caminhos que
 * imaginei" de "provei que a propriedade se sustenta".
 */
const TODAS_AS_COMBINACOES: ContextoRoteamento[] = []
for (const politicaAgente of ['autonomo', 'copiloto', 'desligado'] as PoliticaAgente[]) {
  for (const modoEntrada of [null, 'inbound_wa', 'outbound_formulario'] as (ModoEntrada | null)[]) {
    for (const clienteAltoValor of [false, true]) {
      for (const donoCarteiraId of [null, 'dono-x']) {
        for (const foraDoEscopo of [false, true]) {
          for (const veioDeAnuncio of [false, true]) {
            for (const foraDoExpediente of [false, true]) {
              TODAS_AS_COMBINACOES.push({
                politicaAgente, modoEntrada, clienteAltoValor,
                donoCarteiraId, foraDoEscopo, veioDeAnuncio, foraDoExpediente,
              })
            }
          }
        }
      }
    }
  }
}

describe(`Propriedades sobre as ${TODAS_AS_COMBINACOES.length} combinações possíveis`, () => {
  it('a função é total — toda entrada produz decisão', () => {
    for (const ctx of TODAS_AS_COMBINACOES) {
      const d = rotearLead(ctx)
      expect(['agente', 'fila_humana']).toContain(d.destino)
      expect(d.regra).toBeGreaterThanOrEqual(1)
    }
  })

  // ⚠️ A propriedade que sustenta o kill switch: NENHUMA combinação de entradas
  //    consegue mandar para o agente com a política desligada.
  it('com o agente desligado, NADA chega ao agente', () => {
    const escaparam = TODAS_AS_COMBINACOES
      .filter((c) => c.politicaAgente === 'desligado')
      .filter((c) => rotearLead(c).destino === 'agente')
    expect(escaparam).toEqual([])
  })

  it('em campanha outbound, NADA chega ao agente', () => {
    const escaparam = TODAS_AS_COMBINACOES
      .filter((c) => c.modoEntrada === 'outbound_formulario')
      .filter((c) => rotearLead(c).destino === 'agente')
    expect(escaparam).toEqual([])
  })

  it('cliente de alto valor NUNCA cai no agente', () => {
    const escaparam = TODAS_AS_COMBINACOES
      .filter((c) => c.clienteAltoValor)
      .filter((c) => rotearLead(c).destino === 'agente')
    expect(escaparam).toEqual([])
  })

  it('na política copiloto, NADA chega ao agente', () => {
    const escaparam = TODAS_AS_COMBINACOES
      .filter((c) => c.politicaAgente === 'copiloto')
      .filter((c) => rotearLead(c).destino === 'agente')
    expect(escaparam).toEqual([])
  })

  it('quem tem dono de carteira NUNCA cai no agente', () => {
    const escaparam = TODAS_AS_COMBINACOES
      .filter((c) => c.donoCarteiraId !== null)
      .filter((c) => rotearLead(c).destino === 'agente')
    expect(escaparam).toEqual([])
  })

  // ⚠️ O padrão é humano: o agente é minoria, e só por regra explícita.
  it('a maioria das combinações termina em fila humana', () => {
    const noAgente = TODAS_AS_COMBINACOES.filter((c) => rotearLead(c).destino === 'agente').length
    expect(noAgente).toBeLessThan(TODAS_AS_COMBINACOES.length / 2)
  })

  it('toda decisão tem explicação para a tela mostrar', () => {
    for (const ctx of TODAS_AS_COMBINACOES) {
      expect(EXPLICACAO[rotearLead(ctx).motivo]).toBeTruthy()
    }
  })
})
