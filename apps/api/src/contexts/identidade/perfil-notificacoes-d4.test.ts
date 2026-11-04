import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasAuth } from './rotas-auth.js'
import { rotasPerfil } from './rotas-perfil.js'
import { ProvedorSenhaFalso } from './provedor-senha-falso.js'
import { rotasNotificacoes } from '../atendimento/rotas-notificacoes.js'
import { rotasNotificacoesPreferencias } from '../atendimento/rotas-notificacoes-preferencias.js'
import { notificarPessoasDaConversa } from '../atendimento/notificacao.js'
import { definirArquivosBucket, type ArquivosBucket } from '../crm/arquivos-bucket.js'
import { despacharPushDoTenant, type EnviarPush } from '../plataforma/push.js'
import { despacharEmailsDoTenant, EmailEmMemoria } from '../plataforma/email-notificacao.js'

/**
 * D4 — notificações (página, preferências), meu perfil, troca de senha, "esqueci a senha" e a
 * auditoria de login/logout. Banco real sob o papel da aplicação, DOIS tenants, provedor de senha
 * FALSO e bucket em memória: nenhum teste chama a AWS nem o S3.
 */
const A = 'd4a00000-0000-4000-8000-00000000000a'
const B = 'd4a00000-0000-4000-8000-00000000000b'
const PLANO = 'd4a00000-0001-4000-8000-000000000001'
const MODELO = 'd4a00000-0002-4000-8000-000000000001'
const PV_A = 'd4a00000-0003-4000-8000-00000000000a'
const PV_B = 'd4a00000-0003-4000-8000-00000000000b'
const U_A1 = 'd4a00000-0005-4000-8000-000000000001'
const U_A2 = 'd4a00000-0005-4000-8000-000000000002'
const U_B1 = 'd4a00000-0005-4000-8000-000000000003'
const CANAL = 'd4a00000-0006-4000-8000-000000000001'
const CONTATO = 'd4a00000-0007-4000-8000-000000000001'
const CONVERSA = 'd4a00000-0008-4000-8000-000000000001'
const SUB = { a1: 'd4-sub-a1', a2: 'd4-sub-a2', b1: 'd4-sub-b1' }
const EMAIL = { a1: 'a1@d4.test', a2: 'a2@d4.test', b1: 'b1@d4.test' }

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const senhas = new ProvedorSenhaFalso()
const objetos = new Map<string, Buffer>()
const bucketFalso: ArquivosBucket = {
  disponivel: () => true,
  subir: async (chave, bytes) => { objetos.set(chave, bytes) },
  remover: async (chave) => { objetos.delete(chave) },
  urlAssinada: async () => 'https://bucket.test/objeto?assinada=1',
}
let app: FastifyInstance
const fetchMock = vi.fn()

type Quem = keyof typeof SUB
async function pedir(quem: Quem | 'staff', method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const headers: Record<string, string> = {
    'x-tenant-id': quem === 'b1' ? B : A, 'x-teste-sub': quem === 'staff' ? 'd4-staff' : SUB[quem],
  }
  if (quem === 'staff') headers['x-teste-staff'] = '1'
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  return { status: r.statusCode, corpo: (r.body ? JSON.parse(r.body) : null) as Record<string, any> }
}

/** Multipart montado à mão (sem dependência de form-data). */
async function enviarFoto(quem: Quem, nome: string, mime: string, bytes: Buffer) {
  const limite = '----d4limite'
  const corpo = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="foto"; filename="${nome}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${limite}--\r\n`),
  ])
  const r = await app.inject({
    method: 'PUT', url: '/v1/perfil/foto', payload: corpo,
    headers: { 'x-tenant-id': A, 'x-teste-sub': SUB[quem], 'content-type': `multipart/form-data; boundary=${limite}` },
  })
  return { status: r.statusCode, corpo: JSON.parse(r.body) as Record<string, any> }
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`DELETE FROM notificacao WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_preferencia_notificacao WHERE tenant_id = ${t}`
    await dono`DELETE FROM push_assinatura WHERE tenant_id = ${t}`
    await dono`DELETE FROM push_cursor WHERE tenant_id = ${t}`
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_conectado WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.COGNITO_CLIENT_ID = 'cid-teste'
  process.env.COGNITO_CLIENT_SECRET = 'segredo-teste'
  vi.stubGlobal('fetch', fetchMock)
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-d4', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-d4', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'D4 A'], [B, PV_B, 'D4 B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv})`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo')`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
    (${A}, ${U_A1}, ${SUB.a1}, 'Ana Um', ${EMAIL.a1}),
    (${A}, ${U_A2}, ${SUB.a2}, 'Beto Dois', ${EMAIL.a2}),
    (${B}, ${U_B1}, ${SUB.b1}, 'Bia Outra', ${EMAIL.b1})`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${A}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado')`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${A}, ${CONTATO}, 'Cliente Zé', 'teste', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${A}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0)`
  senhas.semear(EMAIL.a1, 'SenhaAtual#1')
  definirArquivosBucket(bucketFalso)

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = Object.values(EMAIL)[Object.values(SUB).indexOf(s)] ?? `${s}@d4.test` }
    if (req.headers['x-teste-staff'] === '1') req.atorStaff = true
  })
  await app.register(rotasNotificacoes)
  await app.register(rotasNotificacoesPreferencias)
  await app.register(rotasPerfil, { provedorSenha: senhas })
  await app.register(rotasAuth, { provedorSenha: senhas })
  await app.ready()
})

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  definirArquivosBucket()
  vi.unstubAllGlobals()
  await app?.close(); await encerrarBanco(); await dono.end()
})

beforeEach(async () => {
  fetchMock.mockReset()
  await dono`DELETE FROM notificacao WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM usuario_preferencia_notificacao WHERE tenant_id IN (${A}, ${B})`
  await dono`DELETE FROM outbox WHERE tenant_id IN (${A}, ${B})`
})

/** Semeia N notificações do usuário, mais nova por último, com microssegundos distintos. */
async function semear(tenant: string, usuario: string, n: number, tipo = 'mensagem.nova', lidas = 0) {
  for (let i = 0; i < n; i++) {
    await dono`INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, lida_em, criado_em)
               VALUES (${tenant}, gen_random_uuid(), ${usuario}, ${tipo}, ${`aviso ${i}`},
                       ${i < lidas ? dono`now()` : null}, now() - (${n - i} * interval '1 second'))`
  }
}

/** Emite pelo serviço de verdade (o mesmo caminho de SLA, NPS, reatribuição). */
async function emitir(usuarios: string[], tipo: string) {
  await dono.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${A}, true)`
    await notificarPessoasDaConversa(tx as never, usuarios, tipo, 'teste D4', CONVERSA)
  })
}

describe('página Notificações', () => {
  it('cada usuário vê só as PRÓPRIAS (dois usuários, dois tenants)', async () => {
    await semear(A, U_A1, 3); await semear(A, U_A2, 2); await semear(B, U_B1, 4)
    expect((await pedir('a1', 'GET', '/v1/notificacoes')).corpo['itens']).toHaveLength(3)
    expect((await pedir('a2', 'GET', '/v1/notificacoes')).corpo['itens']).toHaveLength(2)
    expect((await pedir('b1', 'GET', '/v1/notificacoes')).corpo['itens']).toHaveLength(4)
    expect((await pedir('a1', 'GET', '/v1/notificacoes/contador')).corpo['naoLidas']).toBe(3)
  })

  it('cursor: duas páginas, sem repetir nem perder', async () => {
    await semear(A, U_A1, 35)
    const p1 = await pedir('a1', 'GET', '/v1/notificacoes')
    expect(p1.corpo['itens']).toHaveLength(30)
    expect(p1.corpo['proximoCursor']).toBeTruthy()
    const p2 = await pedir('a1', 'GET', `/v1/notificacoes?cursor=${p1.corpo['proximoCursor']}`)
    expect(p2.corpo['itens']).toHaveLength(5)
    expect(p2.corpo['proximoCursor']).toBeNull()
    const ids = [...p1.corpo['itens'], ...p2.corpo['itens']].map((i: { id: string }) => i.id)
    expect(new Set(ids).size).toBe(35)
    expect((await pedir('a1', 'GET', '/v1/notificacoes?cursor=lixo')).status).toBe(422)
  })

  it('filtra por lida/não lida e por tipo; filtro inválido é 422', async () => {
    await semear(A, U_A1, 4, 'mensagem.nova', 1)
    await semear(A, U_A1, 2, 'sla.estourado')
    expect((await pedir('a1', 'GET', '/v1/notificacoes?lida=nao')).corpo['itens']).toHaveLength(5)
    expect((await pedir('a1', 'GET', '/v1/notificacoes?lida=sim')).corpo['itens']).toHaveLength(1)
    expect((await pedir('a1', 'GET', '/v1/notificacoes?tipo=sla.estourado')).corpo['itens']).toHaveLength(2)
    expect((await pedir('a1', 'GET', '/v1/notificacoes?lida=talvez')).status).toBe(422)
    expect((await pedir('a1', 'GET', '/v1/notificacoes?tipo=a;b')).status).toBe(422)
  })

  it('marcar uma e marcar todas — só as do próprio usuário', async () => {
    await semear(A, U_A1, 3); await semear(A, U_A2, 2)
    const lista = (await pedir('a1', 'GET', '/v1/notificacoes')).corpo['itens'] as { id: string }[]
    expect((await pedir('a1', 'POST', '/v1/notificacoes/lidas', { ids: [lista[0]!.id] })).corpo['marcadas']).toBe(1)
    expect((await pedir('a1', 'GET', '/v1/notificacoes/contador')).corpo['naoLidas']).toBe(2)
    // a2 tentando marcar a notificação de a1 por id: não marca nada.
    expect((await pedir('a2', 'POST', '/v1/notificacoes/lidas', { ids: [lista[1]!.id] })).corpo['marcadas']).toBe(0)
    expect((await pedir('a1', 'POST', '/v1/notificacoes/lidas', {})).corpo['marcadas']).toBe(2)
    expect((await pedir('a1', 'GET', '/v1/notificacoes/contador')).corpo['naoLidas']).toBe(0)
    expect((await pedir('a2', 'GET', '/v1/notificacoes/contador')).corpo['naoLidas']).toBe(2)
  })
})

describe('preferências por tipo × canal', () => {
  it('sem linha vale o padrão; PUT grava só para o próprio usuário', async () => {
    const g = await pedir('a1', 'GET', '/v1/notificacoes/preferencias')
    const sla = g.corpo['tipos'].find((t: { tipo: string }) => t.tipo === 'sla.estourado')
    expect(sla.canais).toEqual({ app: true, push: true, email: true })
    expect(g.corpo['tipos'].find((t: { tipo: string }) => t.tipo === 'mensagem.nova').canais).toEqual({ app: true, push: true, email: false })

    expect((await pedir('a1', 'PUT', '/v1/notificacoes/preferencias', { itens: [{ tipo: 'mensagem.nova', canal: 'app', ligado: false }] })).status).toBe(200)
    const a1 = await pedir('a1', 'GET', '/v1/notificacoes/preferencias')
    expect(a1.corpo['tipos'].find((t: { tipo: string }) => t.tipo === 'mensagem.nova').canais.app).toBe(false)
    // a2 (mesmo tenant) e b1 (outro tenant) não são afetados.
    for (const q of ['a2', 'b1'] as const) {
      const r = await pedir(q, 'GET', '/v1/notificacoes/preferencias')
      expect(r.corpo['tipos'].find((t: { tipo: string }) => t.tipo === 'mensagem.nova').canais.app).toBe(true)
    }
  })

  it('corpo inválido é 422 tipificado; staff não tem preferências', async () => {
    const ruim = await pedir('a1', 'PUT', '/v1/notificacoes/preferencias', { itens: [{ tipo: 'mensagem.nova', canal: 'email', ligado: true }] })
    expect(ruim.status).toBe(422)
    expect(ruim.corpo['erro']).toBe('preferencia.email_indisponivel')
    expect((await pedir('staff', 'GET', '/v1/notificacoes/preferencias')).status).toBe(403)
  })

  it('app desligado: nada no sino, mas a linha existe para o push', async () => {
    await pedir('a1', 'PUT', '/v1/notificacoes/preferencias', { itens: [{ tipo: 'nps.detrator', canal: 'app', ligado: false }] })
    await emitir([U_A1, U_A2], 'nps.detrator')
    expect((await pedir('a1', 'GET', '/v1/notificacoes')).corpo['itens']).toHaveLength(0)
    expect((await pedir('a1', 'GET', '/v1/notificacoes/contador')).corpo['naoLidas']).toBe(0)
    expect((await pedir('a2', 'GET', '/v1/notificacoes')).corpo['itens']).toHaveLength(1)
    const [l] = await dono<{ no_app: boolean }[]>`SELECT no_app FROM notificacao WHERE tenant_id = ${A} AND usuario_id = ${U_A1}`
    expect(l?.no_app).toBe(false)
    // O evento de tempo real só vai para quem tem o canal ligado.
    const ev = await dono<{ agregado_id: string }[]>`SELECT agregado_id FROM outbox WHERE tenant_id = ${A} AND tipo = 'notificacao.nova'`
    expect(ev.map((e) => e.agregado_id)).toEqual([U_A2])
  })

  it('todos os canais desligados: nenhuma notificação é gerada', async () => {
    await pedir('a1', 'PUT', '/v1/notificacoes/preferencias', { itens: [
      { tipo: 'nps.detrator', canal: 'app', ligado: false }, { tipo: 'nps.detrator', canal: 'push', ligado: false },
    ] })
    await emitir([U_A1], 'nps.detrator')
    const [c] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM notificacao WHERE tenant_id = ${A} AND usuario_id = ${U_A1}`
    expect(c?.n).toBe(0)
  })

  it('push desligado: o despachante não empurra aquele tipo', async () => {
    await dono`INSERT INTO push_assinatura (tenant_id, id, usuario_id, endpoint, p256dh, auth)
               VALUES (${A}, gen_random_uuid(), ${U_A1}, 'https://push.test/1', 'p', 'a')`
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${A}, now() - interval '1 minute')`
    await pedir('a1', 'PUT', '/v1/notificacoes/preferencias', { itens: [{ tipo: 'nps.detrator', canal: 'push', ligado: false }] })
    await emitir([U_A1], 'nps.detrator')
    const enviar: EnviarPush = vi.fn(async () => ({ ok: true, status: 201 }))
    await despacharPushDoTenant(dono as never, A, enviar)
    expect(enviar).not.toHaveBeenCalled()
    // Outro tipo, sem preferência: o padrão (ligado) empurra. (A pendência por conversa é única: lê a anterior.)
    await dono`UPDATE notificacao SET lida_em = now() WHERE tenant_id = ${A}`
    await emitir([U_A1], 'sla.estourado')
    const r = await despacharPushDoTenant(dono as never, A, enviar)
    expect(r.enviados).toBe(1)
  })

  it('e-mail: SLA estourado enfileira e o worker envia pela porta; desligado não envia', async () => {
    await emitir([U_A1, U_A2], 'sla.estourado')
    await pedir('a2', 'PUT', '/v1/notificacoes/preferencias', { itens: [{ tipo: 'sla.estourado', canal: 'email', ligado: false }] })
    // a2 desligou DEPOIS de gerar: a linha já está pendente. Gera de novo para provar a regra na emissão.
    await dono`DELETE FROM notificacao WHERE tenant_id = ${A}`
    await emitir([U_A1, U_A2], 'sla.estourado')
    const porta = new EmailEmMemoria()
    const r = await despacharEmailsDoTenant(dono as never, A, porta)
    expect(r.enviados).toBe(1)
    expect(porta.enviados.map((m) => m.para)).toEqual([EMAIL.a1])
    expect(porta.enviados[0]!.assunto).toContain('SLA')
    // Não reenvia.
    expect((await despacharEmailsDoTenant(dono as never, A, porta)).enviados).toBe(0)
    // Tipo sem e-mail (nps) nunca enfileira.
    await emitir([U_A1], 'nps.detrator')
    expect((await despacharEmailsDoTenant(dono as never, A, porta)).enviados).toBe(0)
  })

  it('e-mail com falha fica pendente para a próxima passada', async () => {
    await emitir([U_A1], 'sla.estourado')
    const porta = new EmailEmMemoria()
    porta.falhar = true
    expect(await despacharEmailsDoTenant(dono as never, A, porta)).toEqual({ enviados: 0, falhas: 1 })
    porta.falhar = false
    expect((await despacharEmailsDoTenant(dono as never, A, porta)).enviados).toBe(1)
  })
})

describe('meu perfil', () => {
  beforeEach(() => { objetos.clear() })

  it('lê o próprio perfil; grava telefone só em dígitos e audita antes/depois', async () => {
    const g = await pedir('a1', 'GET', '/v1/perfil')
    expect(g.corpo).toMatchObject({ id: U_A1, nome: 'Ana Um', email: EMAIL.a1, telefone: null })
    const p = await pedir('a1', 'PATCH', '/v1/perfil', { nome: ' Ana Maria ', telefone: '(11) 98888-7777', cargo: 'Vendedora' })
    expect(p.status).toBe(200)
    expect(p.corpo).toMatchObject({ nome: 'Ana Maria', telefone: '11988887777', cargo: 'Vendedora' })
    const [u] = await dono<{ telefone: string }[]>`SELECT telefone FROM usuario WHERE tenant_id = ${A} AND id = ${U_A1}`
    expect(u?.telefone).toBe('11988887777')
    const [a] = await dono<{ dados: { antes: Record<string, unknown>; depois: Record<string, unknown> } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'usuario.perfil_alterado' AND ator_id = ${U_A1}`
    expect(a?.dados.antes).toMatchObject({ nome: 'Ana Um', telefone: null })
    expect(a?.dados.depois).toMatchObject({ nome: 'Ana Maria', telefone: '11988887777' })
    // Os colegas não mudaram.
    expect((await pedir('a2', 'GET', '/v1/perfil')).corpo).toMatchObject({ nome: 'Beto Dois', telefone: null })
    await dono`UPDATE usuario SET nome = 'Ana Um', telefone = NULL, cargo = NULL WHERE tenant_id = ${A} AND id = ${U_A1}`
  })

  it('erros por campo (422) e sessão de staff (403)', async () => {
    const r = await pedir('a1', 'PATCH', '/v1/perfil', { nome: '  ', telefone: '123' })
    expect(r.status).toBe(422)
    expect(Object.keys(r.corpo['campos'])).toEqual(['nome', 'telefone'])
    expect((await pedir('staff', 'GET', '/v1/perfil')).status).toBe(403)
  })

  it('foto: sobe ao bucket, devolve URL assinada e remove a anterior', async () => {
    const r1 = await enviarFoto('a1', 'eu.jpg', 'image/jpeg', JPEG)
    expect(r1.status).toBe(200)
    expect(r1.corpo['fotoUrl']).toContain('assinada=1')
    const [u1] = await dono<{ foto_chave: string }[]>`SELECT foto_chave FROM usuario WHERE tenant_id = ${A} AND id = ${U_A1}`
    expect(u1!.foto_chave.startsWith(`tenant/${A}/perfil/${U_A1}/`)).toBe(true)
    expect(objetos.has(u1!.foto_chave)).toBe(true)
    expect(JSON.stringify(r1.corpo)).not.toContain(u1!.foto_chave)

    await enviarFoto('a1', 'eu2.jpg', 'image/jpeg', JPEG)
    expect(objetos.has(u1!.foto_chave)).toBe(false)
    expect(objetos.size).toBe(1)

    expect((await pedir('a1', 'DELETE', '/v1/perfil/foto')).status).toBe(204)
    expect(objetos.size).toBe(0)
  })

  it('foto: tipo e conteúdo verificados', async () => {
    expect((await enviarFoto('a1', 'x.gif', 'image/gif', Buffer.from('GIF89a'))).corpo['erro']).toBe('perfil.foto_tipo')
    expect((await enviarFoto('a1', 'x.jpg', 'image/jpeg', Buffer.from('<html>não sou imagem</html>'))).corpo['erro']).toBe('perfil.foto_conteudo')
    expect(objetos.size).toBe(0)
  })
})

describe('trocar senha (porta de identidade)', () => {
  it('senha atual errada, política e sucesso — erros tipificados', async () => {
    const errada = await pedir('a1', 'POST', '/v1/perfil/senha', { senhaAtual: 'não é essa', novaSenha: 'NovaSenha#2' })
    expect(errada.status).toBe(422)
    expect(errada.corpo['erro']).toBe('perfil.senha_atual_errada')

    const fraca = await pedir('a1', 'POST', '/v1/perfil/senha', { senhaAtual: 'SenhaAtual#1', novaSenha: 'curta' })
    expect(fraca.status).toBe(422)
    expect(fraca.corpo['erro']).toBe('perfil.senha_invalida')
    expect(Object.keys(fraca.corpo['campos'])).toEqual(['novaSenha'])

    expect((await pedir('a1', 'POST', '/v1/perfil/senha', { senhaAtual: 'SenhaAtual#1', novaSenha: 'SenhaAtual#1' })).corpo['erro']).toBe('perfil.senha_igual')

    const ok = await pedir('a1', 'POST', '/v1/perfil/senha', { senhaAtual: 'SenhaAtual#1', novaSenha: 'NovaSenha#2' })
    expect(ok.status).toBe(200)
    expect(senhas.senhas.get(EMAIL.a1)).toBe('NovaSenha#2')
    const [a] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'usuario.senha_alterada' AND ator_id = ${U_A1}`
    expect(a?.n).toBe(1)
    senhas.semear(EMAIL.a1, 'SenhaAtual#1')
  })

  it('o e-mail enviado ao provedor é o da linha do token, não do corpo; staff é 403', async () => {
    senhas.chamadas.length = 0
    await pedir('a1', 'POST', '/v1/perfil/senha', { senhaAtual: 'x', novaSenha: 'y', email: EMAIL.a2 })
    expect(senhas.chamadas).toEqual([{ op: 'trocar', email: EMAIL.a1 }])
    expect((await pedir('staff', 'POST', '/v1/perfil/senha', { senhaAtual: 'x', novaSenha: 'y' })).status).toBe(403)
  })

  it('provedor indisponível é 503 tipificado', async () => {
    senhas.indisponivel = true
    const r = await pedir('a2', 'POST', '/v1/perfil/senha', { senhaAtual: 'x', novaSenha: 'NovaSenha#2' })
    senhas.indisponivel = false
    expect(r.status).toBe(503)
    expect(r.corpo['erro']).toBe('perfil.senha_indisponivel')
  })
})

describe('esqueci a senha', () => {
  const pedirEsqueci = (usuario: string, ip: string) => app.inject({
    method: 'POST', url: '/v1/auth/esqueci-senha', payload: { usuario }, remoteAddress: ip,
  })

  it('a resposta é IDÊNTICA para e-mail cadastrado e não cadastrado', async () => {
    const existe = await pedirEsqueci(EMAIL.a1, '10.4.0.1')
    const naoExiste = await pedirEsqueci('ninguem@d4.test', '10.4.0.1')
    expect(existe.statusCode).toBe(200)
    expect(naoExiste.statusCode).toBe(existe.statusCode)
    expect(naoExiste.body).toBe(existe.body)
    // Só o existente ganhou código no provedor.
    expect(senhas.codigos.has(EMAIL.a1)).toBe(true)
    expect(senhas.codigos.has('ninguem@d4.test')).toBe(false)
  })

  it('limite por IP: a 6ª tentativa é 429; outro IP segue livre', async () => {
    const ip = '10.4.0.2'
    for (let i = 0; i < 5; i++) expect((await pedirEsqueci(`x${i}@d4.test`, ip)).statusCode).toBe(200)
    const barrada = await pedirEsqueci('x9@d4.test', ip)
    expect(barrada.statusCode).toBe(429)
    expect(barrada.json()['erro']).toBe('limite.excedido')
    expect((await pedirEsqueci('x9@d4.test', '10.4.0.3')).statusCode).toBe(200)
  })

  it('e-mail malformado é 422', async () => {
    expect((await pedirEsqueci('sem-arroba', '10.4.0.4')).statusCode).toBe(422)
  })

  it('confirma com o código; código errado e e-mail sem pedido são a mesma resposta', async () => {
    const ip = '10.4.0.5'
    const red = (usuario: string, codigo: string, novaSenha: string) => app.inject({
      method: 'POST', url: '/v1/auth/redefinir-senha', payload: { usuario, codigo, novaSenha }, remoteAddress: ip,
    })
    senhas.codigos.set(EMAIL.a2, { codigo: '123456', expirado: false })
    senhas.semear(EMAIL.a2, 'Antiga#123')

    const errado = await red(EMAIL.a2, '000000', 'Nova#12345')
    const semPedido = await red('ninguem@d4.test', '000000', 'Nova#12345')
    expect(errado.statusCode).toBe(422)
    expect(semPedido.body).toBe(errado.body)
    expect(errado.json()['erro']).toBe('auth.codigo_invalido')

    expect((await red(EMAIL.a2, '123456', 'curta')).json()['erro']).toBe('auth.senha_invalida')
    senhas.codigos.set(EMAIL.a2, { codigo: '123456', expirado: true })
    expect((await red(EMAIL.a2, '123456', 'Nova#12345')).json()['erro']).toBe('auth.codigo_expirado')
    senhas.codigos.set(EMAIL.a2, { codigo: '123456', expirado: false })
    expect((await red(EMAIL.a2, '123456', 'Nova#12345')).statusCode).toBe(200)
    expect(senhas.senhas.get(EMAIL.a2)).toBe('Nova#12345')
  })
})

describe('auditoria de login e logout (D6)', () => {
  const idTokenDe = (sub: string, tenant: string) =>
    `h.${Buffer.from(JSON.stringify({ sub, 'custom:tenant_id': tenant })).toString('base64url')}.s`

  it('o login entra na trilha com ator, ação, entidade e IP; carimba o último login', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ AuthenticationResult: { IdToken: idTokenDe(SUB.a1, A), ExpiresIn: 3600 } }) })
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { usuario: EMAIL.a1, senha: 'x' }, remoteAddress: '10.4.1.1' })
    expect(r.statusCode).toBe(200)
    const [a] = await dono<{ ator_id: string; entidade: string; entidade_id: string; dados: { ip: string } }[]>`
      SELECT ator_id, entidade, entidade_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'usuario.login'`
    expect(a).toMatchObject({ ator_id: U_A1, entidade: 'usuario', entidade_id: U_A1 })
    expect(a?.dados.ip).toBe('10.4.1.1')
    const [u] = await dono<{ ultimo_login_em: Date | null }[]>`SELECT ultimo_login_em FROM usuario WHERE tenant_id = ${A} AND id = ${U_A1}`
    expect(u?.ultimo_login_em).not.toBeNull()
    // Nada vazou para a trilha do outro tenant.
    const [b] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${B}`
    expect(b?.n).toBe(0)
  })

  it('senha errada NÃO audita login', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${A}`
    fetchMock.mockResolvedValue({ status: 400, json: async () => ({ __type: 'NotAuthorizedException', message: 'x' }) })
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { usuario: EMAIL.a1, senha: 'errada' } })
    expect(r.statusCode).toBe(400)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'usuario.login'`
    expect(n?.n).toBe(0)
  })

  it('o logout entra na trilha com o ator do token', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${A}`
    expect((await pedir('a2', 'POST', '/v1/auth/logout')).status).toBe(204)
    const [a] = await dono<{ ator_id: string; acao: string }[]>`SELECT ator_id, acao FROM auditoria WHERE tenant_id = ${A}`
    expect(a).toEqual({ ator_id: U_A2, acao: 'usuario.logout' })
  })
})
