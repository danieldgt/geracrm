import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp } from '@geracrm/conectores'
import { ALCADA_PADRAO, type AlcadaAgente } from '@geracrm/shared'
import { encerrarBanco } from '../../db/index.js'
import { efetivarSeDentroDaAlcada } from './alcada.js'

/**
 * ALÇADA (ADR-027): com o cliente confirmado, o domínio decide se efetiva
 * sozinho — e, quando efetiva, passa pelo MESMO `efetivarPedido` da rota, com
 * conector falso (nunca o ERP real em teste).
 */
const T = 'f4a30000-0000-4000-8000-000000000001'
const PV = 'f4a30000-1111-4000-8000-000000000001'
const PLANO = 'f4a30000-3333-4000-8000-000000000001'
const MODELO = 'f4a30000-4444-4000-8000-000000000001'
const CONTATO = 'f4a30000-6666-4000-8000-000000000001'
const SISTEMA = 'erp:teste-alcada'
const AGORA = new Date('2026-09-01T12:00:00Z')

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

function conectorFake(efetiva: () => Awaited<ReturnType<NonNullable<ConectorErp['efetivarPedido']>>>): ConectorErp {
  return {
    nome: 'fake', capacidades: { escritaPedido: true } as never,
    efetivarPedido: async () => efetiva(),
  } as unknown as ConectorErp
}
const deps = (conector: ConectorErp | null) => ({ conector: async () => ({ conectorNome: 'fake', sistema: SISTEMA, conector }) })

async function confirmado(totalCentavos: number, descontoPct = 0): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, confirmado_em, total_centavos, total_pecas, desconto_pct, origem)
             VALUES (${T}, ${id}, ${CONTATO}, 'confirmado', now(), ${totalCentavos}, 1, ${descontoPct}, 'agente')`
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${id}, 1, 'SKU-1', 'Camisa', 1, ${totalCentavos})`
  return id
}
const estadoDe = async (id: string) => (await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE id = ${id}`)[0]!.estado

const AUTONOMO: AlcadaAgente = { valorMaxAutonomoCentavos: 50_000, descontoMaxPct: 0, efetivaSozinho: true }

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-alcada', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-alcada', 'Moda') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Alçada', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Moda') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_identidade_externa (tenant_id, sistema, id_externo, contato_id)
             VALUES (${T}, ${SISTEMA}, 'CLI-1', ${CONTATO}) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`UPDATE perfil_vertical SET regras_pedido = '{}'::jsonb WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('efetivarSeDentroDaAlcada', () => {
  it('⚠️ alçada PADRÃO (tudo zero, efetiva_sozinho=false): sempre espera o vendedor', async () => {
    const id = await confirmado(100)
    const r = await efetivarSeDentroDaAlcada(T, id, ALCADA_PADRAO, AGORA, deps(conectorFake(() => ({ ok: true, valor: { numeroExterno: 'X' } }))))
    expect(r).toEqual({ decisao: { acao: 'aguardar_vendedor', motivo: 'efetivacao_manual' } })
    expect(await estadoDe(id)).toBe('confirmado') // ninguém tocou no pedido
  })

  it('acima do valor máximo → aguarda vendedor, pedido intacto', async () => {
    const id = await confirmado(50_001)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(null))
    expect(r).toEqual({ decisao: { acao: 'aguardar_vendedor', motivo: 'acima_do_valor' } })
    expect(await estadoDe(id)).toBe('confirmado')
  })

  it('⚠️ qualquer desconto acima do permitido (zero) → aguarda vendedor, mesmo dentro do valor', async () => {
    const id = await confirmado(1_000, 5)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(null))
    expect(r).toEqual({ decisao: { acao: 'aguardar_vendedor', motivo: 'desconto' } })
  })

  it('dentro da alçada → efetiva pelo conector (o mesmo caso de uso da rota)', async () => {
    const id = await confirmado(50_000)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(conectorFake(() => ({ ok: true, valor: { numeroExterno: 'ERP-9' } }))))
    expect(r).toEqual({ decisao: { acao: 'efetivar' }, efetivacao: { tipo: 'efetivado', numeroExterno: 'ERP-9' } })
    expect(await estadoDe(id)).toBe('efetivado')
  })

  it('dentro da alçada mas o ERP não escreve → degrada visível, pedido continua confirmado', async () => {
    const id = await confirmado(100)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(null))
    expect(r).toEqual({ decisao: { acao: 'efetivar' }, efetivacao: { tipo: 'degradado' } })
    expect(await estadoDe(id)).toBe('confirmado')
  })

  it('dentro da alçada e o ERP recusa → falha NOMEADA, rascunho preservado', async () => {
    const id = await confirmado(100)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA,
      deps(conectorFake(() => ({ ok: false, falha: { tipo: 'estoque_insuficiente', skuExterno: 'SKU-1', disponivel: 0 } }))))
    expect(r.efetivacao).toMatchObject({ tipo: 'falha', falha: { tipo: 'estoque_insuficiente' } })
    expect(await estadoDe(id)).toBe('falhou')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido_item WHERE pedido_id = ${id}`
    expect(n!.n).toBe(1)
  })

  it('regra comercial violada na efetivação é revalidada (INV-28) e nomeada', async () => {
    await dono`UPDATE perfil_vertical SET regras_pedido = '{"minimo_pecas": 10}'::jsonb WHERE tenant_id = ${T}`
    const id = await confirmado(100)
    const r = await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(conectorFake(() => ({ ok: true, valor: { numeroExterno: 'X' } }))))
    expect(r.efetivacao).toMatchObject({ tipo: 'regras', violacao: { tipo: 'abaixo_do_minimo', faltam: { pecas: 9 } } })
    expect(await estadoDe(id)).toBe('confirmado')
  })

  it('só pedido CONFIRMADO passa pela alçada; inexistente é nomeado', async () => {
    const id = await confirmado(100)
    await dono`UPDATE pedido SET estado = 'rascunho', confirmado_em = NULL WHERE id = ${id}`
    expect(await efetivarSeDentroDaAlcada(T, id, AUTONOMO, AGORA, deps(null)))
      .toEqual({ decisao: { acao: 'nao_aplicavel', motivo: 'nao_confirmado', estado: 'rascunho' } })
    expect(await efetivarSeDentroDaAlcada(T, randomUUID(), AUTONOMO, AGORA, deps(null)))
      .toEqual({ decisao: { acao: 'nao_aplicavel', motivo: 'nao_encontrado' } })
  })
})
