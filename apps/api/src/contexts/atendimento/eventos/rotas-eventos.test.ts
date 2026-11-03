import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasEventos } from './rotas-eventos.js'
import { despacharParaTeste } from './barramento.js'

/**
 * SSE NO ESCOPO (revisão de segurança D3, A4) — servidor de verdade (listen) e
 * fetch com stream, porque a rota sequestra a resposta.
 *
 *   VA (vendedora) dona do cliente CA → conversa CV.a; VB dono de CB → CV.b.
 *   O tenant tem admin (regra estrita).
 *
 * Prova: VA não recebe evento da conversa alheia (ao vivo nem no replay), mas
 * recebe os da própria e os sem conversa; usuário desativado tem a conexão
 * ENCERRADA na revalidação; inativo nem abre.
 */
const A = 'd3500000-0000-4000-8000-00000000000a'
const PLANO = 'd3500000-0001-4000-8000-000000000001'
const MODELO = 'd3500000-0002-4000-8000-000000000001'
const PV = 'd3500000-0003-4000-8000-00000000000a'
const U = {
  adm: 'd3500000-0005-4000-8000-000000000001',
  va: 'd3500000-0005-4000-8000-000000000002',
  vb: 'd3500000-0005-4000-8000-000000000003',
  ina: 'd3500000-0005-4000-8000-000000000004',
}
const C = { a: 'd3500000-0006-4000-8000-000000000001', b: 'd3500000-0006-4000-8000-000000000002' }
const N = 'd3500000-0007-4000-8000-000000000001'
const CV = { a: 'd3500000-0008-4000-8000-000000000001', b: 'd3500000-0008-4000-8000-000000000002' }

const sub = (k: keyof typeof U) => `d35-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let base = ''

interface Conexao { status: number; eventos: { id: number; conversaId?: string }[]; fechou: Promise<void>; abortar(): void }

/** Abre o SSE como `quem` e vai acumulando os eventos; `fechou` resolve quando o servidor encerra. */
async function abrir(quem: keyof typeof U, desde?: number): Promise<Conexao> {
  const controle = new AbortController()
  const resp = await fetch(`${base}/v1/eventos${desde ? `?desde=${desde}` : ''}`, {
    headers: { 'x-tenant-id': A, 'x-teste-sub': sub(quem), accept: 'text/event-stream' },
    signal: controle.signal,
  })
  const eventos: { id: number; conversaId?: string }[] = []
  let fechou: Promise<void> = Promise.resolve()
  if (resp.ok && resp.body) {
    const leitor = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    fechou = (async () => {
      try {
        for (;;) {
          const { done, value } = await leitor.read()
          if (done) return
          buf += dec.decode(value, { stream: true })
          let corte: number
          while ((corte = buf.indexOf('\n\n')) >= 0) {
            const bloco = buf.slice(0, corte)
            buf = buf.slice(corte + 2)
            const dados = bloco.split('\n').find((l) => l.startsWith('data:'))
            if (dados) eventos.push(JSON.parse(dados.slice(5)) as { id: number; conversaId?: string })
          }
        }
      } catch { /* abortado */ }
    })()
  }
  return { status: resp.status, eventos, fechou, abortar: () => controle.abort() }
}

const esperar = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const ate = Date.now() + ms
  while (!cond()) {
    if (Date.now() > ate) throw new Error('tempo esgotado esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.SSE_REVALIDAR_MS = '150'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-sse-d3', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-sse-d3', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${A}, 'SSE D3', ${PLANO}, ${PV})`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${A}, ${PV}, ${MODELO}, 'Varejo')`
  })
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@d35.test'}, ${k !== 'ina'})`
  }
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${A}, ${U.adm}, NULL, 'admin'), (${A}, ${U.va}, NULL, 'vendedor'), (${A}, ${U.vb}, NULL, 'vendedor')`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${C.a}, 'SSE Alfa'), (${A}, ${C.b}, 'SSE Beta')`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${C.a}, ${U.va}), (${A}, gen_random_uuid(), ${C.b}, ${U.vb})`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${A}, ${N}, 'whatsapp_nao_oficial', 'Zap SSE', 'conectado')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_direcao, ultima_mensagem_em) VALUES
    (${A}, ${CV.a}, ${N}, ${C.a}, 'saliente', now()), (${A}, ${CV.b}, ${N}, ${C.b}, 'saliente', now())`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@d35.test` }
  })
  await app.register(rotasEventos)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const end = app.server.address()
  base = `http://127.0.0.1:${typeof end === 'object' && end ? end.port : 0}`
})

async function limpar(): Promise<void> {
  for (const tabela of ['outbox', 'conversa', 'canal_conectado', 'carteira_atribuicao', 'contato', 'usuario_filial', 'usuario']) {
    await dono`DELETE FROM ${dono(tabela)} WHERE tenant_id = ${A}`
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${A}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${A}`
  await dono`DELETE FROM tenant WHERE id = ${A}`
}

afterAll(async () => {
  delete process.env.SSE_REVALIDAR_MS
  await limpar()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('SSE no escopo (A4)', () => {
  it('ao vivo: a vendedora NÃO recebe evento da conversa alheia; recebe a própria e o evento sem conversa', async () => {
    const va = await abrir('va')
    const adm = await abrir('adm')
    try {
      expect(va.status).toBe(200)
      await new Promise((r) => setTimeout(r, 50)) // assinaturas registradas
      despacharParaTeste({ tenantId: A, id: 910001, tipo: 'conversa.mudou', conversaId: CV.b })
      despacharParaTeste({ tenantId: A, id: 910002, tipo: 'contato.mudou' })
      despacharParaTeste({ tenantId: A, id: 910003, tipo: 'conversa.mudou', conversaId: CV.a })
      // Entrega SERIAL: quando o 3º chega, o 1º já teria chegado se fosse entregue.
      await esperar(() => va.eventos.some((e) => e.id === 910003))
      expect(va.eventos.map((e) => e.id)).toEqual([910002, 910003])
      await esperar(() => adm.eventos.length >= 3)
      expect(adm.eventos.map((e) => e.id)).toEqual([910001, 910002, 910003])
    } finally {
      va.abortar(); adm.abortar()
    }
  })

  it('replay (?desde=): o MESMO filtro de escopo', async () => {
    const [l] = await dono<{ id: string }[]>`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload) VALUES
        (${A}, 'mensagem.nova', 'conversa', ${CV.b}, ${JSON.stringify({ conversaId: CV.b, versao: 1 })}::text::jsonb),
        (${A}, 'mensagem.nova', 'conversa', ${CV.a}, ${JSON.stringify({ conversaId: CV.a, versao: 1 })}::text::jsonb)
      RETURNING id`
    const va = await abrir('va', Number(l!.id) - 1)
    try {
      await esperar(() => va.eventos.length >= 1)
      await new Promise((r) => setTimeout(r, 100))
      expect(va.eventos.map((e) => e.conversaId)).toEqual([CV.a])
    } finally {
      va.abortar()
    }
  })

  it('usuário inativo não abre a conexão (403)', async () => {
    const ina = await abrir('ina')
    expect(ina.status).toBe(403)
  })

  it('usuário DESATIVADO durante a conexão tem a conexão encerrada na revalidação', async () => {
    const vb = await abrir('vb')
    expect(vb.status).toBe(200)
    try {
      await dono`UPDATE usuario SET ativo = false WHERE tenant_id = ${A} AND id = ${U.vb}`
      let encerrou = false
      void vb.fechou.then(() => { encerrou = true })
      await esperar(() => encerrou, 3000)
      expect(encerrou).toBe(true)
    } finally {
      vb.abortar()
      await dono`UPDATE usuario SET ativo = true WHERE tenant_id = ${A} AND id = ${U.vb}`
    }
  })
})
