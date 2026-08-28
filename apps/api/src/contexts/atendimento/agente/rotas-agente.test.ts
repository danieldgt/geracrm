import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { REGRAS_AGENTE_PADRAO, type RegrasDoAgente } from '@geracrm/shared'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'

/**
 * A superfície do agente. ⚠️ O que estes testes protegem é o botão de desligar e
 * a recusa de ligar sem base — as duas coisas que, se falharem, deixam um robô
 * mal configurado falando com o cliente de alguém.
 */
const T = 'a9a00000-0000-4000-8000-000000000001'
const OUTRO = 'a9a00000-0000-4000-8000-000000000002'
const PV = 'a9a00000-1111-4000-8000-000000000001'
const PV2 = 'a9a00000-1111-4000-8000-000000000002'
const PLANO = 'a9a00000-3333-4000-8000-000000000001'
const MODELO = 'a9a00000-4444-4000-8000-000000000001'
const CANAL = 'a9a00000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const POLITICAS = 'Entrega em 3 dias úteis. Pagamento por PIX ou cartão.'

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  // ⚠️ A rota recusa ligar sem a chave do modelo. Nos testes ela existe só para
  //    o caminho feliz ser alcançável — nenhuma chamada real é feita.
  process.env.ANTHROPIC_API_KEY ||= 'chave-de-teste'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-agente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-agente', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja Centro', 'conectado') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => { await dono`DELETE FROM agente_config WHERE tenant_id IN (${T}, ${OUTRO})` })

afterAll(async () => {
  await dono`DELETE FROM agente_config   WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Configuração do agente', () => {
  it('sem configuração, nasce DESLIGADO', async () => {
    const r = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as
      { ativo: boolean; regras: RegrasDoAgente }
    expect(r.ativo).toBe(false)
    // ⚠️ Canal nunca configurado devolve os PADRÕES, não zeros: a tela abre
    //    mostrando o agente que ele terá ao ser ligado.
    expect(r.regras).toEqual(REGRAS_AGENTE_PADRAO)
  })

  it('salva e relê', async () => {
    expect((await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, {
      ativo: true, politicas: POLITICAS, maxTurnos: 4,
    })).statusCode).toBe(200)
    const r = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as
      { ativo: boolean; politicas: string; regras: RegrasDoAgente }
    expect(r).toMatchObject({ ativo: true, politicas: POLITICAS })
    expect(r.regras.maxTurnos).toBe(4)
  })

  /**
   * ⚠️ AS REGRAS DE ENTRADA (0078). O que este caso protege é a ida e volta
   * inteira: tela → validação → colunas → tela. Uma regra que a tela oferece e o
   * banco não guarda é pior que não ter a opção — o dono acha que mudou algo.
   */
  it('salva e relê as regras de entrada', async () => {
    expect((await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, {
      ativo: true, politicas: POLITICAS,
      soQuandoNinguemDisponivel: false, exigirAusenciaAntes: false, reabrirAposEncerrada: true,
      horasDesdeAusencia: 24, minutosPresenca: 15, maxTurnos: 8,
      maxCaracteres: 500, falasDeContexto: 20,
    })).statusCode).toBe(200)
    const r = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { regras: RegrasDoAgente }
    expect(r.regras).toEqual({
      soQuandoNinguemDisponivel: false, exigirAusenciaAntes: false, reabrirAposEncerrada: true,
      horasDesdeAusencia: 24, minutosPresenca: 15, maxTurnos: 8,
      maxCaracteres: 500, falasDeContexto: 20,
    })
  })

  /** PUT sem as regras não pode zerar o que já estava configurado. */
  it('salvar só as políticas mantém as regras nos padrões, não em zero', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: POLITICAS })
    const r = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { regras: RegrasDoAgente }
    expect(r.regras).toEqual(REGRAS_AGENTE_PADRAO)
  })

  /** ⚠️ Compatibilidade de um deploy: o console velho ainda lê daqui. */
  it('maxTurnos continua no topo da resposta', async () => {
    await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: POLITICAS, maxTurnos: 9 })
    const r = (await chamar(T, 'GET', `/v1/canais/${CANAL}/agente`)).json() as { maxTurnos: number }
    expect(r.maxTurnos).toBe(9)
  })

  it('canal inexistente → 404', async () => {
    const r = await chamar(T, 'PUT', '/v1/canais/a9a00000-9999-4000-8000-000000000009/agente', { politicas: 'x' })
    expect(r.statusCode).toBe(404)
  })
})

describe('⚠️ Não liga sem base de políticas', () => {
  /**
   * Agente ligado sem base responde "não sei" a tudo: gasta a paciência do
   * cliente e o dinheiro do dono para não informar nada. A recusa é uma FRASE
   * com ação corretiva, não um erro de banco vazando para a tela.
   */
  it('ligar sem políticas devolve 422 com o que fazer', async () => {
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { ativo: true, politicas: '  ' })
    expect(r.statusCode).toBe(422)
    const corpo = r.json() as { erro: string; mensagem: string }
    expect(corpo.erro).toBe('agente.sem_politicas')
    expect(corpo.mensagem).toContain('Escreva as políticas')
  })

  it('salvar políticas DESLIGADO é permitido — é o rascunho de quem vai configurar', async () => {
    expect((await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, {
      ativo: false, politicas: '',
    })).statusCode).toBe(200)
  })

  it('teto de turnos fora da faixa é recusado com motivo', async () => {
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: POLITICAS, maxTurnos: 99 })
    expect(r.statusCode).toBe(422)
    const corpo = r.json() as { erro: string; mensagem: string; campos: string[] }
    expect(corpo.erro).toBe('agente.regra_invalida')
    // ⚠️ A tela precisa saber QUAL campo, não só que algo deu errado.
    expect(corpo.campos).toContain('maxTurnos')
    expect(corpo.mensagem).toContain('20')
  })

  it('regra numérica fora da faixa é recusada antes de chegar ao CHECK do banco', async () => {
    const r = await chamar(T, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: POLITICAS, minutosPresenca: 9999 })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { campos: string[] }).campos).toContain('minutosPresenca')
  })
})

describe('⚠️ Isolamento entre tenants (RLS)', () => {
  it('um tenant não configura o canal do outro', async () => {
    const r = await chamar(OUTRO, 'PUT', `/v1/canais/${CANAL}/agente`, { politicas: POLITICAS })
    expect(r.statusCode).toBe(404)
  })

  it('e não enxerga as sessões dele', async () => {
    const r = (await chamar(OUTRO, 'GET', '/v1/agente/sessoes')).json() as { itens: unknown[] }
    expect(r.itens).toEqual([])
  })
})

describe('Auditoria', () => {
  it('a lista responde paginada por cursor', async () => {
    const r = (await chamar(T, 'GET', '/v1/agente/sessoes')).json() as { itens: unknown[]; proximoCursor: string | null }
    expect(Array.isArray(r.itens)).toBe(true)
    expect(r).toHaveProperty('proximoCursor')
  })

  it('cursor corrompido é recusado, não ignorado', async () => {
    expect((await chamar(T, 'GET', '/v1/agente/sessoes?cursor=lixo')).statusCode).toBe(422)
  })
})
