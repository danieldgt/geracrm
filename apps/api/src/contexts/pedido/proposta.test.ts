import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import type { ResultadoEnvioTexto } from '../atendimento/envio-conversa.js'
import { confirmarPedidoPorResposta } from './confirmacao-pedido.js'
import { HORAS_VALIDADE_PROPOSTA, MARCADOR_PROPOSTA, proporPedido, type FuncaoEnvio } from './proposta.js'

/**
 * PROPOR-E-CONFIRMAR (ADR-027): a proposta carimba a versão do conteúdo e o
 * "sim" só confirma essa versão. Envio por remetente FALSO: a Meta nunca é
 * tocada em teste.
 */
const T = 'f4a20000-0000-4000-8000-000000000001'
const PV = 'f4a20000-1111-4000-8000-000000000001'
const PLANO = 'f4a20000-3333-4000-8000-000000000001'
const MODELO = 'f4a20000-4444-4000-8000-000000000001'
const C1 = 'f4a20000-6666-4000-8000-000000000001'
const CANAL = 'f4a20000-7777-4000-8000-000000000001'
const CONV = 'f4a20000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const comoT = <X>(fn: Parameters<typeof comTenantServico<X>>[1]) => comTenantServico(T, fn)
const AGORA = new Date('2026-09-01T12:00:00Z')
const horas = (h: number) => new Date(AGORA.getTime() + h * 3_600_000)

/** Remetente falso: registra o que seria enviado e responde o que o teste manda. */
function remetente(resposta: ResultadoEnvioTexto = { ok: true, conversaId: CONV, mensagemId: randomUUID() }) {
  const enviados: { conversaId: string; texto: string; remetente: string | null; marcador?: string }[] = []
  const enviar: FuncaoEnvio = async (_t, conversaId, texto, remetenteNome, _agora, opcoes) => {
    enviados.push({ conversaId, texto, remetente: remetenteNome, ...(opcoes.marcador ? { marcador: opcoes.marcador } : {}) })
    return resposta
  }
  return { enviar, enviados }
}

async function rascunhoNaConversa(itens: { desc: string; qtd: number; valor: number }[] = [{ desc: 'Camisa Polo', qtd: 2, valor: 5_000 }]): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, origem) VALUES (${T}, ${id}, ${C1}, ${CONV}, 'rascunho', 'agente')`
  let seq = 0
  for (const i of itens) {
    seq += 1
    await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
               VALUES (${T}, ${id}, ${seq}, ${'SKU-' + seq}, ${i.desc}, ${i.qtd}, ${i.valor})`
  }
  await dono`UPDATE pedido SET total_centavos = (SELECT coalesce(sum(quantidade * valor_unitario_centavos), 0) FROM pedido_item WHERE pedido_id = ${id}),
                               total_pecas = (SELECT coalesce(sum(quantidade), 0) FROM pedido_item WHERE pedido_id = ${id}),
                               versao_conteudo = ${itens.length}
              WHERE id = ${id}`
  return id
}

const propostas = (id: string) => dono<{ versao_conteudo: number; vigente: boolean; confirmada_em: Date | null; confirmada_por: string | null; expira_em: Date; total_centavos: string }[]>`
  SELECT versao_conteudo, vigente, confirmada_em, confirmada_por, expira_em, total_centavos::text
    FROM pedido_proposta WHERE tenant_id = ${T} AND pedido_id = ${id} ORDER BY criado_em`
const estadoDe = async (id: string) => (await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE id = ${id}`)[0]!.estado

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-proposta', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-proposta', 'Moda') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Proposta', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Moda') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Maria Silva', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES (${T}, ${CONV}, ${CANAL}, ${C1}) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`UPDATE perfil_vertical SET regras_pedido = '{}'::jsonb WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('proporPedido', () => {
  it('dado rascunho com itens, quando propõe, então envia o resumo, grava a proposta e espera o SIM', async () => {
    const id = await rascunhoNaConversa()
    const { enviar, enviados } = remetente()
    const r = await proporPedido(T, id, AGORA, { enviar })
    expect(r.tipo).toBe('ok')
    if (r.tipo !== 'ok') return
    expect(r.totalCentavos).toBe(10_000)
    expect(r.expiraEm).toEqual(horas(HORAS_VALIDADE_PROPOSTA))
    expect(r.resumo).toContain('Olá, Maria!')
    expect(r.resumo).toContain('2× Camisa Polo')
    // Enviado pelo gateway, com o marcador do sistema e sem assinatura humana.
    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toMatchObject({ conversaId: CONV, remetente: null, marcador: MARCADOR_PROPOSTA })
    expect(enviados[0]!.texto).toBe(r.resumo)
    // Estado + proposta no mesmo commit.
    expect(await estadoDe(id)).toBe('aguardando_confirmacao')
    const ps = await propostas(id)
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ versao_conteudo: 1, vigente: true, confirmada_em: null, total_centavos: '10000' })
  })

  it('propor de novo invalida a proposta anterior — só a nova é vigente', async () => {
    const id = await rascunhoNaConversa()
    await proporPedido(T, id, AGORA, remetente())
    const r2 = await proporPedido(T, id, horas(1), remetente())
    expect(r2.tipo).toBe('ok')
    const ps = await propostas(id)
    expect(ps.map((p) => p.vigente)).toEqual([false, true])
    expect(await estadoDe(id)).toBe('aguardando_confirmacao')
  })

  it('⚠️ envio recusado: o pedido NÃO muda e nenhuma proposta nasce', async () => {
    const id = await rascunhoNaConversa()
    const r = await proporPedido(T, id, AGORA, remetente({ ok: false, classe: 'recusa', motivo: 'janela_fechada' }))
    expect(r).toMatchObject({ tipo: 'envio_recusado', motivo: 'janela_fechada', classe: 'recusa', conversaId: CONV })
    expect(await estadoDe(id)).toBe('rascunho')
    expect(await propostas(id)).toEqual([])
  })

  it('vazio, sem conversa, inexistente e não-rascunho são nomeados', async () => {
    const vazio = await rascunhoNaConversa([])
    expect(await proporPedido(T, vazio, AGORA, remetente())).toEqual({ tipo: 'vazio' })
    const semConversa = randomUUID()
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado) VALUES (${T}, ${semConversa}, ${C1}, 'rascunho')`
    expect(await proporPedido(T, semConversa, AGORA, remetente())).toEqual({ tipo: 'sem_conversa' })
    expect(await proporPedido(T, randomUUID(), AGORA, remetente())).toEqual({ tipo: 'nao_encontrado' })
    const efetivado = await rascunhoNaConversa()
    await dono`UPDATE pedido SET estado = 'efetivado' WHERE id = ${efetivado}`
    expect(await proporPedido(T, efetivado, AGORA, remetente())).toEqual({ tipo: 'nao_rascunho', estado: 'efetivado' })
  })

  it('regra comercial violada (PED-05) bloqueia ANTES de enviar, com o que falta', async () => {
    await dono`UPDATE perfil_vertical SET regras_pedido = '{"minimo_pecas": 10}'::jsonb WHERE tenant_id = ${T}`
    const id = await rascunhoNaConversa() // 2 peças
    const { enviar, enviados } = remetente()
    const r = await proporPedido(T, id, AGORA, { enviar })
    expect(r).toMatchObject({ tipo: 'regras', violacao: { tipo: 'abaixo_do_minimo', faltam: { pecas: 8 } } })
    expect(enviados).toHaveLength(0)
    expect(await estadoDe(id)).toBe('rascunho')
  })
})

describe('⚠️ O "sim" só confirma a proposta da versão atual (ADR-027)', () => {
  it('dado proposta enviada, quando o cliente diz sim, então confirma e carimba a proposta', async () => {
    const id = await rascunhoNaConversa()
    await proporPedido(T, id, AGORA, remetente())
    const r = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(2)))
    expect(r).toEqual({ tipo: 'confirmado', pedidoId: id })
    expect(await estadoDe(id)).toBe('confirmado')
    const [p] = await propostas(id)
    expect(p!.confirmada_por).toBe('cliente')
    expect(p!.confirmada_em).toEqual(horas(2))
  })

  it('⚠️ dado item alterado DEPOIS do envio, quando o cliente diz sim, então proposta_desatualizada e nada confirma', async () => {
    const id = await rascunhoNaConversa()
    await proporPedido(T, id, AGORA, remetente())
    // Qualquer caminho que mude o conteúdo incrementa a versão (recalcularTotais).
    await dono`UPDATE pedido SET versao_conteudo = versao_conteudo + 1, total_centavos = 15000 WHERE id = ${id}`
    const r = await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(1)))
    expect(r).toEqual({ tipo: 'proposta_desatualizada', pedidoId: id })
    expect(await estadoDe(id)).toBe('aguardando_confirmacao')
    expect((await propostas(id))[0]!.confirmada_em).toBeNull()
    // Propor de novo (nova versão) e o sim volta a valer.
    await proporPedido(T, id, horas(1), remetente())
    expect(await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(2)))).toEqual({ tipo: 'confirmado', pedidoId: id })
  })

  it('proposta expirada (24h) não confirma — quem confirma aí é uma pessoa', async () => {
    const id = await rascunhoNaConversa()
    await proporPedido(T, id, AGORA, remetente())
    expect(await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(23)))).toEqual({ tipo: 'confirmado', pedidoId: id })
    const outro = await rascunhoNaConversa()
    await proporPedido(T, outro, AGORA, remetente())
    expect(await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(25)))).toEqual({ tipo: 'fora_da_janela', pedidoId: outro })
    expect(await estadoDe(outro)).toBe('aguardando_confirmacao')
  })

  it('pedido SEM proposta (fluxo humano anterior) confirma como antes', async () => {
    const id = await rascunhoNaConversa()
    await dono`UPDATE pedido SET estado = 'aguardando_confirmacao', resumo_enviado_em = ${AGORA} WHERE id = ${id}`
    expect(await comoT((tx) => confirmarPedidoPorResposta(tx, CONV, 'sim', horas(1)))).toEqual({ tipo: 'confirmado', pedidoId: id })
  })
})
