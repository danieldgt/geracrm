import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { carregarContextoDoLead } from './contexto-lead.js'
import type { Sql } from '../../../db/index.js'

/**
 * ⚠️ O que este teste protege é a diferença entre um agente que ATENDE e um que
 * INTERROGA. Perguntar o CNPJ de quem compra há dois anos é o jeito mais rápido
 * de a pessoa largar a conversa — e o dado estava no nosso banco o tempo todo.
 */
const T = 'c0e70000-0000-4000-8000-000000000001'
const PV = 'c0e70000-1111-4000-8000-000000000001'
const PLANO = 'c0e70000-3333-4000-8000-000000000001'
const MODELO = 'c0e70000-4444-4000-8000-000000000001'
const CANAL = 'c0e70000-5555-4000-8000-000000000001'
const CONTATO = 'c0e70000-6666-4000-8000-000000000001'
const CONVERSA = 'c0e70000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** Roda com o tenant setado, como a ingestão faz. */
const carregar = () => dono.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
  return carregarContextoDoLead(tx as unknown as Sql, CONVERSA)
})

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-contexto-lead', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-contexto-lead', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Contexto', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas)
             VALUES (${T}, ${CONTATO}, 'Daniel Alencar Barros Tavares', 'teste', true, 0)
             ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
             VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM venda             WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_endereco  WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  // ⚠️ Apagar o contato levaria a conversa junto (cascade). O baseline volta por
  //    UPDATE, não por recriação.
  await dono`UPDATE contato SET qtd_vendas = 0, ultima_venda_em = NULL
              WHERE tenant_id = ${T} AND id = ${CONTATO}`
})

afterAll(async () => {
  await dono`DELETE FROM venda             WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_endereco  WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa          WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado   WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical   WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant            WHERE id = ${T}`
  await dono`DELETE FROM plano             WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const venda = (mesesAtras: number, cancelada = false) => dono`
  INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, cancelada_em)
  VALUES (${T}, ${randomUUID()}, ${CONTATO}, now() - make_interval(months => ${mesesAtras}),
          10000, ${cancelada ? new Date() : null})`

describe('Lead novo', () => {
  it('sem compra, sem endereço, sem documento: tudo em branco e nada inventado', async () => {
    expect(await carregar()).toEqual({
      nome: 'Daniel', jaEhCliente: false, comprasNoUltimoAno: 0,
      ultimaCompraEm: null, cidade: null, temCnpj: false,
    })
  })

  it('conversa inexistente devolve null em vez de um lead vazio', async () => {
    const r = await dono.begin(async (tx) => {
      await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
      return carregarContextoDoLead(tx as unknown as Sql, '00000000-0000-4000-8000-000000000000')
    })
    expect(r).toBeNull()
  })
})

describe('⚠️ Só o primeiro nome sai do nosso perímetro', () => {
  /**
   * "Daniel" conversa igual a "Daniel Alencar Barros Tavares" e carrega menos
   * gente identificável para o fornecedor. Razão social inteira num prompt não
   * ajuda a responder nada.
   */
  it('o nome completo não vai para o contexto', async () => {
    expect((await carregar())?.nome).toBe('Daniel')
  })
})

describe('⚠️ Compras do ÚLTIMO ANO, não de sempre', () => {
  /**
   * Usar o total de sempre faria um cliente que sumiu há três anos parecer
   * ativo, e o agente trataria como recorrente quem já foi embora.
   */
  it('conta só o último ano', async () => {
    await venda(2); await venda(5); await venda(18)
    const c = await carregar()
    expect(c?.comprasNoUltimoAno).toBe(2)
  })

  it('venda cancelada não conta', async () => {
    await venda(1); await venda(1, true)
    expect((await carregar())?.comprasNoUltimoAno).toBe(1)
  })

  it('quem já comprou é cliente, mesmo sem compra no último ano', async () => {
    await venda(30)
    await dono`UPDATE contato SET qtd_vendas = 1, ultima_venda_em = now() - interval '30 months'
                WHERE tenant_id = ${T} AND id = ${CONTATO}`
    const c = await carregar()
    expect(c?.jaEhCliente).toBe(true)       // é cliente…
    expect(c?.comprasNoUltimoAno).toBe(0)   // …mas está inativo
  })
})

describe('⚠️ O documento nunca sai — só o fato de existir', () => {
  it('CNPJ cadastrado vira temCnpj, e o número não aparece', async () => {
    await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fonte)
               VALUES (${T}, ${CONTATO}, 1, 'cnpj', '11222333000181', 'erp')`
    const c = await carregar()
    expect(c?.temCnpj).toBe(true)
    expect(JSON.stringify(c)).not.toContain('11222333000181')
  })
})

describe('Cidade vem do endereço principal', () => {
  it('prefere o principal', async () => {
    await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, principal, fonte)
               VALUES (${T}, ${CONTATO}, 1, 'Manaus', false, 'erp'),
                      (${T}, ${CONTATO}, 2, 'Boa Vista', true, 'erp')`
    expect((await carregar())?.cidade).toBe('Boa Vista')
  })

  it('endereço sem cidade não vira cidade vazia', async () => {
    await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, principal, fonte)
               VALUES (${T}, ${CONTATO}, 1, NULL, true, 'erp')`
    expect((await carregar())?.cidade).toBeNull()
  })
})
