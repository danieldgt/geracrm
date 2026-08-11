import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { ehAfirmativo, confirmarPedidoPorResposta } from './confirmacao-pedido.js'
import type { Sql } from '../../db/index.js'

describe('ehAfirmativo', () => {
  it('aceita SIM claro e curto', () => {
    for (const t of ['sim', 'SIM', 'Sim!', 'ok', 'confirmo', 'pode confirmar', 'isso mesmo', '👍', 'ok pode mandar', 'beleza']) {
      expect(ehAfirmativo(t), t).toBe(true)
    }
  })
  it('⚠️ recusa resposta ambígua/negativa/longa', () => {
    for (const t of ['não', 'nao', 'quanto custa?', 'sim, mas troca a cor azul pela preta', 'depois eu confirmo', '', 'quero mudar']) {
      expect(ehAfirmativo(t), t).toBe(false)
    }
  })
})

/** confirmarPedidoPorResposta — confirma o pedido pendente da conversa. */
const T = 'c0f10000-0000-4000-8000-000000000001'
const PV = 'c0f10000-1111-4000-8000-000000000001'
const PLANO = 'c0f10000-3333-4000-8000-000000000001'
const MODELO = 'c0f10000-4444-4000-8000-000000000001'
const C1 = 'c0f10000-6666-4000-8000-000000000001'
const CANAL = 'c0f10000-7777-4000-8000-000000000001'
const CONV = 'c0f10000-8888-4000-8000-000000000001'
const PED = 'c0f10000-9999-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const comoT = <X>(fn: (tx: Sql) => Promise<X>): Promise<X> =>
  dono.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<X>

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-cf2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-cf2', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja CF', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente CF', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${CONV}, ${CANAL}, ${C1}) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T} AND tipo = 'pedido.confirmado'`
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado) VALUES (${T}, ${PED}, ${C1}, ${CONV}, 'aguardando_confirmacao')`
})

afterAll(async () => {
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('confirmarPedidoPorResposta', () => {
  it('⚠️ SIM confirma o pedido pendente e emite o evento', async () => {
    const id = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'Sim, pode confirmar', new Date()))
    expect(id).toBe(PED)
    const [p] = await dono<{ estado: string; confirmado_em: Date | null }[]>`SELECT estado, confirmado_em FROM pedido WHERE id = ${PED}`
    expect(p!.estado).toBe('confirmado')
    expect(p!.confirmado_em).not.toBeNull()
    const [ev] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND tipo = 'pedido.confirmado'`
    expect(ev!.n).toBe(1)
  })

  it('resposta ambígua NÃO confirma', async () => {
    const id = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim, mas troca a cor', new Date()))
    expect(id).toBeNull()
    const [p] = await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE id = ${PED}`
    expect(p!.estado).toBe('aguardando_confirmacao')
  })

  it('idempotente: segundo SIM não reconfirma', async () => {
    await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', new Date()))
    const id2 = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', new Date()))
    expect(id2).toBeNull() // já não está mais aguardando
  })

  it('sem pedido pendente na conversa → null', async () => {
    await dono`UPDATE pedido SET estado = 'rascunho' WHERE id = ${PED}`
    const id = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', new Date()))
    expect(id).toBeNull()
  })
})
