import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { montarPipeline, rodarPreLlm, PIPELINE_PADRAO } from './index.js'
import type { ContextoPipeline } from './tipos.js'
import { etapaDevolucaoDaEquipe, instrucaoDaDevolucao, lerRecadoDevolucao } from './devolucao-da-equipe.js'

/**
 * ETAPA "devolução da equipe" (G1) — o recado de "Devolver ao agente" chega ao
 * modelo no 1º turno depois da devolução e só nele; as etapas de proteção
 * continuam todas no caminho. Turno de verdade (banco real, WhatsApp falso).
 */
const T = 'de7a0000-0000-4000-8000-000000000001'
const PV = 'de7a0000-1111-4000-8000-000000000001'
const PLANO = 'de7a0000-3333-4000-8000-000000000001'
const MODELO = 'de7a0000-4444-4000-8000-000000000001'
const CANAL = 'de7a0000-5555-4000-8000-000000000001'
const CONTATO = 'de7a0000-6666-4000-8000-000000000001'
const CONVERSA = 'de7a0000-7777-4000-8000-000000000001'
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const FRASE = 'A equipe devolveu a conversa para você'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const enviarRecusado = (async () => ({ ok: false, classe: 'permanente', motivo: 'recusado no teste' })) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

let pedidos: PedidoDeLaco[] = []
function llmQueDiz(mensagens: string[]): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p): Promise<ResultadoLaco> {
      pedidos.push(p)
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = async (texto: string, extra: Partial<DepsTurno> = {}) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente(texto)]), { llm: llmQueDiz(['Certo, seguimos!']), ligacoes, enviar: enviarFalso, ...extra })
/** O texto de operador que o modelo recebeu no último turno. */
const operadorDoUltimoTurno = () => pedidos.at(-1)!.mensagens.filter((m) => m.papel === 'operador').map((m) => m.texto).join('\n')
const estadoDaSessao = async () => (await dono<{ estado_agente: Record<string, unknown> }[]>`
  SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${CONVERSA} AND estado = 'ativa'`)[0]?.estado_agente
const ultimaDecisao = async () => (await dono<{ guardrails: { etapa: string; codigo: string }[]; numeros_bloqueados: number[] }[]>`
  SELECT guardrails, numeros_bloqueados FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!

/** O que a rota de devolução deixa: sessão ativa, sem turnos, com o recado. */
const devolver = (recado: Record<string, unknown>) => dono`
  INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, motivo_entrada, modo, estado_agente)
  VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, ${CANAL}, 'devolvido_pela_equipe', 'autonomo',
          ${JSON.stringify({ devolucao: recado })}::text::jsonb)`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-devolucao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-devolucao', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Devolução', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Devolução', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990888', '5585999990888', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1, 'ia') ON CONFLICT DO NOTHING`
  await dono`
    INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
    VALUES (${T}, ${CANAL}, true, 'autonomo', 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja Devolução"}'::jsonb, '{}'::jsonb)
    ON CONFLICT (tenant_id, canal_id) DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; pedidos = []
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
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

describe('Turno real com o recado da devolução', () => {
  it('a instrução entra no 1º turno depois da devolução (motivo + observação mascarada) e NÃO no 2º', async () => {
    await devolver({ motivo: 'resolvido_pelo_humano', observacao: 'trocou o boleto; fone 5585999990001', em: new Date().toISOString() })

    const r1 = await turno('oi, voltei')
    expect(r1.desfecho).toBe('respondeu')
    const op1 = operadorDoUltimoTurno()
    expect(op1).toContain(FRASE)
    expect(op1).toContain('assunto resolvido pela equipe')
    expect(op1).toContain('trocou o boleto')
    expect(op1).not.toContain('5585999990001')
    expect(op1).toMatch(/Não repita o que o atendente já resolveu; retome do ponto em que ele parou/)
    expect(enviados.at(-1)).toBe('Certo, seguimos!')
    expect(await estadoDaSessao()).not.toHaveProperty('devolucao')
    expect((await ultimaDecisao()).guardrails).toContainEqual(expect.objectContaining({ etapa: 'devolucao-da-equipe', codigo: 'recado_lido' }))

    await turno('e o frete?')
    expect(pedidos).toHaveLength(2)
    expect(operadorDoUltimoTurno()).not.toContain(FRASE)
  })

  it('nenhuma proteção é desligada: com o recado, a rede final de R$ ainda segura valor sem fonte', async () => {
    await devolver({ motivo: 'outro', observacao: 'combinamos 39,90 cada', em: new Date().toISOString() })
    const r = await turno('quanto fica?', { llm: llmQueDiz(['Fica 39,90 cada.']) })
    expect(operadorDoUltimoTurno()).toContain(FRASE)
    // O número da observação NÃO vira fonte: a resposta é barrada e vai para o humano.
    expect(r).toMatchObject({ desfecho: 'handoff', handoff: { motivo: 'incerteza' } })
    expect(enviados).not.toContain('Fica 39,90 cada.')
    expect((await ultimaDecisao()).numeros_bloqueados).toEqual([3990])
  })

  it('envio recusado pelo gateway: o recado FICA para o próximo turno', async () => {
    await devolver({ motivo: 'cliente_quer_continuar_com_agente', em: new Date().toISOString() })
    await turno('oi', { enviar: enviarRecusado })
    expect(operadorDoUltimoTurno()).toContain(FRASE)
    expect(await estadoDaSessao()).toHaveProperty('devolucao')
    await turno('oi de novo')
    expect(operadorDoUltimoTurno()).toContain(FRASE)
    expect(await estadoDaSessao()).not.toHaveProperty('devolucao')
  })

  it('o consumo confere o carimbo: uma devolução NOVA gravada durante o turno não é apagada', async () => {
    await devolver({ motivo: 'fora_do_horario', em: '2026-11-01T10:00:00.000Z' })
    const novo = { motivo: 'outro', observacao: 'segunda devolução', em: '2026-11-01T12:00:00.000Z' }
    const llmQueRegrava: PortaLlmFerramentas = { ...llmQueDiz(['Ok!']), async rodar(p) {
      await dono`UPDATE agente_sessao SET estado_agente = estado_agente || ${JSON.stringify({ devolucao: novo })}::text::jsonb
                  WHERE tenant_id = ${T} AND conversa_id = ${CONVERSA} AND estado = 'ativa'`
      return llmQueDiz(['Ok!']).rodar(p)
    } }
    await turno('oi', { llm: llmQueRegrava })
    expect(await estadoDaSessao()).toMatchObject({ devolucao: novo })
  })
})

describe('Ordem e contrato da etapa', () => {
  const ctxCom = (estado: Record<string, unknown>, sessaoId: string | null = 's1') =>
    ({ estado, sessaoId, modo: 'autonomo', entrantes: [], historico: [] }) as unknown as ContextoPipeline
  const recado = { devolucao: { motivo: 'outro', em: new Date().toISOString() } }

  it('está no pipeline padrão como a ÚLTIMA etapa pré-modelo: quem barra antes (gatilho, teto) não deixa o recado ser lido', async () => {
    expect(PIPELINE_PADRAO.devolucao).toBe(etapaDevolucaoDaEquipe)
    const p = montarPipeline({
      gatilhos: { nome: 'g', executar: async () => ({ tipo: 'segue' }) },
      slots: { nome: 's', executar: async () => ({ tipo: 'segue' }) },
      teto: { ...PIPELINE_PADRAO.teto, antes: async () => ({ tipo: 'silencio', motivo: 'teto' }) },
    })
    const barrado = await rodarPreLlm(p, ctxCom(recado))
    expect(barrado.decisao).toEqual({ tipo: 'silencio', motivo: 'teto' })
    expect(barrado.instrucoes.join()).not.toContain(FRASE)
    expect(barrado.efeitos).toHaveLength(0)

    const livre = await rodarPreLlm(montarPipeline({
      gatilhos: { nome: 'g', executar: async () => ({ tipo: 'segue', instrucoes: ['do gatilho'] }) },
      slots: { nome: 's', executar: async () => ({ tipo: 'segue', instrucoes: ['dos slots'] }) },
      teto: { ...PIPELINE_PADRAO.teto, antes: async () => ({ tipo: 'segue' }) },
    }), ctxCom(recado))
    expect(livre.instrucoes[0]).toBe('do gatilho')
    expect(livre.instrucoes[1]).toBe('dos slots')
    expect(livre.instrucoes[2]).toContain(FRASE)
    expect(livre.efeitos.map((e) => e.nome)).toEqual(['devolucao-da-equipe'])
  })

  it('sem recado, recado malformado ou sem sessão: segue sem instrução e sem efeito', async () => {
    for (const ctx of [ctxCom({}), ctxCom({ devolucao: { motivo: 'inventado', em: 'x' } }), ctxCom(recado, null)]) {
      expect(await etapaDevolucaoDaEquipe.executar(ctx)).toEqual({ tipo: 'segue' })
    }
  })

  it('leitura tolerante e máscara da observação', () => {
    expect(lerRecadoDevolucao(null)).toBeNull()
    expect(lerRecadoDevolucao({ motivo: 'outro' })).toBeNull()
    const r = lerRecadoDevolucao({ motivo: 'outro', observacao: '  cpf 123.456.789-09  ', em: '2026-11-01T10:00:00Z' })!
    expect(r.observacao).toBe('cpf 123.456.789-09')
    const texto = instrucaoDaDevolucao(r)
    expect(texto).toContain('outro motivo')
    expect(texto).not.toContain('123.456.789-09')
  })
})
