import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * QUEM SE MARCOU AUSENTE NÃO RESPONDE — pelo ENDPOINT, que é onde a regra
 * precisa valer.
 *
 * ⚠️ Testar só a tela não provaria nada: o campo de digitação escondido é
 * conforto, e a aba que já estava aberta quando a pessoa se marcou ausente
 * continua com o botão de enviar desenhado. A trava é esta, no servidor.
 *
 * ⚠️ O par "ausente" + "assumir" é o mais perigoso dos dois: assumir CALA o
 * agente naquela conversa por uma hora (`atendente_presente` no portão), então
 * quem está fora da mesa desligaria o robô sem colocar ninguém no lugar — o
 * cliente escreve e não recebe nada de ninguém. É a mesma família da assunção
 * esquecida que silenciou a resposta de ausência em 26/08.
 */
const T = 'a05e0000-0000-4000-8000-000000000001'
const PV = 'a05e0000-1111-4000-8000-000000000001'
const PLANO = 'a05e0000-3333-4000-8000-000000000001'
const MODELO = 'a05e0000-4444-4000-8000-000000000001'
const CANAL = 'a05e0000-5555-4000-8000-000000000001'
const CONTATO = 'a05e0000-6666-4000-8000-000000000001'
const CONVERSA = 'a05e0000-7777-4000-8000-000000000001'
const USUARIO = 'a05e0000-8888-4000-8000-000000000001'
/** ⚠️ O mesmo `sub` sintético que `subDoUsuario` produz em dev (por tenant). */
const SUB = `dev-${T}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const com = (m: 'GET' | 'POST' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': T }, ...(corpo ? { payload: corpo } : {}) })

const marcar = (ausente: boolean) => com('PATCH', '/v1/config/ausencia', { ausente })
const enviar = () => com('POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'oi' })
const assumir = () => com('POST', `/v1/conversas/${CONVERSA}/assumir`, {})

const contarMensagens = async () => {
  const [r] = await dono<{ n: string }[]>`SELECT count(*) AS n FROM mensagem WHERE tenant_id = ${T}`
  return Number(r?.n ?? 0)
}
const contarAtendimentos = async () => {
  const [r] = await dono<{ n: string }[]>`SELECT count(*) AS n FROM atendimento WHERE tenant_id = ${T}`
  return Number(r?.n ?? 0)
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a05e', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a05e', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Presenca', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado', '\\x00'::bytea) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990000', '5585999990000', true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             VALUES (${T}, ${USUARIO}, ${SUB}, 'Ana', 'ana@presenca.local') ON CONFLICT (tenant_id, cognito_sub) DO NOTHING`

  app = await criarApp()
  await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM auditoria WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento_etapa_historico WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento_etapa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close()
  await encerrarBanco()
  await dono.end()
})

describe('Ausente vê, não responde', () => {
  it('o estado vai e volta, e a tela pergunta sobre SI MESMA (/config/eu)', async () => {
    expect((await com('GET', '/v1/config/eu')).json()).toMatchObject({ ausente: false })

    expect((await marcar(true)).statusCode).toBe(200)
    expect((await com('GET', '/v1/config/eu')).json()).toMatchObject({ ausente: true, nome: 'Ana' })

    expect((await marcar(false)).statusCode).toBe(200)
    expect((await com('GET', '/v1/config/eu')).json()).toMatchObject({ ausente: false })
  })

  /**
   * ⚠️ A recusa vem ANTES de gravar. Recusar depois deixaria uma linha
   * 'pendente' no histórico de uma mensagem que nunca existiu para o cliente —
   * e o inbox mostraria ao colega uma resposta que ninguém mandou.
   */
  it('marcado ausente, o envio é recusado e NADA é gravado', async () => {
    await marcar(true)
    const antes = await contarMensagens()

    const r = await enviar()
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ ok: false, erro: 'operador_ausente' })
    // ⚠️ A mensagem nomeia a AÇÃO CORRETIVA (PED-08), não só o estado.
    expect((r.json() as { mensagem: string }).mensagem).toContain('Estou disponível')

    expect(await contarMensagens()).toBe(antes)
  })

  /** ⚠️ Assumir estando ausente calaria o agente sem ninguém na mesa. */
  it('marcado ausente, assumir é recusado e nenhum atendimento nasce', async () => {
    await marcar(true)
    const antes = await contarAtendimentos()

    const r = await assumir()
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'operador_ausente' })

    expect(await contarAtendimentos()).toBe(antes)
  })

  /**
   * ⚠️ O outro lado da regra: disponível passa. Sem este caso, uma trava que
   * recusasse SEMPRE passaria nos dois testes de cima — e o produto inteiro
   * pararia de responder com todos os testes verdes.
   */
  it('de volta a disponível, o envio passa da trava e a conversa é assumida', async () => {
    await marcar(false)

    // O envio chega ao gateway: a mensagem é gravada antes do despacho. O
    // resultado do despacho não importa aqui (o canal de teste não tem
    // credencial de verdade) — o que se prova é que a presença não barrou.
    const antes = await contarMensagens()
    const r = await enviar()
    expect((r.json() as { erro?: string }).erro).not.toBe('operador_ausente')
    expect(await contarMensagens()).toBe(antes + 1)

    const a = await assumir()
    expect(a.statusCode).toBe(201)
    expect(a.json()).toMatchObject({ ok: true, meu: true })
  })
})
