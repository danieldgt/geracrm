import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import { conduzirTurnoVendedor } from './vendedor.js'
import { LlmSimulado } from './llm-simulado.js'
import { agendarTurno, pegarProximaTarefa, type Tarefa } from './fila.js'
import { processarTarefasDoAgente } from '../../../workers/agente.js'
import type { PortaLlmFerramentas, ResultadoLaco } from './porta-llm.js'
import type { CatalogoPorta, Ligacoes, PedidoPorta, PedidoParaLlm } from './ferramentas/ligacoes-porta.js'

/**
 * O TURNO DO VENDEDOR — a coreografia inteira com modelo simulado e portas
 * falsas de catálogo/pedido: fila → portão → ferramentas → guardrail → modo →
 * envio → auditoria → handoff. O WhatsApp é falso; o banco é real.
 */
const T = 'b2e20000-0000-4000-8000-000000000001'
const PV = 'b2e20000-1111-4000-8000-000000000001'
const PLANO = 'b2e20000-3333-4000-8000-000000000001'
const MODELO = 'b2e20000-4444-4000-8000-000000000001'
const CANAL = 'b2e20000-5555-4000-8000-000000000001'
const CONTATO = 'b2e20000-6666-4000-8000-000000000001'
const CONVERSA = 'b2e20000-7777-4000-8000-000000000001'
const USUARIO = 'b2e20000-8888-4000-8000-000000000001'
const SKU_VERDE = 'b2e20000-9999-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never

/** Catálogo falso com um produto e dois SKUs. */
const catalogoFalso: CatalogoPorta = {
  async buscar(_ctx, p) {
    if (!/camiseta/i.test(p.consulta)) return { itens: [] }
    return { itens: [{
      produtoId: 'b2e20000-aaaa-4000-8000-000000000001', referencia: 'CAM-001', produto: 'Camiseta básica', categoria: 'Camisetas', descricao: null,
      skus: [
        { skuId: SKU_VERDE, atributos: { cor: 'verde', tamanho: 'G' }, precoCentavos: 4990, saldo: 12 },
        { skuId: 'b2e20000-9999-4000-8000-000000000002', atributos: { cor: 'azul', tamanho: 'M' }, precoCentavos: 4990, saldo: 0 },
      ],
    }] }
  },
  async detalhar() { return null },
  async precoEEstoque(_ctx, ids) { return ids.map((skuId) => ({ skuId, situacao: 'cotado' as const, precoCentavos: 4990, saldo: 12 })) },
}
let pedidoFalso: PedidoParaLlm | null = null
let propostas = 0
const pedidoPortaFalsa: PedidoPorta = {
  async ver() { return pedidoFalso },
  async itens(_ctx, p) {
    if (p.acao !== 'adicionar') return { situacao: 'item_nao_encontrado' }
    if (p.skuId !== SKU_VERDE) return { situacao: 'sku_desconhecido' }
    pedidoFalso = { pedidoId: 'b2e20000-cccc-4000-8000-000000000001', estado: 'rascunho', totalCentavos: 4990 * p.quantidade,
      itens: [{ seq: 1, descricao: 'Camiseta básica', atributos: { cor: 'verde', tamanho: 'G' }, quantidade: p.quantidade, valorUnitarioCentavos: 4990, subtotalCentavos: 4990 * p.quantidade }] }
    return { situacao: 'ok', pedido: pedidoFalso }
  },
  async propor() {
    if (!pedidoFalso) return { situacao: 'vazio' }
    propostas += 1
    return { situacao: 'ok', resumo: 'Resumo', totalCentavos: pedidoFalso.totalCentavos, expiraEm: new Date().toISOString() }
  },
  async recentes() { return [] },
}
const ligacoes = async (): Promise<Ligacoes> => ({ catalogo: catalogoFalso, pedido: pedidoPortaFalsa, conhecimento: { async buscar() { return { trechos: [{ texto: 'Entrega em 3 dias úteis.', fonte: 'Políticas' }] } } } })

function llmQueDiz(saida: unknown): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> { return { ok: true, saida, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } } } }
}
function llmQueFalha(motivo: string): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> { return { ok: false, motivo: motivo as never, detalhe: 'simulada' } } }
}

const configurar = (modo: string, extra: Record<string, unknown> = {}) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, orcamento_dia_centavos)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis. Pagamento por PIX.', false, false,
          ${JSON.stringify({ nome: 'Lia', loja: 'Loja Teste', ...(extra['persona'] as object | undefined) })}::jsonb, '{}'::jsonb, ${(extra['orcamento'] as number | undefined) ?? null})
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo,
    so_quando_ninguem_disponivel = false, exigir_ausencia_antes = false, orcamento_dia_centavos = EXCLUDED.orcamento_dia_centavos`

const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = (ids: string[], llm?: PortaLlmFerramentas) =>
  conduzirTurnoVendedor(tarefaPara(ids), { llm: llm ?? new LlmSimulado(), ligacoes, enviar: enviarFalso })
const decisoes = () => dono<{ desfecho: string; enviada: boolean; modo: string; handoff_motivo: string | null; ferramentas: { nome: string }[]; numeros_bloqueados: number[]; portao_motivo: string | null }[]>`
  SELECT desfecho, enviada, modo, handoff_motivo, ferramentas, numeros_bloqueados, portao_motivo FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-vendedor', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-vendedor', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Vendedor', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, nome, email, cognito_sub) VALUES (${T}, ${USUARIO}, 'Vendedora', 'v@vendedor.test', 'sub-vendedor') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990001', '5585999990001', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; pedidoFalso = null; propostas = 0
  await dono`DELETE FROM agente_decisao WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
  await dono`DELETE FROM notificacao WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'pedido', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'usuario', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('Modo autônomo — vende com ferramentas', () => {
  it('dado "quero 2 camiseta verde", então busca, adiciona ao pedido e responde o total que veio da ferramenta', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('quero 2 camiseta verde')])
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.join(' ')).toContain('R$ 99,80')
    const [d] = await decisoes()
    expect(d!.enviada).toBe(true)
    expect(d!.ferramentas.map((f) => f.nome)).toEqual(['catalogo_buscar', 'pedido_itens'])
    const [s] = await dono<{ turnos: number; fase: string; modo: string }[]>`SELECT turnos, fase, modo FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s).toMatchObject({ turnos: 1, fase: 'recomendacao', modo: 'autonomo' })
    const [c] = await dono<{ conduzida_por: string }[]>`SELECT conduzida_por FROM conversa WHERE id = ${CONVERSA}`
    expect(c!.conduzida_por).toBe('ia')
  })

  it('dado "pode fechar", então propõe pelo domínio e não repete o resumo', async () => {
    await configurar('autonomo')
    await turno([await mensagemDoCliente('quero 1 camiseta verde')])
    enviados.length = 0
    const r = await turno([await mensagemDoCliente('pode fechar')])
    expect(r.desfecho).toBe('respondeu')
    expect(propostas).toBe(1)
    expect(enviados[0]).toMatch(/resumo do pedido/i)
  })

  it('dado pedido de humano, então transfere: atendimento na fila, mensagem de sistema, sessão entregue, notificação', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('quero falar com um atendente')])
    expect(r.desfecho).toBe('handoff')
    expect(r.handoff?.motivo).toBe('pedido_de_humano')
    const [a] = await dono<{ estado: string; atendente_id: string | null }[]>`SELECT estado, atendente_id FROM atendimento WHERE tenant_id = ${T}`
    expect(a).toMatchObject({ estado: 'na_fila', atendente_id: null })
    const [m] = await dono<{ tipo: string; conteudo: { automatica: string } }[]>`SELECT tipo, conteudo FROM mensagem WHERE tenant_id = ${T} AND tipo = 'sistema'`
    expect(m!.conteudo.automatica).toBe('agente_handoff')
    const [s] = await dono<{ estado: string; fase: string }[]>`SELECT estado, fase FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s).toMatchObject({ estado: 'entregue', fase: 'handoff' })
    expect(enviados.length).toBe(1) // a despedida saiu
  })
})

describe('Guardrail numérico', () => {
  it('dado o modelo citando um preço que nenhuma ferramenta devolveu, então a resposta é trocada e vira handoff por incerteza', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('quanto custa?')], llmQueDiz({ mensagens: ['Custa R$ 39,90!'], confianca: 0.9 }))
    expect(r.desfecho).toBe('handoff')
    expect(enviados.join(' ')).not.toContain('39,90')
    const [d] = await decisoes()
    expect(d!.numeros_bloqueados).toEqual([3990])
    expect(d!.handoff_motivo).toBe('incerteza')
  })

  it('confiança abaixo do limiar vira handoff por incerteza', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('hmm')], llmQueDiz({ mensagens: ['Acho que sim?'], confianca: 0.2 }))
    expect(r.desfecho).toBe('handoff')
    expect(r.handoff?.motivo).toBe('incerteza')
  })
})

describe('Modos sombra e assistido — nunca enviam', () => {
  it('sombra: decide, grava a decisão com as mensagens e não envia nada', async () => {
    await configurar('sombra')
    const r = await turno([await mensagemDoCliente('tem camiseta?')])
    expect(r.desfecho).toBe('sugeriu')
    expect(enviados).toEqual([])
    const [d] = await decisoes()
    expect(d).toMatchObject({ desfecho: 'sugeriu', enviada: false, modo: 'sombra' })
    expect(r.mensagens?.[0]).toMatch(/Camiseta básica/)
  })
  it('assistido: idem, e emite o evento de sugestão para a tela', async () => {
    await configurar('assistido')
    await turno([await mensagemDoCliente('tem camiseta?')])
    const [ev] = await dono<{ tipo: string }[]>`SELECT tipo FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`
    expect(ev).toBeTruthy()
    expect(enviados).toEqual([])
  })
})

describe('Falha do modelo não é silêncio', () => {
  it('modelo fora do ar → handoff modelo_indisponivel com atendimento na fila e decisão de falha', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('oi')], llmQueFalha('indisponivel'))
    expect(r.desfecho).toBe('handoff')
    expect(r.motivo).toBe('modelo_indisponivel')
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T}`
    expect(a!.estado).toBe('na_fila')
    const [d] = await decisoes()
    expect(d!.desfecho).toBe('falha')
  })
  it('resposta fora do formato → idem', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('oi')], llmQueDiz({ qualquer: 'coisa' }))
    expect(r.desfecho).toBe('handoff')
  })
})

describe('Portão', () => {
  it('desligado → silêncio registrado', async () => {
    await configurar('desligado')
    const r = await turno([await mensagemDoCliente('oi')])
    expect(r.desfecho).toBe('silencio')
    const [d] = await decisoes()
    expect(d!.portao_motivo).toBe('agente_desligado')
  })
  it('humano assumiu a conversa → o agente cala', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 1, ${USUARIO}, 'em_atendimento', now())`
    const r = await turno([await mensagemDoCliente('oi')])
    expect(r.desfecho).toBe('silencio')
    expect(r.motivo).toBe('humano_assumiu')
  })
  it('orçamento do dia estourado → handoff limite_de_custo', async () => {
    await configurar('autonomo', { orcamento: 1 })
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, custo_centavos)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 'autonomo', 'respondeu', 5)`
    const r = await turno([await mensagemDoCliente('oi')])
    expect(r.desfecho).toBe('handoff')
    expect(r.motivo).toBe('limite_de_custo')
  })
})

describe('Alçada depois do "sim"', () => {
  it('dado pedido confirmado de origem agente e alçada padrão, então avisa o cliente, transfere por acima_da_alcada e cala', async () => {
    await configurar('autonomo')
    const pedidoId = 'b2e20000-dddd-4000-8000-000000000001'
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, origem, total_centavos, total_pecas, confirmado_em)
               VALUES (${T}, ${pedidoId}, ${CONTATO}, ${CONVERSA}, 'confirmado', 'agente', 9980, 2, now())`
    const r = await turno([await mensagemDoCliente('sim')])
    expect(r.desfecho).toBe('handoff')
    expect(r.motivo).toBe('acima_da_alcada')
    expect(enviados[0]).toMatch(/pedido confirmado/i)
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T}`
    expect(a!.estado).toBe('na_fila')
    // Com a conversa na fila, a próxima mensagem não é respondida pelo robô.
    const r2 = await turno([await mensagemDoCliente('e aí?')])
    expect(r2.desfecho).toBe('silencio')
    expect(r2.motivo).toBe('humano_assumiu')
    await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  })
})

describe('Sequência e worker', () => {
  it('dado mensagem nova chegando durante o turno, então a resposta é descartada (superada) e a tarefa volta para a fila', async () => {
    await configurar('autonomo')
    const m1 = await mensagemDoCliente('quero 1 camiseta verde')
    const lento: PortaLlmFerramentas = { nome: 'lento', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar() {
        await mensagemDoCliente('na verdade quero azul')
        return { ok: true, saida: { mensagens: ['Incluí a verde.'], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'lento', latenciaMs: 1, parouPor: 'fim' } }
      } }
    const r = await turno([m1], lento)
    expect(r.desfecho).toBe('superada')
    expect(enviados).toEqual([])
  })

  it('o worker drena a fila: agenda → vence → processa → conclui', async () => {
    await configurar('autonomo')
    const m1 = await mensagemDoCliente('tem camiseta?')
    await comTenantServico(T, (tx) => agendarTurno(tx, { conversaId: CONVERSA, canalId: CANAL, mensagemId: m1, agora: new Date(), atrasoMs: 0 }))
    const r = await processarTarefasDoAgente(dono as never, { llm: new LlmSimulado(), ligacoes, enviar: enviarFalso }, new Date(Date.now() + 10))
    expect(r).toMatchObject({ processadas: 1, respondidas: 1 })
    expect(enviados.length).toBeGreaterThan(0)
    const [t] = await dono<{ estado: string }[]>`SELECT estado FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(t!.estado).toBe('concluida')
    expect(await pegarProximaTarefa(dono as never, new Date(Date.now() + 10))).toBeNull()
  })
})
