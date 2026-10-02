import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import {
  agendarTurno, pegarProximaTarefa, concluirTarefa, falharTarefa, recuperarTravadas, chegouMensagemNova, reagendarTarefa,
  DEBOUNCE_MS, MAX_TENTATIVAS, TETO_DEBOUNCE_MS,
} from './fila.js'

/**
 * A fila do agente (ADR-024): uma pendente por conversa, debounce, serial por
 * conversa, recuperação de travadas. Tudo contra o Postgres real.
 */
const T = 'b1f10000-0000-4000-8000-000000000001'
const PV = 'b1f10000-1111-4000-8000-000000000001'
const PLANO = 'b1f10000-3333-4000-8000-000000000001'
const MODELO = 'b1f10000-4444-4000-8000-000000000001'
const CANAL = 'b1f10000-5555-4000-8000-000000000001'
const CONTATO = 'b1f10000-6666-4000-8000-000000000001'
const CONTATO2 = 'b1f10000-6666-4000-8000-000000000002'
const CONVERSA = 'b1f10000-7777-4000-8000-000000000001'
const CONVERSA2 = 'b1f10000-7777-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const agora = () => new Date()

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-fila-agente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-fila-agente', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Fila', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Fila', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Fila', true), (${T}, ${CONTATO2}, 'Cliente Fila 2', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1), (${T}, ${CONVERSA2}, ${CANAL}, ${CONTATO2}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
})
afterAll(async () => {
  await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

const agendar = (conversaId: string, mensagemId?: string, atrasoMs?: number) =>
  comTenantServico(T, (tx) => agendarTurno(tx, { conversaId, canalId: CANAL, mensagemId, agora: agora(), atrasoMs }))

describe('Debounce — uma pendente por conversa', () => {
  it('dado duas mensagens em sequência, quando agendam, então existe UMA tarefa com as duas mensagens', async () => {
    const m1 = 'b1f10000-aaaa-4000-8000-000000000001', m2 = 'b1f10000-aaaa-4000-8000-000000000002'
    const a = await agendar(CONVERSA, m1)
    const b = await agendar(CONVERSA, m2)
    expect(a.reagendada).toBe(false)
    expect(b.reagendada).toBe(true)
    expect(b.tarefaId).toBe(a.tarefaId)
    const [t] = await dono<{ mensagens_ids: string[]; executar_em: Date }[]>`SELECT mensagens_ids, executar_em FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(t!.mensagens_ids).toEqual([m1, m2])
    expect(t!.executar_em.getTime()).toBeGreaterThan(Date.now() + DEBOUNCE_MS - 500)
  })

  it('o debounce tem teto: mensagens sem parar não adiam a execução para sempre', async () => {
    await dono`INSERT INTO agente_tarefa (tenant_id, id, conversa_id, canal_id, estado, executar_em, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 'pendente', now() + interval '3 seconds', now() - make_interval(secs => ${TETO_DEBOUNCE_MS / 1000 + 5}))`
    await agendar(CONVERSA)
    const [t] = await dono<{ atrasada: boolean }[]>`SELECT executar_em <= now() AS atrasada FROM agente_tarefa WHERE tenant_id = ${T} AND estado = 'pendente'`
    expect(t!.atrasada).toBe(true)
  })

  it('a tarefa só vence depois do debounce', async () => {
    await agendar(CONVERSA)
    expect(await pegarProximaTarefa(dono as never, agora())).toBeNull()
    const depois = new Date(Date.now() + DEBOUNCE_MS + 10)
    const t = await pegarProximaTarefa(dono as never, depois)
    expect(t?.conversa_id).toBe(CONVERSA)
  })
})

describe('Serialização por conversa', () => {
  it('dado uma executando, quando nasce outra pendente da MESMA conversa, então o worker não a pega', async () => {
    await agendar(CONVERSA, undefined, 0)
    const primeira = await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))
    expect(primeira).not.toBeNull()
    await agendar(CONVERSA, undefined, 0)
    expect(await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))).toBeNull()
    await concluirTarefa(dono as never, primeira!, agora())
    const segunda = await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))
    expect(segunda?.conversa_id).toBe(CONVERSA)
  })

  it('⚠️ reagendar/falhar quando já nasceu outra pendente CANCELA a antiga em vez de violar o índice', async () => {
    await agendar(CONVERSA, undefined, 0)
    const antiga = (await pegarProximaTarefa(dono as never, new Date(Date.now() + 10)))!
    const nova = await agendar(CONVERSA, undefined, 0) // chegou mensagem durante o turno
    expect(nova.tarefaId).not.toBe(antiga.id)
    expect(await reagendarTarefa(dono as never, antiga, agora())).toBe('cancelada')
    const [l] = await dono<{ estado: string }[]>`SELECT estado FROM agente_tarefa WHERE id = ${antiga.id}`
    expect(l!.estado).toBe('cancelada')
    // A nova é pega normalmente: nada ficou executando.
    const proxima = await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))
    expect(proxima?.id).toBe(nova.tarefaId)
    await concluirTarefa(dono as never, proxima!, agora())
    // E o mesmo vale para falhar.
    await agendar(CONVERSA, undefined, 0)
    const t2 = (await pegarProximaTarefa(dono as never, new Date(Date.now() + 10)))!
    await agendar(CONVERSA, undefined, 0)
    await expect(falharTarefa(dono as never, t2, 'boom', agora())).resolves.toBe('reagendada')
    const [l2] = await dono<{ estado: string }[]>`SELECT estado FROM agente_tarefa WHERE id = ${t2.id}`
    expect(l2!.estado).toBe('cancelada')
  })

  it('outra conversa não espera', async () => {
    await agendar(CONVERSA, undefined, 0)
    await agendar(CONVERSA2, undefined, 0)
    const a = await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))
    const b = await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))
    expect(new Set([a?.conversa_id, b?.conversa_id])).toEqual(new Set([CONVERSA, CONVERSA2]))
  })
})

describe('Falha e recuperação', () => {
  it('falha reagenda com backoff até o teto; no teto marca falhou com o erro', async () => {
    await agendar(CONVERSA, undefined, 0)
    let t = (await pegarProximaTarefa(dono as never, new Date(Date.now() + 10)))!
    for (let i = 1; i < MAX_TENTATIVAS; i++) {
      expect(await falharTarefa(dono as never, t, 'boom', agora())).toBe('reagendada')
      t = (await pegarProximaTarefa(dono as never, new Date(Date.now() + 60_000 * i)))!
      expect(t).not.toBeNull()
    }
    expect(await falharTarefa(dono as never, t, 'boom final', agora())).toBe('desistiu')
    const [l] = await dono<{ estado: string; ultimo_erro: string }[]>`SELECT estado, ultimo_erro FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(l).toMatchObject({ estado: 'falhou', ultimo_erro: 'boom final' })
  })

  it('executando há muito tempo volta para a fila (processo morreu)', async () => {
    await agendar(CONVERSA, undefined, 0)
    const t = (await pegarProximaTarefa(dono as never, new Date(Date.now() + 10)))!
    await dono`UPDATE agente_tarefa SET iniciada_em = now() - interval '10 minutes' WHERE id = ${t.id}`
    expect(await recuperarTravadas(dono as never, agora())).toBe(1)
    const [l] = await dono<{ estado: string }[]>`SELECT estado FROM agente_tarefa WHERE id = ${t.id}`
    expect(l!.estado).toBe('pendente')
  })
})

describe('Verificação de sequência', () => {
  it('dado mensagem entrante depois das da tarefa, então chegouMensagemNova é verdadeiro', async () => {
    const m1 = 'b1f10000-bbbb-4000-8000-000000000001'
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, ${m1}, ${CONVERSA}, 'entrante', 'texto', '{"texto":"oi"}', now() - interval '5 seconds')`
    expect(await comTenantServico(T, (tx) => chegouMensagemNova(tx, CONVERSA, [m1]))).toBe(false)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'entrante', 'texto', '{"texto":"e aí?"}', now())`
    expect(await comTenantServico(T, (tx) => chegouMensagemNova(tx, CONVERSA, [m1]))).toBe(true)
  })
})
