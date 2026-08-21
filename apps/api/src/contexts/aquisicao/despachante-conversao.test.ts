import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  backoffSegundos, decidirAposFalha, avaliarDescarte, despacharDoTenant, despacharTodos,
  MAX_TENTATIVAS, DIAS_JANELA_IMPORTACAO, type AdaptadorPara,
} from './despachante-conversao.js'
import type { Sql } from '../../db/index.js'
import type {
  PortaPlataformaMidia, MotivoFalhaPlataforma, ConversaoParaEnvio,
} from './plataformas/porta.js'

const T = 'c0f1a000-0000-4000-8000-000000000001'
const PV = 'c0f1a000-1111-4000-8000-000000000001'
const PLANO = 'c0f1a000-3333-4000-8000-000000000001'
const MODELO = 'c0f1a000-4444-4000-8000-000000000001'
const CONTA = 'c0f1a000-7777-4000-8000-000000000001'
const CONTATO = 'c0f1a000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const AGORA = new Date('2026-08-21T12:00:00Z')

/** Adaptador falso — a plataforma nunca é chamada de verdade. */
function adaptadorFalso(
  resposta: { ok: true } | { ok: false; motivo: MotivoFalhaPlataforma },
  opcoes: { conversaoOffline?: boolean } = {},
): { fabrica: AdaptadorPara; enviadas: ConversaoParaEnvio[] } {
  const enviadas: ConversaoParaEnvio[] = []
  const porta = {
    plataforma: 'google',
    capacidades: {
      leituraEstrutura: true, leituraMetrica: true, publicoPersonalizado: false,
      conversaoOffline: opcoes.conversaoOffline ?? true,
      cliqueParaConversa: false, escritaEstado: false, escritaOrcamento: false,
    },
    async testarConexao() { return { ok: true as const, dados: { nomeConta: 'x', moeda: 'BRL' } } },
    async lerEstrutura() { return { ok: true as const, dados: { campanhas: [], conjuntos: [], anuncios: [] } } },
    async lerMetricas() { return { ok: true as const, dados: [] } },
    async enviarConversao(_conta: string, c: ConversaoParaEnvio) {
      enviadas.push(c)
      return resposta.ok
        ? { ok: true as const, dados: { idExterno: 'ext-1' } }
        : { ok: false as const, motivo: resposta.motivo }
    },
  } as unknown as PortaPlataformaMidia
  return { fabrica: () => porta, enviadas }
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-desp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-desp', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Lead') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', 'conta-desp', 'Conta') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM midia_conversao   WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono.end()
})

/** Cria origem + conversão pendente. `clickId: null` simula origem sem identificador. */
async function pendente(opcoes: {
  clickId?: string | null; ocorridaEm?: Date; tentativas?: number; eventId?: string
} = {}): Promise<string> {
  const [o] = await dono<{ id: string }[]>`
    INSERT INTO midia_lead_origem (tenant_id, id, contato_id, plataforma, conta_id, click_id, primeira)
    VALUES (${T}, gen_random_uuid(), ${CONTATO}, 'google', ${CONTA},
            ${opcoes.clickId === undefined ? 'gclid-abc' : opcoes.clickId}, false)
    RETURNING id`
  // ⚠️ `proxima_tentativa_em` é EXPLÍCITA e no passado de AGORA. O default é
  //    `now()` do banco — deixar assim faria o teste depender do relógio de
  //    parede: se a máquina estivesse à frente do AGORA fixo, a fila viria vazia
  //    e o teste falharia sem ninguém entender por quê.
  const [c] = await dono<{ id: string }[]>`
    INSERT INTO midia_conversao (tenant_id, id, origem_id, plataforma, tipo_evento, event_id,
                                 valor_centavos, venda_id, venda_ocorrida_em, tentativas,
                                 proxima_tentativa_em, criado_em)
    VALUES (${T}, gen_random_uuid(), ${o!.id}, 'google', 'compra',
            ${opcoes.eventId ?? 'ev-' + Math.floor(AGORA.getTime())}, 50000,
            gen_random_uuid(), ${opcoes.ocorridaEm ?? new Date('2026-08-20T12:00:00Z')},
            ${opcoes.tentativas ?? 0},
            ${new Date(AGORA.getTime() - 60_000)}, ${new Date(AGORA.getTime() - 60_000)})
    RETURNING id`
  return c!.id
}

const estado = async (id: string) => (await dono<{
  estado: string; tentativas: number; ultimo_erro: string | null; proxima_tentativa_em: Date
}[]>`SELECT estado, tentativas, ultimo_erro, proxima_tentativa_em
       FROM midia_conversao WHERE tenant_id = ${T} AND id = ${id}`)[0]!

const sql = dono as unknown as Sql

describe('Backoff', () => {
  it('cresce e para no teto de 6h', () => {
    expect(backoffSegundos(1)).toBe(300)
    expect(backoffSegundos(2)).toBe(600)
    expect(backoffSegundos(3)).toBe(1200)
    expect(backoffSegundos(20)).toBe(21_600)
  })

  // ⚠️ Mais lento que o do webhook de propósito: conversão não é notificação, e
  //    insistir rápido contra API de anúncio gasta cota que o sync precisa.
  it('é mais lento que o do webhook, que começa em 30s', () => {
    expect(backoffSegundos(1)).toBeGreaterThan(30)
  })
})

describe('Descarte — decidido ANTES de chamar a plataforma', () => {
  it('origem sem click_id não tem como casar', () => {
    expect(avaliarDescarte({ clickId: null, ocorridaEm: AGORA }, true, AGORA)).toBe('sem_identificador')
  })

  it('fato mais velho que a janela nasce recusado', () => {
    const velho = new Date(AGORA.getTime() - (DIAS_JANELA_IMPORTACAO + 1) * 86_400_000)
    expect(avaliarDescarte({ clickId: 'g', ocorridaEm: velho }, true, AGORA)).toBe('fora_da_janela_de_importacao')
  })

  it('dentro da janela, segue', () => {
    const recente = new Date(AGORA.getTime() - 10 * 86_400_000)
    expect(avaliarDescarte({ clickId: 'g', ocorridaEm: recente }, true, AGORA)).toBeNull()
  })

  it('plataforma sem a capacidade descarta em vez de tentar', () => {
    expect(avaliarDescarte({ clickId: 'g', ocorridaEm: AGORA }, false, AGORA)).toBe('plataforma_sem_capacidade')
  })
})

describe('Decisão após falha', () => {
  /**
   * ⚠️ A regra que protege a receita: rajada de rate limit não pode mandar para o
   * dead-letter um lote de conversões válidas. Estourar cota é defeito do NOSSO
   * ritmo, não da conversão.
   */
  it('limite_de_taxa reagenda SEM consumir tentativa', () => {
    const d = decidirAposFalha('limite_de_taxa', 5)
    expect(d).toMatchObject({ acao: 'reagendar', tentativas: 5 })
  })

  it('e nem no limite de tentativas o rate limit mata a conversão', () => {
    const d = decidirAposFalha('limite_de_taxa', MAX_TENTATIVAS - 1)
    expect(d.acao).toBe('reagendar')
  })

  // ⚠️ Retentar credencial revogada 8 vezes só atrasa a descoberta de um
  //    problema que é humano.
  it.each(['credencial_invalida', 'sem_permissao', 'conta_indisponivel'] as const)(
    '%s vai direto ao dead-letter', (motivo) => {
      expect(decidirAposFalha(motivo, 0).acao).toBe('dead_letter')
    })

  it('indisponivel retenta e consome tentativa', () => {
    expect(decidirAposFalha('indisponivel', 2)).toMatchObject({ acao: 'reagendar', tentativas: 3 })
  })

  it('esgotadas as tentativas, vira dead-letter', () => {
    expect(decidirAposFalha('indisponivel', MAX_TENTATIVAS - 1).acao).toBe('dead_letter')
  })
})

describe('Despacho contra o banco', () => {
  it('entrega e marca como enviada, com o valor em centavos', async () => {
    const id = await pendente()
    const { fabrica, enviadas } = adaptadorFalso({ ok: true })
    const r = await despacharDoTenant(sql, T, fabrica, AGORA)

    expect(r.enviadas).toBe(1)
    expect((await estado(id)).estado).toBe('enviada')
    expect(enviadas[0]!.valorCentavos).toBe(50000)  // ⚠️ número, não string
    expect(enviadas[0]!.clickId).toBe('gclid-abc')
  })

  it('origem sem click_id é descartada sem chamar a plataforma', async () => {
    const id = await pendente({ clickId: null })
    const { fabrica, enviadas } = adaptadorFalso({ ok: true })
    const r = await despacharDoTenant(sql, T, fabrica, AGORA)

    expect(r.descartadas).toBe(1)
    expect(enviadas).toHaveLength(0)  // ⚠️ não gastou cota
    expect(await estado(id)).toMatchObject({ estado: 'descartada', ultimo_erro: 'sem_identificador' })
  })

  it('rate limit reagenda no futuro e mantém pendente', async () => {
    const id = await pendente({ tentativas: 3 })
    const r = await despacharDoTenant(sql, T, adaptadorFalso({ ok: false, motivo: 'limite_de_taxa' }).fabrica, AGORA)

    expect(r.reagendadas).toBe(1)
    const e = await estado(id)
    expect(e.estado).toBe('pendente')
    expect(e.tentativas).toBe(3)  // ⚠️ não consumiu
    expect(e.proxima_tentativa_em.getTime()).toBeGreaterThan(AGORA.getTime())
  })

  it('credencial inválida vira dead-letter na primeira', async () => {
    const id = await pendente()
    const r = await despacharDoTenant(sql, T, adaptadorFalso({ ok: false, motivo: 'credencial_invalida' }).fabrica, AGORA)

    expect(r.falhadas).toBe(1)
    expect(await estado(id)).toMatchObject({ estado: 'falhou', ultimo_erro: 'credencial_invalida' })
  })

  it('não pega conversão cuja hora ainda não chegou', async () => {
    const id = await pendente()
    await dono`UPDATE midia_conversao SET proxima_tentativa_em = ${new Date(AGORA.getTime() + 3600_000)}
                WHERE tenant_id = ${T} AND id = ${id}`
    const r = await despacharDoTenant(sql, T, adaptadorFalso({ ok: true }).fabrica, AGORA)
    expect(r.enviadas).toBe(0)
  })

  // ⚠️ Conversão entregue duas vezes infla a receita no painel da plataforma —
  //    e o número fica MAIOR, então ninguém reclama.
  it('a segunda passada não reenvia o que já foi enviado', async () => {
    await pendente()
    const { fabrica, enviadas } = adaptadorFalso({ ok: true })
    await despacharDoTenant(sql, T, fabrica, AGORA)
    await despacharDoTenant(sql, T, fabrica, AGORA)
    expect(enviadas).toHaveLength(1)
  })

  it('uma falha não desfaz a entrega da anterior', async () => {
    const okId = await pendente({ eventId: 'ev-ok' })
    await dono`UPDATE midia_conversao SET estado='enviada' WHERE tenant_id=${T} AND id=${okId}`
    await pendente({ eventId: 'ev-falha' })

    await despacharDoTenant(sql, T, adaptadorFalso({ ok: false, motivo: 'credencial_invalida' }).fabrica, AGORA)
    expect((await estado(okId)).estado).toBe('enviada')
  })

  it('a varredura de todos os tenants alcança o pendente', async () => {
    await pendente()
    const r = await despacharTodos(sql, adaptadorFalso({ ok: true }).fabrica, AGORA)
    expect(r.enviadas).toBeGreaterThanOrEqual(1)
  })
})
