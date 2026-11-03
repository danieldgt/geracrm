import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pluginTenant } from '../../plugins/tenant.js'
import { encerrarBanco } from '../../db/index.js'
import { rotasFunil } from './rotas-funil.js'

/**
 * B1 — Panorama do funil e filtros do board. Fixa: agrupamento por filial/vendedor, "sem dono" à parte,
 * contagem por etapa, ganhos/perdidos do MÊS no fuso do tenant, escopo (vendedor só o próprio grupo, gestor a
 * filial), filtros da coluna e dos totais, e isolamento entre dois tenants.
 */
const A = 'b1b10000-0001-4000-8000-000000000001'
const B = 'b1b10000-0001-4000-8000-000000000002'
const PV_A = 'b1b10000-0002-4000-8000-000000000001'
const PV_B = 'b1b10000-0002-4000-8000-000000000002'
const PLANO = 'b1b10000-0003-4000-8000-000000000001'
const MODELO = 'b1b10000-0004-4000-8000-000000000001'
const FX = 'b1b10000-0005-4000-8000-000000000001'
const FY = 'b1b10000-0005-4000-8000-000000000002'
const U = {
  adm: 'b1b10000-0006-4000-8000-000000000001',
  gx: 'b1b10000-0006-4000-8000-000000000002',
  va: 'b1b10000-0006-4000-8000-000000000003',
  vb: 'b1b10000-0006-4000-8000-000000000004',
  bx: 'b1b10000-0006-4000-8000-000000000005',
} as const
const ETQ = 'b1b10000-0007-4000-8000-000000000001'
const ORI = 'b1b10000-0008-4000-8000-000000000001'
const c = (n: number) => `b1b10000-0009-4000-8000-${String(n).padStart(12, '0')}`
const o = (n: number) => `b1b10000-000a-4000-8000-${String(n).padStart(12, '0')}`

const sub = (k: keyof typeof U) => `b1b1-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let lead = ''
let conversa = ''

type Item = {
  chave: string; rotulo: string; ativos: number; ganhosMes: number; perdidosMes: number
  semProximoPasso: number; porEtapa: { etapaId: string; total: number }[]
}
async function pedir(quem: keyof typeof U, url: string) {
  const tenant = quem === 'bx' ? B : A
  const r = await app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant, 'x-teste-sub': sub(quem) } })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> & { itens: Record<string, unknown>[] } }
}
const panorama = async (quem: keyof typeof U, agrupar: string) => {
  const r = await pedir(quem, `/v1/funil/panorama?agrupar=${agrupar}`)
  return { ...r, itens: r.corpo.itens as unknown as Item[] }
}
const porChave = (itens: Item[], chave: string) => itens.find((i) => i.chave === chave)
const nomes = (corpo: { itens: Record<string, unknown>[] }) => corpo.itens.map((i) => i.nome as string).sort()

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM funil_etapa WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-b1', 'Pro')`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-b1', 'Varejo')`
  for (const [t, pv, nome] of [[A, PV_A, 'B1 A'], [B, PV_B, 'B1 B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv})`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo')`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X'), (${A}, ${FY}, 'Filial Y')`
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    const t = k === 'bx' ? B : A
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${t}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@b1.test'}, true)`
  }
  const vinc = (t: string, u: string, f: string | null, p: string) =>
    dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, ${f}, ${p})`
  await vinc(A, U.adm, null, 'admin')
  await vinc(A, U.gx, FX, 'gestor')
  await vinc(A, U.va, FX, 'vendedor')
  await vinc(A, U.vb, FY, 'vendedor')
  await vinc(B, U.bx, null, 'admin')
  await dono`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (${A}, ${ETQ}, 'Quente')`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${A}, ${ORI}, 'Indicação')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@b1.test` }
  })
  await app.register(rotasFunil)
  await app.ready()

  // Etapas nascem na 1ª leitura.
  await pedir('adm', '/v1/funil/etapas')
  await pedir('bx', '/v1/funil/etapas')
  const etapas = (await pedir('adm', '/v1/funil/etapas')).corpo.itens as { id: string; tipo: string }[]
  lead = etapas.find((e) => e.tipo === 'aberto')!.id
  conversa = etapas.filter((e) => e.tipo === 'aberto')[1]!.id
  const ganho = etapas.find((e) => e.tipo === 'ganho')!.id
  const perdido = etapas.find((e) => e.tipo === 'perdido')!.id
  const [eb] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${B} AND tipo = 'aberto' ORDER BY ordem LIMIT 1`
  await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${A}, 'preco', 'Preço') ON CONFLICT DO NOTHING`

  // Contatos 1..9 (A), 20 (B).
  const nomesContato = ['Alfa Padaria', 'Beta Mercado', 'Gama Loja', 'Delta Bar', 'Epsilon Café', 'Zeta Ganho', 'Eta Perdido',
    'Theta Antigo', 'Iota Sem Dono']
  for (let i = 0; i < nomesContato.length; i++) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${c(i + 1)}, ${nomesContato[i]!})`
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${B}, ${c(20)}, 'Outro Tenant')`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
             VALUES (${A}, ${c(1)}, 1, '+5585988887777', '5585988887777', true, 'teste')`
  await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (${A}, ${c(1)}, ${ETQ})`
  await dono`UPDATE contato SET origem_id = ${ORI} WHERE tenant_id = ${A} AND id = ${c(2)}`

  // Carteira vigente: sem ela o contato é "órfão" e o gestor de qualquer filial o enxerga (regra D3).
  for (const [n, u] of [[1, U.va], [2, U.va], [3, U.va], [6, U.va], [8, U.va], [4, U.vb], [5, U.vb], [7, U.vb]] as const) {
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${A}, gen_random_uuid(), ${c(n)}, ${u})`
  }
  // Abertas: 1,2 (va; lead), 3 (va; conversa), 4 (vb; lead), 5 (vb; conversa), 9 (sem dono; lead).
  const abertas: [number, string | null, string][] = [
    [1, U.va, lead], [2, U.va, lead], [3, U.va, conversa], [4, U.vb, lead], [5, U.vb, conversa], [9, null, lead],
  ]
  for (const [n, resp, etapa] of abertas) {
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id, posicao)
               VALUES (${A}, ${o(n)}, ${c(n)}, ${etapa}, ${resp}, ${n})`
  }
  // Ganha este mês (va), perdida este mês (vb), ganha em mês passado (va) — não conta.
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id, posicao, estado, fechada_em)
             VALUES (${A}, ${o(6)}, ${c(6)}, ${ganho}, ${U.va}, 6, 'ganha', now())`
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id, posicao, estado, motivo_perda_codigo, fechada_em)
             VALUES (${A}, ${o(7)}, ${c(7)}, ${perdido}, ${U.vb}, 7, 'perdida', 'preco', now())`
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id, posicao, estado, fechada_em)
             VALUES (${A}, ${o(8)}, ${c(8)}, ${ganho}, ${U.va}, 8, 'ganha', now() - interval '70 days')`
  // Próximo passo: tarefa aberta nos contatos 1 e 4; as demais abertas ficam "sem próximo passo".
  await dono`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, vence_em) VALUES
    (${A}, gen_random_uuid(), ${c(1)}, ${U.va}, 'Ligar', now() + interval '1 day'),
    (${A}, gen_random_uuid(), ${c(4)}, ${U.vb}, 'Ligar', now() + interval '1 day')`
  // Outro tenant.
  await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, responsavel_id, posicao)
             VALUES (${B}, ${o(20)}, ${c(20)}, ${eb!.id}, ${U.bx}, 1)`
})

afterAll(async () => {
  await limpar()
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('B1: panorama por vendedor', () => {
  it('agrupa por dono, com "sem dono" à parte e contagem por etapa', async () => {
    const { status, itens } = await panorama('adm', 'vendedor')
    expect(status).toBe(200)
    const va = porChave(itens, U.va)!
    expect(va.rotulo).toBe('Pessoa va')
    expect(va.ativos).toBe(3)
    expect(va.porEtapa.find((e) => e.etapaId === lead)!.total).toBe(2)
    expect(va.porEtapa.find((e) => e.etapaId === conversa)!.total).toBe(1)
    expect(porChave(itens, U.vb)!.ativos).toBe(2)
    const sem = porChave(itens, 'sem-dono')!
    expect(sem.rotulo).toBe('Sem dono')
    expect(sem.ativos).toBe(1)
    expect(itens).toHaveLength(3)
  })

  it('ganhos e perdidos contam só o mês corrente; sem próximo passo = sem tarefa aberta', async () => {
    const { itens } = await panorama('adm', 'vendedor')
    const va = porChave(itens, U.va)!
    expect(va.ganhosMes).toBe(1) // a ganha de 70 dias atrás fica de fora
    expect(va.perdidosMes).toBe(0)
    expect(va.semProximoPasso).toBe(2) // contatos 2 e 3 (o 1 tem tarefa)
    const vb = porChave(itens, U.vb)!
    expect(vb.perdidosMes).toBe(1)
    expect(vb.semProximoPasso).toBe(1) // contato 5 (o 4 tem tarefa)
    expect(porChave(itens, 'sem-dono')!.semProximoPasso).toBe(1)
  })

  it('respeita o fuso do tenant na virada do mês', async () => {
    // Fechada 1 minuto antes do início do mês em São Paulo = mês passado, mesmo que em UTC já seja o mês atual.
    await dono`UPDATE oportunidade SET fechada_em = (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') - interval '1 minute'
                WHERE tenant_id = ${A} AND id = ${o(6)}`
    try {
      const { itens } = await panorama('adm', 'vendedor')
      expect(porChave(itens, U.va)!.ganhosMes).toBe(0)
    } finally {
      await dono`UPDATE oportunidade SET fechada_em = now() WHERE tenant_id = ${A} AND id = ${o(6)}`
    }
    const { itens } = await panorama('adm', 'vendedor')
    expect(porChave(itens, U.va)!.ganhosMes).toBe(1)
  })
})

describe('B1: panorama por filial', () => {
  it('agrupa pela filial do responsável; sem dono à parte', async () => {
    const { itens } = await panorama('adm', 'filial')
    const x = porChave(itens, FX)!
    expect(x.rotulo).toBe('Filial X')
    expect(x.ativos).toBe(3)
    expect(x.ganhosMes).toBe(1)
    expect(porChave(itens, FY)!.ativos).toBe(2)
    expect(porChave(itens, 'sem-dono')!.ativos).toBe(1)
  })

  it('agrupar inválido é 422', async () => {
    const r = await pedir('adm', '/v1/funil/panorama?agrupar=cor')
    expect(r.status).toBe(422)
  })
})

describe('B1: escopo do panorama', () => {
  it('vendedor vê só o próprio grupo', async () => {
    const { itens } = await panorama('va', 'vendedor')
    expect(itens.map((i) => i.chave)).toEqual([U.va])
    expect(itens[0]!.ativos).toBe(3)
  })

  it('gestor da filial X não vê a carteira da filial Y', async () => {
    const { itens } = await panorama('gx', 'vendedor')
    const chaves = itens.map((i) => i.chave)
    expect(chaves).toContain(U.va)
    expect(chaves).not.toContain(U.vb)
  })
})

describe('B1: isolamento entre tenants', () => {
  it('o outro tenant só enxerga o próprio panorama', async () => {
    const { itens } = await panorama('bx', 'vendedor')
    expect(itens.map((i) => i.chave)).toEqual([U.bx])
    expect(itens[0]!.ativos).toBe(1)
    const { itens: doA } = await panorama('adm', 'vendedor')
    expect(doA.map((i) => i.chave)).not.toContain(U.bx)
  })
})

describe('B1: filtros da coluna e dos totais', () => {
  const coluna = (quem: keyof typeof U, etapa: string, query = '') => pedir(quem, `/v1/funil/coluna/${etapa}?${query}`)
  const totalLead = async (quem: keyof typeof U, query = '') => {
    const r = await pedir(quem, `/v1/funil/etapas?${query}`)
    return (r.corpo.itens as unknown as { id: string; total: number }[]).find((e) => e.id === lead)!.total
  }

  it('vendedorId e sem-dono', async () => {
    expect(nomes((await coluna('adm', lead, `vendedorId=${U.va}`)).corpo)).toEqual(['Alfa Padaria', 'Beta Mercado'])
    expect(nomes((await coluna('adm', lead, 'vendedorId=sem-dono')).corpo)).toEqual(['Iota Sem Dono'])
    expect(await totalLead('adm', `vendedorId=${U.va}`)).toBe(2)
    expect(await totalLead('adm', 'vendedorId=sem-dono')).toBe(1)
  })

  it('filialId', async () => {
    expect(nomes((await coluna('adm', lead, `filialId=${FY}`)).corpo)).toEqual(['Delta Bar'])
    expect(await totalLead('adm', `filialId=${FY}`)).toBe(1)
  })

  it('filialId=sem-filial pega quem tem dono sem filial', async () => {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${A}, 'b1b10000-0006-4000-8000-0000000000aa', 'b1b1-sub-solto', 'Solto', 'solto@b1.test', true)`
    await dono`UPDATE oportunidade SET responsavel_id = 'b1b10000-0006-4000-8000-0000000000aa' WHERE tenant_id = ${A} AND id = ${o(2)}`
    try {
      expect(nomes((await coluna('adm', lead, 'filialId=sem-filial')).corpo)).toEqual(['Beta Mercado'])
      const { itens } = await panorama('adm', 'filial')
      expect(porChave(itens, 'sem-filial')!.ativos).toBe(1)
    } finally {
      await dono`UPDATE oportunidade SET responsavel_id = ${U.va} WHERE tenant_id = ${A} AND id = ${o(2)}`
      await dono`DELETE FROM usuario WHERE tenant_id = ${A} AND id = 'b1b10000-0006-4000-8000-0000000000aa'`
    }
  })

  it('etiquetaId, origemId e busca por nome/telefone', async () => {
    expect(nomes((await coluna('adm', lead, `etiquetaId=${ETQ}`)).corpo)).toEqual(['Alfa Padaria'])
    expect(nomes((await coluna('adm', lead, `origemId=${ORI}`)).corpo)).toEqual(['Beta Mercado'])
    expect(nomes((await coluna('adm', lead, 'q=mercado')).corpo)).toEqual(['Beta Mercado'])
    expect(nomes((await coluna('adm', lead, 'q=88887777')).corpo)).toEqual(['Alfa Padaria'])
    expect(await totalLead('adm', 'q=mercado')).toBe(1)
    expect(await totalLead('adm', `etiquetaId=${ETQ}`)).toBe(1)
  })

  it('curinga do LIKE é texto literal', async () => {
    expect((await coluna('adm', lead, 'q=%25')).corpo.itens).toHaveLength(0)
  })

  it('filtros combinam (E) e mantêm o escopo', async () => {
    expect((await coluna('adm', lead, `vendedorId=${U.vb}&q=alfa`)).corpo.itens).toHaveLength(0)
    // vendedor va pedindo a carteira da vb: o escopo corta, o filtro não alarga.
    expect((await coluna('va', lead, `vendedorId=${U.vb}`)).corpo.itens).toHaveLength(0)
    expect(await totalLead('va', `vendedorId=${U.vb}`)).toBe(0)
  })

  it('UUID malformado é 422 e o cursor segue funcionando com filtro', async () => {
    expect((await coluna('adm', lead, 'filialId=xx')).status).toBe(422)
    const r = await coluna('adm', lead, `vendedorId=${U.va}`)
    expect(r.status).toBe(200)
    expect((r.corpo as unknown as { proximoCursor: string | null }).proximoCursor).toBeNull()
  })
})
