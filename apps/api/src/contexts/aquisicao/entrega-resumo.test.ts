import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  entregarNoOutbox, entregarResumoDoTenant, varrerResumoDiario, TIPO_EVENTO_RESUMO,
} from './entrega-resumo.js'
import { montarResumo } from './resumo-diario.js'
import type { Sql } from '../../db/index.js'

/**
 * A entrega do resumo diário (AQ-08).
 *
 * ⚠️ O que pode dar errado aqui é invisível: resumo entregue DUAS vezes (e o
 * cliente para de confiar no relatório), ou carimbado com o dia errado para quem
 * não vive no fuso de Brasília.
 *
 * ⚠️ As asserções são por TENANT, nunca sobre os contadores globais da varredura:
 * os arquivos de teste rodam em paralelo e outro tenant de teste entraria na
 * conta. Contador global em teste de varredura é flake esperando o dia cheio.
 */

const PLANO = '00161b00-1111-4000-8000-000000000001'
const MODELO = '00161b00-4444-4000-8000-000000000001'

/** São Paulo (UTC-3) e Manaus (UTC-4) — a diferença entre eles é o teste. */
const T_SP = '00161b00-2222-4000-8000-000000000001'
const PV_SP = '00161b00-3333-4000-8000-000000000001'
const T_MAO = '00161b00-2222-4000-8000-000000000002'
const PV_MAO = '00161b00-3333-4000-8000-000000000002'

const CONTA = (n: number) => `00161b00-7777-4000-8000-00000000000${n}`
const CAMP = (n: number) => `00161b00-8888-4000-8000-00000000000${n}`
const CONJ = (n: number) => `00161b00-9999-4000-8000-00000000000${n}`
const AD = (n: number) => `00161b00-aaaa-4000-8000-00000000000${n}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const sql = dono as unknown as Sql

/** 23:30 UTC → 20:30 em SP (dia 24) e 19:30 em Manaus (dia 24). */
const AGORA_20H_SP = new Date('2026-08-24T23:30:00Z')
/** 01:00 UTC do dia 25 → 22h em SP e 21h em Manaus, ambos AINDA no dia 24. */
const AGORA_DEPOIS_DA_VIRADA_UTC = new Date('2026-08-25T01:00:00Z')
const DIA = '2026-08-24'

beforeAll(async () => {
  // ⚠️ `codigo` é único GLOBAL: reaproveitar o código de outro arquivo de teste
  //    faz o ON CONFLICT engolir a inserção e o tenant nasce sem plano.
  await dono`INSERT INTO plano (id, codigo, nome)
             VALUES (${PLANO}, 'plano-teste-entrega-resumo', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome)
             VALUES (${MODELO}, 'modelo-teste-entrega-resumo', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, fuso] of [
    [T_SP, PV_SP, 'America/Sao_Paulo'],
    [T_MAO, PV_MAO, 'America/Manaus'],
  ] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso)
               VALUES (${t}, 'Loja', ${PLANO}, ${pv}, ${fuso})
               ON CONFLICT (id) DO UPDATE SET fuso = EXCLUDED.fuso`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
})

async function limpar(): Promise<void> {
  for (const t of [T_SP, T_MAO]) {
    await dono`DELETE FROM midia_resumo_entregue WHERE tenant_id = ${t}`
    await dono`DELETE FROM outbox               WHERE tenant_id = ${t}`
    await dono`DELETE FROM alerta               WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_metrica_dia    WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_conta          WHERE tenant_id = ${t}`
  }
}

beforeEach(async () => {
  await limpar()
  let n = 1
  for (const t of [T_SP, T_MAO]) {
    await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
               VALUES (${t}, ${CONTA(n)}, 'google', ${'resumo-' + n}, 'Conta')`
    await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
               VALUES (${t}, ${CAMP(n)}, ${CONTA(n)}, ${'c' + n}, 'Camp')`
    await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
               VALUES (${t}, ${CONJ(n)}, ${CAMP(n)}, ${'g' + n}, 'Conj')`
    await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
               VALUES (${t}, ${AD(n)}, ${CONJ(n)}, ${'a' + n}, 'Anúncio')`
    n++
  }
})

afterAll(async () => {
  await limpar()
  await dono.end()
})

async function gastar(tenant: string, anuncio: string, dia: string, centavos: number): Promise<void> {
  await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, cliques, custo_centavos)
             VALUES (${tenant}, ${anuncio}, ${dia}::date, 10, ${centavos})
             ON CONFLICT (tenant_id, anuncio_id, dia) DO UPDATE
               SET custo_centavos = EXCLUDED.custo_centavos`
}

const eventos = (t: string) => dono<{ tipo: string; payload: { dia?: string; texto?: string } }[]>`
  SELECT tipo, payload FROM outbox WHERE tenant_id = ${t} AND tipo = ${TIPO_EVENTO_RESUMO}`

describe('Entrega no webhook de saída', () => {
  it('grava o evento com o TEXTO do resumo — o receptor não tem API para buscar', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)
    const resumo = await montarResumo(sql, T_SP, AGORA_20H_SP, DIA)

    expect(await entregarNoOutbox(sql, resumo, DIA)).toBe(true)

    const evs = await eventos(T_SP)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.payload.dia).toBe(DIA)
    expect(evs[0]!.payload.texto).toContain('Investido')
  })

  /**
   * ⚠️ A trava é a chave `(tenant_id, dia)` do `0061`, não um `SELECT` antes do
   * `INSERT` — que perde a corrida entre duas instâncias por construção.
   */
  it('a segunda entrega do mesmo dia não acontece', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)
    const resumo = await montarResumo(sql, T_SP, AGORA_20H_SP, DIA)

    expect(await entregarNoOutbox(sql, resumo, DIA)).toBe(true)
    expect(await entregarNoOutbox(sql, resumo, DIA)).toBe(false)

    expect(await eventos(T_SP)).toHaveLength(1)
  })

  it('recibo e evento nascem no MESMO commit — o recibo aponta para o evento', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)
    const resumo = await montarResumo(sql, T_SP, AGORA_20H_SP, DIA)
    await entregarNoOutbox(sql, resumo, DIA)

    const [r] = await dono<{ outbox_id: string | null }[]>`
      SELECT outbox_id FROM midia_resumo_entregue WHERE tenant_id = ${T_SP} AND dia = ${DIA}::date`
    expect(r?.outbox_id).not.toBeNull()
  })
})

describe('A hora é a do CLIENTE, não a do servidor', () => {
  it('antes das 20h locais, ninguém recebe', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)
    // 12:00 UTC = 09:00 em SP.
    expect(await entregarResumoDoTenant(sql, T_SP, new Date('2026-08-24T12:00:00Z')))
      .toBe('fora_da_hora')
    expect(await eventos(T_SP)).toHaveLength(0)
  })

  it('às 20h30 de SP, SP recebe e Manaus (19h30) ainda não', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)
    await gastar(T_MAO, AD(2), DIA, 20_000)

    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('entregue')
    expect(await entregarResumoDoTenant(sql, T_MAO, AGORA_20H_SP)).toBe('fora_da_hora')

    expect(await eventos(T_SP)).toHaveLength(1)
    expect(await eventos(T_MAO)).toHaveLength(0)
  })

  /**
   * ⚠️ O BUG QUE ESTE TESTE FECHA: às 21h de Manaus o relógio em UTC já virou o
   * dia 25. Um resumo carimbado com o dia UTC diria "25/08" para um dia que o
   * cliente ainda está vivendo — e leria as métricas do dia errado.
   */
  it('depois da virada do dia em UTC, o carimbo continua sendo o dia LOCAL', async () => {
    await gastar(T_MAO, AD(2), DIA, 20_000)

    expect(await entregarResumoDoTenant(sql, T_MAO, AGORA_DEPOIS_DA_VIRADA_UTC)).toBe('entregue')

    const [ev] = await eventos(T_MAO)
    expect(ev!.payload.dia).toBe(DIA)
    const [recibo] = await dono<{ dia: string }[]>`
      SELECT to_char(dia, 'YYYY-MM-DD') AS dia FROM midia_resumo_entregue WHERE tenant_id = ${T_MAO}`
    expect(recibo!.dia).toBe(DIA)
  })

  it('já entregue hoje, a próxima passada não repete', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)

    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('entregue')
    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('ja_entregue')

    expect(await eventos(T_SP)).toHaveLength(1)
  })
})

describe('⚠️ Sem dado não é "tudo zero"', () => {
  it('dia sem gasto, sem lead e sem alerta não gera evento nem recibo', async () => {
    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('sem_dado')

    expect(await eventos(T_SP)).toHaveLength(0)
    const recibos = await dono`SELECT dia FROM midia_resumo_entregue WHERE tenant_id = ${T_SP}`
    expect(recibos).toHaveLength(0)
  })

  /**
   * E porque não gerou recibo, o dia continua elegível: o lead que entra às 21h
   * faz o resumo sair às 21h, em vez de se perder até amanhã.
   */
  it('o dado que aparece mais tarde ainda vira resumo no mesmo dia', async () => {
    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('sem_dado')

    await gastar(T_SP, AD(1), DIA, 34_000)

    expect(await entregarResumoDoTenant(sql, T_SP, AGORA_20H_SP)).toBe('entregue')
    expect(await eventos(T_SP)).toHaveLength(1)
  })
})

describe('Varredura', () => {
  it('percorre os tenants com conta ativa e entrega a quem tem o que dizer', async () => {
    await gastar(T_SP, AD(1), DIA, 34_000)

    const r = await varrerResumoDiario(sql, AGORA_20H_SP)

    // ⚠️ Contadores globais só como piso: outro arquivo de teste pode ter tenant
    //    de mídia vivo no mesmo banco.
    expect(r.avaliados).toBeGreaterThanOrEqual(2)
    expect(r.entregues).toBeGreaterThanOrEqual(1)
    expect(await eventos(T_SP)).toHaveLength(1)
    expect(await eventos(T_MAO)).toHaveLength(0) // 19h30 lá
  })

  it('tenant sem tenant no banco não derruba a passada', async () => {
    expect(await entregarResumoDoTenant(sql, '00161b00-dead-4000-8000-000000000001', AGORA_20H_SP))
      .toBe('tenant_desconhecido')
  })
})
