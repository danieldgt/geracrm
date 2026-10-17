import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { abrirSessaoStaff } from '../plataforma/staff-sessao.js'
import { ativasSuspensasDe } from './rotas-canais.js'

/**
 * Tela de números (P10): QR só para admin, `podeParear` na listagem, dados
 * mascarados, modo do agente e ativas suspensas (leitura tolerante da 0101).
 *
 * ⚠️ O QR pareia QUALQUER aparelho ao número: gestor vê o estado, nunca o QR.
 *
 * Em dev (header x-tenant-id) o sub é `dev-<tenant>`. Fixtures exclusivas
 * deste arquivo — a suíte roda em paralelo.
 */
const T = 'c0a10000-0000-4000-8000-000000000001'
const T2 = 'c0a10000-0000-4000-8000-000000000002'
const PV = 'c0a10000-1111-4000-8000-000000000001'
const PV2 = 'c0a10000-1111-4000-8000-000000000002'
const PLANO = 'c0a10000-3333-4000-8000-000000000001'
const MODELO = 'c0a10000-4444-4000-8000-000000000001'
const NAO_OFICIAL = 'c0a10000-5555-4000-8000-000000000001'
const OFICIAL = 'c0a10000-5555-4000-8000-000000000002'
const CANAL_T2 = 'c0a10000-5555-4000-8000-000000000003'
const U_ADMIN = 'c0a10000-6666-4000-8000-000000000001'
const SUB = `dev-${T}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const get = (url: string, tenant = T) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
const papel = (u: string, p: string) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${u}, NULL, ${p})
       ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`
const idDoUsuarioDev = async () =>
  (await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND cognito_sub = ${SUB}`)[0]?.id

interface ItemCanal {
  id: string; podeParear: boolean; modoAgente: string
  modoAgenteNumero: string; modoAgenteOrigem: string; modoAgenteMotivo: string | null
  telefoneMascarado: string | null; identificadorMascarado: string | null
  ativasSuspensas: { desde: string; motivo: string | null } | null
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.CREDENCIAL_CHAVE ??= 'chave-de-teste-com-mais-de-32-caracteres-aqui'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-canal-qr', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-canal-qr', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [tenant, perfil, nome] of [[T, PV, 'Loja QR'], [T2, PV2, 'Loja QR Vizinha']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${tenant}, ${nome}, ${PLANO}, ${perfil}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${tenant}, ${perfil}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  // ⚠️ Sem credencial de propósito: o QR de quem PASSA na checagem de papel
  //    para em 422 (credencial ausente) sem ir à rede do fornecedor.
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${NAO_OFICIAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja (QR)', 'conectando')`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, identificador_externo)
             VALUES (${T}, ${OFICIAL}, 'whatsapp_oficial', 'meta_oficial', 'Loja (Meta)', 'conectado', 'pnid-c0a1-106540352242922')`
  await dono`INSERT INTO numero_whatsapp (tenant_id, canal_id, telefone_e164, waba_id, phone_number_id)
             VALUES (${T}, ${OFICIAL}, '+5585998617049', 'waba-c0a1', 'pnid-c0a1-106540352242922')`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo) VALUES (${T}, ${NAO_OFICIAL}, 'assistido')`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T2}, ${CANAL_T2}, 'whatsapp_nao_oficial', 'plugzapi', 'Vizinha', 'conectado')`
  // Um admin "de verdade" em T — encerra o modo fundador para os demais.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             VALUES (${T}, ${U_ADMIN}, 'sub-admin-canal-qr', 'Ada', 'ada@qr.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM staff_sessao WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM agente_config WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM agente_tenant WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM numero_whatsapp WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${T2})`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('QR de pareamento — só admin', () => {
  it('⚠️ a LISTAGEM não escreve: sem linha de usuário, podeParear=false e nenhuma linha criada', async () => {
    expect(await idDoUsuarioDev()).toBeUndefined()
    const lista = await get('/v1/canais')
    expect(lista.statusCode).toBe(200)
    expect((lista.json() as { podeParear: boolean }).podeParear).toBe(false)
    expect(await idDoUsuarioDev()).toBeUndefined()
  })

  it('⚠️ modo fundador no PRIMEIRO acesso ao QR: a linha de usuário é garantida antes do papel', async () => {
    // Nenhuma linha de usuário para o sub dev ainda (sem batimento de presença).
    expect(await idDoUsuarioDev()).toBeUndefined()
    const r = await get(`/v1/canais/${NAO_OFICIAL}/qrcode`)
    // Passou na checagem de papel; parou na credencial ausente — sem rede.
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'canal.credencial_ausente' })
    expect(await idDoUsuarioDev()).toBeDefined()
  })

  it('dado GESTOR num tenant com admin, então 403 no QR — e a listagem diz podeParear=false', async () => {
    await papel(U_ADMIN, 'admin')
    await papel((await idDoUsuarioDev())!, 'gestor')

    const r = await get(`/v1/canais/${NAO_OFICIAL}/qrcode`)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente', exige: ['admin'] })

    const lista = await get('/v1/canais')
    expect(lista.statusCode).toBe(200)
    const corpo = lista.json() as { podeParear: boolean; itens: ItemCanal[] }
    expect(corpo.podeParear).toBe(false)
    // O gestor continua VENDO o estado de todos os números.
    expect(corpo.itens.map((i) => i.id).sort()).toEqual([NAO_OFICIAL, OFICIAL].sort())
    expect(corpo.itens.every((i) => i.podeParear === false)).toBe(true)
  })

  it('403 vem antes de revelar se o canal existe (id de outro tenant ou inexistente)', async () => {
    expect((await get(`/v1/canais/${CANAL_T2}/qrcode`)).statusCode).toBe(403)
  })

  it('dado ADMIN, então passa no QR e podeParear vale só no não-oficial', async () => {
    await papel((await idDoUsuarioDev())!, 'admin')
    expect((await get(`/v1/canais/${NAO_OFICIAL}/qrcode`)).statusCode).toBe(422)

    const corpo = (await get('/v1/canais')).json() as { podeParear: boolean; itens: ItemCanal[] }
    expect(corpo.podeParear).toBe(true)
    const porId = Object.fromEntries(corpo.itens.map((i) => [i.id, i]))
    expect(porId[NAO_OFICIAL]!.podeParear).toBe(true)
    // ⚠️ No oficial não há QR: a conexão é gerida no Meta Business.
    expect(porId[OFICIAL]!.podeParear).toBe(false)
  })

  it('admin com canal de OUTRO tenant: 404 (RLS), nunca o QR do vizinho', async () => {
    expect((await get(`/v1/canais/${CANAL_T2}/qrcode`)).statusCode).toBe(404)
  })

  it('papel retirado deixa de valer na próxima requisição', async () => {
    await papel((await idDoUsuarioDev())!, 'vendedor')
    expect((await get(`/v1/canais/${NAO_OFICIAL}/qrcode`)).statusCode).toBe(403)
  })

  it('sessão de STAFF vale admin (tenant estrito) e NÃO cria linha em usuario', async () => {
    const STAFF_SUB = 'staff-sub-canal-qr'
    const { token } = await comTenantServico(T, (tx) =>
      abrirSessaoStaff(tx, { atorSub: STAFF_SUB, atorEmail: 'staff@gera3.test', motivo: 'teste P10' }))
    const comStaff = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })

    // Passa na checagem de papel (para na credencial ausente, sem rede).
    expect((await comStaff(`/v1/canais/${NAO_OFICIAL}/qrcode`)).statusCode).toBe(422)
    const lista = (await comStaff('/v1/canais')).json() as { podeParear: boolean }
    expect(lista.podeParear).toBe(true)
    const linhas = await dono`SELECT 1 FROM usuario WHERE tenant_id = ${T} AND cognito_sub = ${STAFF_SUB}`
    expect(linhas).toHaveLength(0)
  })
})

describe('Listagem — dados mascarados, modo do agente, ativas', () => {
  it('⚠️ telefone e identificador saem MASCARADOS; o valor completo não aparece no corpo', async () => {
    const r = await get('/v1/canais')
    const porId = Object.fromEntries((r.json() as { itens: ItemCanal[] }).itens.map((i) => [i.id, i]))
    expect(porId[OFICIAL]!.telefoneMascarado).toBe('+55 (85) •••••-7049')
    expect(porId[OFICIAL]!.identificadorMascarado).toBe('••••2922')
    expect(r.body).not.toContain('998617049')
    expect(r.body).not.toContain('106540352242922')
    expect(porId[NAO_OFICIAL]!.telefoneMascarado).toBeNull()
  })

  it('modo do agente vem do agente_config; sem linha = desligado', async () => {
    const porId = Object.fromEntries(((await get('/v1/canais')).json() as { itens: ItemCanal[] }).itens.map((i) => [i.id, i]))
    expect(porId[NAO_OFICIAL]!.modoAgente).toBe('assistido')
    expect(porId[OFICIAL]!.modoAgente).toBe('desligado')
  })

  it('(s) a lista mostra o modo EFETIVO: sob o kill switch, origem = teto da conta (tenant); o configurado fica em modoAgenteNumero', async () => {
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'sombra')`
    try {
      const porId = Object.fromEntries(((await get('/v1/canais')).json() as { itens: ItemCanal[] }).itens.map((i) => [i.id, i]))
      expect(porId[NAO_OFICIAL]).toMatchObject({ modoAgente: 'sombra', modoAgenteNumero: 'assistido', modoAgenteOrigem: 'tenant', modoAgenteMotivo: 'teto_do_tenant' })
      expect(porId[OFICIAL]).toMatchObject({ modoAgente: 'desligado', modoAgenteNumero: 'desligado', modoAgenteOrigem: 'numero' })
    } finally {
      await dono`DELETE FROM agente_tenant WHERE tenant_id = ${T}`
    }
    const depois = Object.fromEntries(((await get('/v1/canais')).json() as { itens: ItemCanal[] }).itens.map((i) => [i.id, i]))
    expect(depois[NAO_OFICIAL]).toMatchObject({ modoAgente: 'assistido', modoAgenteOrigem: 'numero', modoAgenteMotivo: null })
  })

  it('ativas suspensas: tolerante antes da 0101 (null), e lida quando a coluna existe', async () => {
    const porId = Object.fromEntries(((await get('/v1/canais')).json() as { itens: ItemCanal[] }).itens.map((i) => [i.id, i]))
    // Antes ou depois da 0101, sem suspensão o valor é null — e a rota não quebra.
    expect(porId[NAO_OFICIAL]!.ativasSuspensas).toBeNull()
  })

  it('ativasSuspensasDe — regra pura sobre a linha em jsonb', () => {
    expect(ativasSuspensasDe({})).toBeNull()
    expect(ativasSuspensasDe(null)).toBeNull()
    expect(ativasSuspensasDe({ ativas_suspensas_em: null })).toBeNull()
    expect(ativasSuspensasDe({ ativas_suspensas_em: '2026-10-17T12:00:00+00:00', ativas_suspensas_motivo: 'qualidade_vermelha' }))
      .toEqual({ desde: '2026-10-17T12:00:00.000Z', motivo: 'qualidade_vermelha' })
  })
})
