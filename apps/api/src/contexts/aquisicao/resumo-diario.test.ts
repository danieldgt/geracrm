import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { montarTexto, variacao, montarResumo, resumirTodos, type NumerosDoDia } from './resumo-diario.js'
import type { Sql } from '../../db/index.js'

/**
 * ⚠️ `toLocaleString('pt-BR', {style:'currency'})` separa `R$` do número com
 * ESPAÇO NÃO-QUEBRÁVEL (U+00A0), não espaço comum. Comparar com espaço normal
 * falha por um caractere invisível — e a mensagem de erro mostra os dois textos
 * idênticos na tela, que é o pior tipo de teste vermelho.
 */
const semNbsp = (t: string): string => t.replace(/\u00A0/g, ' ')

const base: NumerosDoDia = {
  custoCentavos: 34_000, cliques: 120, leads: 8, leadsQualificados: 3,
  pedidosCentavos: 0, custoOntemCentavos: 30_000, leadsOntem: 10,
}

describe('Variação', () => {
  it('sobe e desce com sinal', () => {
    expect(variacao(120, 100)).toBe('+20%')
    expect(variacao(80, 100)).toBe('-20%')
  })

  it('igual é "estável", não "+0%"', () => {
    expect(variacao(100, 100)).toBe('estável')
  })

  /**
   * ⚠️ "Sem base" ≠ "0%". No primeiro dia, exibir 0% inventaria uma estabilidade
   * que ninguém observou.
   */
  it('sem base devolve null', () => {
    expect(variacao(50, 0)).toBeNull()
  })
})

describe('Texto do resumo', () => {
  it('traz investido, leads e custo por lead', () => {
    const { texto: bruto } = montarTexto('2026-08-24', base, [])
    expect(semNbsp(bruto)).toContain('Investido: R$ 340,00')
    expect(semNbsp(bruto)).toContain('Leads: 8')
    expect(semNbsp(bruto)).toContain('Custo por lead: R$ 42,50')
  })

  it('mostra a variação contra ontem', () => {
    const { texto: bruto } = montarTexto('2026-08-24', base, [])
    expect(semNbsp(bruto)).toContain('(+13%)')   // custo 340 vs 300
    expect(semNbsp(bruto)).toContain('(-20%)')   // leads 8 vs 10
  })

  // ⚠️ Custo por lead com zero leads é INDEFINIDO. "R$ 0,00" faria o pior dia
  //    parecer o melhor — mesma regra da tela.
  it('zero leads mostra traço, não R$ 0,00', () => {
    const { texto: bruto } = montarTexto('2026-08-24', { ...base, leads: 0 }, [])
    expect(semNbsp(bruto)).toContain('Custo por lead: —')
    expect(semNbsp(bruto)).not.toContain('Custo por lead: R$ 0,00')
  })

  /**
   * ⚠️ A decisão de ordem que importa: um resumo que abre com "gastamos R$ 340" e
   * enterra "nenhum lead entrou" no fim é lido como boa notícia.
   */
  it('alertas vêm ANTES dos números', () => {
    const { texto: bruto } = montarTexto('2026-08-24', base, ['200 cliques e NENHUM lead entrou.'])
    expect(semNbsp(bruto).indexOf('NENHUM lead')).toBeLessThan(semNbsp(bruto).indexOf('Investido'))
    expect(semNbsp(bruto)).toContain('⚠️')
  })

  it('sem alerta, não inventa seção de atenção', () => {
    const { texto: bruto } = montarTexto('2026-08-24', base, [])
    expect(semNbsp(bruto)).not.toContain('⚠️')
  })

  it('pluraliza os pontos de atenção', () => {
    const um = semNbsp(montarTexto('2026-08-24', base, ['a']).texto)
    const dois = semNbsp(montarTexto('2026-08-24', base, ['a', 'b']).texto)
    expect(um).toContain('Atenção:')
    expect(dois).toContain('2 pontos de atenção')
  })

  // ⚠️ AMK-009: número de atribuição sempre com o modelo ao lado.
  it('ROAS aparece SEMPRE com o modelo e a janela no rótulo', () => {
    const { texto: bruto } = montarTexto('2026-08-24', { ...base, pedidosCentavos: 170_000 }, [])
    expect(semNbsp(bruto)).toContain('ROAS (último toque, 14d): 5.0×')
  })

  it('sem receita, não mostra ROAS', () => {
    const { texto: bruto } = montarTexto('2026-08-24', base, [])
    expect(semNbsp(bruto)).not.toContain('ROAS')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const T = '00e51100-0000-4000-8000-000000000001'
const PV = '00e51100-1111-4000-8000-000000000001'
const PLANO = '00e51100-3333-4000-8000-000000000001'
const MODELO = '00e51100-4444-4000-8000-000000000001'
const CONTA = '00e51100-7777-4000-8000-000000000001'
const CAMP = '00e51100-8888-4000-8000-000000000001'
const CONJ = '00e51100-9999-4000-8000-000000000001'
const AD = '00e51100-aaaa-4000-8000-000000000001'
const CONTATO = '00e51100-6666-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-24T15:00:00Z')
const HOJE = '2026-08-24'

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-resumo', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-resumo', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => {
  await dono`DELETE FROM alerta            WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono`INSERT INTO contato (tenant_id, id, nome, qualificado, qualificado_em)
             VALUES (${T}, ${CONTATO}, 'Lead', true, now())`
  await dono`INSERT INTO midia_conta (tenant_id, id, plataforma, id_externo, nome)
             VALUES (${T}, ${CONTA}, 'google', 'resumo-1', 'Conta')`
  await dono`INSERT INTO midia_campanha (tenant_id, id, conta_id, id_externo, nome)
             VALUES (${T}, ${CAMP}, ${CONTA}, 'c1', 'Camp')`
  await dono`INSERT INTO midia_conjunto (tenant_id, id, campanha_id, id_externo, nome)
             VALUES (${T}, ${CONJ}, ${CAMP}, 'g1', 'Conj')`
  await dono`INSERT INTO midia_anuncio (tenant_id, id, conjunto_id, id_externo, nome)
             VALUES (${T}, ${AD}, ${CONJ}, 'a1', 'Anúncio')`
})

afterAll(async () => {
  await dono`DELETE FROM alerta            WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${T}`
  await dono`DELETE FROM midia_conta       WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono.end()
})

describe('Resumo contra o banco', () => {
  it('junta gasto, leads e qualificados do dia', async () => {
    await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, cliques, custo_centavos)
               VALUES (${T}, ${AD}, ${HOJE}::date, 100, 25_000)`
    await dono`INSERT INTO midia_lead_origem (tenant_id, id, contato_id, plataforma, primeira, capturado_em)
               VALUES (${T}, gen_random_uuid(), ${CONTATO}, 'google', true, ${HOJE + 'T10:00:00Z'})`

    const r = await montarResumo(sql, T, AGORA)
    expect(r.temDado).toBe(true)
    expect(semNbsp(r.texto)).toContain('Investido: R$ 250,00')
    expect(semNbsp(r.texto)).toContain('Leads: 1')
    expect(semNbsp(r.texto)).toContain('Qualificados: 1')
  })

  it('traz os alertas abertos da mídia, no topo', async () => {
    await dono`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
               VALUES (${T}, gen_random_uuid(), 'midia_leads_sumiram', 'critico', 'Cliques sem nenhum lead.')`
    const r = await montarResumo(sql, T, AGORA)
    expect(r.alertas).toEqual(['Cliques sem nenhum lead.'])
    expect(semNbsp(r.texto).indexOf('nenhum lead')).toBeLessThan(semNbsp(r.texto).indexOf('Investido'))
  })

  /**
   * ⚠️ Resumo vazio todo dia é o caminho mais curto para o cliente parar de ler
   * os que importam.
   */
  it('sem gasto, sem lead e sem alerta, marca temDado=false', async () => {
    const r = await montarResumo(sql, T, AGORA)
    expect(r.temDado).toBe(false)
  })

  it('mas um alerta sozinho já justifica o resumo', async () => {
    await dono`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
               VALUES (${T}, gen_random_uuid(), 'midia_veiculacao_parada', 'critico', 'Parou.')`
    expect((await montarResumo(sql, T, AGORA)).temDado).toBe(true)
  })
})

describe('Entrega plugável', () => {
  it('sem entregador, apenas MONTA — não manda nada', async () => {
    await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, custo_centavos)
               VALUES (${T}, ${AD}, ${HOJE}::date, 25_000)`
    const r = await resumirTodos(sql, AGORA)
    expect(r.montados).toBeGreaterThanOrEqual(1)
    expect(r.entregues).toBe(0)
  })

  it('com entregador, entrega só quem tem dado', async () => {
    await dono`INSERT INTO midia_metrica_dia (tenant_id, anuncio_id, dia, custo_centavos)
               VALUES (${T}, ${AD}, ${HOJE}::date, 25_000)`
    const entregues: string[] = []
    const r = await resumirTodos(sql, AGORA, async (res) => { entregues.push(res.tenantId) })
    expect(entregues).toContain(T)
    expect(r.entregues).toBeGreaterThanOrEqual(1)
  })

  it('tenant sem dado não recebe nada', async () => {
    const entregues: string[] = []
    await resumirTodos(sql, AGORA, async (res) => { entregues.push(res.tenantId) })
    expect(entregues).not.toContain(T)
  })
})
