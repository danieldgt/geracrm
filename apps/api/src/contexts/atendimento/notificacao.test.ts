import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { notificarMensagemEntrante } from './notificacao.js'

/**
 * PLT-07 — notificação ao atendente na mensagem entrante. O que o teste fixa:
 *   • conversa SEM atendimento aberto → não notifica ninguém (fica na fila);
 *   • conversa assumida → notifica o atendente;
 *   • DEDUP: várias entrantes seguidas = UMA pendência (índice parcial);
 *   • marcar lida zera o contador e uma nova entrante cria outra;
 *   • cada emissão empilha um evento no canal do usuário (outbox).
 */
const T = 'b07f0000-0000-4000-8000-000000000001'
const PV = 'b07f0000-1111-4000-8000-000000000001'
const PLANO = 'b07f0000-3333-4000-8000-000000000001'
const MODELO = 'b07f0000-4444-4000-8000-000000000001'
const CANAL = 'b07f0000-5555-4000-8000-000000000001'
const CONTATO = 'b07f0000-6666-4000-8000-000000000001'
const CONVERSA = 'b07f0000-7777-4000-8000-000000000001'
const ATEND = 'b07f0000-9999-4000-8000-000000000001'
const U1 = 'b07f0000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** Roda o helper com o tenant setado, como a ingestão faz. */
const notificar = () => dono.begin(async (tx) => {
  await tx`SELECT set_config('geracrm.tenant_id', ${T}, true)`
  await notificarMensagemEntrante(tx as never, { conversaId: CONVERSA })
})

const contarNaoLidas = async () => {
  const [c] = await dono<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notificacao WHERE tenant_id = ${T} AND usuario_id = ${U1} AND lida_em IS NULL`
  return c!.n
}
const contarEventos = async () => {
  const [c] = await dono<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND tipo = 'notificacao.nova'`
  return c!.n
}

const abrirAtendimento = () => dono`
  INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
  VALUES (${T}, ${ATEND}, ${CONVERSA}, ${CANAL}, 1, ${U1}, 'em_atendimento', now())
  ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado' DO NOTHING`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-plt07', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-plt07', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja PLT07', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Zé', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U1}, 'sub-plt07', 'Ana', 'ana@t.local') ON CONFLICT (cognito_sub) DO NOTHING`
})

afterAll(async () => {
  await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('PLT-07: notificação de mensagem entrante', () => {
  it('conversa na fila (sem atendimento) não notifica ninguém', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await notificar()
    expect(await contarNaoLidas()).toBe(0)
  })

  it('conversa assumida notifica o atendente com o nome do contato no título', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar()
    const [n] = await dono<{ titulo: string; conversa_id: string; tipo: string }[]>`
      SELECT titulo, conversa_id, tipo FROM notificacao WHERE tenant_id = ${T} AND usuario_id = ${U1}`
    expect(n).toMatchObject({ titulo: 'Cliente Zé', conversa_id: CONVERSA, tipo: 'mensagem.nova' })
    expect(await contarNaoLidas()).toBe(1)
  })

  it('⚠️ dedup: três entrantes seguidas = UMA pendência não-lida', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar(); await notificar(); await notificar()
    expect(await contarNaoLidas()).toBe(1)
  })

  it('marcar lida zera; nova entrante cria OUTRA pendência', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar()
    await dono`UPDATE notificacao SET lida_em = now() WHERE tenant_id = ${T} AND usuario_id = ${U1}`
    expect(await contarNaoLidas()).toBe(0)
    await notificar()
    expect(await contarNaoLidas()).toBe(1)
  })

  it('cada emissão empilha um evento no canal do usuário (outbox)', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar()
    expect(await contarEventos()).toBe(1)
    const [ev] = await dono<{ agregado: string; agregado_id: string }[]>`
      SELECT agregado, agregado_id FROM outbox WHERE tenant_id = ${T} AND tipo = 'notificacao.nova'`
    expect(ev).toMatchObject({ agregado: 'usuario', agregado_id: U1 })
  })
})
