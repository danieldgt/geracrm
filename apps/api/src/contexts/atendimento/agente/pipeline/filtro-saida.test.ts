import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { filtrarSaida } from '@geracrm/shared'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { etapaFiltroSaida, MENSAGEM_FILTRO_ESVAZIOU } from './filtro-saida.js'
import type { ContextoPipeline } from './tipos.js'

/**
 * FILTRO DE SAÍDA (raia P2) — a etapa de verdade dentro do turno de verdade
 * (banco real, WhatsApp falso), nos quatro modos; as extras do número valem
 * no turno seguinte; e o teste que impede o filtro de virar censura: as
 * respostas aprovadas saem INALTERADAS.
 */
const T = 'f1a00000-0000-4000-8000-000000000001'
const PV = 'f1a00000-1111-4000-8000-000000000001'
const PLANO = 'f1a00000-3333-4000-8000-000000000001'
const MODELO = 'f1a00000-4444-4000-8000-000000000001'
const CANAL = 'f1a00000-5555-4000-8000-000000000001'
const CONTATO = 'f1a00000-6666-4000-8000-000000000001'
const CONVERSA = 'f1a00000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

function llmQueDiz(mensagens: string[], handoff?: { motivo: 'pedido_de_humano'; resumo: string }): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: true, saida: { mensagens, confianca: 0.9, ...(handoff ? { handoff } : {}) }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja Filtro"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const tarefa = async (texto: string): Promise<Tarefa> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() }
}
const turno = async (diz: string[], extra: Partial<DepsTurno> = {}) =>
  conduzirTurnoVendedor(await tarefa('oi'), { llm: llmQueDiz(diz), ligacoes, enviar: enviarFalso, ...extra })
const ultimaDecisao = async () => (await dono<{
  modo: string; desfecho: string; handoff_motivo: string | null
  guardrails: { etapa: string; codigo: string; gravidade: string; acao: string; trecho?: string }[]
  resposta: { mensagens: string[]; original?: { mensagens: string[] } } | null
}[]>`
  SELECT modo, desfecho, handoff_motivo, guardrails, resposta FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-filtro-saida', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-filtro-saida', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Filtro', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Filtro', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990888', '5585999990888', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
  await dono`UPDATE agente_config SET compliance = DEFAULT WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

const PROMESSA = 'Temos o item. Garantimos entrega amanhã. Quantas caixas?'
const FILTRADA = 'Temos o item. Quantas caixas?'

describe('Filtro de saída no turno — vale em todo modo', () => {
  it('autônomo: a promessa NÃO sai; a marca CRÍTICA fica na decisão; o original fica na auditoria', async () => {
    await configurar('autonomo')
    expect((await turno([PROMESSA])).desfecho).toBe('respondeu')
    expect(enviados).toEqual([FILTRADA])
    const d = await ultimaDecisao()
    expect(d.resposta?.mensagens).toEqual([FILTRADA])
    expect(d.resposta?.original?.mensagens).toEqual([PROMESSA])
    expect(d.guardrails).toEqual([{ etapa: 'filtro-saida', codigo: 'garantia_sem_fonte', gravidade: 'CRITICA', acao: 'removido', trecho: 'Garantimos entrega amanhã.' }])
  })

  it('a negação passa intacta: "não garantimos entrega amanhã"', async () => {
    await configurar('autonomo')
    const honesta = 'Não garantimos entrega amanhã, mas o pedido sai hoje. Quer fechar?'
    await turno([honesta])
    expect(enviados).toEqual([honesta])
    expect((await ultimaDecisao()).guardrails).toEqual([])
  })

  it.each(['sombra', 'assistido'])('%s: a decisão (e a sugestão) sai filtrada e marcada, sem envio', async (modo) => {
    await configurar(modo)
    await turno([PROMESSA])
    expect(enviados).toEqual([])
    const d = await ultimaDecisao()
    expect(d.modo).toBe(modo)
    expect(d.resposta?.mensagens).toEqual([FILTRADA])
    expect(d.guardrails.map((g) => `${g.codigo}/${g.gravidade}`)).toEqual(['garantia_sem_fonte/CRITICA'])
  })

  it('simulação (playground): mesma filtragem', async () => {
    await configurar('sombra')
    await turno([PROMESSA], { simulacao: true })
    const d = await ultimaDecisao()
    expect(d.modo).toBe('simulacao')
    expect(d.resposta?.mensagens).toEqual([FILTRADA])
    expect(d.guardrails.map((g) => g.codigo)).toEqual(['garantia_sem_fonte'])
  })

  it('resposta inteira proibida: bloqueia, transfere e manda a mensagem fixa sem prazo', async () => {
    await configurar('autonomo')
    const r = await turno(['Garantimos entrega amanhã!', 'Temos o melhor preço do mercado!'])
    expect(r).toMatchObject({ desfecho: 'handoff', handoff: { motivo: 'incerteza' } })
    expect(enviados).toEqual([MENSAGEM_FILTRO_ESVAZIOU])
    expect((await ultimaDecisao()).guardrails.map((g) => g.codigo)).toEqual(['garantia_sem_fonte', 'melhor_preco_do_mercado', 'resposta_esvaziada'])
  })

  it('handoff do modelo: promessa de prazo sai e o cliente sabe quem retoma', async () => {
    await configurar('autonomo')
    await conduzirTurnoVendedor(await tarefa('quero falar com alguém'), {
      llm: llmQueDiz(['Certo! Te respondem em 5 minutos.'], { motivo: 'pedido_de_humano', resumo: 'Pediu humano.' }), ligacoes, enviar: enviarFalso,
    })
    expect(enviados.join(' ')).not.toMatch(/5 minutos/)
    expect(enviados.join(' ')).toMatch(/vendedor da equipe/)
    expect((await ultimaDecisao()).guardrails.map((g) => g.codigo)).toEqual(['promessa_prazo_handoff', 'retomada_handoff'])
  })
})

describe('Extras do número (agente_config.compliance) — só acrescentam', () => {
  it('a extra gravada vale no turno seguinte; a base continua valendo', async () => {
    await configurar('autonomo')
    const consig = 'Trabalhamos com consignação sim. Quantas caixas?'
    await turno([consig])
    expect(enviados).toEqual([consig])

    await dono`UPDATE agente_config SET compliance = ${JSON.stringify({ frasesProibidas: ['consignação'], gatilhosHandoff: [] })}::text::jsonb WHERE tenant_id = ${T}`
    enviados.length = 0
    await turno([consig])
    expect(enviados).toEqual(['Quantas caixas?'])
    expect((await ultimaDecisao()).guardrails).toEqual([expect.objectContaining({ codigo: 'extra:consignacao', gravidade: 'CRITICA', acao: 'removido' })])

    enviados.length = 0
    await turno([PROMESSA])
    expect(enviados).toEqual([FILTRADA])
  })

  it('compliance corrompido no banco não derruba o turno e não desliga a base', async () => {
    await configurar('autonomo')
    await dono`UPDATE agente_config SET compliance = '{"frasesProibidas": "isto não é lista", "gatilhosHandoff": [1,2]}'::jsonb WHERE tenant_id = ${T}`
    await turno([PROMESSA])
    expect(enviados).toEqual([FILTRADA])
  })
})

describe('Respostas aprovadas B2B — o filtro não vira censura', () => {
  const aprovadas = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../evals/respostas-aprovadas-b2b.json'), 'utf8')) as Array<{ id: string; resposta: string }>

  it('o banco tem ao menos 30 respostas', () => {
    expect(aprovadas.length).toBeGreaterThanOrEqual(30)
  })

  it.each(aprovadas.map((a) => [a.id, a.resposta] as const))('%s sai inalterada', (_id, resposta) => {
    expect(filtrarSaida(resposta)).toEqual({ texto: resposta, alterado: false, ocorrencias: [], esvaziado: false })
  })

  it('pela etapa, sem handoff, também não ganham marca nenhuma', async () => {
    const ctx = { cfgExtra: {} } as unknown as ContextoPipeline
    const r = await etapaFiltroSaida.executar(ctx, {
      mensagens: aprovadas.map((a) => a.resposta), handoff: null, centavosVistos: new Set(), numerosVistos: new Set(), falasAnterioresDoAgente: [],
    })
    expect(r.guardrails).toEqual([])
    expect(r.mensagens).toEqual(aprovadas.map((a) => a.resposta))
  })
})
