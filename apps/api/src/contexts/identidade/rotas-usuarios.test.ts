import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasUsuarios } from './rotas-usuarios.js'
import { rotasFiliais } from './rotas-filiais.js'
import { ProvedorIdentidadeFalso } from './provedor-identidade-falso.js'

/**
 * CADASTRO DE USUÁRIOS E FILIAIS (D3) — banco real sob o papel da aplicação,
 * DOIS tenants, provedor de identidade FALSO (nenhuma chamada à AWS).
 *
 * Identidade: `x-teste-sub` vira `usuarioSub` (como o Cognito faria).
 */
const A = 'd3a00000-0000-4000-8000-00000000000a'
const B = 'd3a00000-0000-4000-8000-00000000000b'
const PLANO = 'd3a00000-0001-4000-8000-000000000001'
const MODELO = 'd3a00000-0002-4000-8000-000000000001'
const PV_A = 'd3a00000-0003-4000-8000-00000000000a'
const PV_B = 'd3a00000-0003-4000-8000-00000000000b'
const ADM_A = 'd3a00000-0005-4000-8000-000000000001'
const VEND_A = 'd3a00000-0005-4000-8000-000000000002'
const ADM_B = 'd3a00000-0005-4000-8000-000000000003'
const SUB = { admA: 'd3a-sub-adm-a', vendA: 'd3a-sub-vend-a', admB: 'd3a-sub-adm-b' }

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const provedor = new ProvedorIdentidadeFalso()
let app: FastifyInstance

async function pedir(quem: keyof typeof SUB, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const headers = { 'x-tenant-id': quem === 'admB' ? B : A, 'x-teste-sub': SUB[quem] }
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> }
}

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-usuarios-d3', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-usuarios-d3', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Usuarios A'], [B, PV_B, 'Usuarios B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv})`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo')`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
    (${A}, ${ADM_A}, ${SUB.admA}, 'Ana Admin', ${SUB.admA + '@d3a.test'}),
    (${A}, ${VEND_A}, ${SUB.vendA}, 'Vitor Vendas', ${SUB.vendA + '@d3a.test'}),
    (${B}, ${ADM_B}, ${SUB.admB}, 'Bia Admin', ${SUB.admB + '@d3a.test'})`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${A}, ${ADM_A}, NULL, 'admin'), (${A}, ${VEND_A}, NULL, 'vendedor'), (${B}, ${ADM_B}, NULL, 'admin')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@d3a.test` }
  })
  await app.register(rotasUsuarios, { provedor })
  await app.register(rotasFiliais)
  await app.ready()
})

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

let filialX = ''
let novoId = ''

describe('acesso: só admin', () => {
  it('vendedor → 403 em todas as rotas de cadastro', async () => {
    for (const [m, url] of [['GET', '/v1/usuarios'], ['POST', '/v1/usuarios'], ['PATCH', `/v1/usuarios/${ADM_A}`],
      ['POST', `/v1/usuarios/${ADM_A}/redefinir-senha`], ['GET', '/v1/filiais'], ['POST', '/v1/filiais'], ['PATCH', `/v1/filiais/${ADM_A}`]] as const) {
      const r = await pedir('vendA', m, url, m === 'GET' ? undefined : { nome: 'x' })
      expect(r.status, `${m} ${url}`).toBe(403)
      expect(r.corpo.erro).toBe('acesso.papel_insuficiente')
    }
  })
})

describe('filiais', () => {
  it('cria, lista por cursor e edita; matriz única; cor e tipo validados', async () => {
    const m = await pedir('admA', 'POST', '/v1/filiais', { nome: 'Matriz Recife', tipo: 'matriz', cor: '#1A2B3C', uf: 'pe' })
    expect(m.status).toBe(201)
    const x = await pedir('admA', 'POST', '/v1/filiais', { nome: 'Filial Caruaru', cidade: 'Caruaru' })
    expect(x.status).toBe(201)
    filialX = x.corpo.id as string

    const dup = await pedir('admA', 'POST', '/v1/filiais', { nome: 'Outra matriz', tipo: 'matriz' })
    expect(dup.status).toBe(409)
    expect(dup.corpo.erro).toBe('filial.matriz_duplicada')
    expect((await pedir('admA', 'POST', '/v1/filiais', { nome: 'Cor ruim', cor: 'azul' })).corpo.erro).toBe('filial.cor_invalida')
    expect((await pedir('admA', 'POST', '/v1/filiais', { nome: 'Tipo ruim', tipo: 'loja' })).corpo.erro).toBe('filial.tipo_invalido')
    expect((await pedir('admA', 'POST', '/v1/filiais', {})).corpo.erro).toBe('filial.nome_obrigatorio')

    const lista = await pedir('admA', 'GET', '/v1/filiais')
    const itens = lista.corpo.itens as { nome: string; tipo: string; uf: string | null; cor: string | null; ativa: boolean }[]
    expect(itens.map((f) => f.nome)).toEqual(['Filial Caruaru', 'Matriz Recife'])
    expect(itens[1]).toMatchObject({ tipo: 'matriz', uf: 'PE', cor: '#1A2B3C', ativa: true })
    expect(lista.corpo.proximoCursor).toBeNull()

    expect((await pedir('admA', 'PATCH', `/v1/filiais/${filialX}`, { ativa: false, cor: '#00FF00' })).status).toBe(200)
    const [f] = await dono<{ ativa: boolean; cor: string }[]>`SELECT ativa, cor FROM filial WHERE tenant_id = ${A} AND id = ${filialX}`
    expect(f).toEqual({ ativa: false, cor: '#00FF00' })
    expect((await pedir('admA', 'PATCH', `/v1/filiais/${filialX}`, { tipo: 'matriz' })).corpo.erro).toBe('filial.matriz_duplicada')
  })

  it('outro tenant não lista nem edita a filial de A (404)', async () => {
    expect((await pedir('admB', 'GET', '/v1/filiais')).corpo.itens).toEqual([])
    expect((await pedir('admB', 'PATCH', `/v1/filiais/${filialX}`, { nome: 'Roubada' })).status).toBe(404)
  })
})

describe('usuários', () => {
  it('cria no provedor + usuario + usuario_filial; aparece na lista com os papéis por filial', async () => {
    const r = await pedir('admA', 'POST', '/v1/usuarios', {
      nome: 'Carla Campo', email: 'Carla@Exemplo.com', telefone: '81999990000', cargo: 'Vendedora externa',
      papeis: [{ papel: 'vendedor', filialId: filialX }, { papel: 'atendente', filialId: null }],
    })
    expect(r.status).toBe(201)
    novoId = r.corpo.id as string
    expect(provedor.usuarios.get('carla@exemplo.com')?.tenantId).toBe(A)
    const [u] = await dono<{ email: string; cognito_sub: string; cargo: string; telefone: string }[]>`
      SELECT email, cognito_sub, cargo, telefone FROM usuario WHERE tenant_id = ${A} AND id = ${novoId}`
    expect(u).toMatchObject({ email: 'carla@exemplo.com', cargo: 'Vendedora externa', telefone: '81999990000' })
    expect(u!.cognito_sub).toBe(provedor.usuarios.get('carla@exemplo.com')!.sub)

    const lista = await pedir('admA', 'GET', '/v1/usuarios?busca=carla')
    const [item] = lista.corpo.itens as { id: string; papeis: { papel: string; filialId: string | null; filial: string | null }[]; ativo: boolean; ultimoLoginEm: unknown }[]
    expect(item!.id).toBe(novoId)
    expect(item!.ativo).toBe(true)
    expect(item!.ultimoLoginEm).toBeNull()
    expect(item!.papeis).toEqual([
      { papel: 'atendente', filialId: null, filial: null },
      { papel: 'vendedor', filialId: filialX, filial: 'Filial Caruaru' },
    ])
    const [aud] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'usuario.criado' AND entidade_id = ${novoId}`
    expect(aud!.n).toBe(1)
  })

  it('e-mail duplicado no tenant → 409 sem chamar o provedor; e-mail já no provedor → 409 próprio', async () => {
    const antes = provedor.chamadas.length
    const dup = await pedir('admA', 'POST', '/v1/usuarios', { nome: 'Outra', email: 'CARLA@exemplo.com' })
    expect(dup.status).toBe(409)
    expect(dup.corpo.erro).toBe('usuario.email_duplicado')
    expect(provedor.chamadas.length).toBe(antes)

    // Já tem login (de outra empresa: o tenant no provedor é imutável).
    await provedor.criarUsuario({ email: 'ja@outra.com', nome: 'X', tenantId: B })
    const emUso = await pedir('admA', 'POST', '/v1/usuarios', { nome: 'Já', email: 'ja@outra.com' })
    expect(emUso.status).toBe(409)
    expect(emUso.corpo.erro).toBe('usuario.email_em_uso')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM usuario WHERE tenant_id = ${A} AND email = 'ja@outra.com'`
    expect(n!.n).toBe(0)
  })

  it('validações tipificadas e provedor indisponível → 503 sem gravar nada', async () => {
    expect((await pedir('admA', 'POST', '/v1/usuarios', { email: 'a@b.com' })).corpo.erro).toBe('usuario.nome_obrigatorio')
    expect((await pedir('admA', 'POST', '/v1/usuarios', { nome: 'X', email: 'nao-e-email' })).corpo.erro).toBe('usuario.email_invalido')
    expect((await pedir('admA', 'POST', '/v1/usuarios', { nome: 'X', email: 'x@y.com', papeis: [{ papel: 'rei' }] })).corpo.erro).toBe('usuario.papel_invalido')
    expect((await pedir('admA', 'POST', '/v1/usuarios', { nome: 'X', email: 'x@y.com', papeis: [{ papel: 'vendedor', filialId: null }, { papel: 'gestor', filialId: null }] })).corpo.erro).toBe('usuario.papeis_duplicados')
    // Filial de OUTRO tenant não existe para A.
    const [fb] = await dono<{ id: string }[]>`INSERT INTO filial (tenant_id, id, nome) VALUES (${B}, gen_random_uuid(), 'Filial B') RETURNING id`
    const filialDeB = await pedir('admA', 'POST', '/v1/usuarios', { nome: 'X', email: 'x@y.com', papeis: [{ papel: 'vendedor', filialId: fb!.id }] })
    expect(filialDeB.status).toBe(422)
    expect(filialDeB.corpo.erro).toBe('usuario.filial_invalida')
    expect((await pedir('admA', 'POST', '/v1/usuarios', { nome: 'X', email: 'x@y.com', senhaTemporaria: '123' })).corpo.erro).toBe('usuario.senha_invalida')

    provedor.indisponivel = true
    const r = await pedir('admA', 'POST', '/v1/usuarios', { nome: 'Sem IdP', email: 'semidp@exemplo.com' })
    provedor.indisponivel = false
    expect(r.status).toBe(503)
    expect(r.corpo.erro).toBe('identidade.indisponivel')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM usuario WHERE tenant_id = ${A} AND email = 'semidp@exemplo.com'`
    expect(n!.n).toBe(0)
  })

  it('edita dados e substitui os papéis; desativa e reativa (no banco E no provedor)', async () => {
    const r = await pedir('admA', 'PATCH', `/v1/usuarios/${novoId}`, { cargo: 'Gerente', papeis: [{ papel: 'gestor', filialId: filialX }] })
    expect(r.status).toBe(200)
    const vinc = await dono<{ papel: string; filial_id: string | null }[]>`SELECT papel, filial_id FROM usuario_filial WHERE tenant_id = ${A} AND usuario_id = ${novoId}`
    expect(vinc).toEqual([{ papel: 'gestor', filial_id: filialX }])

    const des = await pedir('admA', 'PATCH', `/v1/usuarios/${novoId}`, { ativo: false })
    expect(des.status).toBe(200)
    expect(des.corpo.provedor).toBe('ok')
    expect(provedor.usuarios.get('carla@exemplo.com')!.ativo).toBe(false)
    const [u] = await dono<{ ativo: boolean }[]>`SELECT ativo FROM usuario WHERE tenant_id = ${A} AND id = ${novoId}`
    expect(u!.ativo).toBe(false)

    expect((await pedir('admA', 'PATCH', `/v1/usuarios/${novoId}`, { ativo: true })).status).toBe(200)
    expect(provedor.usuarios.get('carla@exemplo.com')!.ativo).toBe(true)
    expect((await pedir('admA', 'PATCH', `/v1/usuarios/${novoId}`, {})).corpo.erro).toBe('usuario.nada_a_mudar')
  })

  it('redefinir senha: senha temporária vai ao provedor', async () => {
    expect((await pedir('admA', 'POST', `/v1/usuarios/${novoId}/redefinir-senha`, { senhaTemporaria: 'Temp#2026x' })).status).toBe(200)
    expect(provedor.usuarios.get('carla@exemplo.com')!.senhaTemporaria).toBe('Temp#2026x')
  })

  it('o ÚLTIMO admin ativo não se rebaixa nem se desativa (422); com outro admin, pode', async () => {
    const rebaixa = await pedir('admA', 'PATCH', `/v1/usuarios/${ADM_A}`, { papeis: [{ papel: 'vendedor', filialId: null }] })
    expect(rebaixa.status).toBe(422)
    expect(rebaixa.corpo.erro).toBe('usuario.ultimo_admin')
    const desativa = await pedir('admA', 'PATCH', `/v1/usuarios/${ADM_A}`, { ativo: false })
    expect(desativa.status).toBe(422)
    expect(desativa.corpo.erro).toBe('usuario.ultimo_admin')
    const [ainda] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM usuario_filial WHERE tenant_id = ${A} AND usuario_id = ${ADM_A} AND papel = 'admin'`
    expect(ainda!.n).toBe(1)

    // Promove a Carla a admin → agora a Ana pode deixar de ser.
    expect((await pedir('admA', 'PATCH', `/v1/usuarios/${novoId}`, { papeis: [{ papel: 'admin', filialId: null }] })).status).toBe(200)
    expect((await pedir('admA', 'PATCH', `/v1/usuarios/${ADM_A}`, { papeis: [{ papel: 'gestor', filialId: null }] })).status).toBe(200)
    // E a Ana, sem admin, perde o acesso ao cadastro na hora.
    expect((await pedir('admA', 'GET', '/v1/usuarios')).status).toBe(403)
  })

  it('login bem-sucedido carimba usuario.ultimo_login_em (pelo sub e tenant do ID token)', async () => {
    const { rotasAuth } = await import('./rotas-auth.js')
    const fetchOriginal = globalThis.fetch
    process.env.COGNITO_CLIENT_ID = 'cid-d3a'
    process.env.COGNITO_CLIENT_SECRET = 'segredo-d3a'
    const payload = Buffer.from(JSON.stringify({ sub: SUB.vendA, 'custom:tenant_id': A })).toString('base64url')
    globalThis.fetch = (async () => ({
      status: 200, json: async () => ({ AuthenticationResult: { IdToken: `cab.${payload}.ass`, ExpiresIn: 3600 } }),
    })) as unknown as typeof fetch
    const auth = Fastify()
    try {
      await auth.register(rotasAuth)
      const r = await auth.inject({ method: 'POST', url: '/v1/auth/login', payload: { usuario: 'v@d3a.test', senha: 'x' } })
      expect(r.statusCode).toBe(200)
    } finally {
      globalThis.fetch = fetchOriginal
      delete process.env.COGNITO_CLIENT_ID
      delete process.env.COGNITO_CLIENT_SECRET
      await auth.close()
    }
    const [u] = await dono<{ recente: boolean }[]>`
      SELECT ultimo_login_em > now() - interval '1 minute' AS recente FROM usuario WHERE tenant_id = ${A} AND id = ${VEND_A}`
    expect(u!.recente).toBe(true)
  })

  it('dois tenants: admin de B não vê nem edita usuário de A', async () => {
    const lista = await pedir('admB', 'GET', '/v1/usuarios')
    expect((lista.corpo.itens as { id: string }[]).map((u) => u.id)).toEqual([ADM_B])
    expect((await pedir('admB', 'PATCH', `/v1/usuarios/${novoId}`, { nome: 'Roubada' })).status).toBe(404)
    expect((await pedir('admB', 'POST', `/v1/usuarios/${novoId}/redefinir-senha`, { senhaTemporaria: 'Temp#2026x' })).status).toBe(404)
  })
})
