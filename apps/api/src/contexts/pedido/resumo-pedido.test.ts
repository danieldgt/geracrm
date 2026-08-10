import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { resumoPedidoTexto } from './resumo-pedido.js'

describe('resumoPedidoTexto (puro)', () => {
  it('formata itens e total com negrito do WhatsApp; qtd inteira sem casas', () => {
    const t = resumoPedidoTexto(
      [{ descricao: 'Camisa Azul M', quantidade: 2, valorUnitarioCentavos: 5000 },
       { descricao: 'Calça Preta 42', quantidade: 1, valorUnitarioCentavos: 8000 }],
      18000,
    )
    expect(t).toContain('*Resumo do seu pedido*')
    expect(t).toContain('• 2× Camisa Azul M — R$\xa0100,00')
    expect(t).toContain('• 1× Calça Preta 42 — R$\xa080,00')
    expect(t).toContain('*Total: R$\xa0180,00*')
  })

  it('com contexto: saudação pelo 1º nome, pagamento, observação e CTA', () => {
    const t = resumoPedidoTexto(
      [{ descricao: 'Camisa', quantidade: 1, valorUnitarioCentavos: 5000 }], 5000,
      { contatoNome: 'Maria Silva', formaPagamento: 'Pix', observacao: 'Entrega na sexta' },
    )
    expect(t).toContain('Olá, Maria!')
    expect(t).toContain('Pagamento: Pix')
    expect(t).toContain('Obs.: Entrega na sexta')
    expect(t).toContain('Responda *SIM*')
  })
})

/** Endpoint enviar-resumo — validações + persistência via gateway único. */
const T = 'de54000a-0000-4000-8000-000000000001'
const PV = 'de54000a-1111-4000-8000-000000000001'
const PLANO = 'de54000a-3333-4000-8000-000000000001'
const MODELO = 'de54000a-4444-4000-8000-000000000001'
const C1 = 'de54000a-6666-4000-8000-000000000001'
const CANAL = 'de54000a-7777-4000-8000-000000000001'
const CONV = 'de54000a-8888-4000-8000-000000000001'
const PED_CONV = 'de54000a-9999-4000-8000-000000000001'
const PED_SEM = 'de54000a-9999-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (m: 'POST', url: string) => app.inject({ method: m, url, headers: { 'x-tenant-id': T } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rp', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja RP', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${C1}, 'Cliente RP', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${C1}, 1, '+5511988887777', '5511988887777', true, true, 'teste') ON CONFLICT DO NOTHING`
  // ⚠️ Canal SEM credencial: o gateway recusa em 'canal_sem_credencial' ANTES de
  //    qualquer rede — testa o fluxo sem tocar a Meta.
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'meta_cloud', 'Zap', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_entrante_em)
             VALUES (${T}, ${CONV}, ${CANAL}, ${C1}, now()) ON CONFLICT DO NOTHING`
  // Pedido na conversa, com 2 itens.
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, total_centavos)
             VALUES (${T}, ${PED_CONV}, ${C1}, ${CONV}, 'rascunho', 18000) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${PED_CONV}, 1, 'SKU1', 'Camisa Azul M', 2, 5000)`
  await dono`INSERT INTO pedido_item (tenant_id, pedido_id, seq, sku_snapshot, descricao_snapshot, quantidade, valor_unitario_centavos)
             VALUES (${T}, ${PED_CONV}, 2, 'SKU2', 'Calça Preta 42', 1, 8000)`
  // Pedido SEM conversa (venda de balcão).
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos)
             VALUES (${T}, ${PED_SEM}, ${C1}, 'rascunho', 5000) ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  await dono`DELETE FROM pedido_item WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('POST /v1/pedidos/:id/enviar-resumo', () => {
  it('pedido inexistente → 404; pedido sem conversa → 422', async () => {
    expect((await chamar('POST', `/v1/pedidos/${randomUUID()}/enviar-resumo`)).statusCode).toBe(404)
    const semConv = await chamar('POST', `/v1/pedidos/${PED_SEM}/enviar-resumo`)
    expect(semConv.statusCode).toBe(422)
    expect((semConv.json() as { erro: string }).erro).toBe('pedido.sem_conversa')
  })

  it('⚠️ envia pelo gateway: persiste a mensagem saliente com o resumo; recusa tipificada sem rede', async () => {
    const r = await chamar('POST', `/v1/pedidos/${PED_CONV}/enviar-resumo`)
    expect(r.statusCode).toBe(200)
    // Canal sem credencial → gateway recusa (sem tocar a Meta), status 'falhou'.
    expect((r.json() as { ok: boolean; motivo?: string })).toMatchObject({ ok: false, motivo: 'canal_sem_credencial' })
    // ⚠️ Mesmo recusado, a mensagem saliente foi registrada com o resumo.
    const [m] = await dono<{ texto: string; status: string; direcao: string }[]>`
      SELECT conteudo->>'texto' AS texto, status, direcao FROM mensagem
       WHERE tenant_id = ${T} AND conversa_id = ${CONV} ORDER BY criado_em DESC LIMIT 1`
    expect(m?.direcao).toBe('saliente')
    expect(m?.status).toBe('falhou')
    expect(m?.texto).toContain('Olá, Cliente!') // saudação pelo 1º nome do contato
    expect(m?.texto).toContain('Camisa Azul M')
  })
})
