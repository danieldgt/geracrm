import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { CRITERIOS_RUBRICA, fracaoEstavel, type MarcaGuardrail } from '@geracrm/shared'
import { encerrarBanco, comTenantServico } from '../db/index.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../contexts/atendimento/agente/porta-llm.js'
import { avaliacaoDasMarcas } from '../contexts/atendimento/agente/qualidade/avaliacao.js'
import { processarQualidade } from './qualidade.js'

/**
 * WORKER DE QUALIDADE (ADR-031, raia P12) — banco real, dois tenants, juiz falso.
 *
 *   - regras em 100% das decisões com resposta, idempotente por (decisão, tipo);
 *   - juiz só na amostra estável, no fim da sessão e a cada 10 turnos, uma vez;
 *   - custo pelo catálogo, teto mensal por número (com alerta), falha registrada sem repetir;
 *   - a fração estável do SQL é a mesma do shared;
 *   - RLS: um tenant não vê a avaliação do outro.
 */
const A = 'c0a12000-0000-4000-8000-000000000001'
const B = 'c0a12000-0000-4000-8000-000000000002'
const PV_A = 'c0a12000-1111-4000-8000-000000000001'
const PV_B = 'c0a12000-1111-4000-8000-000000000002'
const PLANO = 'c0a12000-3333-4000-8000-000000000001'
const MODELO = 'c0a12000-4444-4000-8000-000000000001'
const CANAL_A = 'c0a12000-5555-4000-8000-000000000001'
const CANAL_B = 'c0a12000-5555-4000-8000-000000000002'
const CONTATO_A = 'c0a12000-6666-4000-8000-000000000001'
const CONTATO_B = 'c0a12000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let chamadas: PedidoDeLaco[] = []
let falhar = false
const notasFalsas = Object.fromEntries(CRITERIOS_RUBRICA.map((c, i) => [c, { nota: [4, 5, 3, 2, 5][i], justificativa: `ok ${c} liga 85 99999-1234` }]))
/** Juiz falso: registra o pedido e devolve a rubrica com uso cobrável no catálogo (Sonnet 5.5). */
const juizFalso: PortaLlmFerramentas = {
  nome: 'claude', capacidades: { ferramentas: false, saidaEstruturada: true, cacheDePrefixo: true },
  async rodar(p): Promise<ResultadoLaco> {
    chamadas.push(p)
    const rastro = { chamadas: [], rodadas: 1, uso: { entrada: 100_000, saida: 1_000, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'claude-sonnet-5-5', provedor: 'claude', latenciaMs: 1, parouPor: 'fim' as const }
    if (falhar) return { ok: false, motivo: 'indisponivel', detalhe: 'fora', rastro }
    return { ok: true, saida: notasFalsas, rastro }
  },
}

const rodar = (t: string, extra: { juiz?: PortaLlmFerramentas } = {}) =>
  processarQualidade(dono as never, { juiz: juizFalso, somenteTenant: t, ...extra }, new Date())

/** Uma conversa com sessão e `n` turnos (decisões com resposta). */
async function conversaCom(t: string, canal: string, p: {
  modo?: string; estado?: 'ativa' | 'entregue'; turnos: number; marcas?: MarcaGuardrail[]; idConversa?: string
}): Promise<{ conversa: string; sessao: string; decisoes: string[] }> {
  const conversa = p.idConversa ?? crypto.randomUUID()
  const sessao = crypto.randomUUID()
  // Uma conversa por (número, contato): cada conversa do teste ganha o seu contato.
  const contato = crypto.randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Cliente', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conversa}, ${canal}, ${contato}, 1)`
  const ativa = (p.estado ?? 'entregue') === 'ativa'
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, encerrada_em, motivo_saida, iniciada_em)
             VALUES (${t}, ${sessao}, ${conversa}, ${canal}, ${p.modo ?? 'sombra'}, ${p.turnos}, ${p.estado ?? 'entregue'},
                     ${ativa ? null : new Date()}, ${ativa ? null : 'teste'}, now() - interval '1 hour')`
  const decisoes: string[] = []
  for (let i = 0; i < p.turnos; i++) {
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${t}, ${crypto.randomUUID()}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto: `quero 10 caixas, meu fone 85 98888-${String(1000 + i)}` })}::text::jsonb, now() - make_interval(mins => ${50 - i}))`
    const id = crypto.randomUUID()
    decisoes.push(id)
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, guardrails, criado_em)
               VALUES (${t}, ${id}, ${conversa}, ${canal}, ${sessao}, ${p.modo ?? 'sombra'}, 'sugeriu',
                       ${JSON.stringify({ mensagens: [`Temos sim, quantas caixas? (${i})`], confianca: 0.9 })}::text::jsonb,
                       ${JSON.stringify(i === p.turnos - 1 ? p.marcas ?? [] : [])}::text::jsonb, now() - make_interval(mins => ${49 - i}))`
  }
  return { conversa, sessao, decisoes }
}

const avaliacoes = async (t: string) => dono<{
  decisao_id: string; tipo: string; gatilho: string; origem: string; pior_gravidade: string | null; acao: string | null
  violacoes: { regra: string; gravidade: string; corrigida: boolean; trecho: string }[]; nota_media: string | null
  notas: Record<string, number> | null; justificativas: Record<string, string> | null; custo_centavos: string; erro: string | null; turnos: number | null
}[]>`SELECT decisao_id, tipo, gatilho, origem, pior_gravidade, acao, violacoes, nota_media::text, notas, justificativas,
            custo_centavos::text, erro, turnos FROM agente_avaliacao WHERE tenant_id = ${t} ORDER BY criado_em`

/** Um id de conversa que cai (ou não) numa amostra de 0,5 — a fração é estável, então dá para escolher. */
function conversaComFracao(dentro: boolean): string {
  for (;;) {
    const id = crypto.randomUUID()
    if ((fracaoEstavel(id) < 0.5) === dentro) return id
  }
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-qualidade-worker', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-qualidade-worker', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal, contato] of [[A, PV_A, CANAL_A, CONTATO_A], [B, PV_B, CANAL_B, CONTATO_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Qualidade ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas) VALUES (${t}, ${canal}, true, 'sombra', 'Entrega em 3 dias.') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Cliente', true) ON CONFLICT DO NOTHING`
  }
})
beforeEach(async () => {
  chamadas = []; falhar = false
  for (const t of [A, B]) {
    for (const tab of ['agente_avaliacao', 'agente_decisao', 'agente_sessao', 'mensagem', 'alerta', 'outbox', 'conversa']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`DELETE FROM contato WHERE tenant_id = ${t} AND id NOT IN (${CONTATO_A}, ${CONTATO_B})`
    await dono`UPDATE agente_config SET qualidade_amostra = NULL, qualidade_teto_mes_centavos = NULL, modo = 'sombra' WHERE tenant_id = ${t}`
  }
})
afterAll(async () => {
  for (const t of [A, B]) {
    for (const tab of ['agente_avaliacao', 'agente_decisao', 'agente_sessao', 'mensagem', 'alerta', 'outbox', 'conversa', 'agente_config', 'contato', 'canal_conectado']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('avaliacaoDasMarcas — das marcas do turno para a avaliação de regras', () => {
  it('o que escapou define a gravidade; o corrigido entra marcado e não conta', () => {
    const a = avaliacaoDasMarcas([
      { etapa: 'filtro-saida', codigo: 'garantia_sem_fonte', gravidade: 'CRITICA', acao: 'removido', trecho: 'garantimos' },
      { etapa: 'regras-qualidade', codigo: 'multiplas_perguntas', gravidade: 'MEDIA', acao: 'registrado', trecho: 'a? | b?' },
      { etapa: 'filtro-saida', codigo: 'hesitacao_talvez', gravidade: 'INFO', acao: 'registrado' },
    ])
    expect(a.piorGravidade).toBe('MEDIA')
    expect(a.acao).toBe('registrado')
    expect(a.violacoes).toEqual([
      expect.objectContaining({ regra: 'palavra_proibida', gravidade: 'CRITICA', corrigida: true, detalhe: 'garantia_sem_fonte' }),
      expect.objectContaining({ regra: 'multiplas_perguntas', gravidade: 'MEDIA', corrigida: false }),
    ])
  })

  it('pausa e "não envie" viram a ação', () => {
    expect(avaliacaoDasMarcas([
      { etapa: 'regras-qualidade', codigo: 'palavra_proibida', gravidade: 'CRITICA', acao: 'registrado' },
      { etapa: 'regras-qualidade', codigo: 'qualidade_violacao_critica', gravidade: 'CRITICA', acao: 'handoff' },
    ])).toMatchObject({ piorGravidade: 'CRITICA', acao: 'pausa_humano' })
    expect(avaliacaoDasMarcas([
      { etapa: 'regras-qualidade', codigo: 'palavra_proibida', gravidade: 'CRITICA', acao: 'registrado' },
      { etapa: 'regras-qualidade', codigo: 'nao_envie', gravidade: 'CRITICA', acao: 'bloqueado' },
    ]).acao).toBe('nao_envie')
    expect(avaliacaoDasMarcas([])).toEqual({ violacoes: [], piorGravidade: null, acao: null })
  })
})

describe('worker de qualidade', () => {
  it('regras em 100% das decisões com resposta, idempotente por (decisão, tipo)', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 0 WHERE tenant_id = ${A}`
    const { decisoes } = await conversaCom(A, CANAL_A, {
      turnos: 3, marcas: [{ etapa: 'regras-qualidade', codigo: 'palavra_proibida', gravidade: 'CRITICA', acao: 'registrado', trecho: 'sem nota' },
        { etapa: 'regras-qualidade', codigo: 'nao_envie', gravidade: 'CRITICA', acao: 'bloqueado' }],
    })
    // Simulação (playground) e silêncio não entram.
    const conv = (await dono<{ conversa_id: string }[]>`SELECT conversa_id FROM agente_decisao WHERE id = ${decisoes[0]!}`)[0]!.conversa_id
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, resposta) VALUES (${A}, ${crypto.randomUUID()}, ${conv}, ${CANAL_A}, 'simulacao', 'respondeu', '{"mensagens":["x"]}'::jsonb)`
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho) VALUES (${A}, ${crypto.randomUUID()}, ${conv}, ${CANAL_A}, 'sombra', 'silencio')`

    const r1 = await rodar(A)
    expect(r1.regras).toBe(3)
    const r2 = await rodar(A)
    expect(r2.regras).toBe(0)
    const av = await avaliacoes(A)
    expect(av).toHaveLength(3)
    expect(av.every((x) => x.tipo === 'regras' && x.gatilho === 'turno' && x.origem === 'sugestao')).toBe(true)
    const ultima = av.find((x) => x.decisao_id === decisoes[2])!
    expect(ultima).toMatchObject({ pior_gravidade: 'CRITICA', acao: 'nao_envie' })
    expect(av.filter((x) => x.pior_gravidade === null)).toHaveLength(2)
    expect(chamadas).toHaveLength(0) // amostra 0: juiz nunca
  })

  it('juiz no fim da sessão, na amostra, uma vez só — rubrica, média, custo do catálogo e transcrição mascarada', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${A}`
    const { decisoes } = await conversaCom(A, CANAL_A, { turnos: 2 })
    const r = await rodar(A)
    expect(r.julgadas).toBe(1)
    expect(chamadas).toHaveLength(1)
    const texto = chamadas[0]!.mensagens[0]!.texto
    expect(texto).toMatch(/AGENTE \(sugestão\): Temos sim/)
    expect(texto).toMatch(/CLIENTE: quero 10 caixas/)
    expect(texto).not.toMatch(/98888/)
    expect(chamadas[0]!.ferramentas).toEqual([])

    const juiz = (await avaliacoes(A)).find((x) => x.tipo === 'juiz')!
    expect(juiz).toMatchObject({ decisao_id: decisoes[1], gatilho: 'fim_sessao', origem: 'sugestao', erro: null, turnos: 2 })
    expect(juiz.notas).toEqual({ aderencia: 4, clareza: 5, empatia: 3, conducao: 2, compliance: 5 })
    expect(Number(juiz.nota_media)).toBe(3.8)
    expect(Object.values(juiz.justificativas!).join(' ')).not.toMatch(/99999/)
    // 100k entrada × US$ 2/M + 1k saída × US$ 10/M = US$ 0,21 → × 5,5 ≈ 116 centavos.
    expect(Number(juiz.custo_centavos)).toBeGreaterThan(100)

    expect((await rodar(A)).julgadas).toBe(0)
    expect(chamadas).toHaveLength(1)
  })

  it('fora da amostra o juiz não roda; a amostra é estável pelo id da conversa', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 0.5 WHERE tenant_id = ${A}`
    await conversaCom(A, CANAL_A, { turnos: 1, idConversa: conversaComFracao(false) })
    const dentro = await conversaCom(A, CANAL_A, { turnos: 1, idConversa: conversaComFracao(true) })
    expect((await rodar(A)).julgadas).toBe(1)
    expect((await avaliacoes(A)).filter((x) => x.tipo === 'juiz').map((x) => x.decisao_id)).toEqual(dentro.decisoes)
  })

  it('padrão do modo: autônomo amostra 5% (fora), sombra 100% (dentro)', async () => {
    const id = conversaComFracao(false) // ≥ 0,5 → fora de 0,05
    await conversaCom(A, CANAL_A, { turnos: 1, modo: 'autonomo', idConversa: id })
    expect((await rodar(A)).julgadas).toBe(0)
    await conversaCom(A, CANAL_A, { turnos: 1, modo: 'sombra' })
    expect((await rodar(A)).julgadas).toBe(1)
  })

  it('a cada 10 turnos numa sessão ativa: julga no 10º, não repete, julga de novo no 20º', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${A}`
    await conversaCom(A, CANAL_A, { turnos: 9, estado: 'ativa' })
    expect((await rodar(A)).julgadas).toBe(0)
    const { sessao } = (await dono<{ sessao: string }[]>`SELECT id AS sessao FROM agente_sessao WHERE tenant_id = ${A}`)[0]!
    await dono`UPDATE agente_sessao SET turnos = 10 WHERE id = ${sessao}`
    expect((await rodar(A)).julgadas).toBe(1)
    expect((await rodar(A)).julgadas).toBe(0)
    // Mais 10 turnos (uma decisão nova para julgar) → julga de novo.
    const conv = (await dono<{ conversa_id: string }[]>`SELECT conversa_id FROM agente_sessao WHERE id = ${sessao}`)[0]!.conversa_id
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta)
               VALUES (${A}, ${crypto.randomUUID()}, ${conv}, ${CANAL_A}, ${sessao}, 'sombra', 'sugeriu', '{"mensagens":["Fechamos?"]}'::jsonb)`
    await dono`UPDATE agente_sessao SET turnos = 20 WHERE id = ${sessao}`
    expect((await rodar(A)).julgadas).toBe(1)
    const juiz = (await avaliacoes(A)).filter((x) => x.tipo === 'juiz')
    expect(juiz.map((x) => [x.gatilho, x.turnos])).toEqual([['turnos', 10], ['turnos', 20]])
    // A sessão termina no 20º: já julgada depois do último turno → não paga de novo.
    await dono`UPDATE agente_sessao SET estado = 'entregue', encerrada_em = now(), motivo_saida = 'teste' WHERE id = ${sessao}`
    expect((await rodar(A)).julgadas).toBe(0)
  })

  it('teto mensal por número: para no teto, abre alerta e não escolhe mais o número', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1, qualidade_teto_mes_centavos = 50 WHERE tenant_id = ${A}`
    await conversaCom(A, CANAL_A, { turnos: 1 })
    await conversaCom(A, CANAL_A, { turnos: 1 })
    await conversaCom(A, CANAL_A, { turnos: 1 })
    const r = await rodar(A)
    expect(r.julgadas).toBe(1) // o 1º já custa > 50 centavos
    expect(chamadas).toHaveLength(1)
    const alertas = await dono<{ tipo: string; severidade: string; mensagem: string }[]>`SELECT tipo, severidade, mensagem FROM alerta WHERE tenant_id = ${A} AND resolvido_em IS NULL`
    expect(alertas).toEqual([expect.objectContaining({ tipo: 'agente_qualidade_teto', severidade: 'aviso' })])
    expect((await rodar(A)).julgadas).toBe(0)
    expect(chamadas).toHaveLength(1)
    // Teto 0 = juiz desligado no número.
    await dono`UPDATE agente_config SET qualidade_teto_mes_centavos = 0 WHERE tenant_id = ${B}`
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${B}`
    await conversaCom(B, CANAL_B, { turnos: 1 })
    expect((await rodar(B)).julgadas).toBe(0)
  })

  it('falha do juiz fica registrada (sem nota) e não repete a cada passada', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${A}`
    await conversaCom(A, CANAL_A, { turnos: 1 })
    falhar = true
    const r = await rodar(A)
    expect(r.falhas).toBe(1)
    const [j] = (await avaliacoes(A)).filter((x) => x.tipo === 'juiz')
    expect(j).toMatchObject({ nota_media: null, erro: 'indisponivel: fora' })
    expect((await rodar(A)).falhas).toBe(0)
    expect(chamadas).toHaveLength(1)
  })

  it('juiz fora do formato vira falha nomeada', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${A}`
    await conversaCom(A, CANAL_A, { turnos: 1 })
    const torto: PortaLlmFerramentas = { ...juizFalso, async rodar(p) { const r = await juizFalso.rodar(p); return r.ok ? { ...r, saida: { clareza: 3 } } : r } }
    expect((await rodar(A, { juiz: torto })).falhas).toBe(1)
    expect((await avaliacoes(A)).find((x) => x.tipo === 'juiz')!.erro).toMatch(/^formato/)
  })

  it('a fração estável do SQL é a mesma do shared (FNV-1a)', async () => {
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID())
    const sql = await dono<{ f: number }[]>`SELECT qualidade_fracao_estavel(x) AS f FROM unnest(${ids}::text[]) WITH ORDINALITY AS t(x, n) ORDER BY n`
    sql.forEach((l, i) => expect(l.f).toBeCloseTo(fracaoEstavel(ids[i]!), 12))
  })

  it('RLS: o tenant B não enxerga (nem por id) a avaliação do A', async () => {
    await dono`UPDATE agente_config SET qualidade_amostra = 1 WHERE tenant_id = ${A}`
    const { decisoes } = await conversaCom(A, CANAL_A, { turnos: 1 })
    await rodar(A)
    expect((await avaliacoes(A)).length).toBeGreaterThan(0)
    const vistoPorB = await comTenantServico(B, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_avaliacao WHERE decisao_id = ${decisoes[0]!}`)
    expect(vistoPorB[0]!.n).toBe(0)
    const vistoPorA = await comTenantServico(A, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_avaliacao WHERE decisao_id = ${decisoes[0]!}`)
    expect(vistoPorA[0]!.n).toBe(2)
    // B tentando gravar uma linha com o tenant de A: a policy (WITH CHECK) barra.
    const [d] = await dono<{ conversa_id: string }[]>`SELECT conversa_id FROM agente_decisao WHERE id = ${decisoes[0]!}`
    await expect(comTenantServico(B, (tx) => tx`
      INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho)
      VALUES (${A}, ${crypto.randomUUID()}, ${decisoes[0]!}, ${d!.conversa_id}, ${CANAL_A}, 'agente', 'juiz', 'manual')`)).rejects.toThrow()
    expect((await avaliacoes(A)).length).toBe(2)
    // A passada de B não toca em A.
    expect((await rodar(B)).processadas).toBe(0)
  })
})
