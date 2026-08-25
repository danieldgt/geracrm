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
const C_RITMO = 'a17a0000-6666-4000-8000-000000000004'   // 3 vendas, atraso ~0,83× (janela de antecipação)
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
  // Ritmo do cliente: 3 vendas em ~85/55/25 dias atrás → média 30d, recência 25d,
  // atraso ≈ 0,83 (na janela de antecipação [0,8; 1,0)). Alimenta a MV.
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas, ultima_venda_em, criado_em)
             VALUES (${T}, ${C_RITMO}, 'No ritmo', 'teste', true, 3, ${ago(25)}, ${ago(120)}) ON CONFLICT DO NOTHING`
  for (const d of [85, 55, 25]) {
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${T}, ${randomUUID()}, ${C_RITMO}, now() - (${d} || ' days')::interval, 20000)`
  }
  await dono`SELECT atualizar_metricas_contato()`
  await dono`INSERT INTO lista (tenant_id, id, nome) VALUES (${T}, ${LISTA}, 'Resgate') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sequencia (tenant_id, id, nome) VALUES (${T}, ${SEQ}, 'Pós-detrator') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo) VALUES (${T}, ${SEQ}, 1, 0, 'Ligar hoje')`
  await dono`INSERT INTO sequencia_passo (tenant_id, sequencia_id, seq, offset_dias, titulo) VALUES (${T}, ${SEQ}, 2, 3, 'Verificar')`
})

beforeEach(async () => {
  await dono`DELETE FROM automacao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM lista_membro WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`UPDATE contato SET recebe_automacoes = true WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM automacao WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tarefa WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM venda WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`SELECT atualizar_metricas_contato()`
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

  it('⚠️ reposicao_ritmo: age na janela de antecipação (0,8× o ritmo) e reincide no próximo ciclo', async () => {
    const id = await novaAutomacao('reposicao_ritmo', { fator: 0.8 }, 'criar_tarefa', { titulo: 'Oferecer reposição', paraDono: false })
    expect(await executarNoTenant(sql, T, AGORA)).toBe(1)
    const [t] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id=${T} AND contato_id=${C_RITMO}`
    expect(t!.n).toBe(1)
    // 2ª passada no MESMO ciclo NÃO recria (dedup ciente do ciclo).
    expect(await executarNoTenant(sql, T, AGORA)).toBe(0)
    // Novo ciclo (o cliente comprou de novo → o carimbo fica ANTES da última
    // compra): a régua reincide. Simulo recuando o executado_em.
    await dono`UPDATE automacao_execucao SET executado_em = now() - interval '90 days'
               WHERE tenant_id=${T} AND automacao_id=${id} AND contato_id=${C_RITMO}`
    expect(await executarNoTenant(sql, T, AGORA)).toBe(1)
  })

  it('⚠️ isolamento: automação de um tenant não age na base do outro', async () => {
    await novaAutomacao('lead_frio', { dias: 30 }, 'adicionar_lista', { listaId: LISTA })
    // Rodar para OUTRO não faz nada (a regra e os contatos são de T).
    const n = await executarNoTenant(sql, OUTRO, AGORA)
    expect(n).toBe(0)
  })
})

/**
 * ⚠️ A AÇÃO MAIS PERIGOSA DO PRODUTO (0065): a única que fala com o cliente.
 * Estes testes existem para provar que ela NÃO tem caminho próprio de envio e
 * que nenhum dos opt-outs é contornável por ela.
 */
describe('Ação enviar_mensagem', () => {
  const tarefas = () => dono<{ titulo: string; descricao: string }[]>`
    SELECT titulo, descricao FROM tarefa WHERE tenant_id = ${T}`

  it('sem conversa aberta, NÃO inventa uma — vira tarefa com o motivo escrito', async () => {
    // ⚠️ Abrir conversa para falar primeiro é mensagem fria: no oficial exige
    //    template, no não-oficial é o caminho curto para o banimento (ADR-021).
    await novaAutomacao('lead_frio', { dias: 30 }, 'enviar_mensagem',
      { texto: 'Oi {nome}, ainda posso ajudar?' })

    const n = await executarNoTenant(sql, T, AGORA)
    expect(n).toBe(1)

    const [t] = await tarefas()
    expect(t!.titulo).toContain('Falar com o cliente')
    expect(t!.descricao).toContain('não tem conversa aberta')
    // A mensagem que sairia fica na tarefa — o humano faz o que o robô não pôde.
    expect(t!.descricao).toContain('Oi Lead frio, ainda posso ajudar?')
  })

  /**
   * ⚠️ `recebe_automacoes` é opt-out DIFERENTE da lista de bloqueio: "pode me
   * mandar campanha, mas não robô". E o filtro é ANTES do dedup — quem não
   * recebe hoje continua elegível se mudar de ideia amanhã.
   */
  it('respeita recebe_automacoes, e sem queimar a regra para o contato', async () => {
    await dono`UPDATE contato SET recebe_automacoes = false WHERE tenant_id = ${T} AND id = ${C_LEAD}`
    const id = await novaAutomacao('lead_frio', { dias: 30 }, 'enviar_mensagem', { texto: 'Oi' })

    expect(await executarNoTenant(sql, T, AGORA)).toBe(0)
    const [dedup] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM automacao_execucao WHERE tenant_id = ${T} AND automacao_id = ${id}`
    expect(dedup!.n).toBe(0)

    // Mudou de ideia: a mesma regra volta a alcançá-lo.
    await dono`UPDATE contato SET recebe_automacoes = true WHERE tenant_id = ${T} AND id = ${C_LEAD}`
    expect(await executarNoTenant(sql, T, AGORA)).toBe(1)
  })

  it('a mesma ação NÃO alcança quem só tem tarefa: outras ações ignoram o opt-out de robô', async () => {
    // ⚠️ Criar tarefa para um contato que não quer mensagem de robô é correto —
    //    quem vai falar com ele é uma pessoa.
    await dono`UPDATE contato SET recebe_automacoes = false WHERE tenant_id = ${T} AND id = ${C_LEAD}`
    await novaAutomacao('lead_frio', { dias: 30 }, 'criar_tarefa', { titulo: 'Ligar' })

    expect(await executarNoTenant(sql, T, AGORA)).toBe(1)
  })

  it('automação sem texto não faz nada — e não deixa tarefa órfã', async () => {
    await novaAutomacao('lead_frio', { dias: 30 }, 'enviar_mensagem', {})
    await executarNoTenant(sql, T, AGORA)
    expect(await tarefas()).toHaveLength(0)
  })

  /**
   * ⚠️ O marcador some LIMPO: sem o espaço órfão nem a vírgula pendurada que
   * denunciam o modelo. O cliente não precisa saber que havia um campo ali.
   */
  it('{nome} some limpo quando o contato não tem nome útil', async () => {
    await dono`UPDATE contato SET nome = '' WHERE tenant_id = ${T} AND id = ${C_LEAD}`
    await novaAutomacao('lead_frio', { dias: 30 }, 'enviar_mensagem', { texto: 'Oi {nome}, tudo bem?' })

    await executarNoTenant(sql, T, AGORA)

    const [t] = await tarefas()
    expect(t!.descricao).toContain('Oi, tudo bem?')
    await dono`UPDATE contato SET nome = 'Lead frio' WHERE tenant_id = ${T} AND id = ${C_LEAD}`
  })
})
