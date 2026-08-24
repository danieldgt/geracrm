import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  avaliarGastoAnomalo, avaliarVeiculacaoParada, avaliarLeadsSumiram,
  avaliarCodigoPerdido, avaliarConversoesFalhando, vigiarTenant, REGRAS,
} from './vigia.js'
import type { Sql } from '../../db/index.js'

const base7 = (v: number) => Array<number>(REGRAS.diasBase).fill(v)

describe('Gasto anômalo', () => {
  it('dispara quando o dia estoura a média por 3×', () => {
    const a = avaliarGastoAnomalo(100_000, base7(20_000))
    expect(a?.tipo).toBe('midia_gasto_anomalo')
    expect(a?.severidade).toBe('critico')
    expect(a?.mensagem).toContain('5.0×')
  })

  it('não dispara dentro da banda', () => {
    expect(avaliarGastoAnomalo(40_000, base7(20_000))).toBeNull()
  })

  // ⚠️ Massa mínima: sem histórico suficiente, "média" é chute.
  it('sem base de 7 dias, não opina', () => {
    expect(avaliarGastoAnomalo(999_999, [10_000, 10_000])).toBeNull()
  })

  it('gasto irrelevante não vira incidente', () => {
    // 3× de quase nada continua sendo quase nada.
    expect(avaliarGastoAnomalo(300, base7(100))).toBeNull()
  })

  /**
   * ⚠️ Gasto que DESPENCA não é este alerta: é veiculação parada, com outra causa
   * e outra ação. Juntar os dois faria procurar cartão recusado quando o problema
   * é orçamento disparado.
   */
  it('gasto zerado NÃO vira gasto anômalo', () => {
    expect(avaliarGastoAnomalo(0, base7(20_000))).toBeNull()
  })
})

describe('Veiculação parada', () => {
  it('dispara quando gastava todo dia e hoje zerou', () => {
    const a = avaliarVeiculacaoParada(0, base7(30_000))
    expect(a?.tipo).toBe('midia_veiculacao_parada')
    expect(a?.mensagem).toContain('forma de pagamento')
  })

  // ⚠️ Conta que gasta dia sim, dia não, não está parada — está no ritmo dela.
  it('histórico intermitente não caracteriza parada', () => {
    const intermitente = [30_000, 0, 30_000, 0, 30_000, 0, 30_000]
    expect(avaliarVeiculacaoParada(0, intermitente)).toBeNull()
  })

  it('com gasto hoje, não dispara', () => {
    expect(avaliarVeiculacaoParada(10_000, base7(30_000))).toBeNull()
  })

  it('base de gasto irrisório não gera alerta ao parar', () => {
    expect(avaliarVeiculacaoParada(0, base7(100))).toBeNull()
  })
})

describe('⚠️ Leads sumiram — o pior sinal', () => {
  /**
   * O painel da plataforma continua BONITO (impressões, cliques, CTR normais)
   * enquanto o dinheiro sai e nada chega. Sem esta regra, a descoberta viria pelo
   * cliente perguntando por que não recebeu ninguém.
   */
  it('dispara com cliques e gasto, mas zero leads', () => {
    const a = avaliarLeadsSumiram(200, 0, 50_000)
    expect(a?.tipo).toBe('midia_leads_sumiram')
    expect(a?.mensagem).toContain('NENHUM lead')
    expect(a?.mensagem).toContain('webhook')   // diz onde procurar
  })

  it('com pelo menos um lead, não dispara', () => {
    expect(avaliarLeadsSumiram(200, 1, 50_000)).toBeNull()
  })

  // ⚠️ Poucos cliques sem lead é acaso, não incidente.
  it('poucos cliques não sustentam a conclusão', () => {
    expect(avaliarLeadsSumiram(5, 0, 50_000)).toBeNull()
  })
})

describe('Código perdido — a métrica de saúde da atribuição', () => {
  it('dispara acima do limite de origens sem anúncio', () => {
    const a = avaliarCodigoPerdido(100, 40)
    expect(a?.tipo).toBe('midia_codigo_perdido')
    expect(a?.mensagem).toContain('40%')
    expect(a?.severidade).toBe('aviso')   // fura a atribuição, não queima verba
  })

  it('dentro do limite, silêncio', () => {
    expect(avaliarCodigoPerdido(100, 10)).toBeNull()
  })

  it('amostra pequena não opina', () => {
    expect(avaliarCodigoPerdido(5, 5)).toBeNull()
  })
})

describe('Conversões falhando', () => {
  it('dispara no dead-letter acumulado', () => {
    const a = avaliarConversoesFalhando(10)
    expect(a?.mensagem).toContain('loop está aberto')
  })

  it('uma ou outra falha não é incidente', () => {
    expect(avaliarConversoesFalhando(1)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const T = '00161a00-0000-4000-8000-000000000001'
const PV = '00161a00-1111-4000-8000-000000000001'
const PLANO = '00161a00-3333-4000-8000-000000000001'
const MODELO = '00161a00-4444-4000-8000-000000000001'
const CONTA = '00161a00-7777-4000-8000-000000000001'
const CAMP = '00161a00-8888-4000-8000-000000000001'
const CONJ = '00161a00-9999-4000-8000-000000000001'
const AD = '00161a00-aaaa-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-24T12:00:00Z')
const dia = (n: number) => new Date(AGORA.getTime() - n * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-vigia', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-vigia', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => {
  await dono`DELETE FROM alerta            WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox            WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_metrica_dia WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', 'vigia-1', 'Conta')`
  await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
             VALUES (${T}, ${CAMP}, ${CONTA}, 'c1', 'Camp')`
  await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
             VALUES (${T}, ${CONJ}, ${CAMP}, 'g1', 'Conj')`
  await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
             VALUES (${T}, ${AD}, ${CONJ}, 'a1', 'Anúncio')`
})

afterAll(async () => {
  await dono`DELETE FROM alerta            WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox            WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono.end()
})

async function gasto(diasAtras: number, centavos: number, cliques = 10): Promise<void> {
  await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, cliques, custo_centavos)
             VALUES (${T}, ${AD}, ${dia(diasAtras)}::date, ${cliques}, ${centavos})
             ON CONFLICT (tenant_id, anuncio_id, dia) DO UPDATE
               SET custo_centavos = EXCLUDED.custo_centavos, cliques = EXCLUDED.cliques`
}

const alertas = () => dono<{ tipo: string; resolvido_em: Date | null }[]>`
  SELECT tipo, resolvido_em FROM alerta WHERE tenant_id = ${T} ORDER BY tipo`

describe('Varredura contra o banco', () => {
  it('abre alerta de gasto anômalo e emite evento UMA vez', async () => {
    for (let d = 1; d <= REGRAS.diasBase; d++) await gasto(d, 20_000)
    await gasto(0, 200_000)

    const r1 = await vigiarTenant(sql, T, AGORA)
    expect(r1.abertos).toBe(1)

    // ⚠️ Segunda passada: o alerta continua, mas NÃO nasce de novo — senão a
    //    tela piscaria a cada varredura e o operador pararia de olhar.
    const r2 = await vigiarTenant(sql, T, AGORA)
    expect(r2.abertos).toBe(0)

    const [ev] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND tipo = 'alerta.novo'`
    expect(ev!.n).toBe(1)
  })

  it('resolve sozinho quando o gasto volta ao normal', async () => {
    for (let d = 1; d <= REGRAS.diasBase; d++) await gasto(d, 20_000)
    await gasto(0, 200_000)
    await vigiarTenant(sql, T, AGORA)

    await gasto(0, 25_000)                     // voltou à banda
    const r = await vigiarTenant(sql, T, AGORA)
    expect(r.resolvidos).toBe(1)

    const abertos = (await alertas()).filter((a) => a.resolvido_em === null)
    expect(abertos).toHaveLength(0)
  })

  /**
   * ⚠️ O caso que o vigia existe para pegar: cliques e gasto normais, zero leads.
   * O painel da plataforma não mostraria nada de errado.
   */
  it('pega "cliques e gasto sem nenhum lead"', async () => {
    await gasto(0, 50_000, 200)
    const r = await vigiarTenant(sql, T, AGORA)
    expect(r.abertos).toBeGreaterThanOrEqual(1)

    const tipos = (await alertas()).map((a) => a.tipo)
    expect(tipos).toContain('midia_leads_sumiram')
  })

  it('tenant sem dado não gera alerta nenhum', async () => {
    const r = await vigiarTenant(sql, T, AGORA)
    expect(r).toEqual({ abertos: 0, resolvidos: 0 })
  })
})
