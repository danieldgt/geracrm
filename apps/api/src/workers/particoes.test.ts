import { randomBytes, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { avaliarSaude, LIMITES_SAUDE_PADRAO } from '@geracrm/shared'
import { lerHorizontes, mesesCobertosAFrente, processarParticoes, MESES_A_FRENTE } from './particoes.js'

/**
 * PARTIÇÕES MENSAIS (migration 0110 + worker diário) — banco real.
 *
 *   - o registro cobre TODA tabela particionada do schema;
 *   - o worker cria o que falta (12 meses à frente) e é idempotente;
 *   - mês já coberto por partição de outro nome (a `*_anterior`) é pulado, sem erro;
 *   - limites em UTC mesmo numa sessão em outro fuso;
 *   - tabela-mãe ocupada (lock_timeout) e horizonte < 3 meses → `curtas` (o alerta)
 *     e `/saude/detalhada` degradado;
 *   - INSERT num mês futuro coberto funciona — nas tabelas reais, depois da 0110.
 *
 * ⚠️ Banco compartilhado entre arquivos: o worker roda SÓ sobre tabelas
 *    particionadas criadas por este arquivo (`deps.tabelas`) — nunca cria nem
 *    trava partição de `mensagem` debaixo de outro teste. As tabelas reais só são
 *    lidas, e o INSERT nelas é de um tenant exclusivo, apagado no fim.
 * ⚠️ As tabelas do teste moram num SCHEMA PRÓPRIO, primeiro no search_path desta
 *    conexão: os varredores de `public` (`db/scanners.test.ts`, em paralelo) não
 *    as enxergam, e as funções da 0110 (em `public`) resolvem os nomes sem prefixo.
 */
const sufixo = randomBytes(4).toString('hex')
const SCHEMA = `teste_particoes_${sufixo}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, {
  max: 3, onnotice: () => {}, connection: { search_path: `${SCHEMA}, public` } as never,
})
const T_FALTANDO = `teste_particoes_falta_${sufixo}`
const T_ESCAPE = `teste_particoes_escape_${sufixo}`
const T_CURTA = `teste_particoes_curta_${sufixo}`
const T_FUSO = `teste_particoes_fuso_${sufixo}`
const TODAS = [T_FALTANDO, T_ESCAPE, T_CURTA, T_FUSO]
const TENANT = 'c0110000-0000-4000-8000-000000000001'

/** Relógio do BANCO (host e contêiner divergem — skill geracrm-testes). */
let agora: Date
const mes = (n: number) => new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + n, 1))
const criarMae = (t: string) => dono.unsafe(`CREATE TABLE ${t} (em timestamptz NOT NULL, v int) PARTITION BY RANGE (em)`)
const particao = (t: string, nome: string, de: Date, ate: Date) =>
  dono.unsafe(`CREATE TABLE ${nome} PARTITION OF ${t} FOR VALUES FROM ('${de.toISOString()}') TO ('${ate.toISOString()}')`)
const contar = async (t: string) =>
  (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM particoes_mensais_da_tabela(${t})`)[0]!.n

beforeAll(async () => {
  await dono.unsafe(`CREATE SCHEMA ${SCHEMA}`)
  agora = (await dono<{ agora: Date }[]>`SELECT now() AS agora`)[0]!.agora
  for (const t of TODAS) await criarMae(t)
  // Só o mês corrente: o worker tem 12 para criar.
  await particao(T_FALTANDO, `${T_FALTANDO}_atual`, mes(0), mes(1))
  // Escape do passado até o FIM do mês que vem, com outro nome: garantir não pode tentar recriar.
  await particao(T_ESCAPE, `${T_ESCAPE}_anterior`, new Date('1900-01-01T00:00:00Z'), mes(2))
  // Corrente + 1 mês à frente: horizonte curto.
  await particao(T_CURTA, `${T_CURTA}_atual`, mes(0), mes(1))
  await particao(T_CURTA, `${T_CURTA}_prox`, mes(1), mes(2))
})

afterAll(async () => {
  await dono.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await dono`DELETE FROM auditoria WHERE tenant_id = ${TENANT}`
  await dono.end()
})

describe('Registro das tabelas particionadas por mês', () => {
  it('dado o schema public, então TODA tabela particionada está em tabelas_particionadas_por_mes()', async () => {
    const particionadas = await dono<{ t: string }[]>`
      SELECT c.relname::text AS t FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT c.relispartition`
    const registro = await dono<{ t: string }[]>`SELECT t FROM tabelas_particionadas_por_mes() AS t`
    expect(particionadas.map((r) => r.t).sort()).toEqual(registro.map((r) => r.t).sort())
  })

  it('dado as tabelas reais depois da 0110, então cada uma tem ≥ 12 meses à frente (a migration deixou 24)', async () => {
    const h = await lerHorizontes(dono as never, agora)
    expect(h.map((x) => x.tabela).sort()).toEqual(['auditoria', 'item_venda', 'mensagem', 'venda'])
    for (const x of h) expect(x.mesesAFrente).toBeGreaterThanOrEqual(MESES_A_FRENTE)
  })
})

describe('Worker de partições — cria o que falta, idempotente', () => {
  it('dado só o mês corrente, quando a passada roda, então cria 12 meses à frente e o horizonte vira 12', async () => {
    const r = await processarParticoes(dono as never, { tabelas: [T_FALTANDO] }, agora)
    expect(r.criadas).toEqual({ [T_FALTANDO]: MESES_A_FRENTE })
    expect(r.processadas).toBe(MESES_A_FRENTE)
    expect(r.falhas).toEqual([])
    expect(r.horizontes).toEqual([{ tabela: T_FALTANDO, mesesAFrente: MESES_A_FRENTE }])
    expect(r.curtas).toEqual([])
    expect(await contar(T_FALTANDO)).toBe(1 + MESES_A_FRENTE)
  })

  it('dado a passada já feita, quando roda de novo, então não cria nada (idempotente)', async () => {
    const r = await processarParticoes(dono as never, { tabelas: [T_FALTANDO] }, agora)
    expect(r.criadas).toEqual({ [T_FALTANDO]: 0 })
    expect(r.processadas).toBe(0)
    expect(await contar(T_FALTANDO)).toBe(1 + MESES_A_FRENTE)
  })

  it('dado meses cobertos por uma partição de escape com outro nome, então pula os cobertos e cria só o resto', async () => {
    const r = await processarParticoes(dono as never, { tabelas: [T_ESCAPE] }, agora)
    // O escape cobre o corrente e o seguinte: faltam 11 (de +2 a +12).
    expect(r.criadas).toEqual({ [T_ESCAPE]: MESES_A_FRENTE - 1 })
    expect(r.falhas).toEqual([])
    expect(r.horizontes[0]!.mesesAFrente).toBe(MESES_A_FRENTE)
  })

  it('dado um INSERT num mês futuro coberto pela passada, então grava; além do horizonte, o Postgres recusa', async () => {
    const coberto = new Date(mes(MESES_A_FRENTE).getTime() + 15 * 86_400_000)
    await dono.unsafe(`INSERT INTO ${T_FALTANDO} (em, v) VALUES ('${coberto.toISOString()}', 1)`)
    const alem = mes(MESES_A_FRENTE + 1)
    await expect(dono.unsafe(`INSERT INTO ${T_FALTANDO} (em, v) VALUES ('${alem.toISOString()}', 1)`))
      .rejects.toMatchObject({ code: '23514' }) // "no partition of relation found for row"
  })

  it('dado uma sessão em outro fuso, então os limites criados seguem em UTC (sem buraco de 3 h entre meses)', async () => {
    await dono.begin(async (tx) => {
      await tx`SET LOCAL timezone = 'America/Sao_Paulo'`
      await tx`SELECT garantir_particoes_mensais(${T_FUSO}, 2, 0, ${agora})`
    })
    const p = await dono<{ de: Date; ate: Date }[]>`SELECT de, ate FROM particoes_mensais_da_tabela(${T_FUSO}) ORDER BY de`
    expect(p.map((x) => x.de.toISOString())).toEqual([mes(0), mes(1), mes(2)].map((d) => d.toISOString()))
    const [h] = await lerHorizontes(dono as never, agora, [T_FUSO])
    expect(h!.mesesAFrente).toBe(2)
  })
})

describe('Horizonte curto — alerta e saúde degradada', () => {
  it('dado a tabela-mãe ocupada (lock_timeout) e só 1 mês à frente, então a falha é nomeada e a tabela entra em "curtas"', async () => {
    // Outra transação segurando a tabela: CREATE … PARTITION OF precisa de ACCESS EXCLUSIVE.
    const ocupante = await dono.reserve()
    try {
      await ocupante`BEGIN`
      await ocupante.unsafe(`LOCK TABLE ${T_CURTA} IN ACCESS SHARE MODE`)
      const r = await processarParticoes(dono as never, { tabelas: [T_CURTA] }, agora)
      expect(r.falhas).toEqual([{ tabela: T_CURTA, codigo: '55P03' }])
      expect(r.horizontes).toEqual([{ tabela: T_CURTA, mesesAFrente: 1 }])
      expect(r.curtas).toEqual([T_CURTA])

      // O mesmo horizonte, na saúde: degradado com `particoes_curtas`.
      const s = avaliarSaude({
        encerrando: false, uptimeSeg: 60, bancoLatenciaMs: 1,
        workers: {
          workerAgente: { configurado: true, batimentoHaSeg: 1 }, transcricao: { configurado: false, batimentoHaSeg: null },
          embeddings: { configurado: false, batimentoHaSeg: null }, retornos: { configurado: true, batimentoHaSeg: 1 },
        },
        filas: { agente: { vencidas: 0, maisAntigaHaSeg: null, executando: 0, executandoMaisAntigaHaSeg: null }, retornos: { vencidos: 0, maisAntigoHaSeg: null } },
        transcricao: null, embeddings: null,
        llm: { situacao: 'principal', reservaRestanteSeg: null, falhasSeguidas: 0, modelosBloqueados: 0 },
        particoes: r.horizontes,
      })
      expect(s.status).toBe('degradado')
      expect(s.motivos).toEqual(['particoes_curtas'])
    } finally {
      await ocupante`ROLLBACK`
      ocupante.release()
    }
  }, 20_000)

  it('dado a tabela liberada, quando a passada roda de novo, então recupera os 12 meses e sai de "curtas"', async () => {
    const r = await processarParticoes(dono as never, { tabelas: [T_CURTA] }, agora)
    expect(r.criadas).toEqual({ [T_CURTA]: MESES_A_FRENTE - 1 })
    expect(r.curtas).toEqual([])
  })

  it('dado o limite de 3 meses, então exatamente 3 não é curto e 2 é', () => {
    expect(LIMITES_SAUDE_PADRAO.particoesMinMeses).toBe(3)
    expect(mesesCobertosAFrente(new Date('2026-10-19T12:00:00Z'), new Date('2027-02-01T00:00:00Z'))).toBe(3)
    expect(mesesCobertosAFrente(new Date('2026-10-19T12:00:00Z'), new Date('2027-01-01T00:00:00Z'))).toBe(2)
  })
})

describe('mesesCobertosAFrente', () => {
  it.each([
    ['12 meses completos depois do corrente', '2026-10-19T13:00:00Z', '2027-11-01T00:00:00Z', 12],
    ['só o mês corrente coberto', '2026-10-19T13:00:00Z', '2026-11-01T00:00:00Z', 0],
    ['nem o mês corrente coberto (horizonte = agora)', '2026-10-19T13:00:00Z', '2026-10-19T13:00:00Z', 0],
    ['horizonte no meio de um mês não conta aquele mês', '2026-10-19T13:00:00Z', '2027-01-15T00:00:00Z', 2],
    ['virada de ano', '2026-12-31T23:00:00Z', '2027-02-01T00:00:00Z', 1],
  ])('dado %s, então conta certo', (_n, a, h, esperado) => {
    expect(mesesCobertosAFrente(new Date(a), new Date(h))).toBe(esperado)
  })
})

describe('INSERT real num mês futuro coberto (depois da 0110)', () => {
  it('dado auditoria com partição 12 meses à frente, então o INSERT grava', async () => {
    // 12 = o mínimo que o worker mantém (a 0110 deixou 24); vale em banco migrado há meses.
    const futuro = new Date(mes(MESES_A_FRENTE).getTime() + 10 * 86_400_000)
    const id = randomUUID()
    await dono`INSERT INTO auditoria (tenant_id, id, criado_em, acao, entidade)
               VALUES (${TENANT}, ${id}, ${futuro}, 'teste.particoes', 'teste')`
    const [r] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${TENANT} AND id = ${id}`
    expect(r!.n).toBe(1)
  })
})
