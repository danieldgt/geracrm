import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import { agendarTurno, type Tarefa } from '../fila.js'
import { processarTarefasDoAgente } from '../../../../workers/agente.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { marca, rodarPosResposta, rodarPreLlm, montarPipeline, PIPELINE_PADRAO } from './index.js'
import type { ContextoPipeline, EtapaPosResposta, EtapaPreLlm, PipelineDoTurno } from './tipos.js'

/**
 * O PIPELINE DO TURNO — uma etapa FALSA em cada ponto de extensão, com o turno
 * de verdade em volta (banco real, WhatsApp falso). Prova que cada raia pode
 * preencher o seu stub e o efeito aparece onde o contrato diz: antes do modelo,
 * depois dele, no envio, na auditoria e na fila.
 */
const T = 'c0de0000-0000-4000-8000-000000000001'
const PV = 'c0de0000-1111-4000-8000-000000000001'
const PLANO = 'c0de0000-3333-4000-8000-000000000001'
const MODELO = 'c0de0000-4444-4000-8000-000000000001'
const CANAL = 'c0de0000-5555-4000-8000-000000000001'
const CONTATO = 'c0de0000-6666-4000-8000-000000000001'
const CONVERSA = 'c0de0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

/** Modelo falso que registra o que recebeu e responde sempre o mesmo. */
let pedidos: PedidoDeLaco[] = []
function llmQueDiz(mensagens: string[]): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p): Promise<ResultadoLaco> {
      pedidos.push(p)
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}
const llmQueFalha: PortaLlmFerramentas = { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> { return { ok: false, motivo: 'indisponivel', detalhe: 'simulada' } } }
const llmProibido: PortaLlmFerramentas = { nome: 'proibido', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> { throw new Error('o modelo não devia ser chamado') } }

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja Pipeline"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = async (texto: string, extra: Partial<DepsTurno> = {}) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente(texto)]), { llm: llmQueDiz(['Temos sim!']), ligacoes, enviar: enviarFalso, ...extra })
const ultimaDecisao = async () => (await dono<{ desfecho: string; modo: string; handoff_motivo: string | null; enviada: boolean; guardrails: { etapa: string; codigo: string; trecho?: string }[]; falha_tipo: string | null; portao_motivo: string | null }[]>`
  SELECT desfecho, modo, handoff_motivo, enviada, guardrails, falha_tipo, portao_motivo FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const atendimentos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]!.n

const pre = (fn: EtapaPreLlm['executar']): EtapaPreLlm => ({ nome: 'falsa', executar: fn })
const pos = (fn: EtapaPosResposta['executar']): EtapaPosResposta => ({ nome: 'falsa', executar: fn })
const pipeline = (p: Partial<PipelineDoTurno>) => ({ pipeline: p })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-pipeline', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-pipeline', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Pipeline', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Pipeline', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990777', '5585999990777', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; pedidos = []
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Pipeline padrão = comportamento anterior', () => {
  it('com os stubs, autônomo responde o que o modelo disse e não grava marca nenhuma', async () => {
    await configurar('autonomo')
    const r = await turno('oi')
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toEqual(['Temos sim!'])
    const d = await ultimaDecisao()
    expect(d.guardrails).toEqual([])
    expect(d.falha_tipo).toBeNull()
  })
})

describe('Ponto 1 — modo efetivo (P14)', () => {
  it('número em autônomo, etapa rebaixa para sombra → decide e registra, não envia', async () => {
    await configurar('autonomo')
    const r = await turno('oi', pipeline({ modoEfetivo: { nome: 'falsa', decidir: async () => ({ modo: 'sombra', motivo: 'fora do recorte' }) } }))
    expect(r.desfecho).toBe('sugeriu')
    expect(enviados).toEqual([])
    expect((await ultimaDecisao()).modo).toBe('sombra')
  })
})

describe('Ponto 2 — gatilhos de entrada (P4)', () => {
  it('silencio: nem chama o modelo; a decisão guarda o motivo e as marcas', async () => {
    await configurar('autonomo')
    const r = await turno('[áudio]', {
      llm: llmProibido,
      ...pipeline({ gatilhos: pre(async () => ({ tipo: 'silencio', motivo: 'audio_transcrevendo' })) }),
    })
    expect(r).toMatchObject({ desfecho: 'silencio', motivo: 'audio_transcrevendo' })
    expect(enviados).toEqual([])
  })

  it('resposta_fixa: envia o texto fixo sem modelo e grava o estado da raia na sessão', async () => {
    await configurar('autonomo')
    const r = await turno('é robô?', {
      llm: llmProibido,
      ...pipeline({ gatilhos: pre(async () => ({
        tipo: 'resposta_fixa', mensagens: ['Sou a assistente virtual da Loja Pipeline.'],
        estado: { gatilhos: { robo: 1 } }, guardrails: [marca('gatilhos-entrada', 'pergunta_robo', 'INFO', 'registrado', 'é robô?')],
      })) }),
    })
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toEqual(['Sou a assistente virtual da Loja Pipeline.'])
    const d = await ultimaDecisao()
    expect(d.guardrails).toEqual([{ etapa: 'gatilhos-entrada', codigo: 'pergunta_robo', gravidade: 'INFO', acao: 'registrado', trecho: 'é robô?' }])
    const [s] = await dono<{ estado_agente: Record<string, unknown> }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado_agente).toEqual({ gatilhos: { robo: 1 } })
  })

  it('handoff com aviso: em autônomo o aviso sai pelo gateway e a conversa vai para a fila', async () => {
    await configurar('autonomo')
    const r = await turno('pare de me mandar mensagem', {
      llm: llmProibido,
      ...pipeline({ gatilhos: pre(async () => ({ tipo: 'handoff', motivo: 'opt_out', resumo: 'Cliente pediu para parar.', avisoCliente: 'Tudo bem, não enviaremos mais mensagens.' })) }),
    })
    expect(r).toMatchObject({ desfecho: 'handoff', motivo: 'opt_out' })
    expect(enviados).toEqual(['Tudo bem, não enviaremos mais mensagens.'])
    expect(await atendimentos()).toBe(1)
    const d = await ultimaDecisao()
    expect(d).toMatchObject({ handoff_motivo: 'opt_out', enviada: true })
  })

  it('handoff com aviso em sombra: o aviso NÃO sai e não nasce atendimento', async () => {
    await configurar('sombra')
    const r = await turno('pare', {
      llm: llmProibido,
      ...pipeline({ gatilhos: pre(async () => ({ tipo: 'handoff', motivo: 'opt_out', resumo: 'Parar.', avisoCliente: 'Tudo bem.' })) }),
    })
    expect(r.desfecho).toBe('handoff')
    expect(enviados).toEqual([])
    expect(await atendimentos()).toBe(0)
  })
})

describe('Ponto 3 — slots do cliente (P3)', () => {
  it('as instruções de uma etapa que segue chegam ao modelo como operador', async () => {
    await configurar('autonomo')
    await turno('quero 50 peças', pipeline({ slots: pre(async () => ({ tipo: 'segue', instrucoes: ['O cliente já informou o volume.'] })) }))
    const operador = pedidos[0]!.mensagens.at(-1)!
    expect(operador.papel).toBe('operador')
    expect(operador.texto).toContain('O cliente já informou o volume.')
  })
})

describe('Ponto 4 — teto por conversa (P6)', () => {
  it('antes: barra sem modelo', async () => {
    await configurar('autonomo')
    const r = await turno('oi', {
      llm: llmProibido,
      ...pipeline({ teto: { ...PIPELINE_PADRAO.teto, antes: async () => ({ tipo: 'handoff', motivo: 'limite_de_custo_conversa', resumo: 'Teto da conversa.', avisoCliente: null }) } }),
    })
    expect(r).toMatchObject({ desfecho: 'handoff', motivo: 'limite_de_custo_conversa' })
    expect(enviados).toEqual([])
  })

  it('depois: responde e transfere em silêncio', async () => {
    await configurar('autonomo')
    let custoVisto = -1
    const r = await turno('oi', pipeline({ teto: { ...PIPELINE_PADRAO.teto, depois: async (_ctx, t) => { custoVisto = t.custoCentavos; return { tipo: 'handoff', motivo: 'limite_de_custo_conversa', resumo: 'Estourou.' } } } }))
    expect(enviados).toEqual(['Temos sim!'])
    expect(r).toMatchObject({ desfecho: 'handoff', handoff: { motivo: 'limite_de_custo_conversa' } })
    expect(custoVisto).toBeGreaterThanOrEqual(0)
    expect(await atendimentos()).toBe(1)
  })
})

describe('Pontos 5–8 — depois do modelo (P7, P2, P3, P12)', () => {
  it('cada etapa recebe a saída da anterior, na ordem números → filtro → pergunta → qualidade', async () => {
    await configurar('autonomo')
    const ordem: string[] = []
    const anexa = (nome: string): EtapaPosResposta => pos(async (_ctx, e) => {
      ordem.push(nome)
      return { mensagens: e.mensagens.map((m) => `${m} [${nome}]`), guardrails: [marca(nome, 'teste', 'INFO', 'reescrito')] }
    })
    await turno('oi', pipeline({ numeros: anexa('numeros'), filtro: anexa('filtro'), pergunta: anexa('pergunta'), qualidade: anexa('qualidade') }))
    expect(ordem).toEqual(['numeros', 'filtro', 'pergunta', 'qualidade'])
    expect(enviados).toEqual(['Temos sim! [numeros] [filtro] [pergunta] [qualidade]'])
    expect((await ultimaDecisao()).guardrails.map((g) => g.etapa)).toEqual(['numeros', 'filtro', 'pergunta', 'qualidade'])
  })

  it('filtro recebe as falas anteriores do agente e o estado gravado no turno anterior', async () => {
    await configurar('autonomo')
    const vistos: ContextoPipeline[] = []
    const pergunta = pos(async (ctx, e) => {
      vistos.push(ctx)
      return { mensagens: e.mensagens, guardrails: [], estado: { perguntas: { ultima: e.mensagens[0] } } }
    })
    await turno('oi', pipeline({ pergunta }))
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, 'saliente', 'texto', ${JSON.stringify({ texto: 'Temos sim!' })}::text::jsonb, now())`
    await turno('e em azul?', pipeline({ pergunta }))
    expect(vistos[1]!.estado).toEqual({ perguntas: { ultima: 'Temos sim!' } })
    expect(vistos[1]!.primeiraResposta).toBe(false)
  })

  it('qualidade bloqueia: nada sai e a conversa vai ao humano com o motivo da etapa', async () => {
    await configurar('autonomo')
    const r = await turno('oi', pipeline({ qualidade: pos(async () => ({
      mensagens: [], guardrails: [marca('regras-qualidade', 'promessa', 'CRITICA', 'bloqueado', 'CPF 123.456.789-09 garantido')],
      bloquear: { motivo: 'qualidade_violacao_critica', resumo: 'Promessa proibida.' },
    })) }))
    expect(enviados).toEqual([])
    expect(r).toMatchObject({ desfecho: 'handoff', handoff: { motivo: 'qualidade_violacao_critica' } })
    expect(await atendimentos()).toBe(1)
    const d = await ultimaDecisao()
    expect(d.guardrails[0]!.trecho).toBe('CPF *** garantido')
  })
})

describe('Ponto 9 — política de falha (P5)', () => {
  it('stub: falha em autônomo vira handoff mudo e grava a classe da falha', async () => {
    await configurar('autonomo')
    const r = await turno('oi', { llm: llmQueFalha })
    expect(r).toMatchObject({ desfecho: 'handoff', motivo: 'modelo_indisponivel' })
    expect(enviados).toEqual([])
    expect((await ultimaDecisao()).falha_tipo).toBe('transitoria')
  })

  it('aviso_e_reagendar: avisa em autônomo, mantém a sessão e o worker devolve a tarefa à fila com o atraso', async () => {
    await configurar('autonomo')
    const falha: PipelineDoTurno['falha'] = { nome: 'falsa', decidir: async () => ({ acao: 'aviso_e_reagendar', classe: 'transitoria', avisoCliente: 'Tive uma instabilidade, já te respondo.', reagendarEmMs: 30_000 }) }
    const id = await mensagemDoCliente('oi')
    const agendada = new Date(Date.now() - 60_000)
    await comTenantServico(T, (tx) => agendarTurno(tx, { conversaId: CONVERSA, canalId: CANAL, mensagemId: id, agora: agendada, atrasoMs: 0 }))
    const agora = new Date()
    await processarTarefasDoAgente(dono as never, { llm: llmQueFalha, ligacoes, enviar: enviarFalso, agora, pipeline: { falha } }, agora)
    expect(enviados).toEqual(['Tive uma instabilidade, já te respondo.'])
    const [t] = await dono<{ estado: string; executar_em: Date }[]>`SELECT estado, executar_em FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(t!.estado).toBe('pendente')
    expect(t!.executar_em.getTime() - agora.getTime()).toBe(30_000)
    expect(await atendimentos()).toBe(0)
    const [s] = await dono<{ estado: string }[]>`SELECT estado FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado).toBe('ativa')
  })
})

describe('Copiloto (P13)', () => {
  it('numa conversa com atendimento aberto, sugere sem enviar, sem sessão e grava modo copiloto', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado)
               VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, ${CANAL}, 9001, 'na_fila')`
    const r = await turno('tem em azul?', { copiloto: true })
    expect(r).toMatchObject({ desfecho: 'sugeriu', mensagens: ['Temos sim!'] })
    expect(enviados).toEqual([])
    expect((await ultimaDecisao()).modo).toBe('copiloto')
    const [s] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.n).toBe(0)
  })
})

describe('Runners puros', () => {
  const ctx = { estado: {} } as unknown as ContextoPipeline
  it('rodarPreLlm para na primeira decisão que não segue e junta o estado das anteriores', async () => {
    const p = montarPipeline({
      gatilhos: pre(async () => ({ tipo: 'segue', instrucoes: ['a'], estado: { gatilhos: 1 } })),
      slots: pre(async (c) => ({ tipo: 'silencio', motivo: `viu ${JSON.stringify(c.estado)}` })),
      teto: { ...PIPELINE_PADRAO.teto, antes: async () => { throw new Error('não devia rodar') } },
    })
    const r = await rodarPreLlm(p, ctx)
    expect(r.decisao).toEqual({ tipo: 'silencio', motivo: 'viu {"gatilhos":1}' })
    expect(r.instrucoes).toEqual(['a'])
    expect(r.estado).toEqual({ gatilhos: 1 })
  })

  it('rodarPosResposta: bloquear encerra a cadeia com as mensagens substitutas', async () => {
    const p = montarPipeline({
      numeros: pos(async () => ({ mensagens: [], guardrails: [], bloquear: { motivo: 'incerteza', resumo: '%', mensagensSubstitutas: ['Vou confirmar.'] } })),
      filtro: pos(async () => { throw new Error('não devia rodar') }),
    })
    const r = await rodarPosResposta(p, ctx, { mensagens: ['10% off'], handoff: null, centavosVistos: new Set(), numerosVistos: new Set(), falasAnterioresDoAgente: [] })
    expect(r.mensagens).toEqual(['Vou confirmar.'])
    expect(r.bloqueio?.motivo).toBe('incerteza')
  })

  it('marca corta o trecho em 160 e mascara documento e telefone', () => {
    const m = marca('x', 'y', 'ALTA', 'removido', `ligue 5585999990001 ${'a'.repeat(300)}`)
    expect(m.trecho!.startsWith('ligue 55***')).toBe(true)
    expect(m.trecho!.length).toBe(160)
  })
})
