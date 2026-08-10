import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

/**
 * INB-18 — presença por conversa. O que o teste fixa:
 *   • dois atendentes na mesma conversa se enxergam (colisão evitada);
 *   • ninguém aparece para si mesmo;
 *   • quem parou de bater o coração (visto_em antigo) some pelo TTL;
 *   • um tenant nunca vê a presença de outro (RLS).
 *
 * Testado no nível do SQL sob RLS (a rota é uma casca fina de upsert + leitura);
 * o TTL é exercido gravando `visto_em` no passado, sem esperar em relógio real.
 */
const TTL = 40
const A = 'b18e0000-0000-4000-8000-000000000001'
const B = 'b18e0000-0000-4000-8000-000000000002'
const PVA = 'b18e0000-1111-4000-8000-000000000001'
const PVB = 'b18e0000-1111-4000-8000-000000000002'
const PLANO = 'b18e0000-3333-4000-8000-000000000001'
const MODELO = 'b18e0000-4444-4000-8000-000000000001'
const CANAL = 'b18e0000-5555-4000-8000-000000000001'
const CONTATO = 'b18e0000-6666-4000-8000-000000000001'
const CONVERSA = 'b18e0000-7777-4000-8000-000000000001'
const U1 = 'b18e0000-8888-4000-8000-000000000001'
const U2 = 'b18e0000-8888-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

async function comoTenant<T>(tenantId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<T>
}

/** Grava presença com visto_em deslocado (segundos atrás) para exercitar o TTL. */
const bater = (tenant: string, usuario: string, segundosAtras = 0) => dono`
  INSERT INTO presenca_conversa (tenant_id, conversa_id, usuario_id, visto_em)
  VALUES (${tenant}, ${CONVERSA}, ${usuario}, now() - make_interval(secs => ${segundosAtras}))
  ON CONFLICT (tenant_id, conversa_id, usuario_id) DO UPDATE SET visto_em = EXCLUDED.visto_em`

/** A mesma leitura que a rota faz: quem MAIS está aqui, dentro do TTL. */
const outrosVistosPor = (tenant: string, eu: string) => comoTenant(tenant, (tx) => tx<{ nome: string }[]>`
  SELECT u.nome
    FROM presenca_conversa p
    JOIN usuario u ON u.tenant_id = p.tenant_id AND u.id = p.usuario_id
   WHERE p.tenant_id = tenant_atual() AND p.conversa_id = ${CONVERSA}
     AND p.usuario_id <> ${eu}
     AND p.visto_em > now() - make_interval(secs => ${TTL})
   ORDER BY u.nome`)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-inb18', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-inb18', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PVA, 'Loja A'], [B, PVB, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  // A conversa e os usuários vivem no tenant A. B só precisa existir para o isolamento.
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${A}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${A}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${A}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U1}, 'sub-inb18-1', 'Ana', 'ana@t.local') ON CONFLICT (cognito_sub) DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U2}, 'sub-inb18-2', 'Bia', 'bia@t.local') ON CONFLICT (cognito_sub) DO NOTHING`
})

afterAll(async () => {
  await dono`DELETE FROM presenca_conversa WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM conversa WHERE tenant_id = ${A}`
  await dono`DELETE FROM contato WHERE tenant_id = ${A}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${A}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${A}`
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
  await api.end()
})

describe('INB-18: presença por conversa', () => {
  it('dois atendentes na mesma conversa se enxergam — e não a si mesmos', async () => {
    await dono`DELETE FROM presenca_conversa WHERE tenant_id = ${A}`
    await bater(A, U1)
    await bater(A, U2)

    expect((await outrosVistosPor(A, U1)).map((r) => r.nome)).toEqual(['Bia']) // U1 vê U2
    expect((await outrosVistosPor(A, U2)).map((r) => r.nome)).toEqual(['Ana']) // U2 vê U1
  })

  it('⚠️ quem parou de bater o coração (além do TTL) some', async () => {
    await dono`DELETE FROM presenca_conversa WHERE tenant_id = ${A}`
    await bater(A, U1)                 // presente agora
    await bater(A, U2, TTL + 5)        // último heartbeat há 45s → expirado

    expect(await outrosVistosPor(A, U1)).toEqual([]) // U2 sumiu pelo TTL
  })

  it('⚠️ isolamento: presença de um tenant não aparece para outro (RLS)', async () => {
    await dono`DELETE FROM presenca_conversa WHERE tenant_id IN (${A}, ${B})`
    await bater(A, U1)
    // Visto pelo tenant B: a conversa nem é dele — RLS não deixa ver nada.
    const doB = await comoTenant(B, (tx) => tx`SELECT * FROM presenca_conversa WHERE conversa_id = ${CONVERSA}`)
    expect(doB.length).toBe(0)
  })
})
