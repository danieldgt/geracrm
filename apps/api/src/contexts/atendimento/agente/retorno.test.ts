import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../db/index.js'
import {
  agendarRetorno, cancelarRetornosDaConversa, processarRetornos, textoDoRetorno,
  CADENCIA_RETORNO_MS, MARCADOR_RETORNO, MAX_TENTATIVAS_RETORNO,
} from './retorno.js'
import { ingerirMensagemEntrante } from '../ingestao-mensagem.js'
import { proporPedido } from '../../pedido/proposta.js'
import type { ResultadoEnvioTexto } from '../envio-conversa.js'

/**
 * O retorno do agente (follow-up, R5): agenda/reagenda, cancela quando o
 * cliente escreve, envia pelo gateway em modo autônomo com cadência 1h → 24h →
 * 72h, e vira `recusado` quando o gateway recusa. Banco real; WhatsApp falso.
 */
const T = 'c4d40000-0000-4000-8000-000000000001'
const PV = 'c4d40000-1111-4000-8000-000000000001'
const PLANO = 'c4d40000-3333-4000-8000-000000000001'
const MODELO = 'c4d40000-4444-4000-8000-000000000001'
const CANAL = 'c4d40000-5555-4000-8000-000000000001'
const CONTATO = 'c4d40000-6666-4000-8000-000000000001'
const CONVERSA = 'c4d40000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const H = 3_600_000

interface Envio { conversaId: string; texto: string; opcoes: Record<string, unknown> }
let enviados: Envio[] = []
let respostaDoEnvio: () => ResultadoEnvioTexto = () => ({ ok: true, conversaId: CONVERSA, mensagemId: randomUUID() })
const enviarFalso = (async (_t: string, conversaId: string, texto: string, _n: string | null, _a: Date, opcoes: Record<string, unknown>) => {
  enviados.push({ conversaId, texto, opcoes })
  return respostaDoEnvio()
}) as never

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`
const pedido = async (estado: string, itens = 1, conversaId = CONVERSA): Promise<string> => {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, origem, total_centavos, total_pecas)
             VALUES (${T}, ${id}, ${CONTATO}, ${conversaId}, ${estado}, 'agente', ${4990 * itens}, ${itens})`
  for (let seq = 1; seq <= itens; seq++) {
    await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
               VALUES (${T}, ${id}, ${seq}, ${'SKU-' + seq}, 'Camiseta', 1, 4990)`
  }
  return id
}
const agendar = (motivo: 'proposta_sem_resposta' | 'carrinho_abandonado' | 'combinado', executarEm: Date, extra: Record<string, unknown> = {}) =>
  comTenantServico(T, (tx) => agendarRetorno(tx, { conversaId: CONVERSA, canalId: CANAL, motivo, executarEm, ...extra }))
const retornos = () => dono<{ id: string; motivo: string; estado: string; tentativa: number; executar_em: Date; detalhe: string | null }[]>`
  SELECT id, motivo, estado, tentativa, executar_em, detalhe FROM agente_retorno WHERE tenant_id = ${T} ORDER BY criado_em, tentativa`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-retorno', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-retorno', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Retorno', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados = []
  respostaDoEnvio = () => ({ ok: true, conversaId: CONVERSA, mensagemId: randomUUID() })
  await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido_proposta WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T} AND id <> ${CONVERSA}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T} AND id <> ${CONTATO}`
  await dono`UPDATE conversa SET ultima_entrante_em = NULL WHERE tenant_id = ${T}`
  await configurar('autonomo')
})
afterAll(async () => {
  for (const t of ['agente_retorno', 'agente_tarefa', 'agente_config', 'atendimento', 'pedido_proposta', 'pedido', 'mensagem', 'mensagem_id_externo', 'outbox', 'conversa', 'contato_telefone', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('Agendar e cancelar', () => {
  it('uma pendente por (conversa, motivo): agendar de novo REAGENDA em vez de empilhar', async () => {
    const a = await agendar('proposta_sem_resposta', new Date(Date.now() + H))
    const b = await agendar('proposta_sem_resposta', new Date(Date.now() + 2 * H))
    expect(a).toMatchObject({ reagendado: false })
    expect(b).toMatchObject({ retornoId: (a as { retornoId: string }).retornoId, reagendado: true })
    const linhas = await retornos()
    expect(linhas).toHaveLength(1)
    expect(linhas[0]!.executar_em.getTime()).toBeGreaterThan(Date.now() + 1.5 * H)
    // Outro motivo convive.
    await agendar('carrinho_abandonado', new Date(Date.now() + H))
    expect(await retornos()).toHaveLength(2)
  })

  it('canal_id é resolvido pela conversa quando omitido; conversa inexistente é resultado nomeado', async () => {
    const r = await comTenantServico(T, (tx) => agendarRetorno(tx, { conversaId: CONVERSA, motivo: 'combinado', executarEm: new Date() }))
    expect(r.retornoId).toBeTruthy()
    const [l] = await dono<{ canal_id: string }[]>`SELECT canal_id FROM agente_retorno WHERE tenant_id = ${T}`
    expect(l!.canal_id).toBe(CANAL)
    const x = await comTenantServico(T, (tx) => agendarRetorno(tx, { conversaId: randomUUID(), motivo: 'combinado', executarEm: new Date() }))
    expect(x).toEqual({ retornoId: null, motivo: 'conversa_inexistente' })
  })

  it('cancelarRetornosDaConversa cancela só os pendentes, com o motivo', async () => {
    await agendar('proposta_sem_resposta', new Date(Date.now() + H))
    await agendar('carrinho_abandonado', new Date(Date.now() + H))
    const n = await comTenantServico(T, (tx) => cancelarRetornosDaConversa(tx, CONVERSA))
    expect(n).toBe(2)
    expect((await retornos()).map((r) => [r.estado, r.detalhe])).toEqual([['cancelado', 'cliente_escreveu'], ['cancelado', 'cliente_escreveu']])
    expect(await comTenantServico(T, (tx) => cancelarRetornosDaConversa(tx, CONVERSA))).toBe(0)
  })

  it('o cliente escrevendo de novo (ingestão) cancela os retornos da conversa, no mesmo commit', async () => {
    const entrante = (id: string) => ({ deE164: '5585988880011', idExterno: id, tipo: 'texto' as const, texto: 'oi', recebidaEm: new Date() })
    const primeira = await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, CANAL, entrante('ret-1')))
    if (!primeira.ok) throw new Error(primeira.motivo)
    await comTenantServico(T, (tx) => agendarRetorno(tx, { conversaId: primeira.conversaId, motivo: 'carrinho_abandonado', executarEm: new Date(Date.now() + H) }))
    await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, CANAL, entrante('ret-2')))
    const [l] = await dono<{ estado: string; detalhe: string }[]>`SELECT estado, detalhe FROM agente_retorno WHERE tenant_id = ${T} AND conversa_id = ${primeira.conversaId}`
    expect(l).toEqual({ estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })

  it('propor o pedido agenda o primeiro retorno (1h) — a única costura em pedido/', async () => {
    const pedidoId = await pedido('rascunho', 2)
    const agora = new Date()
    const r = await proporPedido(T, pedidoId, agora, { enviar: enviarFalso, remetenteNome: null })
    expect(r.tipo).toBe('ok')
    const [l] = await retornos()
    expect(l).toMatchObject({ motivo: 'proposta_sem_resposta', estado: 'pendente', tentativa: 1 })
    expect(l!.executar_em.getTime()).toBe(agora.getTime() + CADENCIA_RETORNO_MS[0]!)
  })
})

describe('Processar os vencidos', () => {
  it('dado proposta sem resposta vencida e agente autônomo, quando processa, então envia UM texto pelo gateway como disparo e agenda o passo seguinte (24h)', async () => {
    await pedido('aguardando_confirmacao')
    const agora = new Date()
    await agendar('proposta_sem_resposta', new Date(agora.getTime() - 1000))
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T }, agora)
    expect(r).toMatchObject({ vencidos: 1, enviados: 1, cancelados: 0, recusados: 0 })

    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toMatchObject({ conversaId: CONVERSA, texto: textoDoRetorno('proposta_sem_resposta', 1, null), opcoes: { marcador: MARCADOR_RETORNO, ehDisparo: true } })
    expect(enviados[0]!.texto).not.toMatch(/\d/)

    const linhas = await retornos()
    expect(linhas).toHaveLength(2)
    expect(linhas[0]).toMatchObject({ estado: 'enviado', tentativa: 1 })
    expect(linhas[1]).toMatchObject({ estado: 'pendente', tentativa: 2 })
    expect(linhas[1]!.executar_em.getTime()).toBe(agora.getTime() + CADENCIA_RETORNO_MS[1]!)
  })

  it('cadência 1h → 24h → 72h: a terceira tentativa é a última', async () => {
    await pedido('aguardando_confirmacao')
    let agora = new Date()
    await agendar('proposta_sem_resposta', new Date(agora.getTime() - 1000))
    for (let passo = 1; passo <= MAX_TENTATIVAS_RETORNO; passo++) {
      const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T }, agora)
      expect(r.enviados).toBe(1)
      expect(enviados[passo - 1]!.texto).toBe(textoDoRetorno('proposta_sem_resposta', passo, null))
      agora = new Date(agora.getTime() + (CADENCIA_RETORNO_MS[passo] ?? 0) + 1000)
    }
    const linhas = await retornos()
    expect(linhas.map((l) => [l.tentativa, l.estado])).toEqual([[1, 'enviado'], [2, 'enviado'], [3, 'enviado']])
    expect(await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T }, agora)).toMatchObject({ vencidos: 0 })
  })

  it('não vencido não é processado', async () => {
    await pedido('aguardando_confirmacao')
    await agendar('proposta_sem_resposta', new Date(Date.now() + H))
    expect(await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })).toMatchObject({ vencidos: 0 })
    expect(enviados).toEqual([])
  })

  it('gateway recusa (janela fechada no oficial, opt-out, pausa) → recusado com o motivo, sem novo passo e sem forçar template', async () => {
    await pedido('aguardando_confirmacao')
    respostaDoEnvio = () => ({ ok: false, classe: 'recusa', motivo: 'janela_fechada', conversaId: CONVERSA })
    await agendar('proposta_sem_resposta', new Date(Date.now() - 1000))
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(r).toMatchObject({ recusados: 1, enviados: 0 })
    const linhas = await retornos()
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ estado: 'recusado', detalhe: 'janela_fechada' })
  })

  it('falha de transporte reagenda a MESMA linha para daqui a pouco', async () => {
    await pedido('aguardando_confirmacao')
    respostaDoEnvio = () => ({ ok: false, classe: 'transporte', motivo: 'indisponivel', conversaId: CONVERSA })
    const agora = new Date()
    await agendar('proposta_sem_resposta', new Date(agora.getTime() - 1000))
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T }, agora)
    expect(r).toMatchObject({ reagendados: 1 })
    const [l] = await retornos()
    expect(l).toMatchObject({ estado: 'pendente', tentativa: 1, detalhe: 'transporte: indisponivel' })
    expect(l!.executar_em.getTime()).toBeGreaterThan(agora.getTime())
  })

  it('cliente escreveu depois de agendado → cancelado sem enviar (cinto e suspensório da ingestão)', async () => {
    await pedido('aguardando_confirmacao')
    await agendar('proposta_sem_resposta', new Date(Date.now() - 1000))
    await dono`UPDATE conversa SET ultima_entrante_em = now() + interval '1 second' WHERE tenant_id = ${T} AND id = ${CONVERSA}`
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(r).toMatchObject({ cancelados: 1 })
    expect(enviados).toEqual([])
    expect((await retornos())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })

  it('agente em sombra/assistido/desligado → cancelado com o modo (só o autônomo fala sozinho)', async () => {
    await pedido('aguardando_confirmacao')
    await configurar('sombra')
    await agendar('proposta_sem_resposta', new Date(Date.now() - 1000))
    await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(enviados).toEqual([])
    expect((await retornos())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'modo:sombra' })
  })

  it('atendimento humano aberto cala o retorno', async () => {
    await pedido('aguardando_confirmacao')
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado) VALUES (${T}, ${randomUUID()}, ${CONVERSA}, ${CANAL}, 440001, 'na_fila')`
    await agendar('proposta_sem_resposta', new Date(Date.now() - 1000))
    await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(enviados).toEqual([])
    expect((await retornos())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'humano_atendendo' })
  })

  it('o motivo deixou de existir (pedido já confirmado) → cancelado', async () => {
    await pedido('confirmado')
    await agendar('proposta_sem_resposta', new Date(Date.now() - 1000))
    await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(enviados).toEqual([])
    expect((await retornos())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'sem_proposta_pendente' })
  })

  it('carrinho abandonado: só envia se o rascunho ainda tem itens', async () => {
    await pedido('rascunho', 0)
    await agendar('carrinho_abandonado', new Date(Date.now() - 1000))
    await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(enviados).toEqual([])
    expect((await retornos())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'sem_rascunho_com_itens' })

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await pedido('rascunho', 2)
    await agendar('carrinho_abandonado', new Date(Date.now() - 1000))
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(r.enviados).toBe(1)
    expect(enviados[0]!.texto).toBe(textoDoRetorno('carrinho_abandonado', 1, null))
  })

  it('combinado: usa o texto gravado (ou o padrão) e não depende de pedido', async () => {
    await agendar('combinado', new Date(Date.now() - 1000), { texto: 'Oi! Como combinamos, voltei para falar das camisetas.' })
    const r = await processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T })
    expect(r.enviados).toBe(1)
    expect(enviados[0]!.texto).toBe('Oi! Como combinamos, voltei para falar das camisetas.')
  })
})

describe('Textos fixos', () => {
  it('são educados, curtos e sem números em todos os passos', () => {
    for (const motivo of ['proposta_sem_resposta', 'carrinho_abandonado'] as const) {
      for (let passo = 1; passo <= MAX_TENTATIVAS_RETORNO; passo++) {
        const t = textoDoRetorno(motivo, passo, null)
        expect(t).not.toMatch(/\d/)
        expect(t.length).toBeLessThan(200)
      }
    }
    expect(textoDoRetorno('combinado', 1, null)).not.toMatch(/\d/)
  })
})
