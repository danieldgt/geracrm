import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp, FalhaEfetivacao } from '@geracrm/conectores'
import { efetivarPedido } from './efetivacao.js'

/**
 * ADR-005 — efetivação do pedido. Cobre, com conectores FALSOS, as três coisas
 * onde o produto morreria: idempotência, falha-que-preserva-rascunho, resposta
 * perdida. Mais a degradação (ADR-008) quando o conector não escreve.
 */
const T = 'fed00000-0000-4000-8000-000000000001'
const PV = 'fed00000-1111-4000-8000-000000000001'
const PLANO = 'fed00000-3333-4000-8000-000000000001'
const MODELO = 'fed00000-4444-4000-8000-000000000001'
const CONTATO = 'fed00000-6666-4000-8000-000000000001'
const SISTEMA = 'geracloud'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

async function comoTenant<X>(fn: (tx: postgres.Sql) => Promise<X>): Promise<X> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<X>
}

/** Conector falso: só as partes que a efetivação toca. */
function conectorFake(
  efetiva: (p: { chaveIdempotencia: string }) => Awaited<ReturnType<NonNullable<ConectorErp['efetivarPedido']>>>,
): ConectorErp {
  return {
    nome: 'fake', capacidades: { escritaPedido: true } as never,
    efetivarPedido: async (p: { chaveIdempotencia: string }) => efetiva(p),
  } as unknown as ConectorErp
}

async function novoRascunho(comContato = true): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES (${T}, ${id}, ${comContato ? CONTATO : null}, 'rascunho')`
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${id}, 1, 'SKU-1', 'Camisa', 2, 5000)`
  await dono`UPDATE pedido SET versao_conteudo = 3 WHERE tenant_id = ${T} AND id = ${id}`
  return id
}
const lerPedido = async (id: string) => (await dono<{ estado: string; numero_externo: string | null; erro: unknown; itens: number }[]>`
  SELECT p.estado, p.numero_externo, p.ultimo_erro AS erro,
         (SELECT count(*)::int FROM pedido_item i WHERE i.tenant_id = p.tenant_id AND i.pedido_id = p.id) AS itens
    FROM pedido p WHERE p.tenant_id = ${T} AND p.id = ${id}`)[0]!

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ped', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ped', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Ped', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM pedido_item WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_identidade_externa WHERE tenant_id = ${T}`
  // Por padrão o contato TEM cadastro externo (o caminho feliz).
  await dono`INSERT INTO contato_identidade_externa (tenant_id, sistema, id_externo, contato_id)
             VALUES (${T}, ${SISTEMA}, 'CLI-1', ${CONTATO}) ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await dono`DELETE FROM pedido_item WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end(); await api.end()
})

const AGORA = new Date('2026-08-10T12:00:00Z')

describe('ADR-005: efetivação do pedido', () => {
  it('⚠️ degradação: conector sem escrita NÃO efetiva; rascunho fica intacto', async () => {
    const id = await novoRascunho()
    const r = await comoTenant((tx) => efetivarPedido(tx, null, SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'degradado' })
    const p = await lerPedido(id)
    expect(p.estado).toBe('rascunho') // não perdeu o rascunho
    expect(p.itens).toBe(1)
  })

  it('efetiva no ERP: estado efetivado + número externo', async () => {
    const id = await novoRascunho()
    const con = conectorFake(() => ({ ok: true, valor: { numeroExterno: 'NF-777' } }))
    const r = await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'efetivado', numeroExterno: 'NF-777' })
    const p = await lerPedido(id)
    expect(p.estado).toBe('efetivado')
    expect(p.numero_externo).toBe('NF-777')
  })

  it('⚠️ idempotência: a chave é id:versao_conteudo (INV-29)', async () => {
    const id = await novoRascunho() // versao_conteudo = 3
    let chaveVista = ''
    const con = conectorFake((p) => { chaveVista = p.chaveIdempotencia; return { ok: true, valor: { numeroExterno: 'X' } } })
    await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(chaveVista).toBe(`${id}:3`)
  })

  it('⚠️ estoque insuficiente: falha NOMEADA, estado falhou, rascunho (itens) preservado', async () => {
    const id = await novoRascunho()
    const falha: FalhaEfetivacao = { tipo: 'estoque_insuficiente', skuExterno: 'SKU-1', disponivel: 1 }
    const con = conectorFake(() => ({ ok: false, falha }))
    const r = await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'falha', falha })
    const p = await lerPedido(id)
    expect(p.estado).toBe('falhou')
    expect(p.itens).toBe(1) // ⚠️ itens preservados para reprocessar
    expect((p.erro as { tipo: string }).tipo).toBe('estoque_insuficiente')
  })

  it('crédito bloqueado também é falha nomeada', async () => {
    const id = await novoRascunho()
    const con = conectorFake(() => ({ ok: false, falha: { tipo: 'credito_bloqueado', disponivelCentavos: 0 } }))
    const r = await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(r.tipo).toBe('falha')
    expect((await lerPedido(id)).estado).toBe('falhou')
  })

  it('⚠️ resposta perdida (504) → aguardando_conferencia, nunca reenvia cego (INV-53)', async () => {
    const id = await novoRascunho()
    const con = conectorFake(() => ({ ok: false, falha: { tipo: 'resposta_perdida' } }))
    const r = await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'aguardando_conferencia' })
    expect((await lerPedido(id)).estado).toBe('aguardando_conferencia')
  })

  it('cliente sem cadastro fiscal (sem identidade externa) → falha nomeada', async () => {
    await dono`DELETE FROM contato_identidade_externa WHERE tenant_id = ${T}`
    const id = await novoRascunho()
    const con = conectorFake(() => ({ ok: true, valor: { numeroExterno: 'N' } }))
    const r = await comoTenant((tx) => efetivarPedido(tx, con, SISTEMA, id, AGORA))
    expect(r.tipo).toBe('falha')
    if (r.tipo === 'falha') expect(r.falha.tipo).toBe('cliente_sem_cadastro_fiscal')
  })

  it('pedido vazio não efetiva', async () => {
    const id = randomUUID()
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES (${T}, ${id}, ${CONTATO}, 'rascunho')`
    const r = await comoTenant((tx) => efetivarPedido(tx, null, SISTEMA, id, AGORA))
    expect(r.tipo).toBe('vazio')
  })
})

/**
 * ⚠️ O BECO SEM SAÍDA DO 'confirmado'.
 *
 * A jornada do chat termina com o cliente dizendo SIM: o pedido vira
 * 'confirmado'. Mas a efetivação só aceitava 'rascunho' e 'falhou' — então o
 * pedido confirmado NUNCA chegaria ao ERP, nem com o conector de escrita pronto.
 * O defeito só apareceria no dia em que a escrita fosse ligada, com o pedido de
 * um cliente real parado no meio do caminho.
 */
describe('⚠️ Pedido confirmado no chat pode efetivar', () => {
  const confirmado = async () => {
    const id = await novoRascunho()
    await dono`UPDATE pedido SET estado = 'confirmado', confirmado_em = now()
                WHERE tenant_id = ${T} AND id = ${id}`
    return id
  }

  it('confirmado efetiva e vira efetivado', async () => {
    const id = await confirmado()
    const r = await comoTenant((tx) => efetivarPedido(
      tx, conectorFake(() => ({ ok: true, valor: { numeroExterno: 'ERP-77' } })),
      SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'efetivado', numeroExterno: 'ERP-77' })
    expect((await lerPedido(id)).estado).toBe('efetivado')
  })

  /** ⚠️ Efetivado é imutável — reenviar duplicaria pedido no ERP do cliente. */
  it('efetivado não efetiva de novo', async () => {
    const id = await confirmado()
    await dono`UPDATE pedido SET estado = 'efetivado' WHERE tenant_id = ${T} AND id = ${id}`
    const r = await comoTenant((tx) => efetivarPedido(
      tx, conectorFake(() => ({ ok: true, valor: { numeroExterno: 'X' } })), SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'nao_rascunho' })
  })

  /**
   * ⚠️ 'aguardando_conferencia' é o estado do INV-53: a resposta do ERP se
   * perdeu e o pedido PODE existir lá. Reenviar às cegas é exatamente o que não
   * se pode fazer.
   */
  it('aguardando_conferencia NÃO reenvia', async () => {
    const id = await confirmado()
    await dono`UPDATE pedido SET estado = 'aguardando_conferencia' WHERE tenant_id = ${T} AND id = ${id}`
    const r = await comoTenant((tx) => efetivarPedido(
      tx, conectorFake(() => ({ ok: true, valor: { numeroExterno: 'X' } })), SISTEMA, id, AGORA))
    expect(r).toEqual({ tipo: 'nao_rascunho' })
  })
})
