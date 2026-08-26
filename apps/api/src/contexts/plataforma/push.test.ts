import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  despacharPushDoTenant, montarPayload, assinaturaMorreu, configVapid, type EnviarPush,
} from './push.js'
import type { Sql } from '../../db/index.js'

/**
 * Push nativo (PLT-07).
 *
 * ⚠️ O envio entra por parâmetro: estes testes não tocam a rede nem o serviço de
 * push de ninguém. O que eles guardam é o comportamento em volta — o que vai no
 * payload, o que acontece com assinatura morta, e o cursor.
 */

const T = 'a11f0000-0000-4000-8000-000000000001'
const PV = 'a11f0000-1111-4000-8000-000000000001'
const PLANO = 'a11f0000-3333-4000-8000-000000000001'
const MODELO = 'a11f0000-4444-4000-8000-000000000001'
const USUARIO = 'a11f0000-5555-4000-8000-000000000001'
const CONTATO = 'a11f0000-6666-4000-8000-000000000001'
const CANAL = 'a11f0000-7777-4000-8000-000000000001'
const CONVERSA = 'a11f0000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const sql = dono as unknown as Sql

/** Envio falso: registra o que foi chamado e devolve o status combinado. */
function envioFalso(status = 201): { enviar: EnviarPush; chamadas: { endpoint: string; payload: string }[] } {
  const chamadas: { endpoint: string; payload: string }[] = []
  const enviar: EnviarPush = async (a, payload) => {
    chamadas.push({ endpoint: a.endpoint, payload })
    return { ok: status >= 200 && status < 300, status }
  }
  return { enviar, chamadas }
}

async function assinar(endpoint: string): Promise<void> {
  await dono`INSERT INTO push_assinatura (tenant_id, id, usuario_id, endpoint, p256dh, auth)
             VALUES (${T}, ${randomUUID()}, ${USUARIO}, ${endpoint}, 'chave-p256', 'chave-auth')`
}

async function notificar(titulo: string): Promise<void> {
  await dono`INSERT INTO notificacao (tenant_id, id, usuario_id, tipo, titulo, conversa_id)
             VALUES (${T}, ${randomUUID()}, ${USUARIO}, 'mensagem.nova', ${titulo}, ${CONVERSA})`
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-push', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-push', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
             VALUES (${T}, ${USUARIO}, 'sub-push-teste', 'Atendente', 'push@teste.local')
             ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Cliente') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Vendas', 'conectado')
             ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id)
             VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM push_assinatura WHERE tenant_id = ${T}`
  await dono`DELETE FROM push_cursor     WHERE tenant_id = ${T}`
  await dono`DELETE FROM notificacao     WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM push_assinatura WHERE tenant_id = ${T}`
  await dono`DELETE FROM push_cursor     WHERE tenant_id = ${T}`
  await dono`DELETE FROM notificacao     WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa        WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato         WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario         WHERE tenant_id = ${T}`
  await dono.end()
})

describe('⚠️ O payload não carrega a conversa', () => {
  /**
   * A regra do ADR-007 vale duas vezes aqui: o payload passa pelo serviço de
   * push do navegador (fora da nossa RLS) E aparece na tela de bloqueio do
   * aparelho, à vista de quem estiver por perto.
   */
  it('leva quem escreveu e o id da conversa — nunca o texto', () => {
    const p = JSON.parse(montarPayload('Maria da Silva', CONVERSA))
    expect(p.corpo).toContain('Maria da Silva')
    expect(p.conversaId).toBe(CONVERSA)
    expect(JSON.stringify(p)).not.toContain('mensagem do cliente')
  })

  it('sem nome, ainda avisa — genérico é melhor que silêncio', () => {
    const p = JSON.parse(montarPayload('', CONVERSA))
    expect(p.corpo).toContain('mensagem')
  })
})

/**
 * ⚠️ O aviso da MESMA conversa substitui o anterior na tela (a `tag` do service
 * worker existe para não empilhar dez avisos da mesma pessoa). Se o texto for
 * idêntico, a substituição é indistinguível de nada ter acontecido — e foi
 * exatamente assim que o push passou por "morto" em 26/08, com a entrega
 * funcionando o tempo todo. O corpo tem de CARREGAR a novidade.
 */
describe('O aviso que substitui precisa trazer notícia', () => {
  it('a partir da segunda, diz quantas mensagens novas', () => {
    const p = JSON.parse(montarPayload('Maria da Silva', CONVERSA, 3))
    expect(p.corpo).toContain('Maria da Silva')
    expect(p.corpo).toContain('3')
    // ⚠️ E continua sem o texto da mensagem: a tela de bloqueio é pública.
    expect(JSON.stringify(p)).not.toContain('mensagem do cliente')
  })

  it('a primeira continua com a frase simples', () => {
    expect(JSON.parse(montarPayload('Maria da Silva', CONVERSA, 1)).corpo)
      .toBe('Maria da Silva respondeu')
  })

  it('sem nome e repetida, ainda conta', () => {
    expect(JSON.parse(montarPayload('', CONVERSA, 4)).corpo).toContain('4')
  })
})

describe('Despacho', () => {
  it('sem cursor (ninguém assinou), não empurra nada', async () => {
    await notificar('Maria')
    const { enviar, chamadas } = envioFalso()

    const r = await despacharPushDoTenant(sql, T, enviar)

    expect(r.enviados).toBe(0)
    expect(chamadas).toHaveLength(0)
  })

  /**
   * ⚠️ O cursor nasce no AGORA da primeira assinatura: assinar hoje não pode
   * disparar o histórico da semana passada no celular de alguém.
   */
  it('notificação ANTERIOR à assinatura não vira push', async () => {
    await notificar('Antiga')
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/1')

    const { enviar, chamadas } = envioFalso()
    await despacharPushDoTenant(sql, T, enviar)

    expect(chamadas).toHaveLength(0)
  })

  it('notificação nova vira push, e o cursor avança', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/1')
    await notificar('Maria')

    const { enviar, chamadas } = envioFalso()
    const r = await despacharPushDoTenant(sql, T, enviar)

    expect(r.enviados).toBe(1)
    expect(chamadas[0]!.payload).toContain('Maria')

    // Segunda passada não repete — o cursor andou.
    const segunda = envioFalso()
    expect((await despacharPushDoTenant(sql, T, segunda.enviar)).enviados).toBe(0)
  })

  it('já lida não vira push — a pessoa está com o console aberto e já viu', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/1')
    await notificar('Maria')
    await dono`UPDATE notificacao SET lida_em = now() WHERE tenant_id = ${T}`

    const { enviar, chamadas } = envioFalso()
    await despacharPushDoTenant(sql, T, enviar)
    expect(chamadas).toHaveLength(0)
  })

  it('empurra para TODOS os aparelhos da pessoa', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/desktop')
    await assinar('https://push.exemplo/celular')
    await notificar('Maria')

    const { enviar, chamadas } = envioFalso()
    const r = await despacharPushDoTenant(sql, T, enviar)

    expect(r.enviados).toBe(2)
    expect(chamadas.map((c) => c.endpoint).sort()).toEqual([
      'https://push.exemplo/celular', 'https://push.exemplo/desktop',
    ])
  })

  /**
   * ⚠️ 404/410 é resposta ESPERADA: a pessoa revogou a permissão, limpou o site
   * ou trocou de aparelho. Insistir num endpoint morto é gastar requisição para
   * sempre.
   */
  it('assinatura morta é REMOVIDA, não retentada', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/morta')
    await notificar('Maria')

    const r = await despacharPushDoTenant(sql, T, envioFalso(410).enviar)

    expect(r.removidos).toBe(1)
    const restantes = await dono`SELECT id FROM push_assinatura WHERE tenant_id = ${T}`
    expect(restantes).toHaveLength(0)
  })

  it('falha temporária guarda o motivo e mantém a assinatura', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/instavel')
    await notificar('Maria')

    const r = await despacharPushDoTenant(sql, T, envioFalso(500).enviar)

    expect(r.falhas).toBe(1)
    const [a] = await dono<{ ultimo_erro: string | null }[]>`
      SELECT ultimo_erro FROM push_assinatura WHERE tenant_id = ${T}`
    expect(a!.ultimo_erro).toContain('500')
  })

  /**
   * ⚠️ E o cursor avança MESMO com falha: push não é entrega confiável e não
   * pode virar fila de retry. A notificação já está no banco e no sino — vibrar
   * o celular por algo de dez minutos atrás é pior do que não vibrar.
   */
  it('falha não represa a fila', async () => {
    await dono`INSERT INTO push_cursor (tenant_id, ate_criado_em) VALUES (${T}, now())`
    await assinar('https://push.exemplo/instavel')
    await notificar('Maria')
    await despacharPushDoTenant(sql, T, envioFalso(500).enviar)

    const segunda = envioFalso()
    await despacharPushDoTenant(sql, T, segunda.enviar)
    expect(segunda.chamadas).toHaveLength(0)
  })
})

describe('Configuração', () => {
  it('sem chaves no ambiente, o push simplesmente não existe', () => {
    expect(configVapid({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('com chaves, assume um contato padrão se ninguém declarar', () => {
    const cfg = configVapid({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' } as never)
    expect(cfg?.assunto).toContain('mailto:')
  })

  it('404 e 410 são morte; 500 não é', () => {
    expect(assinaturaMorreu(404)).toBe(true)
    expect(assinaturaMorreu(410)).toBe(true)
    expect(assinaturaMorreu(500)).toBe(false)
  })
})
