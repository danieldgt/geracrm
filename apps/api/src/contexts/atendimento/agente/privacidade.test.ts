import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasPrivacidade, validarPrivacidade } from './rotas-privacidade.js'
import { registrarAvisoSeExibido, lerPrivacidade } from './privacidade.js'
import { registrarOptOut, contatoBloqueado } from '../../crm/opt-out.js'

/**
 * PRIVACIDADE E OPT-OUT (raia P4) com DOIS tenants, sob o papel da aplicação
 * (`DATABASE_URL` = geracrm_api, sem BYPASSRLS): aviso só com envio ok,
 * configuração só por admin, listagem por cursor e nada atravessa tenant.
 */
const A = 'b4b40000-0000-4000-8000-000000000001'
const B = 'b4b40000-0000-4000-8000-000000000002'
const PV_A = 'b4b40000-1111-4000-8000-000000000001'
const PV_B = 'b4b40000-1111-4000-8000-000000000002'
const PLANO = 'b4b40000-3333-4000-8000-000000000001'
const MODELO = 'b4b40000-4444-4000-8000-000000000001'
const CANAL: Record<string, string> = { [A]: 'b4b40000-5555-4000-8000-000000000001', [B]: 'b4b40000-5555-4000-8000-000000000002' }
const CONTATO: Record<string, string> = { [A]: 'b4b40000-6666-4000-8000-000000000001', [B]: 'b4b40000-6666-4000-8000-000000000002' }
const CONVERSA: Record<string, string> = { [A]: 'b4b40000-7777-4000-8000-000000000001', [B]: 'b4b40000-7777-4000-8000-000000000002' }
const U_ADMIN = 'b4b40000-8888-4000-8000-000000000001'
const U_VENDEDOR = 'b4b40000-8888-4000-8000-000000000002'
const CHAVE: Record<string, string> = { [A]: '5585977770401', [B]: '5585977770402' }

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const pedir = (t: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-tenant-id': t }, ...(payload ? { payload: payload as object } : {}) })

const registrar = (t: string, texto: string, envio: { ok: true; mensagemId: string } | { ok: false }) =>
  comTenantServico(t, (tx) => registrarAvisoSeExibido(tx, {
    envio, contatoId: CONTATO[t]!, conversaId: CONVERSA[t]!, canalId: CANAL[t]!, texto, origem: 'agente', agora: new Date(),
  }))

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-privacidade', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-privacidade', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Privacidade ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${CANAL[t]!}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${CONTATO[t]!}, 'Cliente', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${CONTATO[t]!}, 1, ${CHAVE[t]!}, ${CHAVE[t]!}, true, true, 'teste') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${CONVERSA[t]!}, ${CANAL[t]!}, ${CONTATO[t]!}, 1) ON CONFLICT DO NOTHING`
  }
  // Tenant A: um admin (sub de outra pessoa) e quem chama pela rota (sub dev) como VENDEDOR.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, 'sub-admin-privacidade', 'Ada', 'ada@p.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_VENDEDOR}, ${`dev-${A}`}, 'Vito', 'vito@p.test') ON CONFLICT DO NOTHING`

  app = Fastify()
  await app.register(pluginTenant)
  await app.register(rotasPrivacidade)
  await app.ready()
})
beforeEach(async () => {
  for (const t of ['aviso_privacidade', 'tenant_privacidade', 'lista_bloqueio', 'consentimento_contato', 'usuario_filial']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
})
afterAll(async () => {
  for (const t of ['aviso_privacidade', 'tenant_privacidade', 'lista_bloqueio', 'consentimento_contato', 'auditoria', 'usuario_filial', 'usuario', 'conversa', 'contato_telefone', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('registrarAvisoSeExibido — prova, não suposição', () => {
  it('dado envio recusado, então NÃO registra — nem com o texto do aviso', async () => {
    const r = await registrar(A, 'Esta conversa fica registrada para te atender melhor.', { ok: false })
    expect(r).toEqual({ registrado: false, motivo: 'envio_nao_ok' })
    expect((await dono`SELECT 1 FROM aviso_privacidade WHERE tenant_id = ${A}`).length).toBe(0)
  })

  it('dado envio ok sem o aviso no texto, então não registra; com o link configurado, registra uma vez por mensagem', async () => {
    await dono`INSERT INTO tenant_privacidade (tenant_id, url, versao) VALUES (${A}, 'https://a.test/priv', 'v3')`
    const msg = crypto.randomUUID()
    expect(await registrar(A, 'Bom dia! Tem camiseta sim.', { ok: true, mensagemId: msg })).toEqual({ registrado: false, motivo: 'sem_aviso_no_texto' })
    // Sem o LINK configurado, a frase padrão não basta.
    expect(await registrar(A, 'Esta conversa fica registrada.', { ok: true, mensagemId: msg })).toMatchObject({ registrado: false })
    const r = await registrar(A, 'Oi! Aviso de privacidade: https://a.test/priv', { ok: true, mensagemId: msg })
    expect(r).toMatchObject({ registrado: true, versao: 'v3' })
    expect(await registrar(A, 'Oi! Aviso de privacidade: https://a.test/priv', { ok: true, mensagemId: msg })).toEqual({ registrado: false, motivo: 'ja_registrado' })
  })
})

describe('aviso_privacidade é imutável de verdade', () => {
  it('a aplicação não altera nem apaga; nem o dono altera (trigger)', async () => {
    const r = await registrar(A, 'Esta conversa fica registrada para te atender melhor.', { ok: true, mensagemId: crypto.randomUUID() })
    expect(r.registrado).toBe(true)
    await expect(comTenantServico(A, (tx) => tx`UPDATE aviso_privacidade SET versao = 'forjada'`)).rejects.toThrow(/permission denied|imutável/)
    await expect(comTenantServico(A, (tx) => tx`DELETE FROM aviso_privacidade`)).rejects.toThrow(/permission denied/)
    await expect(dono`UPDATE aviso_privacidade SET versao = 'forjada' WHERE tenant_id = ${A}`).rejects.toThrow(/imutável/)
    const [l] = await dono<{ versao: string }[]>`SELECT versao FROM aviso_privacidade WHERE tenant_id = ${A}`
    expect(l!.versao).toBe('padrao')
  })
})

describe('Rotas de privacidade', () => {
  it('GET devolve o padrão quando o tenant nunca configurou', async () => {
    const r = await pedir(A, 'GET', '/v1/privacidade')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ url: null, versao: 'padrao', configurada: false, previa: 'Esta conversa fica registrada para te atender melhor.' })
  })

  it('PUT exige admin: vendedor recebe 403; admin grava, audita {antes, depois} e valida o link', async () => {
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_ADMIN}, NULL, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_VENDEDOR}, NULL, 'vendedor')`
    const corpo = { url: 'https://a.test/privacidade', versao: '2026-10', textoPadrao: 'Tratamos seus dados conforme a LGPD.' }
    const negado = await pedir(A, 'PUT', '/v1/privacidade', corpo)
    expect(negado.statusCode).toBe(403)
    expect(negado.json().erro).toBe('acesso.papel_insuficiente')

    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE tenant_id = ${A} AND usuario_id = ${U_VENDEDOR}`
    expect((await pedir(A, 'PUT', '/v1/privacidade', { url: 'ftp://x' })).statusCode).toBe(422)
    const ok = await pedir(A, 'PUT', '/v1/privacidade', corpo)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ...corpo, configurada: true, previa: 'Tratamos seus dados conforme a LGPD. Aviso de privacidade: https://a.test/privacidade' })
    const [aud] = await dono<{ dados: { antes: { versao: string }; depois: { versao: string } } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'privacidade.alterada' ORDER BY criado_em DESC LIMIT 1`
    expect(aud!.dados.antes.versao).toBe('padrao')
    expect(aud!.dados.depois.versao).toBe('2026-10')

    // Tenant B não enxerga a configuração de A.
    expect((await pedir(B, 'GET', '/v1/privacidade')).json()).toMatchObject({ configurada: false })
  })

  it('validarPrivacidade é pura e normaliza vazios', () => {
    expect(validarPrivacidade({ url: '  ', versao: '', textoPadrao: '' })).toEqual({ ok: true, url: null, versao: 'padrao', textoPadrao: null })
    expect(validarPrivacidade({ versao: 'x'.repeat(41) })).toMatchObject({ ok: false, campo: 'versao' })
    expect(validarPrivacidade({ textoPadrao: 'x'.repeat(501) })).toMatchObject({ ok: false, campo: 'textoPadrao' })
    // O aviso sai antes de qualquer ferramenta: valor ou percentual seria número sem fonte.
    for (const t of ['Frete grátis acima de R$ 500,00.', 'Ganhe 10% no próximo pedido.', 'Taxa de R$5.'])
      expect(validarPrivacidade({ textoPadrao: t })).toMatchObject({ ok: false, campo: 'textoPadrao' })
    expect(validarPrivacidade({ textoPadrao: 'Seus dados ficam guardados por 5 anos, conforme a LGPD.' })).toMatchObject({ ok: true })
  })

  it('avisos por contato exigem gestor/admin (prova LGPD): vendedor recebe 403, gestor lê', async () => {
    await registrar(A, 'Esta conversa fica registrada para te atender melhor.', { ok: true, mensagemId: crypto.randomUUID() })
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_ADMIN}, NULL, 'admin')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_VENDEDOR}, NULL, 'vendedor')`
    const negado = await pedir(A, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade`)
    expect(negado.statusCode).toBe(403)
    expect(negado.json().erro).toBe('acesso.papel_insuficiente')
    await dono`UPDATE usuario_filial SET papel = 'gestor' WHERE tenant_id = ${A} AND usuario_id = ${U_VENDEDOR}`
    const ok = await pedir(A, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().itens).toHaveLength(1)
  })

  it('avisos por contato: paginados por cursor, sem repetir nem perder, e sem atravessar tenant', async () => {
    for (let i = 0; i < 23; i += 1) await registrar(A, 'Esta conversa fica registrada para te atender melhor.', { ok: true, mensagemId: crypto.randomUUID() })
    await registrar(B, 'Esta conversa fica registrada para te atender melhor.', { ok: true, mensagemId: crypto.randomUUID() })
    const p1 = (await pedir(A, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade`)).json()
    expect(p1.itens).toHaveLength(20)
    expect(p1.proximoCursor).toBeTruthy()
    const p2 = (await pedir(A, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade?cursor=${p1.proximoCursor}`)).json()
    expect(p2.itens).toHaveLength(3)
    expect(p2.proximoCursor).toBeNull()
    expect(new Set([...p1.itens, ...p2.itens].map((x: { id: string }) => x.id)).size).toBe(23)
    // B pedindo o contato de A: nada (RLS), não 500.
    const cruzado = await pedir(B, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade`)
    expect(cruzado.statusCode).toBe(200)
    expect(cruzado.json().itens).toHaveLength(0)
    expect((await pedir(A, 'GET', `/v1/contatos/${CONTATO[A]}/avisos-privacidade?cursor=lixo`)).statusCode).toBe(422)
  })
})

describe('RLS das tabelas novas e do opt-out — dois tenants', () => {
  it('tenant A não lê nem grava aviso/privacidade de B; sem tenant, zero linhas', async () => {
    await registrar(B, 'Esta conversa fica registrada para te atender melhor.', { ok: true, mensagemId: crypto.randomUUID() })
    await dono`INSERT INTO tenant_privacidade (tenant_id, versao) VALUES (${B}, 'vb')`
    const vistos = await comTenantServico(A, (tx) => tx`SELECT 1 FROM aviso_privacidade`)
    expect(vistos.length).toBe(0)
    expect((await comTenantServico(A, (tx) => lerPrivacidade(tx))).versao).toBe('padrao')
    await expect(comTenantServico(A, (tx) => tx`
      INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
      VALUES (${B}, gen_random_uuid(), ${CONTATO[B]!}, ${CONVERSA[B]!}, ${CANAL[B]!}, gen_random_uuid(), 'x', 'v', 'agente')`)).rejects.toThrow()
    await expect(comTenantServico(A, (tx) => tx`INSERT INTO tenant_privacidade (tenant_id, versao) VALUES (${B}, 'invasor')`)).rejects.toThrow()
    const semTenant = await dono.begin(async (tx) => {
      await tx`SET LOCAL ROLE geracrm_app`
      return tx`SELECT 1 FROM aviso_privacidade UNION ALL SELECT 1 FROM tenant_privacidade`
    })
    expect(semTenant.length).toBe(0)
  })

  it('opt-out de um tenant não bloqueia o mesmo contato/número em outro, e é idempotente', async () => {
    await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: CONTATO[A]!, origem: 'agente', agora: new Date() }))
    const de2 = await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: CONTATO[A]!, origem: 'agente', agora: new Date() }))
    expect(de2.chaves).toEqual([])
    // ⚠️ Tentar bloquear o contato de B a partir de A não alcança nada.
    const cruzado = await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: CONTATO[B]!, origem: 'agente', agora: new Date() }))
    expect(cruzado.chaves).toEqual([])
    expect(await comTenantServico(A, (tx) => contatoBloqueado(tx, CONTATO[A]!))).toBe(true)
    expect(await comTenantServico(B, (tx) => contatoBloqueado(tx, CONTATO[B]!))).toBe(false)
    const [b] = await dono<{ recebe_campanhas: boolean }[]>`SELECT recebe_campanhas FROM contato WHERE id = ${CONTATO[B]!}`
    expect(b!.recebe_campanhas).toBe(true)
  })
})
