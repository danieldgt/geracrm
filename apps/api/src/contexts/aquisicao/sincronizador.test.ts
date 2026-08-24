import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { sincronizarConta } from './sincronizador.js'
import type { Sql } from '../../db/index.js'
import type { EstruturaVeiculacao, MetricaDiaExterna, PortaPlataformaMidia } from './plataformas/porta.js'

const T = '51c00000-0000-4000-8000-000000000001'
const PV = '51c00000-1111-4000-8000-000000000001'
const PLANO = '51c00000-3333-4000-8000-000000000001'
const MODELO = '51c00000-4444-4000-8000-000000000001'
const CONTA = '51c00000-7777-4000-8000-000000000001'
const CONTATO = '51c00000-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-23T12:00:00Z')

/** Plataforma falsa — o Google nunca é chamado. Conta as "requisições". */
function plataformaFalsa(
  estrutura: EstruturaVeiculacao,
  metricas: readonly MetricaDiaExterna[],
  opcoes: { leituraEstrutura?: boolean; erroMetricas?: boolean } = {},
): PortaPlataformaMidia & { chamadas: number } {
  const p = {
    plataforma: 'google' as const,
    chamadas: 0,
    capacidades: {
      leituraEstrutura: opcoes.leituraEstrutura ?? true, leituraMetrica: true,
      publicoPersonalizado: false, conversaoOffline: false,
      cliqueParaConversa: false, escritaEstado: false, escritaOrcamento: false,
    },
    async testarConexao() { return { ok: true as const, dados: { nomeConta: 'x', moeda: 'BRL' } } },
    async lerEstrutura() { p.chamadas += 3; return { ok: true as const, dados: estrutura } },
    async lerMetricas() {
      p.chamadas += 1
      return opcoes.erroMetricas
        ? { ok: false as const, motivo: 'limite_de_taxa' as const }
        : { ok: true as const, dados: metricas }
    },
    async enviarConversao() { return { ok: false as const, motivo: 'resposta_inesperada' as const } },
  }
  return p as unknown as PortaPlataformaMidia & { chamadas: number }
}

const ESTRUTURA: EstruturaVeiculacao = {
  campanhas: [{ idExterno: 'c1', nome: 'Verão', estado: 'ativa', paiExternoId: null }],
  conjuntos: [{ idExterno: 'g1', nome: 'Grupo', estado: 'ativa', paiExternoId: 'c1' }],
  anuncios: [{ idExterno: 'a1', nome: 'Anúncio 1', estado: 'ativa', paiExternoId: 'g1' }],
}
const metrica = (ad: string, dia: string, custo: number): MetricaDiaExterna => ({
  anuncioExternoId: ad, dia, impressoes: 100, cliques: 5,
  custoCentavos: custo, conversoesPlataforma: 1,
})

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-sinc', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-sinc', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Lead') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', '997-075-4431', 'Drezz')`
})

afterAll(async () => {
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono.end()
})

const sincronizar = (p: PortaPlataformaMidia, dias?: number) =>
  sincronizarConta(sql, {
    tenantId: T, contaId: CONTA, contaExternaId: '9970754431',
    adaptador: p, agora: AGORA, ...(dias ? { diasJanela: dias } : {}),
  })

describe('Sincronização', () => {
  it('grava a hierarquia inteira e as métricas', async () => {
    const r = await sincronizar(plataformaFalsa(ESTRUTURA, [metrica('a1', '2026-08-20', 12345)]))
    expect(r).toMatchObject({ campanhas: 1, conjuntos: 1, anuncios: 1, diasDeMetrica: 1, metricasOrfas: 0 })

    const [m] = await dono<{ custo: string }[]>`
      SELECT custo_centavos::text AS custo FROM midia_metrica_dia WHERE tenant_id = ${T}`
    expect(m!.custo).toBe('12345')
  })

  /**
   * ⚠️ Ressincronizar é o caso NORMAL: as plataformas reescrevem dias já
   * fechados por até ~28 dias. Um INSERT puro duplicaria custo a cada passada.
   */
  it('a segunda passada ATUALIZA em vez de duplicar', async () => {
    await sincronizar(plataformaFalsa(ESTRUTURA, [metrica('a1', '2026-08-20', 10000)]))
    await sincronizar(plataformaFalsa(ESTRUTURA, [metrica('a1', '2026-08-20', 25000)]))

    const linhas = await dono<{ custo: string }[]>`
      SELECT custo_centavos::text AS custo FROM midia_metrica_dia WHERE tenant_id = ${T}`
    expect(linhas).toHaveLength(1)             // não duplicou
    expect(linhas[0]!.custo).toBe('25000')     // ficou com o valor reescrito
  })

  it('atualiza nome e estado da estrutura sem criar duplicata', async () => {
    await sincronizar(plataformaFalsa(ESTRUTURA, []))
    const pausada: EstruturaVeiculacao = {
      ...ESTRUTURA,
      campanhas: [{ idExterno: 'c1', nome: 'Verão 2.0', estado: 'pausada', paiExternoId: null }],
    }
    await sincronizar(plataformaFalsa(pausada, []))

    const linhas = await dono<{ nome: string; estado: string }[]>`
      SELECT nome, estado FROM midia_campanha WHERE tenant_id = ${T}`
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ nome: 'Verão 2.0', estado: 'pausada' })
  })

  /**
   * ⚠️ Métrica de anúncio desconhecido é CONTADA, não engolida: se o número
   * subir, a leitura de estrutura está incompleta e o custo não fecha com a
   * fatura. Engolir esconderia exatamente isso.
   */
  it('métrica de anúncio desconhecido vira órfã contada', async () => {
    const r = await sincronizar(plataformaFalsa(ESTRUTURA, [
      metrica('a1', '2026-08-20', 100),
      metrica('DESCONHECIDO', '2026-08-20', 999999),
    ]))
    expect(r.diasDeMetrica).toBe(1)
    expect(r.metricasOrfas).toBe(1)
  })

  it('conjunto órfão é pulado — hierarquia não se inventa', async () => {
    const semCampanha: EstruturaVeiculacao = {
      campanhas: [], conjuntos: [{ idExterno: 'g9', nome: 'X', estado: 'ativa', paiExternoId: 'inexistente' }],
      anuncios: [],
    }
    const r = await sincronizar(plataformaFalsa(semCampanha, []))
    expect(r.conjuntos).toBe(0)
  })

  // ⚠️ O número que diz quantas contas cabem na cota diária do developer token.
  it('conta as requisições gastas', async () => {
    const p = plataformaFalsa(ESTRUTURA, [metrica('a1', '2026-08-20', 100)])
    const r = await sincronizar(p)
    expect(r.chamadas).toBe(4)   // 3 da estrutura + 1 das métricas
  })

  it('sem capacidade de leitura, degrada com motivo nomeado', async () => {
    const r = await sincronizar(plataformaFalsa(ESTRUTURA, [], { leituraEstrutura: false }))
    expect(r.erro).toMatchObject({ motivo: 'plataforma_sem_capacidade' })
    expect(r.campanhas).toBe(0)
  })

  it('falha nas métricas preserva a estrutura já gravada', async () => {
    const r = await sincronizar(plataformaFalsa(ESTRUTURA, [], { erroMetricas: true }))
    expect(r.erro).toMatchObject({ motivo: 'limite_de_taxa' })
    expect(r.campanhas).toBe(1)   // ⚠️ o que entrou, entrou
    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_campanha WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  /**
   * ⚠️ A resolução roda DEPOIS da estrutura: é o momento em que o lead que
   * chegou primeiro finalmente tem com o que casar.
   */
  it('resolve as origens pendentes que a estrutura acabou de destravar', async () => {
    await dono`INSERT INTO midia_lead_origem
                 (tenant_id, id, contato_id, plataforma, anuncio_externo_id, primeira)
               VALUES (${T}, gen_random_uuid(), ${CONTATO}, 'google', 'a1', true)`

    const r = await sincronizar(plataformaFalsa(ESTRUTURA, []))
    expect(r.origensResolvidas).toBe(1)

    const [o] = await dono<{ anuncio_id: string | null }[]>`
      SELECT anuncio_id FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(o!.anuncio_id).toBeTruthy()
  })
})
