import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { anotarMemoria, detectarDadoSensivel, lerMemoria, listarMemoria, normalizarFato, revogarMemoria } from './memoria.js'
import { ferramentaMemoriaAnotar } from './ferramenta-memoria.js'
import type { ContextoFerramenta } from '../ferramentas/porta.js'

/**
 * Memória do cliente: o filtro de PII (puro), a deduplicação, a validade, o
 * formato que vai ao prompt, a ferramenta do modelo e o isolamento entre
 * tenants — contra o Postgres real, sob o papel da aplicação.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const T = 'c0b40000-0000-4000-8000-000000000001'
const OUTRO = 'c0b40000-0000-4000-8000-000000000002'
const PV = 'c0b40000-1111-4000-8000-000000000001'
const PV2 = 'c0b40000-1111-4000-8000-000000000002'
const PLANO = 'c0b40000-3333-4000-8000-000000000001'
const MODELO = 'c0b40000-4444-4000-8000-000000000001'
const CONTATO = 'c0b40000-5555-4000-8000-000000000001'
const CONTATO2 = 'c0b40000-5555-4000-8000-000000000002'
const CONTATO_OUTRO = 'c0b40000-5555-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-memoria-cliente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-memoria-cliente', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES
             (${T}, ${CONTATO}, 'Maria', 'manual', true), (${T}, ${CONTATO2}, 'João', 'manual', true),
             (${OUTRO}, ${CONTATO_OUTRO}, 'Ana', 'manual', true) ON CONFLICT DO NOTHING`
  await dono`DELETE FROM cliente_memoria WHERE tenant_id IN (${T}, ${OUTRO})`
})

afterAll(async () => {
  await dono`DELETE FROM cliente_memoria WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco()
  await dono.end()
})

const anotar = (fato: string, extra: Partial<Parameters<typeof anotarMemoria>[1]> = {}, tenant = T) =>
  comTenantServico(tenant, (tx) => anotarMemoria(tx, { contatoId: CONTATO, tipo: 'preferencia', fato, ...extra }))

describe('⚠️ Dado sensível nunca entra na memória (puro)', () => {
  it.each([
    ['CPF com pontos', 'o cpf dela é 123.456.789-09', 'cpf'],
    ['CPF só dígitos', 'cpf 12345678909 para a nota', 'cpf'],
    ['CNPJ formatado', 'empresa 12.345.678/0001-95', 'cnpj'],
    ['CNPJ só dígitos', 'cnpj 12345678000195', 'cnpj'],
    ['telefone com DDD e parênteses', 'ligar no (85) 99999-1234', 'telefone'],
    ['telefone com +55', 'whats +55 85 99999 1234 à noite', 'telefone'],
    ['e-mail', 'manda a nota para maria.silva@exemplo.com.br', 'email'],
    ['endereço com rua e número', 'mora na Rua das Flores, 123, bairro Centro', 'endereco'],
    ['endereço com avenida', 'entregar na Av. Santos Dumont 1500 sala 2', 'endereco'],
    ['CEP', 'cep 60000-000', 'cep'],
  ])('%s é recusado', (_nome, fato, padrao) => {
    expect(detectarDadoSensivel(fato)).toBe(padrao)
  })

  it.each([
    'telefone 85999991234',          // 11 dígitos colados: tem forma de CPF E de celular — recusado de qualquer jeito
    'documento 1234 5678 9012',      // sequência longa com espaços
    'cartão 4111 1111 1111 1111',    // número de cartão: nunca
  ])('"%s" é recusado por algum padrão, qualquer que seja o rótulo', (fato) => {
    expect(detectarDadoSensivel(fato)).not.toBeNull()
  })

  it.each([
    'gosta de tamanho G',
    'compra 10 caixas por mês para revender',
    'quer receber até 15/10/2026',
    'achou R$ 1.234,56 caro pelo kit',
    'pedido 2024-10-15 atrasou e ficou chateada',
    'prefere pagar no PIX, não aceita boleto',
    'tem loja em Fortaleza, no centro',
    'pediu desconto de 5% na segunda compra',
  ])('"%s" é aceito', (fato) => {
    expect(detectarDadoSensivel(fato)).toBeNull()
  })

  it('normalizarFato ignora caixa, acento, pontuação e espaços', () => {
    expect(normalizarFato('  Prefere tamanho G.  ')).toBe('prefere tamanho g')
    expect(normalizarFato('PREFERE   tamanho  g!')).toBe('prefere tamanho g')
    expect(normalizarFato('não aceita boleto')).toBe('nao aceita boleto')
  })
})

describe('anotarMemoria', () => {
  it('dado fato limpo, então grava e lerMemoria devolve "[tipo] fato"', async () => {
    const r = await anotar('Gosta de tamanho G')
    expect(r.resultado).toBe('ok')
    expect(await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO))).toEqual(['[preferencia] Gosta de tamanho G'])
  })

  it('dado o mesmo fato com outra caixa/pontuação, então duplicado com o id do original', async () => {
    const original = await anotar('Gosta de tamanho G')
    const r = await anotar('gosta de tamanho g!')
    expect(r.resultado).toBe('duplicado')
    expect(r.resultado === 'duplicado' && original.resultado === 'duplicado' && r.id === original.id).toBe(true)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM cliente_memoria WHERE tenant_id = ${T} AND contato_id = ${CONTATO}`
    expect(n!.n).toBe(1)
  })

  it('dado CPF (com pontos), então fato_sensivel e NADA é gravado', async () => {
    const r = await anotar('cpf 123.456.789-09', { tipo: 'contexto' })
    expect(r).toEqual({ resultado: 'fato_sensivel', padrao: 'cpf' })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM cliente_memoria WHERE tenant_id = ${T} AND fato ILIKE '%cpf%'`
    expect(n!.n).toBe(0)
  })

  it('dado fato vazio ou maior que 300, então fato_invalido', async () => {
    expect(await anotar('   ')).toEqual({ resultado: 'fato_invalido', motivo: 'vazio' })
    expect(await anotar('a'.repeat(301))).toEqual({ resultado: 'fato_invalido', motivo: 'longo' })
  })

  it('dado contato inexistente, então contato_nao_encontrado', async () => {
    const r = await comTenantServico(T, (tx) => anotarMemoria(tx, { contatoId: randomUUID(), tipo: 'contexto', fato: 'x y z' }))
    expect(r).toEqual({ resultado: 'contato_nao_encontrado' })
  })

  it('dado validade vencida, então o fato sai da leitura (mas continua na trilha)', async () => {
    const ontem = new Date(Date.now() - 86_400_000)
    const r = await anotar('Queria receber antes do Natal', { tipo: 'contexto', validoAte: ontem })
    expect(r.resultado).toBe('ok')
    const lidas = await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO))
    expect(lidas.some((l) => /Natal/.test(l))).toBe(false)
    const amanha = new Date(Date.now() + 86_400_000)
    await anotar('Quer o pedido antes da feira', { tipo: 'contexto', validoAte: amanha })
    expect((await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO))).some((l) => /feira/.test(l))).toBe(true)
  })

  it('dado revogação, então sai da leitura e pode ser anotado de novo', async () => {
    const r = await anotar('Não aceita boleto', { tipo: 'restricao' })
    expect(r.resultado).toBe('ok')
    const id = r.resultado === 'ok' ? r.id : ''
    expect(await comTenantServico(T, (tx) => revogarMemoria(tx, id))).toBe(true)
    expect(await comTenantServico(T, (tx) => revogarMemoria(tx, id))).toBe(false)
    expect((await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO))).some((l) => /boleto/.test(l))).toBe(false)
    const de_novo = await anotar('não aceita boleto', { tipo: 'restricao' })
    expect(de_novo.resultado).toBe('ok')
  })

  it('lerMemoria: mais recentes primeiro, no limite pedido; listarMemoria pagina por cursor', async () => {
    for (let i = 0; i < 5; i++) await comTenantServico(T, (tx) => anotarMemoria(tx, { contatoId: CONTATO2, tipo: 'objecao', fato: `Achou caro o item ${i}` }))
    const lidas = await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO2, 3))
    expect(lidas).toHaveLength(3)
    expect(lidas[0]).toBe('[objecao] Achou caro o item 4')
    const p1 = await comTenantServico(T, (tx) => listarMemoria(tx, CONTATO2, { limite: 3 }))
    expect(p1.itens.map((m) => m.fato)).toEqual(['Achou caro o item 4', 'Achou caro o item 3', 'Achou caro o item 2'])
    expect(p1.proximoCursor).not.toBeNull()
    const p2 = await comTenantServico(T, (tx) => listarMemoria(tx, CONTATO2, { limite: 3, cursor: p1.proximoCursor }))
    expect(p2.itens.map((m) => m.fato)).toEqual(['Achou caro o item 1', 'Achou caro o item 0'])
    expect(p2.proximoCursor).toBeNull()
    expect(p1.itens[0]).toMatchObject({ tipo: 'objecao', confianca: 0.8, validoAte: null, origemMensagemId: null })
  })
})

describe('Isolamento — dois tenants', () => {
  it('o outro tenant não lê nem revoga a memória do primeiro', async () => {
    const r = await anotar('Prefere cor preta')
    const id = r.resultado === 'ok' ? r.id : r.resultado === 'duplicado' ? r.id : ''
    expect(await comTenantServico(OUTRO, (tx) => lerMemoria(tx, CONTATO))).toEqual([])
    expect(await comTenantServico(OUTRO, (tx) => revogarMemoria(tx, id))).toBe(false)
    expect((await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO))).some((l) => /preta/.test(l))).toBe(true)
  })

  it('o outro tenant não anota em contato do primeiro (contato_nao_encontrado)', async () => {
    const r = await comTenantServico(OUTRO, (tx) => anotarMemoria(tx, { contatoId: CONTATO, tipo: 'contexto', fato: 'invasão' }))
    expect(r).toEqual({ resultado: 'contato_nao_encontrado' })
  })
})

describe('Ferramenta memoria_anotar', () => {
  const ctx: ContextoFerramenta = {
    tenantId: T, conversaId: randomUUID(), contatoId: CONTATO, canalId: randomUUID(),
    perfil: 'varejo', sessaoId: null, modo: 'autonomo', agora: new Date(),
  }
  const f = ferramentaMemoriaAnotar()

  it('anota pelo contexto da conversa e responde anotado:true', async () => {
    const r = await f.executar(ctx, { tipo: 'contexto', fato: 'Compra para revender na feira de domingo' } as never)
    expect(r).toEqual({ ok: true, saida: { anotado: true, motivo: undefined } })
    expect((await comTenantServico(T, (tx) => lerMemoria(tx, CONTATO)))[0]).toBe('[contexto] Compra para revender na feira de domingo')
  })

  it('dado sensível volta anotado:false com motivo — nunca erro', async () => {
    const r = await f.executar(ctx, { tipo: 'contexto', fato: 'telefone (85) 99999-1234' } as never)
    expect(r).toEqual({ ok: true, saida: { anotado: false, motivo: 'fato_sensivel' } })
  })

  it('entrada é estrita: tipo fora da lista não passa no schema', () => {
    expect(f.entrada.safeParse({ tipo: 'segredo', fato: 'x y z' }).success).toBe(false)
    expect(f.entrada.safeParse({ tipo: 'preferencia', fato: 'x y z' }).success).toBe(true)
  })
})
