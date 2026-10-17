import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from './vendedor.js'
import { anotarMemoria } from './memoria/memoria.js'
import { lerContextoAtiva } from './ativas.js'
import { TIPO_ALERTA_LLM } from './pipeline/falha-llm.js'
import type { Tarefa } from './fila.js'
import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from './porta-llm.js'
import type { CatalogoPorta, Ligacoes, PedidoParaLlm, PedidoPorta } from './ferramentas/ligacoes-porta.js'

/**
 * P0c — pendências da integração da onda 1 no turno do vendedor (banco real,
 * WhatsApp falso, modelo falso):
 *   (a) quantidades do pedido aberto são fonte GERAL do guardrail ampliado; a memória do contato
 *       (escrita pelo modelo) só tem peso de fala do cliente — nunca bloqueante, nunca %;
 *   (c) modelo sem preço abre `preco_desconhecido` no próprio turno;
 *   (e) slots ditos no 1º turno com resposta fixa entram na sessão que ela abre;
 *   (h) turno com resposta no formato fecha `agente_llm_indisponivel` (se nenhum OUTRO número falhou há pouco);
 *   (j) escassez só sai com saldo BAIXO (0 < saldo ≤ LIMIAR_ESCASSEZ) de ferramenta de estoque no turno;
 *   (p) fuso inválido gravado no tenant não derruba o turno nem as ativas.
 */
const T = 'c0c00000-0000-4000-8000-000000000001'
const PV = 'c0c00000-1111-4000-8000-000000000001'
const PLANO = 'c0c00000-3333-4000-8000-000000000001'
const MODELO = 'c0c00000-4444-4000-8000-000000000001'
const CANAL = 'c0c00000-5555-4000-8000-000000000001'
const CONTATO = 'c0c00000-6666-4000-8000-000000000001'
const CONVERSA = 'c0c00000-7777-4000-8000-000000000001'
/** Um segundo número do mesmo tenant (alerta de IA é por tenant; modelo é por número). */
const CANAL_B = 'c0c00000-5555-4000-8000-000000000002'
const CONVERSA_B = 'c0c00000-7777-4000-8000-000000000002'
const SKU = 'c0c00000-9999-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never

let saldoDoCatalogo: number | 'desconhecido' | null = 3
const catalogoFalso: CatalogoPorta = {
  async buscar() { return { itens: [] } },
  async detalhar() { return null },
  async precoEEstoque(_ctx, ids) { return ids.map((skuId) => ({ skuId, situacao: 'cotado' as const, precoCentavos: 4990, saldo: saldoDoCatalogo })) },
}
let pedidoAberto: PedidoParaLlm | null = null
const pedidoFalso: PedidoPorta = {
  async ver() { return pedidoAberto },
  async itens() { return { situacao: 'item_nao_encontrado' } },
  async propor() { return { situacao: 'vazio' } },
  async recentes() { return [] },
}
const ligacoes = async (): Promise<Ligacoes> => ({ catalogo: catalogoFalso, pedido: pedidoFalso, conhecimento: { async buscar() { return { trechos: [] } } } })

/** Modelo falso: roda as ferramentas pedidas (pelo registro de verdade) e diz `mensagens`. */
function llm(mensagens: string[], ferramentas: { nome: string; entrada: unknown }[] = [], modelo = 'modelo-sem-preco-p0c'): PortaLlmFerramentas {
  return {
    nome: 'falso-p0c', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
      for (const f of ferramentas) await p.executar(f.nome, f.entrada)
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo, latenciaMs: 1, parouPor: 'fim' } }
    },
  }
}
const naoChamar: PortaLlmFerramentas = {
  nome: 'nao-chamar', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> { throw new Error('a resposta fixa não chama o modelo') },
}

const configurar = (modo: string, orcamento: number | null = null, canal = CANAL) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, orcamento_dia_centavos)
  VALUES (${T}, ${canal}, ${modo !== 'desligado'}, ${modo}, 'Atendimento cordial, sem pressa.', false, false,
          '{"nome":"Lia","loja":"Loja P0c"}'::jsonb, '{}'::jsonb, ${orcamento})
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo, orcamento_dia_centavos = EXCLUDED.orcamento_dia_centavos`

const tarefa = async (texto: string, conversa = CONVERSA, canal = CANAL): Promise<Tarefa> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return { tenant_id: T, id: crypto.randomUUID(), conversa_id: conversa, canal_id: canal, mensagens_ids: [id], tentativas: 1, executar_em: new Date() }
}
const turno = async (texto: string, modelo: PortaLlmFerramentas, extra: Partial<DepsTurno> = {}) =>
  conduzirTurnoVendedor(await tarefa(texto), { llm: modelo, ligacoes, enviar: enviarFalso, ...extra })
const turnoNoB = async (texto: string, modelo: PortaLlmFerramentas) =>
  conduzirTurnoVendedor(await tarefa(texto, CONVERSA_B, CANAL_B), { llm: modelo, ligacoes, enviar: enviarFalso })
/** Modelo que responde FORA do schema (sem `mensagens`). */
const malformado: PortaLlmFerramentas = {
  nome: 'malformado-p0c', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> {
    return { ok: true, saida: { texto: 'oi' }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'modelo-sem-preco-p0c', latenciaMs: 1, parouPor: 'fim' } }
  },
}
const ultimaDecisao = async () => (await dono<{ desfecho: string; guardrails: { etapa: string; codigo: string }[] }[]>`
  SELECT desfecho, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const codigos = async () => (await ultimaDecisao()).guardrails.map((g) => g.codigo)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-vendedor-p0c', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-vendedor-p0c', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Vendedor P0c', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente P0c', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL_B}, 'whatsapp_nao_oficial', 'Loja B', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL_B}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA_B}, ${CANAL_B}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; pedidoAberto = null; saldoDoCatalogo = 3
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'outbox', 'cliente_memoria']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id = ${T}`
  // P4: aviso de privacidade VIGENTE — sem ele o turno autônomo leva a abertura como prefixo.
  await dono`DELETE FROM aviso_privacidade WHERE tenant_id = ${T}`
  await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
             VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${CONVERSA}, ${CANAL}, gen_random_uuid(), 'Esta conversa fica registrada.', 'padrao', 'agente')`
  await configurar('autonomo')
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'outbox', 'cliente_memoria', 'aviso_privacidade', 'conversa', 'contato', 'canal_configuracao', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('(a) fontes de número de fora do laço', () => {
  const comPedido = (quantidade: number) => {
    pedidoAberto = { pedidoId: 'c0c00000-cccc-4000-8000-000000000001', estado: 'rascunho', totalCentavos: 4990 * quantidade,
      itens: [{ seq: 1, descricao: 'Caixa', atributos: {}, quantidade, valorUnitarioCentavos: 4990, subtotalCentavos: 4990 * quantidade }] }
  }

  it('dado pedido aberto com 37 unidades, quando o agente diz "temos 37 unidades", então sai — a quantidade do pedido é fonte', async () => {
    comPedido(37)
    const r = await turno('e o meu pedido?', llm(['Temos 37 unidades separadas no seu pedido.']))
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toEqual(['Temos 37 unidades separadas no seu pedido.'])
    expect(await codigos()).not.toContain('numero_sem_fonte')
  })

  it('dado pedido aberto com 37, quando o agente diz "temos 38 unidades", então bloqueia (fonte não é qualquer número)', async () => {
    comPedido(37)
    const r = await turno('e o meu pedido?', llm(['Temos 38 unidades separadas no seu pedido.']))
    expect(r.desfecho).toBe('handoff')
    expect(enviados.join(' ')).not.toContain('38')
    expect(await codigos()).toContain('numero_sem_fonte')
  })

  it('⚠️ memória NÃO é fonte geral (o modelo escreve nela): "entregamos em 6 dias" vindo da memória é BLOQUEADO', async () => {
    await comTenantServico(T, (tx) => anotarMemoria(tx, { contatoId: CONTATO, tipo: 'contexto', fato: 'entrega combinada em 6 dias' }))
    const r = await turno('e a entrega?', llm(['Entregamos em 6 dias, como combinamos.']))
    expect(r.desfecho).toBe('handoff')
    expect(enviados.join(' ')).not.toContain('6 dias')
    expect(await codigos()).toContain('numero_sem_fonte')
  })

  it('memória vale como fala do CLIENTE: abona número NÃO bloqueante (sem marca)', async () => {
    const diz = ['Posso separar 40 caixas para você.']
    await turno('pode separar?', llm(diz))
    expect(await codigos()).toContain('numero_sem_fonte') // sem memória: ALTA registrada
    enviados.length = 0
    await comTenantServico(T, (tx) => anotarMemoria(tx, { contatoId: CONTATO, tipo: 'contexto', fato: 'costuma levar 40 caixas por mês' }))
    await turno('pode separar?', llm(diz))
    expect(enviados).toEqual(diz)
    expect(await codigos()).not.toContain('numero_sem_fonte')
  })

  it('⚠️ memória nunca abona %: "pediu 15% de desconto" não abona "15% de desconto"', async () => {
    await comTenantServico(T, (tx) => anotarMemoria(tx, { contatoId: CONTATO, tipo: 'objecao', fato: 'pediu 15% de desconto na última compra' }))
    const r = await turno('e o desconto?', llm(['Consigo 15% de desconto para você.']))
    expect(r.desfecho).toBe('handoff')
    expect(enviados.join(' ')).not.toContain('15%')
    expect(await codigos()).toContain('numero_sem_fonte')
  })
})

describe('(c) custo do laço com o tenant', () => {
  it('dado modelo sem preço no catálogo, quando o turno roda, então o alerta preco_desconhecido do tenant abre já', async () => {
    // ⚠️ Modelo exclusivo deste caso: o aviso é deduplicado por processo (tenant × modelo).
    await turno('oi', llm(['Oi! Como posso ajudar?'], [], 'modelo-sem-preco-p0c-caso-c'))
    const alertas = await dono<{ tipo: string }[]>`SELECT tipo FROM alerta WHERE tenant_id = ${T} AND resolvido_em IS NULL`
    expect(alertas.map((a) => a.tipo)).toContain('preco_desconhecido')
  })

  it('simulação não abre alerta de preço (o painel é da operação real)', async () => {
    await turno('oi', llm(['Oi! Como posso ajudar?'], [], 'modelo-sem-preco-p0c-simulacao'), { simulacao: true })
    expect(await dono`SELECT 1 FROM alerta WHERE tenant_id = ${T} AND tipo = 'preco_desconhecido'`).toHaveLength(0)
  })
})

describe('(e) slots no 1º turno com resposta fixa', () => {
  it('dado "você é um robô? preciso de 80 caixas" no 1º turno, então a resposta fixa sai e o volume fica na sessão que ela abriu', async () => {
    const r = await turno('Você é um robô? Preciso de 80 caixas até sexta', naoChamar)
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toHaveLength(1)
    const [s] = await dono<{ turnos: number; estado_agente: { perguntas?: { respondidos?: Record<string, string> }; gatilhos?: { perguntouRobo?: boolean } } }[]>`
      SELECT turnos, estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.turnos).toBe(1)
    expect(s!.estado_agente.gatilhos?.perguntouRobo).toBe(true)
    expect(s!.estado_agente.perguntas?.respondidos).toMatchObject({ volume: '80 caixas', prazo: 'até sexta' })
  })

  it('em simulação (sem efeito) nada é gravado', async () => {
    const r = await turno('Você é um robô? Preciso de 80 caixas', naoChamar, { simulacao: true })
    expect(r.desfecho).not.toBe('falha')
    expect(await dono`SELECT 1 FROM agente_sessao WHERE tenant_id = ${T}`).toHaveLength(0)
  })
})

describe('(h) alerta de IA indisponível fecha quando o modelo volta', () => {
  const abrirAlerta = () => dono`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem) VALUES (${T}, gen_random_uuid(), ${TIPO_ALERTA_LLM}, 'critico', 'IA do agente falhou')`
  const abertos = async () => (await dono<{ n: number }[]>`
    SELECT count(*)::int AS n FROM alerta WHERE tenant_id = ${T} AND tipo = ${TIPO_ALERTA_LLM} AND resolvido_em IS NULL`)[0]!.n

  it('dado alerta aberto, quando um turno tem resposta do modelo, então o alerta é resolvido', async () => {
    await abrirAlerta()
    await turno('oi', llm(['Oi! Como posso ajudar?']))
    expect(await abertos()).toBe(0)
  })

  it('simulação não mexe no painel: o alerta continua aberto', async () => {
    await abrirAlerta()
    await turno('oi', llm(['Oi! Como posso ajudar?']), { simulacao: true })
    expect(await abertos()).toBe(1)
  })

  it('⚠️ modelo sempre malformado não faz o alerta piscar: segue o MESMO alerta aberto, nunca fechado', async () => {
    await abrirAlerta()
    await turno('oi', malformado)
    await turno('oi de novo', malformado)
    const todos = await dono<{ resolvido_em: Date | null }[]>`SELECT resolvido_em FROM alerta WHERE tenant_id = ${T} AND tipo = ${TIPO_ALERTA_LLM}`
    expect(todos).toEqual([{ resolvido_em: null }])
  })

  it('⚠️ número B respondendo NÃO fecha o alerta do número A em falha; A respondendo fecha', async () => {
    await configurar('autonomo', null, CANAL_B)
    await turno('oi', malformado) // A falha → alerta aberto
    expect(await abertos()).toBe(1)
    await turnoNoB('oi', llm(['Oi! Como posso ajudar?']))
    expect(await abertos()).toBe(1)
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}` // a falha em autônomo entregou A à fila
    await turno('oi', llm(['Oi! Como posso ajudar?']))
    expect(await abertos()).toBe(0)
  })
})

describe('(j) escassez só com saldo BAIXO consultado no turno', () => {
  const ESCASSEZ = 'Restam poucas unidades em estoque segundo o sistema. Quer que eu reserve?'
  const consultaSaldo = [{ nome: 'catalogo_preco_estoque', entrada: { skuIds: [SKU] } }]

  it.each([[0, 'esgotado'], [500, 'saldo alto']])('dado saldo %i (%s), então "poucas unidades" é cortada — a frase seria falsa', async (saldo) => {
    saldoDoCatalogo = saldo
    await turno('ainda tem?', llm([ESCASSEZ], consultaSaldo))
    expect(enviados).toEqual(['Quer que eu reserve?'])
    expect(await codigos()).toContain('escassez_sem_fonte')
  })

  it('dado saldo BAIXO (3) devolvido por catalogo_preco_estoque, então "Restam poucas unidades" sai', async () => {
    saldoDoCatalogo = 3
    await turno('ainda tem?', llm([ESCASSEZ], consultaSaldo))
    expect(enviados).toEqual([ESCASSEZ])
    expect(await codigos()).not.toContain('escassez_sem_fonte')
  })

  it('dado saldo "desconhecido" (ERP não informou), então a frase de escassez sai do texto', async () => {
    saldoDoCatalogo = 'desconhecido'
    await turno('ainda tem?', llm([ESCASSEZ], consultaSaldo))
    expect(enviados).toEqual(['Quer que eu reserve?'])
    expect(await codigos()).toContain('escassez_sem_fonte')
  })

  it('sem ferramenta de estoque no turno, a escassez é vetada', async () => {
    await turno('ainda tem?', llm([ESCASSEZ]))
    expect(enviados).toEqual(['Quer que eu reserve?'])
    expect(await codigos()).toContain('escassez_sem_fonte')
  })
})

describe('(p) fuso inválido gravado no tenant', () => {
  it('com orçamento diário (custo do dia no fuso), o turno não quebra', async () => {
    await dono`UPDATE tenant SET fuso = 'Brasil/Ceara' WHERE id = ${T}`
    await configurar('autonomo', 1000)
    const r = await turno('oi', llm(['Oi! Como posso ajudar?']))
    expect(r.desfecho).toBe('respondeu')
  })

  it('as ativas leem o fuso saneado', async () => {
    await dono`UPDATE tenant SET fuso = 'Brasil/Ceara' WHERE id = ${T}`
    const c = await comTenantServico(T, (tx) => lerContextoAtiva(tx, { conversaId: CONVERSA, agora: new Date() }))
    expect(c?.fuso).toBe('America/Sao_Paulo')
  })
})

describe('(t) "enviada" é o que o gateway aceitou', () => {
  it('turno autônomo que conclui SEM mensagem (resposta fixa vazia) grava enviada = false', async () => {
    const semTexto = { nome: 'gatilhos-falso', async executar() { return { tipo: 'resposta_fixa' as const, mensagens: [] } } }
    await turno('pare', naoChamar, { pipeline: { gatilhos: semTexto } })
    expect(enviados).toEqual([])
    const [d] = await dono<{ enviada: boolean; modo: string }[]>`SELECT enviada, modo FROM agente_decisao WHERE tenant_id = ${T}`
    expect(d).toEqual({ enviada: false, modo: 'autonomo' })
  })

  it('com mensagem aceita, enviada = true', async () => {
    await turno('oi', llm(['Oi! Como posso ajudar?']))
    const [d] = await dono<{ enviada: boolean }[]>`SELECT enviada FROM agente_decisao WHERE tenant_id = ${T}`
    expect(d!.enviada).toBe(true)
  })
})

describe('(u) o texto fixo do turno chega às etapas pós-modelo (isento das regras de qualidade)', () => {
  const espia = (vistas: (readonly string[] | undefined)[]) => ({
    nome: 'qualidade-espia',
    async executar(_ctx: unknown, e: { mensagens: readonly string[]; mensagensFixas?: readonly string[] | undefined }) {
      vistas.push(e.mensagensFixas)
      return { mensagens: e.mensagens, guardrails: [] }
    },
  }) as never

  it('sem aviso vigente, a abertura (prefixo) vai em mensagensFixas — e é ela que sai antes da resposta', async () => {
    await dono`DELETE FROM aviso_privacidade WHERE tenant_id = ${T}`
    const vistas: (readonly string[] | undefined)[] = []
    await turno('oi', llm(['Como posso ajudar?']), { pipeline: { qualidade: espia(vistas) } })
    expect(vistas).toHaveLength(1)
    expect(vistas[0]).toHaveLength(1)
    expect(enviados[0]).toBe(vistas[0]![0])
    expect(enviados.at(-1)).toBe('Como posso ajudar?')
  })

  it('com aviso vigente (sem abertura), mensagensFixas vem vazio', async () => {
    const vistas: (readonly string[] | undefined)[] = []
    await turno('oi', llm(['Como posso ajudar?']), { pipeline: { qualidade: espia(vistas) } })
    expect(vistas).toEqual([[]])
  })
})
