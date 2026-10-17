import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'

/**
 * P0d — A 1ª RESPOSTA HUMANA do atendimento é gravada no envio humano, e a métrica fixa de
 * 5 min da performance (`/v1/performance`) passa a ter dado. Antes, `primeira_resposta_humana_em`
 * nunca era preenchida: a tela mostrava "0 respondidos" para sempre.
 *
 * O canal é falso (nenhuma rede); o resto é o caminho real: rota → gateway → pós-envio.
 */
const espiao = vi.hoisted(() => ({ enviados: 0, ok: true }))
vi.mock('./canais/fabrica.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./canais/fabrica.js')>()
  return {
    ...real,
    criarCanal: () => ({
      tipo: 'whatsapp_nao_oficial', capacidades: {},
      async enviarTexto() {
        espiao.enviados += 1
        return espiao.ok ? { ok: true, idExterno: `out-${espiao.enviados}` } : { ok: false, motivo: 'indisponivel', classe: 'transporte' }
      },
    }),
  }
})

const { criarApp } = await import('../../app.js')
const { encerrarBanco } = await import('../../db/index.js')
const { cifrar } = await import('../integracao/cofre.js')

const T = 'f1a50000-0000-4000-8000-000000000001'
const PV = 'f1a50000-1111-4000-8000-000000000001'
const PLANO = 'f1a50000-3333-4000-8000-000000000001'
const MODELO = 'f1a50000-4444-4000-8000-000000000001'
const CANAL = 'f1a50000-5555-4000-8000-000000000001'
const CONTATO = 'f1a50000-6666-4000-8000-000000000001'
const CONVERSA = 'f1a50000-7777-4000-8000-000000000001'
const ANA = 'f1a50000-8888-4000-8000-000000000001'
const BIA = 'f1a50000-8888-4000-8000-000000000002'
/** O `sub` sintético que `subDoUsuario` produz em dev (por tenant): os envios saem como Ana. */
const SUB = `dev-${T}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const enviar = (texto: string) => app.inject({
  method: 'POST', url: `/v1/conversas/${CONVERSA}/mensagens`, headers: { 'x-tenant-id': T }, payload: { tipo: 'texto', texto },
})
const atendimento = async () => (await dono<{
  primeira_entrante_em: Date | null; primeira_resposta_em: Date | null; primeira_resposta_humana_em: Date | null; primeira_resposta_por_id: string | null
}[]>`SELECT primeira_entrante_em, primeira_resposta_em, primeira_resposta_humana_em, primeira_resposta_por_id
       FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]

/** Cliente escreveu há `minutos`; um atendimento aberto o espera (como o handoff cria). */
async function clienteEsperando(minutos: number, extra: { automaticaEm?: Date } = {}): Promise<Date> {
  const chegada = new Date(Date.now() - minutos * 60_000)
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${randomUUID()}, ${CONVERSA}, 'entrante', 'texto', '{"texto":"tem sabão?"}'::jsonb, ${chegada})`
  await dono`UPDATE conversa SET ultima_entrante_em = ${chegada} WHERE tenant_id = ${T} AND id = ${CONVERSA}`
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, criado_em, primeira_resposta_em)
             VALUES (${T}, ${randomUUID()}, ${CONVERSA}, ${CANAL}, ${Date.now()}, 'na_fila', ${chegada}, ${extra.automaticaEm ?? null})`
  return chegada
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-f1a5', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-f1a5', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja 1a resposta', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado',
                     ${cifrar({ instancia: 'i', token: 't', clientToken: 'c' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999991111', '5585999991111', true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
             (${T}, ${ANA}, ${SUB}, 'Ana', 'ana@1a.local'), (${T}, ${BIA}, 'sub-bia-1a', 'Bia', 'bia@1a.local')
             ON CONFLICT DO NOTHING`
  app = await criarApp()
  await app.ready()
})

beforeEach(async () => {
  espiao.enviados = 0; espiao.ok = true
  await dono`UPDATE conversa SET atendimento_atual_id = NULL WHERE tenant_id = ${T}`
  for (const tab of ['atendimento_etapa_historico', 'atendimento', 'mensagem', 'outbox']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${T}'`)
})

afterAll(async () => {
  await dono`UPDATE conversa SET atendimento_atual_id = NULL WHERE tenant_id = ${T}`
  for (const tab of ['auditoria', 'atendimento_etapa_historico', 'atendimento', 'atendimento_etapa', 'metrica', 'alerta', 'mensagem', 'outbox',
    'conversa', 'contato_telefone', 'contato', 'usuario', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${T}'`).catch(() => undefined)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('1ª resposta humana do atendimento', () => {
  it('o primeiro envio humano grava o marco, o autor e a chegada; a performance passa a ter dado dentro do SLA', async () => {
    const chegada = await clienteEsperando(2)
    const antes = Date.now()
    expect((await enviar('Temos sim!')).statusCode).toBe(200)
    const a = await atendimento()
    expect(a!.primeira_resposta_por_id).toBe(ANA)
    expect(a!.primeira_entrante_em!.getTime()).toBe(chegada.getTime())
    expect(a!.primeira_resposta_humana_em!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
    expect(a!.primeira_resposta_em!.getTime()).toBe(a!.primeira_resposta_humana_em!.getTime())

    const p = (await app.inject({ method: 'GET', url: '/v1/performance?dias=7', headers: { 'x-tenant-id': T } })).json() as {
      respondidos: number; dentroSla: number; pctDentroSla: number | null; medianaRespostaSeg: number | null
      porAtendente: { usuarioId: string | null; respondidos: number }[]
    }
    expect(p).toMatchObject({ respondidos: 1, dentroSla: 1, pctDentroSla: 100 })
    expect(p.medianaRespostaSeg).toBeGreaterThanOrEqual(115)
    expect(p.porAtendente).toEqual([expect.objectContaining({ usuarioId: ANA, respondidos: 1 })])
  })

  it('só o PRIMEIRO conta: o segundo envio não move o marco nem troca o autor', async () => {
    await clienteEsperando(1)
    expect((await enviar('Primeira')).statusCode).toBe(200)
    const primeiro = await atendimento()
    // Outro vendedor "responderia" depois: o marco já existe e não é reescrito.
    await dono`UPDATE atendimento SET primeira_resposta_por_id = ${BIA} WHERE tenant_id = ${T}`
    await new Promise((res) => setTimeout(res, 20))
    expect((await enviar('Segunda')).statusCode).toBe(200)
    const depois = await atendimento()
    expect(depois!.primeira_resposta_por_id).toBe(BIA)
    expect(depois!.primeira_resposta_humana_em!.getTime()).toBe(primeiro!.primeira_resposta_humana_em!.getTime())
  })

  it('⚠️ a automática que já respondeu fica em primeira_resposta_em; a humana mede à parte (MC-05)', async () => {
    const automatica = new Date(Date.now() - 4 * 60_000)
    await clienteEsperando(5, { automaticaEm: automatica })
    expect((await enviar('Oi, sou a Ana')).statusCode).toBe(200)
    const a = await atendimento()
    expect(a!.primeira_resposta_em!.getTime()).toBe(automatica.getTime())
    expect(a!.primeira_resposta_humana_em!.getTime()).toBeGreaterThan(automatica.getTime())
  })

  it('envio que não saiu (falha de transporte) não marca nada', async () => {
    await clienteEsperando(1)
    espiao.ok = false
    expect((await enviar('Temos sim!')).statusCode).toBe(502)
    expect(await atendimento()).toMatchObject({ primeira_resposta_humana_em: null, primeira_resposta_por_id: null })
  })

  it('sem atendimento aberto o envio segue normal e nada é marcado', async () => {
    expect((await enviar('Oi!')).statusCode).toBe(200)
    expect((await dono`SELECT 1 FROM atendimento WHERE tenant_id = ${T}`).length).toBe(0)
  })
})
