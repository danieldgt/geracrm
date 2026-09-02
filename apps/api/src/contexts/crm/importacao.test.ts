import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * EP-02 — importação de contatos por CSV, ponta a ponta. Fixa: cria contatos,
 * deduplica por DOCUMENTO (telefone só sem documento), conta rejeições, e isola
 * por tenant.
 */
const T = 'c5f00000-0000-4000-8000-000000000001'
const PV = 'c5f00000-1111-4000-8000-000000000001'
const PLANO = 'c5f00000-3333-4000-8000-000000000001'
const MODELO = 'c5f00000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const importar = (csv: string) =>
  app.inject({ method: 'POST', url: '/v1/contatos/importar', headers: { 'x-tenant-id': T }, payload: { csv } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-imp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-imp', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Imp', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('EP-02: importar contatos por CSV', () => {
  it('cria contatos e grava telefone + documento', async () => {
    const r = await importar('nome,telefone,cnpj\nZé,81998617049,11222333000181\nAna,8133334444,')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ criados: 2, atualizados: 0, rejeitados: 0 })
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(c!.n).toBe(2)
    const [d] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_documento WHERE tenant_id = ${T} AND tipo = 'cnpj'`
    expect(d!.n).toBe(1)
  })

  it('⚠️ deduplica por telefone: reimportar o mesmo número não cria de novo', async () => {
    await importar('nome,telefone\nZé,81998617049')
    const r = await importar('nome,telefone\nZé Silva,81998617049') // mesmo número
    expect(r.json()).toMatchObject({ criados: 0, atualizados: 1 })
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  it('conta rejeições sem abortar a importação inteira', async () => {
    const r = await importar('nome,telefone\nBom,81998617049\n,88887777\nRuim,123')
    const j = r.json() as { criados: number; rejeitados: number; rejeicoes: { motivo: string }[] }
    expect(j.criados).toBe(1)
    expect(j.rejeitados).toBe(2)
    expect(j.rejeicoes.map((x) => x.motivo).sort()).toEqual(['nome_vazio', 'telefone_invalido'])
  })

  it('CSV vazio → 422', async () => {
    expect((await importar('')).statusCode).toBe(422)
  })
})

describe('EP-02: dedup por documento (carga B2B)', () => {
  /**
   * ⚠️ O caso que motivou a mudança, medido numa carga real de 709 confecções:
   * 47 telefones eram do mesmo grupo/escritório e 67 empresas não entravam.
   */
  it('empresas DIFERENTES com o mesmo telefone entram todas', async () => {
    const csv = [
      'nome;cnpj;telefone',
      'RECAMONDE;07.410.252/0001-07;(85) 3253-1477',
      'PROT SERVIS;11.222.333/0001-81;(85) 3253-1477',
      'W. WORK;44.555.666/0001-72;(85) 3253-1477',
    ].join('\n')
    const r = await importar(csv)
    const b = r.json<{ criados: number; atualizados: number; rejeitados: number }>()
    expect(b.rejeitados).toBe(0)
    expect(b.criados).toBe(3)      // antes: 1 criado e 2 perdidos
    expect(b.atualizados).toBe(0)

    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(n!.n).toBe(3)
  })

  it('o MESMO CNPJ com telefone diferente não duplica', async () => {
    await importar(['nome;cnpj;telefone', 'DNOITE;11.222.333/0001-81;(85) 3227-4225'].join('\n'))
    const r = await importar(["nome;cnpj;telefone", "D' NOITE;11.222.333/0001-81;(85) 9 9999-0000"].join('\n'))
    expect(r.json<{ criados: number; atualizados: number }>()).toMatchObject({ criados: 0, atualizados: 1 })

    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T}`
    expect(n!.n).toBe(1)
    // ⚠️ O segundo telefone é guardado (seq calculado), não descartado em silêncio.
    const tels = await dono<{ principal: boolean }[]>`
      SELECT principal FROM contato_telefone WHERE tenant_id = ${T} ORDER BY seq`
    expect(tels).toHaveLength(2)
    expect(tels.filter((t) => t.principal)).toHaveLength(1) // só o primeiro é principal
  })

  it('sem documento, o telefone continua sendo a chave (varejo não muda)', async () => {
    const csv = ['nome;telefone', 'Maria;(85) 9 8888-1111', 'Maria S.;(85) 9 8888-1111'].join('\n')
    const r = await importar(csv)
    expect(r.json<{ criados: number; atualizados: number }>()).toMatchObject({ criados: 1, atualizados: 1 })
  })

  it('⚠️ whatsapp entra como DESCONHECIDO, não como verdadeiro', async () => {
    // Fixo comercial marcado como WhatsApp inflava a métrica do painel.
    await importar(['nome;cnpj;telefone', 'Fábrica X;11.222.333/0001-81;(85) 3253-1477'].join('\n'))
    const [tel] = await dono<{ whatsapp: boolean | null }[]>`
      SELECT whatsapp FROM contato_telefone WHERE tenant_id = ${T}`
    expect(tel!.whatsapp).toBeNull()
  })
})
