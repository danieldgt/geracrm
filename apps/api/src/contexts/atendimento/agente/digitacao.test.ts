import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../db/index.js'
import { cifrar } from '../../integracao/cofre.js'
import { CanalMetaOficial } from '../canais/meta-oficial.js'
import type { PortaCanal } from '../canais/porta.js'
import { indicarDigitacaoDaTarefa } from './digitacao.js'

/**
 * "Digitando…" antes do turno (R5): só com capacidade declarada E modo
 * autônomo; usa o id externo da última mensagem do cliente; nunca lança.
 */
const T = 'd5e50000-0000-4000-8000-000000000001'
const PV = 'd5e50000-1111-4000-8000-000000000001'
const PLANO = 'd5e50000-3333-4000-8000-000000000001'
const MODELO = 'd5e50000-4444-4000-8000-000000000001'
const CANAL = 'd5e50000-5555-4000-8000-000000000001'
const CONTATO = 'd5e50000-6666-4000-8000-000000000001'
const CONVERSA = 'd5e50000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let chamadas: [string, string | undefined][] = []

const canalFalso = (indica: boolean, lanca = false): PortaCanal => {
  const real = new CanalMetaOficial({ phoneNumberId: 'P', token: 't' })
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    capacidades: { ...real.capacidades, indicaDigitacao: indica },
    async indicarDigitacao(para: string, id?: string) { if (lanca) throw new Error('rede'); chamadas.push([para, id]) },
  }) as PortaCanal
}
const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`
const tarefa = { tenant_id: T, conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [] as string[] }

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-digitacao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-digitacao', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Digitação', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${cifrar({ phoneNumberId: 'PHONE-DIG', token: 'tok' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990077', '5585999990077', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  chamadas = []
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, id_externo, criado_em)
             VALUES (${T}, ${randomUUID()}, ${CONVERSA}, 'entrante', 'texto', '{"texto":"oi"}'::jsonb, 'wamid.ANTIGA', now() - interval '1 minute'),
                    (${T}, ${randomUUID()}, ${CONVERSA}, 'entrante', 'texto', '{"texto":"tem camiseta?"}'::jsonb, 'wamid.ULTIMA', now())`
  await configurar('autonomo')
})
afterAll(async () => {
  for (const t of ['agente_config', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('indicarDigitacaoDaTarefa', () => {
  it('autônomo + canal com capacidade → indica para o telefone do cliente com o id da ÚLTIMA mensagem dele', async () => {
    expect(await indicarDigitacaoDaTarefa(tarefa, { criar: () => canalFalso(true) })).toBe('indicou')
    expect(chamadas).toEqual([['5585999990077', 'wamid.ULTIMA']])
  })

  it('canal sem a capacidade → degrada em silêncio', async () => {
    expect(await indicarDigitacaoDaTarefa(tarefa, { criar: () => canalFalso(false) })).toBe('sem_capacidade')
    expect(chamadas).toEqual([])
  })

  it('modo sombra/assistido → não indica (quem responde é gente)', async () => {
    await configurar('assistido')
    expect(await indicarDigitacaoDaTarefa(tarefa, { criar: () => canalFalso(true) })).toBe('modo')
    expect(chamadas).toEqual([])
  })

  it('adaptador que lança não derruba nada', async () => {
    expect(await indicarDigitacaoDaTarefa(tarefa, { criar: () => canalFalso(true, true) })).toBe('falhou')
  })

  it('conversa inexistente → sem_dados', async () => {
    expect(await indicarDigitacaoDaTarefa({ ...tarefa, conversa_id: randomUUID() }, { criar: () => canalFalso(true) })).toBe('sem_dados')
  })
})
