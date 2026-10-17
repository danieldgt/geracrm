import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { CatalogoPorta, Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { AVISO_NUMERO_BLOQUEADO } from './numeros-ampliados.js'

/**
 * GUARDRAIL NUMÉRICO AMPLIADO (P7) — o turno de verdade (banco real, WhatsApp
 * falso), com um modelo falso que chama ferramentas e diz o texto do cenário.
 * Cada tipo com e sem fonte; as fontes (ferramenta, política, conhecimento,
 * cliente); e os falsos positivos que NÃO podem barrar resposta.
 */
const T = 'b7b70000-0000-4000-8000-000000000001'
const PV = 'b7b70000-1111-4000-8000-000000000001'
const PLANO = 'b7b70000-3333-4000-8000-000000000001'
const MODELO = 'b7b70000-4444-4000-8000-000000000001'
const CANAL = 'b7b70000-5555-4000-8000-000000000001'
const CONTATO = 'b7b70000-6666-4000-8000-000000000001'
const CONVERSA = 'b7b70000-7777-4000-8000-000000000001'
const SKU = 'b7b70000-9999-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const POLITICAS = 'Entrega em 3 dias úteis para a capital. Pedido mínimo de 6 peças. Pagamento por PIX.'

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never

const catalogo: CatalogoPorta = {
  async buscar() {
    return { itens: [{ produtoId: 'b7b70000-aaaa-4000-8000-000000000001', referencia: 'CAM-010', produto: 'Camiseta', categoria: null, descricao: null,
      skus: [{ skuId: SKU, atributos: { cor: 'verde', tamanho: '42' }, precoCentavos: 4990, saldo: 12 }] }] }
  },
  async detalhar() { return null },
  async precoEEstoque(_c, ids) { return ids.map((skuId) => ({ skuId, situacao: 'cotado' as const, precoCentavos: 4990, saldo: 12 })) },
}
const ligacoes = async (): Promise<Ligacoes> => ({
  catalogo,
  conhecimento: { async buscar() { return { trechos: [{ texto: 'Pagamento à vista no PIX tem 5% de desconto.', fonte: 'Políticas v2' }] } } },
})

/** Modelo falso: chama as ferramentas pedidas (de verdade, pelo registro) e diz `mensagens`. */
function llm(mensagens: string[], chamadas: { nome: string; entrada: unknown }[] = []): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p): Promise<ResultadoLaco> {
      for (const c of chamadas) await p.executar(c.nome, c.entrada)
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, true, ${modo}, ${POLITICAS}, false, false, '{"nome":"Lia","loja":"Loja Números"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = true, politicas = EXCLUDED.politicas`

const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = async (cliente: string, modelo: PortaLlmFerramentas) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente(cliente)]), { llm: modelo, ligacoes, enviar: enviarFalso })
const ultimaDecisao = async () => (await dono<{
  desfecho: string; handoff_motivo: string | null; enviada: boolean
  guardrails: { etapa: string; codigo: string; gravidade: string; acao: string; trecho?: string }[]
  resposta: { mensagens: string[]; original?: { mensagens: string[] } } | null
}[]>`SELECT desfecho, handoff_motivo, enviada, guardrails, resposta FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const marcasP7 = async () => (await ultimaDecisao()).guardrails.filter((g) => g.etapa === 'numeros-ampliados')
const atendimentosAbertos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]!.n

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p7', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p7', 'Atacado') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Números', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Números', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999990707', '5585999990707', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
  // P4: aviso de privacidade VIGENTE para o contato — sem ele o turno autônomo leva a abertura como prefixo.
  await dono`DELETE FROM aviso_privacidade WHERE tenant_id = ${T}`
  await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
             VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${CONVERSA}, ${CANAL}, gen_random_uuid(), 'Esta conversa fica registrada.', 'padrao', 'agente')`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'aviso_privacidade', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Percentual', () => {
  it('dado "10% de desconto" sem ferramenta, então a resposta NÃO sai: vira aviso fixo e handoff por incerteza', async () => {
    await configurar('autonomo')
    const r = await turno('tem desconto pra pagar à vista?', llm(['Claro! Pagando à vista você ganha 10% de desconto.']))
    expect(enviados.join(' ')).not.toContain('10%')
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
    expect(r.desfecho).toBe('handoff')
    const d = await ultimaDecisao()
    expect(d.handoff_motivo).toBe('incerteza')
    expect(d.resposta?.original?.mensagens.join(' ')).toContain('10%')
    expect(await marcasP7()).toEqual([expect.objectContaining({ codigo: 'numero_sem_fonte', gravidade: 'CRITICA', acao: 'substituido', trecho: expect.stringContaining('10%') })])
    expect(await atendimentosAbertos()).toBe(1)
  })
  it('em assistido o mesmo bloqueio vale para a sugestão (nada enviado, marca registrada)', async () => {
    await configurar('assistido')
    await turno('tem desconto?', llm(['Te dou dez por cento de desconto.']))
    expect(enviados).toEqual([])
    const d = await ultimaDecisao()
    expect(d.resposta?.mensagens).toEqual([AVISO_NUMERO_BLOQUEADO])
    expect((await marcasP7())[0]).toMatchObject({ gravidade: 'CRITICA' })
  })
  it('com fonte no conhecimento ("5% no PIX"), o percentual sai', async () => {
    await configurar('autonomo')
    const r = await turno('tem desconto no pix?', llm(['No PIX à vista você tem 5% de desconto.'], [{ nome: 'conhecimento_buscar', entrada: { pergunta: 'desconto pix' } }]))
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toEqual(['No PIX à vista você tem 5% de desconto.'])
    expect(await marcasP7()).toEqual([])
  })
  it('[3ª revisão 1] % sem palavra comercial também bloqueia ("Posso fazer 10%."); "100% original" e composição saem', async () => {
    await configurar('autonomo')
    await turno('consegue melhorar?', llm(['Posso fazer 10%.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
    for (const t of ['agente_decisao', 'agente_sessao', 'atendimento', 'mensagem']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
    enviados.length = 0
    await turno('é original?', llm(['Produto 100% original, 95% algodão e 5% elastano.']))
    expect(enviados).toEqual(['Produto 100% original, 95% algodão e 5% elastano.'])
    expect(await marcasP7()).toEqual([])
  })
  it('[revisão 2] número de referência do catálogo ("CAM-010") não abona "10%"', async () => {
    await configurar('autonomo')
    await turno('tem desconto na camiseta?', llm(['A camiseta está com 10% de desconto.'], [{ nome: 'catalogo_buscar', entrada: { consulta: 'camiseta', limite: null } }]))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
  it('[revisão 7] o percentual que o VENDEDOR humano escreveu é fonte; o que o próprio agente disse antes, não', async () => {
    await configurar('autonomo')
    const saliente = (texto: string, automatica: string | null) => dono`
      INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
      VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, 'saliente', 'texto',
              ${JSON.stringify({ texto, ...(automatica ? { automatica } : {}) })}::text::jsonb, now() - interval '1 minute')`
    await saliente('Para você consigo 15% no fechamento da caixa.', 'agente')
    await turno('e o desconto?', llm(['Mantemos os 15% de desconto.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])

    for (const t of ['agente_decisao', 'agente_sessao', 'atendimento', 'mensagem']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
    enviados.length = 0
    await saliente('Fechado, te dou 15% no fechamento da caixa.', null)
    await turno('e o desconto?', llm(['Mantemos os 15% de desconto.']))
    expect(enviados).toEqual(['Mantemos os 15% de desconto.'])
  })
  it('o percentual dito pelo CLIENTE não é fonte: "vocês dão 10%?" não autoriza "sim, 10%"', async () => {
    await configurar('autonomo')
    await turno('vocês dão 10% pra pedido grande?', llm(['Damos sim, 10% para pedido grande.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
})

describe('Quantidade', () => {
  it('"temos 12 unidades" com o saldo vindo do catálogo sai', async () => {
    await configurar('autonomo')
    await turno('tem camiseta verde?', llm(['Temos 12 unidades da verde.'], [{ nome: 'catalogo_buscar', entrada: { consulta: 'camiseta verde', limite: null } }]))
    expect(enviados).toEqual(['Temos 12 unidades da verde.'])
    expect(await marcasP7()).toEqual([])
  })
  it('[re-revisão 1] grade: "Temos o 42 em estoque" com o tamanho vindo do catálogo sai; "Tamanhos 38, 40 e 42 disponíveis" também', async () => {
    await configurar('autonomo')
    const busca = [{ nome: 'catalogo_buscar', entrada: { consulta: 'camiseta 42', limite: null } }]
    await turno('tem a 42?', llm(['Temos o 42 em estoque.', 'Tamanhos 38, 40 e 42 disponíveis.'], busca))
    expect(enviados).toEqual(['Temos o 42 em estoque.', 'Tamanhos 38, 40 e 42 disponíveis.'])
    expect(await marcasP7()).toEqual([])
  })
  it('[re-revisão 3] eco do prazo de entrega do cliente sai com marca ALTA', async () => {
    await configurar('autonomo')
    await turno('preciso receber em 10 dias', llm(['Anotei que você precisa receber em 10 dias; vou confirmar com a equipe.']))
    expect(enviados).toEqual(['Anotei que você precisa receber em 10 dias; vou confirmar com a equipe.'])
    expect(await marcasP7()).toEqual([expect.objectContaining({ gravidade: 'ALTA', acao: 'registrado' })])
  })
  it('"temos 40 unidades" sem ferramenta é bloqueado', async () => {
    await configurar('autonomo')
    await turno('tem camiseta verde?', llm(['Temos 40 unidades da verde.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
    expect((await ultimaDecisao()).handoff_motivo).toBe('incerteza')
  })
  it('quantidade dita pelo cliente vale ("quero 50 peças" → "separo as 50 peças")', async () => {
    await configurar('autonomo')
    await turno('quero 50 peças da verde', llm(['Perfeito, vou separar as 50 peças para você.']))
    expect(enviados).toEqual(['Perfeito, vou separar as 50 peças para você.'])
    expect(await marcasP7()).toEqual([])
  })
  it('[revisão 3] o cliente não abona número bloqueante: "vocês tem 500 unidades? entrega em 2 dias?"', async () => {
    await configurar('autonomo')
    await turno('vocês tem 500 unidades? entrega em 2 dias?', llm(['Sim, temos 500 unidades em estoque e entregamos em 2 dias.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
    expect((await marcasP7()).map((m) => m.gravidade)).toEqual(['CRITICA', 'CRITICA'])
  })
  it('quantidade sem afirmação de estoque e sem fonte sai, com marca ALTA', async () => {
    await configurar('autonomo')
    await turno('como funciona o atacado?', llm(['No atacado a gente trabalha com caixas de 24 peças.']))
    expect(enviados).toEqual(['No atacado a gente trabalha com caixas de 24 peças.'])
    expect(await marcasP7()).toEqual([expect.objectContaining({ codigo: 'numero_sem_fonte', gravidade: 'ALTA', acao: 'registrado' })])
  })
})

describe('Prazo', () => {
  it('"entrega em 3 dias úteis" com fonte na política sai', async () => {
    await configurar('autonomo')
    await turno('qual o prazo?', llm(['A entrega é em 3 dias úteis.']))
    expect(enviados).toEqual(['A entrega é em 3 dias úteis.'])
    expect(await marcasP7()).toEqual([])
  })
  it('"entrega em 2 dias" sem fonte é bloqueado', async () => {
    await configurar('autonomo')
    await turno('qual o prazo?', llm(['A entrega é em 2 dias.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
  it('"despachamos em 48 horas" sem fonte é bloqueado', async () => {
    await configurar('autonomo')
    await turno('qual o prazo?', llm(['Despachamos em 48 horas.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
  it('prazo dito pelo cliente fora de compromisso pode ser repetido (marca nenhuma)', async () => {
    await configurar('autonomo')
    await turno('vou usar o material daqui 10 dias', llm(['Anotei: você vai usar o material daqui 10 dias.']))
    expect(enviados).toEqual(['Anotei: você vai usar o material daqui 10 dias.'])
    expect(await marcasP7()).toEqual([])
  })
  it('afirmar o prazo do cliente como nosso ("você vai receber em 10 dias") continua bloqueado', async () => {
    await configurar('autonomo')
    await turno('preciso receber em 10 dias', llm(['Você vai receber em 10 dias.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
})

describe('Falsos positivos: nada disto é número de negócio', () => {
  it('hora, data, telefone, CNPJ, CEP, nº do pedido e SKU saem sem marca', async () => {
    await configurar('autonomo')
    const texto = 'Seu pedido 1234 da referência CAM-001 sai dia 15 (15/10), às 14h, para o CEP 60000-000. '
      + 'CNPJ 12.345.678/0001-90 e telefone (85) 99999-0001 conferidos.'
    const r = await turno('confirma os dados?', llm([texto]))
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toEqual([texto])
    expect(await marcasP7()).toEqual([])
  })
})
