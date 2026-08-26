import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'

/**
 * ⚠️ Os invariantes do agente que moram no BANCO (0071).
 *
 * Um CHECK que ninguém exercita é um CHECK que alguém remove numa migration
 * futura "porque estava atrapalhando". Estes três protegem coisas que, se
 * quebrarem, aparecem para o cliente final do nosso cliente.
 */
const T = 'a9e70000-0000-4000-8000-000000000001'
const PV = 'a9e70000-1111-4000-8000-000000000001'
const PLANO = 'a9e70000-3333-4000-8000-000000000001'
const MODELO = 'a9e70000-4444-4000-8000-000000000001'
const CANAL = 'a9e70000-5555-4000-8000-000000000001'
const CONTATO = 'a9e70000-6666-4000-8000-000000000001'
const CONVERSA = 'a9e70000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-agente-sdr', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-agente-sdr', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Agente', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
             VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
             VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_config WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM agente_sessao    WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_config    WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa         WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato          WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado  WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical  WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant           WHERE id = ${T}`
  await dono`DELETE FROM plano            WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const sessao = (estado: string, motivo: string | null, encerrada: boolean) => dono`
  INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, estado, motivo_saida, encerrada_em)
  VALUES (${T}, ${randomUUID()}, ${CONVERSA}, ${CANAL}, ${estado}, ${motivo},
          ${encerrada ? new Date() : null})`

describe('⚠️ Agente ligado exige base de políticas', () => {
  /**
   * Agente ligado com a base vazia responde "não sei" a tudo — gasta a paciência
   * do cliente e o dinheiro do dono para não informar nada. É pior que não ter
   * agente, e é o tipo de erro que só aparece com o cliente do cliente.
   */
  it('ativar sem políticas é recusado pelo banco', async () => {
    await expect(dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo) VALUES (${T}, ${CANAL}, true)`,
    ).rejects.toThrow(/agente_ativo_exige_politicas/)
  })

  it('políticas em branco também não valem', async () => {
    await expect(dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo, politicas)
      VALUES (${T}, ${CANAL}, true, '   ')`,
    ).rejects.toThrow(/agente_ativo_exige_politicas/)
  })

  it('desligado pode ficar sem políticas — é o estado de quem ainda vai configurar', async () => {
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo) VALUES (${T}, ${CANAL}, false)`
    const [c] = await dono<{ ativo: boolean }[]>`SELECT ativo FROM agente_config WHERE tenant_id = ${T}`
    expect(c!.ativo).toBe(false)
  })
})

describe('⚠️ Uma sessão ativa por conversa', () => {
  /** Duas seriam dois agentes falando no mesmo lugar — o produto discutindo consigo mesmo. */
  it('a segunda sessão ativa na mesma conversa é recusada', async () => {
    await sessao('ativa', null, false)
    await expect(sessao('ativa', null, false)).rejects.toThrow(/agente_sessao_uma_ativa/)
  })

  it('depois de encerrar, uma nova pode começar', async () => {
    await sessao('entregue', 'qualificou', true)
    await expect(sessao('ativa', null, false)).resolves.toBeDefined()
  })
})

describe('⚠️ Sair exige dizer por quê', () => {
  /** "Desqualificado" sem razão auditável é ruído que ninguém consegue contestar. */
  it('encerrar sem motivo é recusado', async () => {
    await expect(sessao('entregue', null, true)).rejects.toThrow(/agente_saida_coerente/)
  })

  it('sessão ativa não pode já ter motivo de saída', async () => {
    await expect(sessao('ativa', 'qualificou', false)).rejects.toThrow(/agente_saida_coerente/)
  })

  it('estado inventado é recusado', async () => {
    await expect(sessao('pensando', 'x', true)).rejects.toThrow(/agente_estado_valido/)
  })
})
