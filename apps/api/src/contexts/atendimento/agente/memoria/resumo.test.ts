import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { MAX_RESUMO, materialParaModelo, montarResumoExtrativo, resumirSessao, resumirSessaoComModelo } from './resumo.js'

/**
 * O resumo da sessão: o extrativo (puro) e a gravação incremental por âncora
 * (`resumo_ate_mensagem_id`) contra o Postgres real, mais a variante com
 * modelo injetado — lê, chama fora da transação, grava.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const T = 'c0b50000-0000-4000-8000-000000000001'
const PV = 'c0b50000-1111-4000-8000-000000000001'
const PLANO = 'c0b50000-3333-4000-8000-000000000001'
const MODELO = 'c0b50000-4444-4000-8000-000000000001'
const CANAL = 'c0b50000-7777-4000-8000-000000000001'
const CONTATO = 'c0b50000-5555-4000-8000-000000000001'
const CONVERSA = 'c0b50000-6666-4000-8000-000000000001'
const SESSAO = 'c0b50000-8888-4000-8000-000000000001'
const PEDIDO = 'c0b50000-9999-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let relogio = Date.now() - 600_000
async function mensagem(direcao: 'entrante' | 'saliente', texto: string): Promise<string> {
  const id = randomUUID()
  relogio += 1000
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, ${direcao}, 'texto', ${JSON.stringify({ texto })}::text::jsonb, ${new Date(relogio)})`
  return id
}

const sessaoNoBanco = () => dono<{ resumo: string | null; resumo_ate_mensagem_id: string | null }[]>`
  SELECT resumo, resumo_ate_mensagem_id FROM agente_sessao WHERE tenant_id = ${T} AND id = ${SESSAO}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-memoria-resumo', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-memoria-resumo', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Resumo', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Maria', 'manual', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, estado, fase, slots)
             VALUES (${T}, ${SESSAO}, ${CONVERSA}, ${CANAL}, 'ativa', 'recomendacao', '{"tipoCompra":"revenda"}'::jsonb)`
})

afterAll(async () => {
  for (const t of ['agente_sessao', 'pedido', 'mensagem', 'conversa', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco()
  await dono.end()
})

describe('montarResumoExtrativo (puro)', () => {
  const base = { resumoAnterior: null, pedido: null, slots: {}, fase: 'descoberta', estado: 'ativa', motivoSaida: null }

  it('dado falas, pedido, slots e fase, então junta as últimas 3 intenções do cliente e o resto nomeado', () => {
    const r = montarResumoExtrativo({
      ...base,
      falas: [
        { de: 'cliente', texto: 'oi' }, { de: 'nos', texto: 'olá!' },
        { de: 'cliente', texto: 'quero camisetas pretas' }, { de: 'nos', texto: 'temos' },
        { de: 'cliente', texto: 'tamanho G, 10 unidades' }, { de: 'cliente', texto: 'qual o prazo?' },
      ],
      pedido: { itens: 2, totalCentavos: 29900, estado: 'rascunho' },
      slots: { tipoCompra: 'revenda', volume: '10' },
      fase: 'proposta',
    })
    expect(r).toBe('Cliente: quero camisetas pretas / tamanho G, 10 unidades / qual o prazo?. Pedido: 2 item(ns), R$ 299.00 (rascunho). Sabemos: tipoCompra=revenda, volume=10. Fase: proposta')
    expect(r.length).toBeLessThanOrEqual(MAX_RESUMO)
  })

  it('dado handoff, então diz que foi entregue e por quê', () => {
    const r = montarResumoExtrativo({ ...base, falas: [{ de: 'cliente', texto: 'quero falar com alguém' }], estado: 'entregue', motivoSaida: 'pediu_humano' })
    expect(r).toBe('Cliente: quero falar com alguém. Entregue a humano (pediu_humano)')
  })

  it('dado resumo anterior, então um fio dele vem antes — e o teto de 400 vale sempre', () => {
    const longa = 'palavra '.repeat(80).trim()
    const r = montarResumoExtrativo({
      ...base, resumoAnterior: `Cliente: ${longa}. Fase: descoberta`,
      falas: [{ de: 'cliente', texto: longa }, { de: 'cliente', texto: longa }, { de: 'cliente', texto: longa }],
    })
    expect(r.startsWith('Antes: Cliente: palavra')).toBe(true)
    expect(r.length).toBeLessThanOrEqual(MAX_RESUMO)
    expect(r.endsWith('…')).toBe(true)
  })

  it('dado só falas nossas e um resumo anterior, então mantém o anterior', () => {
    const r = montarResumoExtrativo({ ...base, resumoAnterior: 'Cliente: queria camisetas. Fase: descoberta', falas: [{ de: 'nos', texto: 'alguma dúvida?' }] })
    expect(r).toBe('Cliente: queria camisetas. Fase: descoberta. Fase: descoberta')
  })

  it('materialParaModelo lista as falas, o pedido e os slots de forma legível', () => {
    const m = materialParaModelo({ ...base, falas: [{ de: 'cliente', texto: 'oi' }, { de: 'nos', texto: 'olá' }], slots: { volume: '10' } })
    expect(m).toBe('Cliente: oi\nVendedor: olá\nSem pedido aberto\nSlots: volume=10\nFase: descoberta; estado da sessão: ativa')
  })
})

describe('resumirSessao — incremental por âncora', () => {
  it('dado sessão sem mensagens, então sem_mensagens_novas e nada gravado', async () => {
    expect(await comTenantServico(T, (tx) => resumirSessao(tx, SESSAO))).toEqual({ resultado: 'sem_mensagens_novas' })
    expect((await sessaoNoBanco())[0]).toEqual({ resumo: null, resumo_ate_mensagem_id: null })
  })

  it('dado sessão inexistente, então sessao_nao_encontrada', async () => {
    expect(await comTenantServico(T, (tx) => resumirSessao(tx, randomUUID()))).toEqual({ resultado: 'sessao_nao_encontrada' })
  })

  it('dado mensagens e pedido aberto, então grava o resumo e a âncora na última mensagem', async () => {
    await mensagem('entrante', 'oi, quero camisetas')
    await mensagem('saliente', 'temos várias, qual tamanho?')
    const ultima = await mensagem('entrante', 'tamanho G, umas 10')
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, origem) VALUES (${T}, ${PEDIDO}, ${CONTATO}, ${CONVERSA}, 'rascunho', 'agente')`
    await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
               VALUES (${T}, ${PEDIDO}, 1, 'CAM-G', 'Camiseta G', 10, 2990)`
    await dono`UPDATE pedido SET total_centavos = 29900 WHERE tenant_id = ${T} AND id = ${PEDIDO}`

    const r = await comTenantServico(T, (tx) => resumirSessao(tx, SESSAO))
    expect(r).toMatchObject({ resultado: 'ok', ateMensagemId: ultima, mensagensNovas: 3 })
    const resumo = r.resultado === 'ok' ? r.resumo : ''
    expect(resumo).toBe('Cliente: oi, quero camisetas / tamanho G, umas 10. Pedido: 1 item(ns), R$ 299.00 (rascunho). Sabemos: tipoCompra=revenda. Fase: recomendacao')
    expect((await sessaoNoBanco())[0]).toEqual({ resumo, resumo_ate_mensagem_id: ultima })
  })

  it('dado nada novo desde a âncora, então sem_mensagens_novas; dado mensagem nova, então resume só o que veio depois', async () => {
    expect(await comTenantServico(T, (tx) => resumirSessao(tx, SESSAO))).toEqual({ resultado: 'sem_mensagens_novas' })
    const nova = await mensagem('entrante', 'e o prazo de entrega?')
    const r = await comTenantServico(T, (tx) => resumirSessao(tx, SESSAO))
    expect(r).toMatchObject({ resultado: 'ok', ateMensagemId: nova, mensagensNovas: 1 })
    const resumo = r.resultado === 'ok' ? r.resumo : ''
    expect(resumo.startsWith('Antes: Cliente: oi, quero camisetas')).toBe(true)
    expect(resumo).toMatch(/Cliente: e o prazo de entrega\?/)
    expect(resumo).not.toMatch(/tamanho G, umas 10\. Cliente/)
  })
})

describe('resumirSessaoComModelo — modelo fora da transação', () => {
  it('dado modelo que responde, então grava o texto dele (no teto) e a âncora', async () => {
    const nova = await mensagem('entrante', 'pode ser PIX?')
    const recebido: string[] = []
    const r = await resumirSessaoComModelo(T, SESSAO, async (material) => { recebido.push(material); return 'Cliente quer 10 camisetas G, perguntou prazo e PIX. ' + 'x'.repeat(500) })
    expect(r).toMatchObject({ resultado: 'ok', ateMensagemId: nova })
    expect(recebido[0]).toMatch(/Cliente: pode ser PIX\?/)
    expect(recebido[0]).toMatch(/Resumo anterior: /)
    expect(recebido[0]).toMatch(/Pedido aberto: 1 item\(ns\)/)
    const [s] = await sessaoNoBanco()
    expect(s!.resumo!.startsWith('Cliente quer 10 camisetas G')).toBe(true)
    expect(s!.resumo!.length).toBe(MAX_RESUMO)
    expect(s!.resumo_ate_mensagem_id).toBe(nova)
  })

  it('dado modelo que falha, então cai no extrativo — o resumo nunca fica vazio por causa de rede', async () => {
    const nova = await mensagem('entrante', 'fechado então')
    const r = await resumirSessaoComModelo(T, SESSAO, async () => { throw new Error('rede') })
    expect(r).toMatchObject({ resultado: 'ok', ateMensagemId: nova })
    expect((await sessaoNoBanco())[0]!.resumo).toMatch(/Cliente: fechado então/)
  })

  it('dado outra rodada que gravou no meio do caminho, então conflito e a âncora da outra fica', async () => {
    const nova = await mensagem('entrante', 'manda o resumo')
    const r = await resumirSessaoComModelo(T, SESSAO, async () => {
      // Enquanto o modelo "pensa", outro worker resume e avança a âncora.
      await comTenantServico(T, (tx) => resumirSessao(tx, SESSAO))
      return 'resumo atrasado'
    })
    expect(r).toEqual({ resultado: 'conflito' })
    const [s] = await sessaoNoBanco()
    expect(s!.resumo).not.toBe('resumo atrasado')
    expect(s!.resumo_ate_mensagem_id).toBe(nova)
  })
})
