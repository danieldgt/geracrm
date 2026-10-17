import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { PERGUNTA_DO_SLOT, PERGUNTA_NEUTRA, mesmaPergunta, perguntasDe } from '@geracrm/shared'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { criarEtapaPerguntaRepetida, falasDoUltimoTurnoDoAgente } from './pergunta-repetida.js'
import { etapaSlotsDoCliente } from './slots-do-cliente.js'
import type { ContextoPipeline } from './tipos.js'

/**
 * RAIA P3 — pergunta repetida e slots determinísticos.
 *
 * Caso real da AM (playbook §3.8, §12 #3) portado ao B2B: o agente pergunta se a compra é para
 * revenda, o cliente responde OUTRA coisa ("50 caixas até sexta") e o modelo devolve a MESMA
 * pergunta. Turno de verdade em volta (banco real, WhatsApp falso que grava a mensagem enviada).
 */
const T = 'b3b30000-0000-4000-8000-000000000003'
const PV = 'b3b30000-1111-4000-8000-000000000003'
const PLANO = 'b3b30000-3333-4000-8000-000000000003'
const MODELO = 'b3b30000-4444-4000-8000-000000000003'
const CANAL = 'b3b30000-5555-4000-8000-000000000003'
const CONTATO = 'b3b30000-6666-4000-8000-000000000003'
const CONVERSA = 'b3b30000-7777-4000-8000-000000000003'

const PERGUNTA_TIPO = 'Você vai revender ou é para uso próprio da empresa?'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
/** Envio falso que GRAVA a mensagem: o histórico do turno seguinte é o de verdade. */
const enviarGravando = (async (_t: string, _c: string, texto: string) => {
  const id = crypto.randomUUID()
  enviados.push(texto)
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'saliente', 'texto', ${JSON.stringify({ texto })}::text::jsonb, clock_timestamp())`
  return { ok: true, conversaId: CONVERSA, mensagemId: id }
}) as never
/** Envio falso que NÃO grava: simula histórico perdido — só o estado sabe a última pergunta. */
const enviarSemHistorico = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

let pedidos: PedidoDeLaco[] = []
/** Modelo falso que responde, em ordem, uma fala por turno. */
function llmEmSequencia(falas: string[]): PortaLlmFerramentas {
  let i = 0
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p): Promise<ResultadoLaco> {
      pedidos.push(p)
      const fala = falas[Math.min(i++, falas.length - 1)]!
      return { ok: true, saida: { mensagens: [fala], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

const configurar = (modo: string, qualificacao: string[]) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, qualificacao)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Distribuidora P3"}'::jsonb, '{}'::jsonb, ${JSON.stringify(qualificacao)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo, qualificacao = EXCLUDED.qualificacao`

const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, clock_timestamp())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = async (texto: string, deps: Omit<DepsTurno, 'ligacoes'>) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente(texto)]), { ligacoes, enviar: enviarGravando, ...deps })
const ultimaDecisao = async () => (await dono<{
  desfecho: string; guardrails: { etapa: string; codigo: string; gravidade: string; acao: string; trecho?: string }[]
  resposta: { mensagens: string[]; original?: { mensagens: string[] } } | null
}[]>`SELECT desfecho, guardrails, resposta FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const sessoes = async () => dono<{ id: string; turnos: number; estado_agente: Record<string, any> }[]>`
  SELECT id, turnos, estado_agente FROM agente_sessao WHERE tenant_id = ${T} ORDER BY iniciada_em DESC`
/** O texto do operador que o modelo recebeu no turno `i`. */
const operador = (i: number) => pedidos[i]!.mensagens.filter((m) => m.papel === 'operador').map((m) => m.texto).join('\n')

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-pergunta-repetida', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-pergunta-repetida', 'Atacado') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Pergunta Repetida', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Distribuidora', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente P3', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990333', '5585999990333', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; pedidos = []
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'outbox']) {
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

describe('Caso real (AM §12 #3) portado ao B2B: a mesma pergunta não sai em dois turnos seguidos', () => {
  it('cliente responde volume e prazo; o modelo repete "revender ou uso próprio?"; sai a pergunta do próximo slot', async () => {
    await configurar('autonomo', ['tipoCompra', 'volume', 'prazo', 'cidade'])
    const llm = llmEmSequencia([
      `Olá! Sou a Lia, atendimento automático da Distribuidora P3. ${PERGUNTA_TIPO}`,
      // O modelo ignora o que o cliente trouxe e devolve a MESMA pergunta (o que aconteceu de verdade).
      `Perfeito, 50 caixas até sexta, anotado! ${PERGUNTA_TIPO}`,
      'Ótimo! Vou ver as opções de copos para você.',
    ])

    await turno('Oi, quero comprar copos descartáveis', { llm })
    expect(enviados.at(-1)).toContain(PERGUNTA_TIPO)
    const [s1] = await sessoes()
    expect(s1!.estado_agente['perguntas']).toMatchObject({ ultima: { texto: PERGUNTA_TIPO, slot: 'tipoCompra' }, respondidos: {} })

    await turno('Preciso de 50 caixas até sexta', { llm })

    // O que chegou ao modelo: o que o cliente trouxe e a pergunta pendente que não deve repetir.
    expect(operador(1)).toContain('volume: 50 caixas')
    expect(operador(1)).toContain('prazo: até sexta')
    expect(operador(1)).toContain(`Sua última pergunta foi: "${PERGUNTA_TIPO}"`)
    expect(operador(1)).toContain('NÃO a repita')

    // O que foi enviado: sem a repetida, com o resto e a pergunta do próximo slot aberto.
    const enviada = enviados.at(-1)!
    expect(enviada).toBe(`Perfeito, 50 caixas até sexta, anotado! ${PERGUNTA_DO_SLOT.cidade}`)
    for (const p of perguntasDe(enviada)) expect(mesmaPergunta(p, PERGUNTA_TIPO)).toBe(false)

    // Auditoria: marca MEDIA substituída; o original do modelo continua lá.
    const d = await ultimaDecisao()
    expect(d.guardrails).toEqual([{ etapa: 'pergunta-repetida', codigo: 'pergunta_repetida', gravidade: 'MEDIA', acao: 'substituido', trecho: PERGUNTA_TIPO }])
    expect(d.resposta!.original!.mensagens[0]).toContain(PERGUNTA_TIPO)

    // Estado: a nova última pergunta e os slots lidos em código.
    const [s2] = await sessoes()
    expect(s2!.estado_agente['perguntas']).toMatchObject({
      ultima: { texto: PERGUNTA_DO_SLOT.cidade, slot: 'cidade' },
      respondidos: { volume: '50 caixas', prazo: 'até sexta' },
    })

    // Turno seguinte: resposta normal sai intacta, sem marca.
    await turno('Rio de Janeiro', { llm })
    expect(enviados.at(-1)).toBe('Ótimo! Vou ver as opções de copos para você.')
    expect((await ultimaDecisao()).guardrails).toEqual([])
  })

  // Revisão adversarial da P3 (ALTA): a trava trocava a confirmação do pedido por pergunta de revenda.
  it('confirmação de pedido ajustada sai intacta, sem marca', async () => {
    await configurar('autonomo', ['tipoCompra', 'volume'])
    const llm = llmEmSequencia([
      'Confirma 10 caixas do sabão neutro?',
      'Ok, ajustei. Confirma 20 caixas do sabão neutro?',
      'Adicionei as 2 caixas. Posso fechar o pedido?',
      'Adicionei mais 2 caixas. Posso fechar o pedido?',
    ])
    await turno('quero sabão neutro', { llm })
    await turno('na verdade são 20', { llm })
    expect(enviados.at(-1)).toBe('Ok, ajustei. Confirma 20 caixas do sabão neutro?')
    await turno('põe mais 2 caixas', { llm })
    await turno('e mais 2', { llm })
    expect(enviados.at(-1)).toBe('Adicionei mais 2 caixas. Posso fechar o pedido?')
    expect((await ultimaDecisao()).guardrails).toEqual([])
  })

  it('sem slot aberto no canal: a repetida sai e entra a pergunta neutra', async () => {
    await configurar('autonomo', [])
    const llm = llmEmSequencia([PERGUNTA_TIPO, `Anotado! ${PERGUNTA_TIPO}`])
    await turno('Oi', { llm })
    await turno('50 caixas', { llm })
    expect(enviados.at(-1)).toBe(`Anotado! ${PERGUNTA_NEUTRA}`)
  })

  it('após restart/histórico perdido vale o estado: a última pergunta guardada ainda trava', async () => {
    await configurar('autonomo', ['tipoCompra', 'volume'])
    const llm = llmEmSequencia([PERGUNTA_TIPO, `Certo! ${PERGUNTA_TIPO}`])
    await turno('Oi', { llm, enviar: enviarSemHistorico })
    // Nenhuma fala nossa no histórico: só o estado sabe o que foi perguntado.
    expect((await dono`SELECT 1 FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente'`).length).toBe(0)
    await turno('quero 10 fardos', { llm, enviar: enviarSemHistorico })
    expect(enviados.at(-1)).toBe(`Certo! ${PERGUNTA_NEUTRA}`)
    expect((await ultimaDecisao()).guardrails.map((g) => g.codigo)).toEqual(['pergunta_repetida'])
  })

  it('CNPJ dito pelo cliente vira "informado" no estado — os dígitos não são gravados', async () => {
    await configurar('autonomo', ['cnpj', 'volume'])
    const llm = llmEmSequencia(['Oi! Como posso ajudar?', 'Obrigada! Qual quantidade você precisa?'])
    await turno('Oi', { llm })
    await turno('meu cnpj é 11.222.333/0001-81', { llm })
    const [s] = await sessoes()
    expect(s!.estado_agente['perguntas'].respondidos).toEqual({ cnpj: 'informado' })
    expect(JSON.stringify(s!.estado_agente)).not.toMatch(/11\.?222/)
    expect(operador(1)).toContain('CNPJ informado')
  })

  it('em sombra a trava vale na sugestão, mas a "última pergunta" não muda (nada foi enviado)', async () => {
    await configurar('sombra', ['tipoCompra', 'cidade'])
    // Histórico com uma pergunta NOSSA (de um vendedor) e o modelo repetindo.
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', ${JSON.stringify({ texto: PERGUNTA_TIPO })}::text::jsonb, clock_timestamp())`
    const r = await turno('bom dia', { llm: llmEmSequencia([`Bom dia! ${PERGUNTA_TIPO}`]) })
    expect(r.desfecho).toBe('sugeriu')
    expect(r.mensagens).toEqual([`Bom dia! ${PERGUNTA_DO_SLOT.cidade}`])
    const [s] = await sessoes()
    expect(s!.estado_agente['perguntas'].ultima).toBeNull()
  })
})

describe('Plano §4: etapa pré-LLM com estado não abre sessão por silêncio', () => {
  const silenciaNoTeto = { nome: 'teto-falso', antes: async () => ({ tipo: 'silencio' as const, motivo: 'teste' }), depois: async () => ({ tipo: 'segue' as const }) }

  it('1º turno sem sessão: slots lidos, teto silencia → nenhuma sessão nasce', async () => {
    await configurar('autonomo', ['volume'])
    const r = await turno('preciso de 50 caixas', { llm: llmEmSequencia(['x']), pipeline: { teto: silenciaNoTeto } })
    expect(r.desfecho).toBe('silencio')
    expect(await sessoes()).toEqual([])
  })

  it('com sessão aberta, o slot dito num turno silenciado fica no estado', async () => {
    await configurar('autonomo', ['volume'])
    await turno('oi', { llm: llmEmSequencia(['Olá! Como posso ajudar?']) })
    await turno('preciso de 50 caixas', { llm: llmEmSequencia(['x']), pipeline: { teto: silenciaNoTeto } })
    const [s] = await sessoes()
    expect(s!.turnos).toBe(1)
    expect(s!.estado_agente['perguntas'].respondidos).toEqual({ volume: '50 caixas' })
  })
})

describe('etapas isoladas', () => {
  const ctxBase = (p: Partial<ContextoPipeline>): ContextoPipeline => ({
    tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'autonomo', agora: new Date('2026-10-17T12:00:00Z'),
    cfgExtra: { qualificacao: ['tipoCompra', 'volume', 'cidade'] }, persona: { nome: 'Lia', loja: '', tom: 'neutro', usaEmojis: false, idioma: 'pt-BR', saudacao: '', identificaComoRobo: true },
    estado: {}, historico: [], entrantes: [], primeiraResposta: false, foraDoExpediente: false, ...p,
  })
  const entrada = (mensagens: string[], handoff: { motivo: string; resumo: string } | null = null) =>
    ({ mensagens, handoff, centavosVistos: new Set<number>(), numerosVistos: new Set<number>(), falasAnterioresDoAgente: [] })

  it('turno anterior = falas nossas entre os dois últimos blocos do cliente', () => {
    expect(falasDoUltimoTurnoDoAgente([
      { de: 'nos', texto: 'velha?' }, { de: 'cliente', texto: 'oi' }, { de: 'nos', texto: 'a' }, { de: 'nos', texto: 'b?' }, { de: 'cliente', texto: 'resp' },
    ])).toEqual(['a', 'b?'])
    expect(falasDoUltimoTurnoDoAgente([{ de: 'cliente', texto: 'oi' }])).toEqual([])
  })

  it('slots conhecidos (modelo/cadastro) contam como respondidos na escolha da substituta', async () => {
    const etapa = criarEtapaPerguntaRepetida({ slotsConhecidos: async () => ['volume'] })
    const r = await etapa.executar(ctxBase({ historico: [{ de: 'nos', texto: PERGUNTA_TIPO }, { de: 'cliente', texto: 'hum' }] }), entrada([PERGUNTA_TIPO]))
    expect(r.mensagens).toEqual([PERGUNTA_DO_SLOT.cidade])
  })

  it('consulta de slots conhecidos falha → degrada, não lança', async () => {
    const etapa = criarEtapaPerguntaRepetida({ slotsConhecidos: async () => { throw new Error('banco fora') } })
    const r = await etapa.executar(ctxBase({ cfgExtra: {}, historico: [{ de: 'nos', texto: PERGUNTA_TIPO }, { de: 'cliente', texto: 'hum' }] }), entrada([PERGUNTA_TIPO]))
    expect(r.mensagens).toEqual([PERGUNTA_NEUTRA])
  })

  it('em handoff a repetida sai, mas nenhuma pergunta de qualificação entra', async () => {
    const etapa = criarEtapaPerguntaRepetida({ slotsConhecidos: async () => [] })
    const r = await etapa.executar(ctxBase({ historico: [{ de: 'nos', texto: PERGUNTA_TIPO }, { de: 'cliente', texto: 'quero falar com alguém' }] }),
      entrada([`Vou te passar para a equipe. ${PERGUNTA_TIPO}`], { motivo: 'pedido_de_humano', resumo: 'x' }))
    expect(r.mensagens).toEqual(['Vou te passar para a equipe.'])
  })

  it('slots: sem sessão devolve instrução mas não estado; com sessão devolve os dois', async () => {
    const entrantes = [{ id: 'm', tipo: 'texto', texto: 'é pra revenda, quero 30 caixas', transcricaoPendente: false, transcricaoFalhou: false }]
    const sem = await etapaSlotsDoCliente.executar(ctxBase({ entrantes }))
    expect(sem).toEqual({ tipo: 'segue', instrucoes: [expect.stringContaining('compra para revenda; volume: 30 caixas')] })
    const com = await etapaSlotsDoCliente.executar(ctxBase({ entrantes, sessaoId: 'b3b30000-9999-4000-8000-000000000003' }))
    expect(com).toMatchObject({ tipo: 'segue', estado: { perguntas: { respondidos: { tipoCompra: 'revenda', volume: '30 caixas' } } } })
  })

  it('slots: áudio ainda sem transcrição não conta; nada a dizer → só segue', async () => {
    const entrantes = [{ id: 'm', tipo: 'audio', texto: '[áudio sem transcrição]', transcricaoPendente: true, transcricaoFalhou: false }]
    expect(await etapaSlotsDoCliente.executar(ctxBase({ entrantes }))).toEqual({ tipo: 'segue' })
  })
})
