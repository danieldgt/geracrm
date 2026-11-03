import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { enviarLembretesAgenda } from './agenda-lembrete.js'

/** Agenda (módulo opcional C2): 404 desligado, CRUD, conflito, versão, escopo, lembrete e sem-próximo-passo. */
const A = 'a9e00000-0000-4000-8000-000000000001' // módulo ligado
const B = 'a9e00000-0000-4000-8000-000000000002' // módulo desligado
const V = 'a9e00000-0000-4000-8000-000000000003' // ligado, usuário do header é VENDEDOR
const PV = { A: 'a9e00000-1111-4000-8000-000000000001', B: 'a9e00000-1111-4000-8000-000000000002', V: 'a9e00000-1111-4000-8000-000000000003' }
const PLANO = 'a9e00000-3333-4000-8000-000000000001'
const MODELO = 'a9e00000-4444-4000-8000-000000000001'
const CA = 'a9e00000-5555-4000-8000-000000000001'
const CB = 'a9e00000-5555-4000-8000-000000000002'
const ADMIN_V = 'a9e00000-6666-4000-8000-000000000001'
const VEND_V = 'a9e00000-6666-4000-8000-000000000002'
const OUTRO_V = 'a9e00000-6666-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

// Horários fixos no futuro (fuso do tenant: America/Sao_Paulo, UTC-3 em 2030).
const h = (hora: number, min = 0, dia = 10) => `2030-03-${String(dia).padStart(2, '0')}T${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`
const novo = (extra: Record<string, unknown> = {}) => ({ titulo: 'Reunião', inicio: h(13), fim: h(14), ...extra })
const criarEvento = async (t: string, extra: Record<string, unknown> = {}) => {
  const r = await chamar(t, 'POST', '/v1/agenda/eventos', novo(extra))
  return { r, id: (r.json() as { id?: string }).id! }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-ag', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-ag', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV.A, 'A'], [B, PV.B, 'B'], [V, PV.V, 'V']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${nome}, ${PLANO}, ${pv}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${CA}, 'Maria Compradora'), (${B}, ${CB}, 'De Outro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${A}, 'agenda', true), (${V}, 'agenda', true)
             ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  // Tenant V: um admin atribuído (encerra o modo fundador) e o usuário do header como VENDEDOR.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
    (${V}, ${ADMIN_V}, 'sub-admin-v', 'Admin', 'admin@v.local'),
    (${V}, ${VEND_V}, ${'dev-' + V}, 'Vendedora', 'vend@v.local'),
    (${V}, ${OUTRO_V}, 'sub-outro-v', 'Outro', 'outro@v.local') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${V}, ${ADMIN_V}, NULL, 'admin'), (${V}, ${VEND_V}, NULL, 'vendedor'), (${V}, ${OUTRO_V}, NULL, 'vendedor')`
  app = await criarApp(); await app.ready()
})
beforeEach(async () => {
  await dono`DELETE FROM evento_agenda WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM notificacao WHERE tenant_id IN (${A}, ${B}, ${V}) AND tipo = 'agenda.lembrete'`
})
afterAll(async () => {
  await dono`DELETE FROM evento_agenda WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM notificacao WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM outbox WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM tenant_modulo WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${A}, ${B}, ${V})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${A}, ${B}, ${V})`
  for (const t of [A, B, V]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const JANELA = '/v1/agenda/eventos?de=2030-03-01&ate=2030-03-31'

describe('Agenda — módulo desligado', () => {
  it('⚠️ todas as rotas respondem 404 com o módulo desligado', async () => {
    const id = 'a9e00000-9999-4000-8000-000000000001'
    const rotas: ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, Record<string, unknown>?][] = [
      ['GET', JANELA], ['GET', `/v1/agenda/eventos/${id}`], ['POST', '/v1/agenda/eventos', novo()],
      ['PUT', `/v1/agenda/eventos/${id}`, { ...novo(), versao: 1 }], ['PATCH', `/v1/agenda/eventos/${id}/status`, { status: 'realizado' }],
      ['DELETE', `/v1/agenda/eventos/${id}`],
    ]
    for (const [m, url, corpo] of rotas) {
      const r = await chamar(B, m, url, corpo)
      expect(r.statusCode, `${m} ${url}`).toBe(404)
      expect(r.json()).toMatchObject({ erro: 'modulo.desligado' })
    }
  })
})

describe('Agenda — CRUD', () => {
  it('cria, lê, lista na janela (com contato) e valida o corpo', async () => {
    const { r, id } = await criarEvento(A, { contatoId: CA, descricao: 'Pauta', lembreteMin: 15, cor: 'sucesso', tipo: 'visita', modalidade: 'online', link: 'https://meet.exemplo/x' })
    expect(r.statusCode).toBe(201)
    const um = (await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as Record<string, unknown>
    expect(um).toMatchObject({ titulo: 'Reunião', contato: 'Maria Compradora', status: 'agendado', versao: 1, lembreteMin: 15, cor: 'sucesso', tipo: 'visita' })
    const lista = (await chamar(A, 'GET', JANELA)).json() as { itens: { id: string }[]; truncado: boolean }
    expect(lista.itens.map((x) => x.id)).toEqual([id])
    expect(lista.truncado).toBe(false)
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-04-01&ate=2030-04-30')).json()).toMatchObject({ itens: [] })

    for (const ruim of [
      { titulo: '' }, { titulo: 'x'.repeat(121) }, { tipo: 'festa' }, { modalidade: 'hibrido' }, { lembreteMin: 7 },
      { cor: '#ff0000' }, { link: 'javascript:alert(1)' }, { inicio: h(15), fim: h(14) }, { inicio: 'ontem' },
    ]) {
      expect((await chamar(A, 'POST', '/v1/agenda/eventos', novo(ruim))).statusCode, JSON.stringify(ruim)).toBe(422)
    }
    expect((await chamar(A, 'POST', '/v1/agenda/eventos', novo({ contatoId: CB }))).statusCode).toBe(422) // contato de outro tenant
  })

  it('intervalo obrigatório e no máximo 62 dias', async () => {
    expect((await chamar(A, 'GET', '/v1/agenda/eventos')).statusCode).toBe(422)
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-03-01')).statusCode).toBe(422)
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-03-10&ate=2030-03-01')).statusCode).toBe(422)
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-03-01&ate=2030-05-02')).statusCode).toBe(422) // 63 dias
  })

  it('62 dias passa; 63 não', async () => {
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-03-01&ate=2030-05-01')).statusCode).toBe(200) // 62 dias
    expect((await chamar(A, 'GET', '/v1/agenda/eventos?de=2030-03-01&ate=2030-05-03')).statusCode).toBe(422) // 64 dias
  })

  it('edita (PUT) com a versão certa; versão velha → 409', async () => {
    const { id } = await criarEvento(A)
    const ok = await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ titulo: 'Renomeada' }), versao: 1 })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ versao: 2 })
    const velho = await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ titulo: 'Outra' }), versao: 1 })
    expect(velho.statusCode).toBe(409)
    expect(velho.json()).toMatchObject({ erro: 'agenda.versao_desatualizada', versaoAtual: 2 })
    expect((await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, novo())).statusCode).toBe(422) // sem versão
  })

  it('reagendar (mudar início/fim) volta para agendado', async () => {
    const { id } = await criarEvento(A)
    await chamar(A, 'PATCH', `/v1/agenda/eventos/${id}/status`, { status: 'nao_compareceu' })
    expect(((await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { status: string }).status).toBe('nao_compareceu')
    const atual = (await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { versao: number }
    const r = await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ inicio: h(15), fim: h(16) }), versao: atual.versao })
    expect(r.statusCode).toBe(200)
    expect(((await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { status: string }).status).toBe('agendado')
  })

  it('status: realizado / não compareceu; inválido → 422; cancelar (DELETE) não apaga', async () => {
    const { id } = await criarEvento(A)
    expect((await chamar(A, 'PATCH', `/v1/agenda/eventos/${id}/status`, { status: 'realizado' })).statusCode).toBe(200)
    expect(((await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { status: string }).status).toBe('realizado')
    expect((await chamar(A, 'PATCH', `/v1/agenda/eventos/${id}/status`, { status: 'sumiu' })).statusCode).toBe(422)
    expect((await chamar(A, 'DELETE', `/v1/agenda/eventos/${id}`)).statusCode).toBe(200)
    const [linha] = await dono<{ status: string }[]>`SELECT status FROM evento_agenda WHERE tenant_id = ${A} AND id = ${id}`
    expect(linha?.status).toBe('cancelado')
    expect((await chamar(A, 'PATCH', '/v1/agenda/eventos/a9e00000-9999-4000-8000-000000000009/status', { status: 'realizado' })).statusCode).toBe(404)
  })
})

describe('Agenda — conflito de horário', () => {
  it('⚠️ mesmo responsável, horário sobreposto → 409 com o evento conflitante; encostar e cancelado passam', async () => {
    const { id } = await criarEvento(A, { titulo: 'Primeiro' })
    const c = await chamar(A, 'POST', '/v1/agenda/eventos', novo({ titulo: 'Segundo', inicio: h(13, 30), fim: h(14, 30) }))
    expect(c.statusCode).toBe(409)
    expect(c.json()).toMatchObject({ erro: 'agenda.horario_ocupado', conflito: { id, titulo: 'Primeiro', inicio: h(13), fim: h(14) } })
    expect((await chamar(A, 'POST', '/v1/agenda/eventos', novo({ inicio: h(14), fim: h(15) }))).statusCode).toBe(201) // encosta
    await chamar(A, 'DELETE', `/v1/agenda/eventos/${id}`)
    expect((await chamar(A, 'POST', '/v1/agenda/eventos', novo({ inicio: h(13, 15), fim: h(13, 45) }))).statusCode).toBe(201) // cancelado libera
  })

  it('reagendar para cima de outro evento → 409; o próprio horário não conflita consigo', async () => {
    const { id } = await criarEvento(A, { titulo: 'X' })
    await criarEvento(A, { titulo: 'Y', inicio: h(16), fim: h(17) })
    expect((await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ titulo: 'X2' }), versao: 1 })).statusCode).toBe(200)
    const r = await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ inicio: h(16, 30), fim: h(17, 30) }), versao: 2 })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'agenda.horario_ocupado' })
  })
})

describe('Agenda — isolamento e escopo', () => {
  it('⚠️ dois tenants: não enxerga nem mexe no evento do outro', async () => {
    await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${B}, 'agenda', true)
               ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
    try {
      const { id } = await criarEvento(A)
      expect((await chamar(B, 'GET', `/v1/agenda/eventos/${id}`)).statusCode).toBe(404)
      expect((await chamar(B, 'PATCH', `/v1/agenda/eventos/${id}/status`, { status: 'realizado' })).statusCode).toBe(404)
      expect((await chamar(B, 'DELETE', `/v1/agenda/eventos/${id}`)).statusCode).toBe(404)
      expect((await chamar(B, 'GET', JANELA)).json()).toMatchObject({ itens: [] })
    } finally {
      await dono`UPDATE tenant_modulo SET ativo = false WHERE tenant_id = ${B}`
    }
  })

  it('vendedor vê e mexe só no que é dele; não agenda para outro', async () => {
    const proprio = (await chamar(V, 'POST', '/v1/agenda/eventos', novo({ titulo: 'Meu' }))).json() as { id: string }
    // Evento de outro usuário, criado direto no banco.
    const alheio = 'a9e00000-7777-4000-8000-000000000001'
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, responsavel_id, inicio, fim)
               VALUES (${V}, ${alheio}, 'Alheio', ${OUTRO_V}, ${h(18)}, ${h(19)})`
    const lista = (await chamar(V, 'GET', JANELA)).json() as { itens: { titulo: string }[] }
    expect(lista.itens.map((i) => i.titulo)).toEqual(['Meu'])
    expect((await chamar(V, 'GET', `/v1/agenda/eventos/${alheio}`)).statusCode).toBe(404)
    expect((await chamar(V, 'PATCH', `/v1/agenda/eventos/${alheio}/status`, { status: 'realizado' })).statusCode).toBe(404)
    expect((await chamar(V, 'POST', '/v1/agenda/eventos', novo({ inicio: h(20), fim: h(21), responsavelId: OUTRO_V }))).statusCode).toBe(403)
    expect((await chamar(V, 'GET', `/v1/agenda/eventos/${proprio.id}`)).statusCode).toBe(200)
  })
})

describe('Agenda — lembrete', () => {
  it('avisa o responsável uma vez, só na hora; idempotente; ignora cancelado e módulo desligado', async () => {
    const { id } = await criarEvento(A, { lembreteMin: 30 })
    const { id: semLembrete } = await criarEvento(A, { inicio: h(16), fim: h(17) })
    const { id: cancelado } = await criarEvento(A, { inicio: h(18), fim: h(19), lembreteMin: 5 })
    await chamar(A, 'DELETE', `/v1/agenda/eventos/${cancelado}`)
    const resp = (await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { responsavelId: string }

    const cedo = new Date(h(12, 29)) // 31 min antes das 13:00Z
    expect(await enviarLembretesAgenda(dono as never, cedo, { somenteTenant: A })).toEqual({ avisados: 0, descartados: 0 })

    const na_hora = new Date(h(12, 30))
    expect(await enviarLembretesAgenda(dono as never, na_hora, { somenteTenant: A })).toEqual({ avisados: 1, descartados: 0 })
    expect(await enviarLembretesAgenda(dono as never, new Date(h(12, 45)), { somenteTenant: A })).toEqual({ avisados: 0, descartados: 0 })

    const notas = await dono<{ usuario_id: string; titulo: string; tipo: string }[]>`
      SELECT usuario_id, titulo, tipo FROM notificacao WHERE tenant_id = ${A} AND tipo = 'agenda.lembrete'`
    expect(notas).toHaveLength(1)
    expect(notas[0]).toMatchObject({ usuario_id: resp.responsavelId, titulo: 'Reunião — às 10:00' }) // 13:00Z = 10:00 em São Paulo
    const out = await dono<{ payload: unknown }[]>`SELECT payload FROM outbox WHERE tenant_id = ${A} AND tipo = 'notificacao.nova' AND agregado_id = ${resp.responsavelId}`
    expect(JSON.stringify(out[0]?.payload)).toBe(JSON.stringify({ usuarioId: resp.responsavelId })) // sem conteúdo
    void semLembrete

    // Reagendar rearma o lembrete.
    const v = ((await chamar(A, 'GET', `/v1/agenda/eventos/${id}`)).json() as { versao: number }).versao
    await chamar(A, 'PUT', `/v1/agenda/eventos/${id}`, { ...novo({ inicio: h(15), fim: h(16), lembreteMin: 30 }), versao: v })
    expect((await enviarLembretesAgenda(dono as never, new Date(h(14, 45)), { somenteTenant: A })).avisados).toBe(1)

    // Módulo desligado: nada é enviado e nada é marcado.
    const { id: outro } = await criarEvento(A, { inicio: h(20), fim: h(21), lembreteMin: 5 })
    await dono`UPDATE tenant_modulo SET ativo = false WHERE tenant_id = ${A}`
    try {
      expect((await enviarLembretesAgenda(dono as never, new Date(h(19, 58)), { somenteTenant: A })).avisados).toBe(0)
    } finally {
      await dono`UPDATE tenant_modulo SET ativo = true WHERE tenant_id = ${A}`
    }
    expect((await enviarLembretesAgenda(dono as never, new Date(h(19, 58)), { somenteTenant: A })).avisados).toBe(1)
    void outro
  })

  it('evento que já terminou sem avisar é descartado (marcado), não notificado', async () => {
    await criarEvento(A, { lembreteMin: 15 })
    expect(await enviarLembretesAgenda(dono as never, new Date(h(15)), { somenteTenant: A })).toEqual({ avisados: 0, descartados: 1 })
    expect(await dono`SELECT 1 FROM notificacao WHERE tenant_id = ${A} AND tipo = 'agenda.lembrete'`).toHaveLength(0)
  })
})

describe('Agenda — sem próximo passo (C1)', () => {
  it('evento futuro agendado conta como próximo passo só com o módulo ligado', async () => {
    await criarEvento(A, { contatoId: CA })
    const consulta = (t: string, c: string) => chamar(t, 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${c}`)
    expect((await consulta(A, CA)).json()).toMatchObject({ itens: [{ contatoId: CA, semProximoPasso: false }] })

    await dono`UPDATE tenant_modulo SET ativo = false WHERE tenant_id = ${A}`
    try {
      expect((await consulta(A, CA)).json()).toMatchObject({ itens: [{ contatoId: CA, semProximoPasso: true }] })
    } finally {
      await dono`UPDATE tenant_modulo SET ativo = true WHERE tenant_id = ${A}`
    }
    // Cancelado deixa de contar.
    const [e] = await dono<{ id: string }[]>`SELECT id FROM evento_agenda WHERE tenant_id = ${A} AND contato_id = ${CA}`
    await chamar(A, 'DELETE', `/v1/agenda/eventos/${e!.id}`)
    expect((await consulta(A, CA)).json()).toMatchObject({ itens: [{ semProximoPasso: true }] })
  })
})
