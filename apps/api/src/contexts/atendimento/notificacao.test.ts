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
const U2 = 'b07f0000-8888-4000-8000-000000000002'

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
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`
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
  /**
   * ⚠️ ESTA REGRA MUDOU EM 2026-08-25, e o teste antigo (que exigia SILÊNCIO na
   * fila) tinha de falhar. A regra anterior — "conversa na fila ainda não é
   * problema de ninguém em particular; o Inbox já mostra o não-lido" — funciona
   * com alguém olhando a tela, e falha exatamente no caso que a camada de
   * aquisição existe para resolver: a resposta a um DISPARO nasce sem dono, e
   * caía numa fila que não avisava ninguém.
   */
  it('conversa na fila notifica a FILA — silêncio aqui é lead perdido', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`

    await notificar()

    const [n] = await dono<{ usuario_id: string; tipo: string; titulo: string }[]>`
      SELECT usuario_id, tipo, titulo FROM notificacao WHERE tenant_id = ${T}`
    // Sem dono de carteira e sem `usuario_canal`: cai no time inteiro (Ana).
    expect(n).toMatchObject({ usuario_id: U1, tipo: 'fila.nova', titulo: 'Cliente Zé' })
  })

  /**
   * ⚠️ Precedência: quem tem a RELAÇÃO é avisado, e só ele. Avisar o time inteiro
   * sobre o cliente de alguém é ruído para todos e responsabilidade de ninguém.
   */
  it('com dono de carteira, avisa só ele', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${T}, ${U2}, 'sub-plt07-b', 'Bruno', 'bruno@t.local')
               ON CONFLICT (cognito_sub) DO NOTHING`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`
    // ⚠️ A coluna é `de`, não `desde` — e `ate IS NULL` é o que marca a posse VIGENTE.
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, de)
               VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${U2}, now())`

    await notificar()

    const alvos = await dono<{ usuario_id: string }[]>`
      SELECT usuario_id FROM notificacao WHERE tenant_id = ${T}`
    expect(alvos).toHaveLength(1)
    expect(alvos[0]!.usuario_id).toBe(U2)
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`
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

  /**
   * ⚠️ O dedup acima é o que faz o push parecer morto: o segundo aviso da mesma
   * conversa SUBSTITUI o primeiro na tela (a `tag` do service worker). Sem saber
   * quantas mensagens entraram, o aviso substituto repete a mesma frase e a
   * pessoa conclui que parou de funcionar — aconteceu em produção em 26/08.
   */
  it('⚠️ a pendência CONTA as mensagens que dedupou', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar(); await notificar(); await notificar()
    const [n] = await dono<{ vezes: number }[]>`
      SELECT vezes FROM notificacao WHERE tenant_id = ${T} AND lida_em IS NULL LIMIT 1`
    expect(n!.vezes).toBe(3)
  })

  it('lida a pendência, a contagem recomeça do 1', async () => {
    await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
    await abrirAtendimento()
    await notificar(); await notificar()
    await dono`UPDATE notificacao SET lida_em = now() WHERE tenant_id = ${T}`
    await notificar()
    const [n] = await dono<{ vezes: number }[]>`
      SELECT vezes FROM notificacao WHERE tenant_id = ${T} AND lida_em IS NULL LIMIT 1`
    expect(n!.vezes).toBe(1)
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
