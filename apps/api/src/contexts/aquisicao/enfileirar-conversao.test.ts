import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { enfileirarConversoesDeVendas } from './enfileirar-conversao.js'
import type { Sql } from '../../db/index.js'

const T = 'e0f11a00-0000-4000-8000-000000000001'
const PV = 'e0f11a00-1111-4000-8000-000000000001'
const PLANO = 'e0f11a00-3333-4000-8000-000000000001'
const MODELO = 'e0f11a00-4444-4000-8000-000000000001'
const CONTATO = 'e0f11a00-6666-4000-8000-000000000001'
const SEM_ORIGEM = 'e0f11a00-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-21T12:00:00Z')
const dias = (n: number) => new Date(AGORA.getTime() - n * 86_400_000)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-enf', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-enf', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  for (const c of [CONTATO, SEM_ORIGEM]) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${c}, 'Lead') ON CONFLICT DO NOTHING`
  }
})

beforeEach(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda             WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda             WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono.end()
})

async function toque(plataforma: string, clickId: string | null, diasAtras: number, contato = CONTATO): Promise<void> {
  await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, plataforma, click_id, primeira, capturado_em)
             VALUES (${T}, gen_random_uuid(), ${contato}, ${plataforma}, ${clickId}, false, ${dias(diasAtras)})`
}

async function venda(valor: number, diasAtras: number, opcoes: { contato?: string; cancelada?: boolean } = {}): Promise<void> {
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, cancelada_em)
             VALUES (${T}, gen_random_uuid(), ${opcoes.contato ?? CONTATO}, ${dias(diasAtras)}, ${valor},
                     ${opcoes.cancelada ? AGORA : null})`
}

const conversoes = () => dono<{
  plataforma: string; tipo_evento: string; valor_centavos: string; event_id: string; estado: string
}[]>`SELECT plataforma, tipo_evento, valor_centavos::text AS valor_centavos, event_id, estado
       FROM midia_conversao WHERE tenant_id = ${T} ORDER BY plataforma`

describe('Enfileiramento de conversões', () => {
  it('venda de contato com origem vira conversão pendente com o valor real', async () => {
    await toque('google', 'gclid-1', 10)
    await venda(50000, 5)

    const r = await enfileirarConversoesDeVendas(sql, T, AGORA)
    expect(r.criadas).toBe(1)

    const [c] = await conversoes()
    expect(c).toMatchObject({ plataforma: 'google', tipo_evento: 'compra', valor_centavos: '50000', estado: 'pendente' })
  })

  /**
   * ⚠️ O caso que justifica o DISTINCT ON. Sem ele, metade do sinal se perderia:
   * o contato tocado por Google e Meta geraria conversão para um só.
   */
  it('contato tocado por DUAS plataformas gera uma conversão para cada', async () => {
    await toque('google', 'gclid-1', 10)
    await toque('meta', 'fbclid-1', 8)
    await venda(50000, 5)

    const r = await enfileirarConversoesDeVendas(sql, T, AGORA)
    expect(r.criadas).toBe(2)
    expect((await conversoes()).map((c) => c.plataforma)).toEqual(['google', 'meta'])
  })

  it('com dois toques da MESMA plataforma, usa o último antes da venda', async () => {
    await toque('google', 'gclid-antigo', 20)
    await toque('google', 'gclid-recente', 6)
    await venda(50000, 5)

    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(1)
    const [o] = await dono<{ click_id: string }[]>`
      SELECT o.click_id FROM midia_conversao c
        JOIN midia_lead_origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
       WHERE c.tenant_id = ${T}`
    expect(o!.click_id).toBe('gclid-recente')
  })

  it('toque POSTERIOR à venda não credita — não pode ter causado', async () => {
    await toque('google', 'gclid-depois', 2)   // depois da venda
    await venda(50000, 5)
    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(0)
  })

  it('origem sem click_id não vira conversão — não haveria como casar', async () => {
    await toque('google', null, 10)
    await venda(50000, 5)
    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(0)
  })

  it('contato sem origem nenhuma é ignorado', async () => {
    await venda(50000, 5, { contato: SEM_ORIGEM })
    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(0)
  })

  // ⚠️ Convenção do repositório: venda cancelada não é receita.
  it('venda cancelada não vira conversão', async () => {
    await toque('google', 'gclid-1', 10)
    await venda(50000, 5, { cancelada: true })
    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(0)
  })

  it('venda fora da janela de importação não é enfileirada', async () => {
    await toque('google', 'gclid-1', 200)
    await venda(50000, 120)
    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(0)
  })

  /**
   * ⚠️ Roda a cada importação do ERP, e importação repetida é normal. Sem
   * idempotência, a receita duplicaria no painel da plataforma — e o número
   * ficaria MAIOR, então ninguém reclamaria.
   */
  it('é idempotente — a segunda passada não cria nada', async () => {
    await toque('google', 'gclid-1', 10)
    await venda(50000, 5)

    expect((await enfileirarConversoesDeVendas(sql, T, AGORA)).criadas).toBe(1)
    const segunda = await enfileirarConversoesDeVendas(sql, T, AGORA)
    expect(segunda.criadas).toBe(0)
    expect(segunda.jaExistiam).toBe(1)
    expect(await conversoes()).toHaveLength(1)
  })

  // ⚠️ Id aleatório faria cada reprocessamento parecer evento novo para a plataforma.
  it('o event_id é determinístico — deriva da venda, plataforma e tipo', async () => {
    await toque('google', 'gclid-1', 10)
    await venda(50000, 5)
    await enfileirarConversoesDeVendas(sql, T, AGORA)

    const [c] = await conversoes()
    expect(c!.event_id).toMatch(/^v-[0-9a-f-]{36}-google-compra$/)
  })

  it('não atravessa tenant', async () => {
    await toque('google', 'gclid-1', 10)
    await venda(50000, 5)
    const outro = 'e0f11a00-0000-4000-8000-0000000000ff'
    expect((await enfileirarConversoesDeVendas(sql, outro, AGORA)).criadas).toBe(0)
  })
})
