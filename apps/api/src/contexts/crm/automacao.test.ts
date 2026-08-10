import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { executarNoTenant } from './automacao-motor.js'

/** Motor de automações — gatilhos, ações internas, dedup e isolamento. */
const T = 'a17a0000-0000-4000-8000-000000000001'
const OUTRO = 'a17a0000-0000-4000-8000-000000000002'
const PV = 'a17a0000-1111-4000-8000-000000000001'
const PV2 = 'a17a0000-1111-4000-8000-000000000002'
const PLANO = 'a17a0000-3333-4000-8000-000000000001'
const MODELO = 'a17a0000-4444-4000-8000-000000000001'
const C_INATIVO = 'a17a0000-6666-4000-8000-000000000001' // comprou há 60 dias
const C_LEAD = 'a17a0000-6666-4000-8000-000000000002'    // nunca comprou, cadastrado há 40 dias
const C_NPS = 'a17a0000-6666-4000-8000-000000000003'     // deu NPS 3
const LISTA = 'a17a0000-9999-4000-8000-000000000001'
const SEQ = 'a17a0000-aaaa-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const AGORA = new Date('2026-08-10T12:00:00Z')

async function novaAutomacao(gatilho: string, gp: object, acao: string, ap: object): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO automacao (tenant_id, id, nome, gatilho, gatilho_param, acao, acao_param)
             VALUES (${T}, ${id}, ${gatilho + '/' + acao}, ${gatilho}, ${JSON.stringify(gp)}::text::jsonb, ${acao}, ${JSON.stringify(ap)}::text::jsonb)`
  return id
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-au', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-au', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, ultima_venda_em, criado_em)
             VALUES (${T}, ${C_INATIVO}, 'Inativo', 'teste', true, 3, ${ago(60)}, ${ago(200)}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, criado_em)
             VALUES (${T}, ${C_LEAD}, 'Lead frio', 'teste', true, 0, ${ago(40)}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, criado_em)
             VALUES (${T}, ${C_NPS}, 'Insatisfeito', 'teste', true, 1, ${ago(10)}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO nps_resposta (tenant_id, id, contato_id, nota, origem) VALUES (${T}, ${randomUUID()}, ${C_NPS}, 3, 'manual')`
  await dono`INSERT INTO lista (tenant_id, id, nome) VALUES (${T}, ${LISTA}, 'Resgate') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sequencia (tenant_id, id, nome) VALUES (${T}, ${SEQ}, 'Pós-detrator') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo) VALUES (${T}, ${SEQ}, 1, 0, 'Ligar hoje')`
  await dono`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo) VALUES (${T}, ${SEQ}, 2, 3, 'Verificar')`
})

beforeEach(async () => {
  await dono`DELETE FROM automacao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM lista_membro WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM automacao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM nps_resposta WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM sequencia WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM lista WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const sql = dono as unknown as import('../../db/index.js').Sql

describe('Motor de automações', () => {
  it('⚠️ dias_sem_comprar → criar_tarefa; ⚠️ dedup na 2ª passada', async () => {
    await novaAutomacao('dias_sem_comprar', { dias: 30 }, 'criar_tarefa', { titulo: 'Reativar cliente', offsetDias: 2, paraDono: false })
    const n1 = await executarNoTenant(sql, T, AGORA)
    expect(n1).toBe(1)
    const [t] = await dono<{ titulo: string; dias: number }[]>`
      SELECT titulo, (vence_em::date - now()::date) AS dias FROM tarefa WHERE tenant_id=${T} AND contato_id=${C_INATIVO}`
    expect(t).toMatchObject({ titulo: 'Reativar cliente', dias: 2 })
    // 2ª passada NÃO recria (dedup).
    const n2 = await executarNoTenant(sql, T, AGORA)
    expect(n2).toBe(0)
  })

  it('lead_frio → adicionar_lista', async () => {
    await novaAutomacao('lead_frio', { dias: 30 }, 'adicionar_lista', { listaId: LISTA })
    const n = await executarNoTenant(sql, T, AGORA)
    expect(n).toBe(1)
    const [m] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_membro WHERE tenant_id=${T} AND lista_id=${LISTA} AND contato_id=${C_LEAD}`
    expect(m!.n).toBe(1)
  })

  it('nps_detrator → aplicar_sequencia (materializa as tarefas dos passos)', async () => {
    await novaAutomacao('nps_detrator', { notaMax: 6, janelaDias: 30 }, 'aplicar_sequencia', { sequenciaId: SEQ })
    const n = await executarNoTenant(sql, T, AGORA)
    expect(n).toBe(1)
    const tarefas = await dono<{ titulo: string }[]>`SELECT titulo FROM tarefa WHERE tenant_id=${T} AND contato_id=${C_NPS} ORDER BY vence_em`
    expect(tarefas.map((x) => x.titulo)).toEqual(['Ligar hoje', 'Verificar'])
  })

  it('⚠️ isolamento: automação de um tenant não age na base do outro', async () => {
    await novaAutomacao('lead_frio', { dias: 30 }, 'adicionar_lista', { listaId: LISTA })
    // Rodar para OUTRO não faz nada (a regra e os contatos são de T).
    const n = await executarNoTenant(sql, OUTRO, AGORA)
    expect(n).toBe(0)
  })
})
