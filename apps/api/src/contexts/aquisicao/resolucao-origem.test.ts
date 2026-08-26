import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { resolverOrigensPendentes } from './resolucao-origem.js'
import type { Sql } from '../../db/index.js'

/**
 * Resolução tardia da origem (AQ-09) e invariantes de `midia_conversao` (AQ-15).
 *
 * ⚠️ Roda em modo DONO, como o worker roda: sem tenant de sessão, com o
 * `tenant_id` explícito em cada consulta.
 */

const T = 'de5a0000-0000-4000-8000-000000000001'
const T2 = 'de5a0000-0000-4000-8000-000000000002'
const PV = 'de5a0000-1111-4000-8000-000000000001'
const PV2 = 'de5a0000-1111-4000-8000-000000000002'
const PLANO = 'de5a0000-3333-4000-8000-000000000001'
const MODELO = 'de5a0000-4444-4000-8000-000000000001'
const CONTA = 'de5a0000-7777-4000-8000-000000000001'
const CAMP = 'de5a0000-8888-4000-8000-000000000001'
const CONJ_1 = 'de5a0000-9999-4000-8000-000000000001'
const CONJ_2 = 'de5a0000-9999-4000-8000-000000000002'
const CONTATO = 'de5a0000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-resol', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-resol', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[T, PV], [T2, PV2]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, 'Loja', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Lead') ON CONFLICT DO NOTHING`
})

// Cada caso monta a própria estrutura — a limpeza entre eles é o que permite
// reusar os mesmos ids fixos sem que um teste contamine o seguinte.
beforeEach(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM midia_conta       WHERE tenant_id IN (${T}, ${T2})`
})

afterAll(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM midia_conta       WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM contato           WHERE tenant_id IN (${T}, ${T2})`
  await dono.end()
})

/** Sobe a hierarquia de veiculação. `conjuntos` permite criar o caso ambíguo. */
async function criarEstrutura(idsExternosPorConjunto: readonly (readonly string[])[]): Promise<void> {
  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', 'conta-resol', 'Conta')`
  await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
             VALUES (${T}, ${CAMP}, ${CONTA}, 'camp-resol', 'Camp')`
  const conjuntos = [CONJ_1, CONJ_2]
  for (let i = 0; i < idsExternosPorConjunto.length; i++) {
    await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
               VALUES (${T}, ${conjuntos[i]!}, ${CAMP}, ${'conj-' + i}, 'Conj')`
    for (const ext of idsExternosPorConjunto[i]!) {
      await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
                 VALUES (${T}, gen_random_uuid(), ${conjuntos[i]!}, ${ext}, 'Anúncio')`
    }
  }
}

async function criarOrigem(anuncioExterno: string, diasAtras = 0): Promise<void> {
  await dono`INSERT INTO midia_lead_origem
               (tenant_id, id, contato_id, anuncio_externo_id, plataforma, primeira, capturado_em)
             VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${anuncioExterno}, 'google', false,
                     now() - make_interval(days => ${diasAtras}))`
}

const resolver = () => resolverOrigensPendentes(dono as unknown as Sql, T)

describe('Resolução tardia da origem', () => {
  it('o lead chega antes da estrutura e fica pendente — não é erro', async () => {
    await criarOrigem('ad-1')
    const [o] = await dono<{ anuncio_id: string | null }[]>`
      SELECT anuncio_id FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(o!.anuncio_id).toBeNull()
  })

  it('quando a estrutura sincroniza, a origem casa e ganha a hierarquia inteira', async () => {
    await criarOrigem('ad-1')
    await criarEstrutura([['ad-1']])

    const r = await resolver()
    expect(r.resolvidas).toBe(1)
    expect(r.pendentes).toBe(0)

    const [o] = await dono<{ anuncio_id: string; campanha_id: string; conta_id: string }[]>`
      SELECT anuncio_id, campanha_id, conta_id FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(o!.anuncio_id).toBeTruthy()
    expect(o!.campanha_id).toBe(CAMP)   // ⚠️ resolve a hierarquia toda, não só o anúncio
    expect(o!.conta_id).toBe(CONTA)
  })

  // ⚠️ Roda depois de toda sincronização: rodar duas vezes não pode mudar nada.
  it('é idempotente — a segunda passada não resolve nada', async () => {
    await criarOrigem('ad-1')
    await criarEstrutura([['ad-1']])
    expect((await resolver()).resolvidas).toBe(1)
    expect((await resolver()).resolvidas).toBe(0)
  })

  /**
   * ⚠️ `id_externo` é único por CONJUNTO, não por tenant. Com dois candidatos,
   * atribuir ao primeiro creditaria a venda ao anúncio errado — e o número
   * ficaria plausível. Mesma regra de `extrairCodigoOrigem`.
   */
  it('com dois anúncios de mesmo id externo, NÃO adivinha', async () => {
    await criarOrigem('ad-repetido')
    await criarEstrutura([['ad-repetido'], ['ad-repetido']])

    const r = await resolver()
    expect(r.resolvidas).toBe(0)
    expect(r.ambiguas).toBe(1)

    const [o] = await dono<{ anuncio_id: string | null }[]>`
      SELECT anuncio_id FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(o!.anuncio_id).toBeNull()
  })

  it('resolve as inequívocas mesmo havendo uma ambígua ao lado', async () => {
    await criarOrigem('ad-repetido')
    await criarOrigem('ad-unico')
    await criarEstrutura([['ad-repetido', 'ad-unico'], ['ad-repetido']])

    const r = await resolver()
    expect(r.resolvidas).toBe(1)
    expect(r.ambiguas).toBe(1)
  })

  // ⚠️ Sem o corte, a varredura arrasta para sempre um resíduo que nunca resolve.
  it('origem mais velha que a janela para de ser tentada', async () => {
    await criarOrigem('ad-1', 45)
    await criarEstrutura([['ad-1']])

    const r = await resolver()
    expect(r.resolvidas).toBe(0)
    expect(r.pendentes).toBe(0) // nem entra na contagem: saiu da janela

    const [o] = await dono<{ anuncio_externo_id: string }[]>`
      SELECT anuncio_externo_id FROM midia_lead_origem WHERE tenant_id = ${T}`
    // Não é perdida: continua valendo como ORIGEM PARCIAL.
    expect(o!.anuncio_externo_id).toBe('ad-1')
  })

  it('não atravessa tenant — o anúncio de um não resolve a origem do outro', async () => {
    await criarOrigem('ad-1')
    await criarEstrutura([['ad-1']])
    const r = await resolverOrigensPendentes(dono as unknown as Sql, T2)
    expect(r.resolvidas).toBe(0)
  })
})

describe('Invariantes de midia_conversao', () => {
  async function origemId(): Promise<string> {
    const [o] = await dono<{ id: string }[]>`
      INSERT INTO midia_lead_origem (tenant_id, id, contato_id, plataforma, primeira)
      VALUES (${T}, gen_random_uuid(), ${CONTATO}, 'google', false) RETURNING id`
    return o!.id
  }

  // ⚠️ É o ponto inteiro da tabela: compra sem valor faz a plataforma voltar a
  //    otimizar por volume de lead.
  it('compra SEM valor é recusada', async () => {
    const o = await origemId()
    await expect(
      dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id,
                                        venda_id, venda_ocorrida_em)
           VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'compra', 'ev-1',
                   gen_random_uuid(), now())`,
    ).rejects.toThrow(/midia_conversao_compra_tem_valor/)
  })

  it('compra SEM venda é recusada', async () => {
    const o = await origemId()
    await expect(
      dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id, valor_centavos)
           VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'compra', 'ev-2', 50000)`,
    ).rejects.toThrow(/midia_conversao_compra_tem_venda/)
  })

  it('mas lead sem valor e sem venda é normal', async () => {
    const o = await origemId()
    const r = await dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id)
                         VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'lead', 'ev-3') RETURNING id`
    expect(r).toHaveLength(1)
  })

  /**
   * ⚠️ INV-62. Sem isto um reprocessamento duplica a receita no painel da
   * plataforma — e o número fica MAIOR, então ninguém reclama.
   */
  it('a mesma venda não é devolvida duas vezes para a mesma plataforma', async () => {
    const o = await origemId()
    const venda = (await dono<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]!.id
    const inserir = (ev: string) =>
      dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id,
                                        valor_centavos, venda_id, venda_ocorrida_em)
           VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'compra', ${ev}, 50000, ${venda}, now())`
    await inserir('ev-a')
    await expect(inserir('ev-b')).rejects.toThrow(/midia_conversao_venda_unica/)
  })

  it('mas a mesma venda PODE ir para plataformas diferentes', async () => {
    const o = await origemId()
    const venda = (await dono<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]!.id
    for (const [p, ev] of [['google', 'ev-g'], ['meta', 'ev-m']] as const) {
      await dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id,
                                              valor_centavos, venda_id, venda_ocorrida_em)
                 VALUES (${T}, gen_random_uuid(), ${o}, ${p}, 'compra', ${ev}, 50000, ${venda}, now())`
    }
    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_conversao WHERE tenant_id = ${T}`
    expect(c!.n).toBe(2)
  })

  // ⚠️ event_id repetido faria a plataforma descartar um dos eventos em silêncio.
  it('event_id é único por tenant', async () => {
    const o = await origemId()
    await dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id)
               VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'lead', 'ev-dup')`
    await expect(
      dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id)
           VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'lead_qualificado', 'ev-dup')`,
    ).rejects.toThrow(/midia_conversao_event_id_unico/)
  })

  it('"descartada" é estado válido e distinto de "falhou"', async () => {
    const o = await origemId()
    await dono`INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id, estado, ultimo_erro)
               VALUES (${T}, gen_random_uuid(), ${o}, 'google', 'lead', 'ev-desc', 'descartada', 'fora_da_janela_de_importacao')`
    const [c] = await dono<{ estado: string }[]>`
      SELECT estado FROM midia_conversao WHERE tenant_id = ${T} AND event_id = 'ev-desc'`
    expect(c!.estado).toBe('descartada')
  })
})
