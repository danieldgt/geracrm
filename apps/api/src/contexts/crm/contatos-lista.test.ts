import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { rotasContatos } from './rotas-contatos.js'
import { rotasContatosAcoesEmMassa } from './rotas-contatos-massa.js'

/**
 * A2 — lista de contatos: filtros em `GET /v1/contatos` e ações em massa.
 * Banco real, papel da aplicação (RLS), DOIS tenants. Identidade pelo header
 * `x-teste-sub` (como o Cognito). Escopo da D3: vendedor só age no que enxerga.
 *
 *   Tenant A (com admin): filiais FX e FY; adm (admin); gx (gestor de FX);
 *     va (vendedor FX), vb (vendedor FY).
 *   Contatos: c1 Ana (va, novo, O1, E1+E2, venda recente, tarefa futura, FX),
 *     c2 Bruno (sem dono, qualificado, O2, E1, sem venda), c3 Carla (vb, descartada, FY),
 *     c4 Diego (va, novo, doc CNPJ, criado em 2020, sem tarefa).
 *   Tenant B: um contato (nunca aparece para A).
 */
const A = 'a2e00000-0000-4000-8000-00000000000a'
const B = 'a2e00000-0000-4000-8000-00000000000b'
const PLANO = 'a2e00000-0001-4000-8000-000000000001'
const MODELO = 'a2e00000-0002-4000-8000-000000000001'
const PV_A = 'a2e00000-0003-4000-8000-00000000000a'
const PV_B = 'a2e00000-0003-4000-8000-00000000000b'
const FX = 'a2e00000-0004-4000-8000-000000000001'
const FY = 'a2e00000-0004-4000-8000-000000000002'
const U = {
  adm: 'a2e00000-0005-4000-8000-000000000001',
  gx: 'a2e00000-0005-4000-8000-000000000002',
  va: 'a2e00000-0005-4000-8000-000000000003',
  vb: 'a2e00000-0005-4000-8000-000000000004',
  bx: 'a2e00000-0005-4000-8000-000000000005',
}
const C = {
  c1: 'a2e00000-0006-4000-8000-000000000001',
  c2: 'a2e00000-0006-4000-8000-000000000002',
  c3: 'a2e00000-0006-4000-8000-000000000003',
  c4: 'a2e00000-0006-4000-8000-000000000004',
  b1: 'a2e00000-0006-4000-8000-0000000000b1',
}
const O1 = 'a2e00000-0007-4000-8000-000000000001'
const O2 = 'a2e00000-0007-4000-8000-000000000002'
const O3 = 'a2e00000-0007-4000-8000-000000000003'
const E1 = 'a2e00000-0008-4000-8000-000000000001'
const E2 = 'a2e00000-0008-4000-8000-000000000002'
const E3 = 'a2e00000-0008-4000-8000-000000000003'
const E_B = 'a2e00000-0008-4000-8000-0000000000b1'
const LISTA = 'a2e00000-0009-4000-8000-000000000001'
const LISTA_B = 'a2e00000-0009-4000-8000-0000000000b1'

const sub = (k: keyof typeof U) => `a2e-sub-${k}`
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

type Quem = keyof typeof U
interface Item { id: string; [k: string]: unknown }
async function pedir(quem: Quem, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const tenant = quem === 'bx' ? B : A
  const r = await app.inject({
    method, url, headers: { 'x-tenant-id': tenant, 'x-teste-sub': sub(quem) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> & { itens?: Item[]; proximoCursor?: string | null } }
}
const listar = async (quem: Quem, qs = '') => {
  const r = await pedir(quem, 'GET', `/v1/contatos${qs ? `?${qs}` : ''}`)
  expect(r.status).toBe(200)
  return (r.corpo.itens ?? []).map((i) => i.id).sort()
}
const so = (...c: (keyof typeof C)[]) => c.map((k) => C[k]).sort()
const massa = (quem: Quem, acao: string, corpo: Record<string, unknown>) => pedir(quem, 'POST', `/v1/contatos/acoes-em-massa/${acao}`, corpo)
const futuro = () => new Date(Date.now() + 3 * 86400_000).toISOString()

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM lista_membro WHERE tenant_id = ${t}`
    await dono`DELETE FROM lista WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM venda WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM comentario WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_documento WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

/** Estado conhecido antes de cada teste (as ações em massa alteram os contatos). */
async function semear(): Promise<void> {
  for (const tb of ['auditoria', 'lista_membro', 'lista', 'contato_etiqueta', 'etiqueta', 'tarefa', 'venda', 'carteira_atribuicao', 'comentario', 'contato_documento', 'contato_telefone', 'contato']) {
    for (const t of [A, B]) await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id = '${t}'`)
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, email, filial_id, origem_id, qualificado, qualificado_em, criado_em) VALUES
    (${A}, ${C.c1}, 'Ana Silva', 'ana@a2.test', ${FX}, ${O1}, NULL, NULL, now()),
    (${A}, ${C.c2}, 'Bruno Costa', NULL, NULL, ${O2}, true, now(), now()),
    (${A}, ${C.c3}, 'Carla Dias', NULL, ${FY}, NULL, false, now(), now()),
    (${A}, ${C.c4}, 'Diego Lima', NULL, NULL, NULL, NULL, NULL, '2020-01-10T12:00:00Z'),
    (${B}, ${C.b1}, 'Beto Outro Tenant', NULL, NULL, NULL, NULL, NULL, now())`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${A}, ${C.c1}, 1, '+5511999990001', 'k-a2-1', true, true, 'manual')`
  await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte)
             VALUES (${A}, ${C.c4}, 1, 'cnpj', '12345678000190', true, 'manual')`
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES
    (${A}, gen_random_uuid(), ${C.c1}, ${U.va}), (${A}, gen_random_uuid(), ${C.c3}, ${U.vb}),
    (${A}, gen_random_uuid(), ${C.c4}, ${U.va})`
  await dono`INSERT INTO etiqueta (tenant_id, id, nome, cor) VALUES
    (${A}, ${E1}, 'VIP', 'sucesso'), (${A}, ${E2}, 'Atacado', 'acao'), (${A}, ${E3}, 'Inativa', 'neutro'),
    (${B}, ${E_B}, 'Alheia', 'neutro')`
  await dono`UPDATE etiqueta SET ativa = false WHERE tenant_id = ${A} AND id = ${E3}`
  await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES
    (${A}, ${C.c1}, ${E1}), (${A}, ${C.c1}, ${E2}), (${A}, ${C.c2}, ${E1})`
  await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
             VALUES (${A}, gen_random_uuid(), ${C.c1}, now() - interval '10 days', 10000)`
  await dono`SELECT atualizar_metricas_contato()`
  await dono`INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, vence_em)
             VALUES (${A}, gen_random_uuid(), ${C.c1}, ${U.va}, 'Ligar Ana', now() + interval '2 days')`
  await dono`INSERT INTO lista (tenant_id, id, nome) VALUES (${A}, ${LISTA}, 'Lista A2'), (${B}, ${LISTA_B}, 'Lista B')`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a2-lista', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a2-lista', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Lista A'], [B, PV_B, 'Lista B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X'), (${A}, ${FY}, 'Filial Y')`
  for (const k of Object.keys(U) as Quem[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${k === 'bx' ? B : A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${sub(k) + '@a2.test'})`
  }
  const vinc = (t: string, u: string, f: string | null, p: string) =>
    dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, ${f}, ${p})`
  await vinc(A, U.adm, null, 'admin')
  await vinc(A, U.gx, FX, 'gestor')
  await vinc(A, U.va, FX, 'vendedor')
  await vinc(A, U.vb, FY, 'vendedor')
  await vinc(B, U.bx, null, 'admin')
  await dono`INSERT INTO origem (tenant_id, id, nome, ordem) VALUES (${A}, ${O1}, 'Site', 1), (${A}, ${O2}, 'Indicação', 2), (${A}, ${O3}, 'Feira', 3)`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@a2.test` }
  })
  await app.register(rotasContatos)
  await app.register(rotasContatosAcoesEmMassa)
  await app.ready()
})

beforeEach(semear)

afterAll(async () => {
  await limpar()
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('GET /v1/contatos — filtros', () => {
  it('sem filtro: a base do tenant, nunca a de outro (e o item traz os campos novos)', async () => {
    expect(await listar('adm')).toEqual(so('c1', 'c2', 'c3', 'c4'))
    const r = await pedir('adm', 'GET', '/v1/contatos?q=ana')
    const ana = r.corpo.itens![0]!
    expect(ana).toMatchObject({
      id: C.c1, nome: 'Ana Silva', email: 'ana@a2.test', telefone: '+5511999990001', qualificacao: 'novo',
      origem: 'Site', vendedor: 'Pessoa va', etiquetasTotal: 2, semProximoPasso: false, segmento: { codigo: 'cliente-recente' },
    })
    expect((ana.etiquetas as { nome: string }[]).map((e) => e.nome)).toEqual(['Atacado', 'VIP'])
    expect(ana.ultimaCompraEm).toBeTruthy()
    expect(ana.criadoEm).toBeTruthy()
  })

  it('gestao: a lista diz se o chamador é da gestão (a tela esconde o que a API negaria)', async () => {
    expect((await pedir('adm', 'GET', '/v1/contatos')).corpo.gestao).toBe(true)
    expect((await pedir('gx', 'GET', '/v1/contatos')).corpo.gestao).toBe(true)
    expect((await pedir('va', 'GET', '/v1/contatos')).corpo.gestao).toBe(false)
  })

  it('etiquetas no item: até 3 e a contagem total', async () => {
    const extras = ['a2e00000-0008-4000-8000-0000000000e1', 'a2e00000-0008-4000-8000-0000000000e2']
    for (const [i, id] of extras.entries()) {
      await dono`INSERT INTO etiqueta (tenant_id, id, nome, cor) VALUES (${A}, ${id}, ${'Extra ' + i}, 'neutro')`
      await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (${A}, ${C.c1}, ${id})`
    }
    const ana = (await pedir('adm', 'GET', '/v1/contatos?q=ana')).corpo.itens![0]!
    expect((ana.etiquetas as unknown[]).length).toBe(3)
    expect(ana.etiquetasTotal).toBe(4)
  })

  it('q: nome, telefone (dígitos) e documento', async () => {
    expect(await listar('adm', 'q=silva')).toEqual(so('c1'))
    expect(await listar('adm', 'q=ANA')).toEqual(so('c1'))
    expect(await listar('adm', 'q=99999-0001')).toEqual(so('c1'))
    expect(await listar('adm', `q=${encodeURIComponent('12.345.678/0001-90')}`)).toEqual(so('c4'))
    expect(await listar('adm', 'q=inexistente')).toEqual([])
    // % e _ são literais, não coringa.
    expect(await listar('adm', `q=${encodeURIComponent('%')}`)).toEqual([])
  })

  it('qualificacao: novo, qualificado, descartado', async () => {
    expect(await listar('adm', 'qualificacao=novo')).toEqual(so('c1', 'c4'))
    expect(await listar('adm', 'qualificacao=qualificado')).toEqual(so('c2'))
    expect(await listar('adm', 'qualificacao=descartado')).toEqual(so('c3'))
  })

  it('segmento: recente (venda há 10 dias) × em-risco (nunca comprou) — a régua do RFV', async () => {
    expect(await listar('adm', 'segmento=cliente-recente')).toEqual(so('c1'))
    expect(await listar('adm', 'segmento=em-risco')).toEqual(so('c2', 'c3', 'c4'))
    expect(await listar('adm', 'segmento=hibernando')).toEqual([])
  })

  it('vendedorId: de um vendedor e sem-dono', async () => {
    expect(await listar('adm', `vendedorId=${U.va}`)).toEqual(so('c1', 'c4'))
    expect(await listar('adm', `vendedorId=${U.vb}`)).toEqual(so('c3'))
    expect(await listar('adm', 'vendedorId=sem-dono')).toEqual(so('c2'))
  })

  it('filialId e origemId', async () => {
    // Filial EFETIVA (D2): a gravada no contato ou, na falta, a do dono vigente — c4 é de va (FX).
    expect(await listar('adm', `filialId=${FX}`)).toEqual(so('c1', 'c4'))
    expect(await listar('adm', `origemId=${O2}`)).toEqual(so('c2'))
  })

  it('etiquetaId: uma, e repetida = contém TODAS', async () => {
    expect(await listar('adm', `etiquetaId=${E1}`)).toEqual(so('c1', 'c2'))
    expect(await listar('adm', `etiquetaId=${E1}&etiquetaId=${E2}`)).toEqual(so('c1'))
    expect(await listar('adm', `etiquetaId=${E2}&etiquetaId=${E3}`)).toEqual([])
  })

  it('semProximoPasso: sem tarefa aberta futura (a regra de /v1/tarefas/sem-proximo-passo)', async () => {
    expect(await listar('adm', 'semProximoPasso=true')).toEqual(so('c2', 'c3', 'c4'))
    const r = await pedir('adm', 'GET', `/v1/tarefas/sem-proximo-passo?contatoIds=${C.c1},${C.c4}`)
    expect(r.status).toBe(404) // a rota de tarefas não está montada neste teste: o filtro não depende dela
    const itens = (await pedir('adm', 'GET', '/v1/contatos')).corpo.itens!
    const sem = Object.fromEntries(itens.map((i) => [i.id, i.semProximoPasso]))
    expect(sem).toMatchObject({ [C.c1]: false, [C.c2]: true, [C.c4]: true })
    // Tarefa vencida ou concluída não conta como próximo passo.
    await dono`UPDATE tarefa SET vence_em = now() - interval '1 day' WHERE tenant_id = ${A}`
    expect(await listar('adm', 'semProximoPasso=true')).toEqual(so('c1', 'c2', 'c3', 'c4'))
    expect(await listar('adm', 'semProximoPasso=false')).toEqual(so('c1', 'c2', 'c3', 'c4'))
  })

  it('criadoDe / criadoAte (dia inteiro, inclusive)', async () => {
    expect(await listar('adm', 'criadoAte=2020-12-31')).toEqual(so('c4'))
    expect(await listar('adm', 'criadoDe=2020-01-10&criadoAte=2020-01-10')).toEqual(so('c4'))
    expect(await listar('adm', 'criadoDe=2021-01-01')).toEqual(so('c1', 'c2', 'c3'))
  })

  it('combina com AND', async () => {
    expect(await listar('adm', `vendedorId=${U.va}&qualificacao=novo&etiquetaId=${E1}`)).toEqual(so('c1'))
    expect(await listar('adm', `vendedorId=${U.va}&qualificacao=qualificado`)).toEqual([])
    expect(await listar('adm', `q=a&qualificacao=novo&semProximoPasso=true`)).toEqual(so('c4'))
  })

  it('valor inválido → 422 com os campos (nunca ignora em silêncio)', async () => {
    for (const [qs, campo] of [
      ['qualificacao=foo', 'qualificacao'], ['segmento=toString', 'segmento'], ['vendedorId=x', 'vendedorId'],
      ['filialId=x', 'filialId'], ['origemId=x', 'origemId'], ['etiquetaId=x', 'etiquetaId'],
      ['criadoDe=2026-02-31', 'criadoDe'], ['criadoAte=ontem', 'criadoAte'],
      ['semProximoPasso=talvez', 'semProximoPasso'],
    ] as const) {
      const r = await pedir('adm', 'GET', `/v1/contatos?${qs}`)
      expect(r.status, qs).toBe(422)
      expect(r.corpo.erro).toBe('contatos.filtro_invalido')
      expect(r.corpo.campos).toContain(campo)
    }
    const seis = Array.from({ length: 6 }, (_, i) => `etiquetaId=a2e00000-0008-4000-8000-00000000010${i}`).join('&')
    expect((await pedir('adm', 'GET', `/v1/contatos?${seis}`)).status).toBe(422)
    expect((await pedir('adm', 'GET', '/v1/contatos?criadoDe=2026-05-02&criadoAte=2026-05-01')).status).toBe(422)
  })

  it('cursor com filtro: percorre todas as páginas sem repetir nem perder', async () => {
    for (let i = 0; i < 5; i++) {
      await dono`INSERT INTO contato (tenant_id, id, nome, origem_id) VALUES (${A}, ${'a2e00000-0006-4000-8000-00000000010' + i}, ${'Feira ' + i}, ${O3})`
    }
    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const r: Awaited<ReturnType<typeof pedir>> = await pedir('adm', 'GET', `/v1/contatos?origemId=${O3}&limite=2${cursor ? `&cursor=${cursor}` : ''}`)
      expect(r.status).toBe(200)
      vistos.push(...r.corpo.itens!.map((i) => i.id))
      cursor = r.corpo.proximoCursor ?? null
      paginas += 1
    } while (cursor && paginas < 10)
    expect(paginas).toBe(3)
    expect(new Set(vistos).size).toBe(5)
    expect(vistos.every((id) => id.startsWith('a2e00000-0006-4000-8000-00000000010'))).toBe(true)
  })

  it('escopo (D3) + filtros: vendedor só vê o seu e filtrar pelo colega não revela nada', async () => {
    expect(await listar('va')).toEqual(so('c1', 'c4'))
    expect(await listar('va', `vendedorId=${U.vb}`)).toEqual([])
    expect(await listar('va', 'vendedorId=sem-dono')).toEqual([])
    expect(await listar('va', 'qualificacao=descartado')).toEqual([])
    expect(await listar('vb')).toEqual(so('c3'))
    // Gestor da filial FX: o que é da filial + carteira dos vendedores dela.
    expect(await listar('gx', 'qualificacao=novo')).toEqual(so('c1', 'c4'))
  })

  it('dois tenants: o filtro nunca cruza o tenant', async () => {
    expect(await listar('bx')).toEqual([C.b1])
    expect(await listar('bx', `origemId=${O1}`)).toEqual([])
    expect(await listar('bx', 'q=ana')).toEqual([])
  })
})

describe('POST /v1/contatos/acoes-em-massa/:acao', () => {
  const estadoDe = async (id: string) =>
    (await dono<{ qualificado: boolean | null; descarte_motivo: string | null }[]>`SELECT qualificado, descarte_motivo FROM contato WHERE tenant_id = ${A} AND id = ${id}`)[0]!
  const auditoria = () => dono<{ acao: string; dados: Record<string, unknown>; entidade_id: string | null }[]>`
    SELECT acao, dados, entidade_id FROM auditoria WHERE tenant_id = ${A} AND acao = 'contatos.acao_em_massa'`

  it('qualificar: aplica, ignora o que não existe (contado) e audita UMA vez sem dado pessoal', async () => {
    const r = await massa('adm', 'qualificar', { contatoIds: [C.c1, C.c4, C.b1, '00000000-0000-4000-8000-000000000999'] })
    expect(r).toMatchObject({ status: 200, corpo: { aplicados: 2, ignorados: 2 } })
    expect((await estadoDe(C.c1)).qualificado).toBe(true)
    expect((await estadoDe(C.c4)).qualificado).toBe(true)
    // O contato do OUTRO tenant não foi tocado.
    expect((await dono`SELECT qualificado FROM contato WHERE tenant_id = ${B} AND id = ${C.b1}`)[0]!.qualificado).toBeNull()
    const a = await auditoria()
    expect(a).toHaveLength(1)
    expect(a[0]!.dados).toEqual({ acao: 'qualificar', solicitados: 4, aplicados: 2, ignorados: 2 })
    expect(JSON.stringify(a[0])).not.toMatch(/Ana|Diego|ana@a2|5511/)
  })

  it('escopo (D3): o vendedor só age no que enxerga; o alheio entra em ignorados, sem efeito', async () => {
    const r = await massa('va', 'qualificar', { contatoIds: [C.c1, C.c3, C.c2] })
    expect(r.corpo).toMatchObject({ aplicados: 1, ignorados: 2 })
    expect((await estadoDe(C.c1)).qualificado).toBe(true)
    expect((await estadoDe(C.c3)).qualificado).toBe(false)
    expect((await estadoDe(C.c2)).qualificado).toBe(true) // já era; não foi tocado pelo va
    const etiquetar = await massa('va', 'etiquetar', { contatoIds: [C.c3], etiquetaIds: [E1] })
    expect(etiquetar.corpo).toMatchObject({ aplicados: 0, ignorados: 1 })
    expect((await dono`SELECT 1 FROM contato_etiqueta WHERE tenant_id = ${A} AND contato_id = ${C.c3}`)).toHaveLength(0)
  })

  it('descartar: exige motivo e observação (422); grava o descarte manual e a nota no contato', async () => {
    expect((await massa('adm', 'descartar', { contatoIds: [C.c1] })).status).toBe(422)
    expect((await massa('adm', 'descartar', { contatoIds: [C.c1], motivo: 'sem_interesse' })).status).toBe(422)
    expect((await massa('adm', 'descartar', { contatoIds: [C.c1], motivo: 'sem_interesse', observacao: '  ' })).status).toBe(422)
    expect((await massa('adm', 'descartar', { contatoIds: [C.c1], motivo: 'inventado', observacao: 'x' })).status).toBe(422)
    expect((await estadoDe(C.c1)).qualificado).toBeNull() // nada gravado nos 422

    const r = await massa('adm', 'descartar', { contatoIds: [C.c1, C.c4], motivo: 'sem_interesse', observacao: 'Não quer mais contato' })
    expect(r.corpo).toMatchObject({ aplicados: 2, ignorados: 0 })
    expect(await estadoDe(C.c1)).toMatchObject({ qualificado: false, descarte_motivo: null }) // manual: o robô nunca reabre
    const notas = await dono<{ texto: string }[]>`SELECT texto FROM comentario WHERE tenant_id = ${A} AND contato_id = ${C.c1}`
    expect(notas[0]!.texto).toBe('Descartado (Sem interesse): Não quer mais contato')
    const a = await auditoria()
    expect(a[0]!.dados).toEqual({ acao: 'descartar', solicitados: 2, aplicados: 2, ignorados: 0, motivo: 'sem_interesse' })
    expect(JSON.stringify(a[0])).not.toContain('Não quer mais')
  })

  it('reabrir: só descartado volta para novo', async () => {
    const r = await massa('adm', 'reabrir', { contatoIds: [C.c3, C.c2, C.c1] })
    expect(r.corpo).toMatchObject({ aplicados: 1, ignorados: 2 })
    expect((await estadoDe(C.c3)).qualificado).toBeNull()
    expect((await estadoDe(C.c2)).qualificado).toBe(true)
  })

  it('transferir: gestão apenas (403 para vendedor), motivo obrigatório, destino válido, escreve a carteira', async () => {
    const corpo = { contatoIds: [C.c1, C.c2], usuarioId: U.vb, motivo: 'Redistribuição' }
    expect((await massa('va', 'transferir', corpo)).status).toBe(403)
    expect((await massa('adm', 'transferir', { ...corpo, motivo: '' })).status).toBe(422)
    const semUsuario = await massa('adm', 'transferir', { ...corpo, usuarioId: 'a2e00000-0005-4000-8000-0000000000ff' })
    expect(semUsuario).toMatchObject({ status: 422, corpo: { erro: 'carteira.usuario_invalido' } })
    const outroTenant = await massa('adm', 'transferir', { ...corpo, usuarioId: U.bx })
    expect(outroTenant.status).toBe(422)

    const r = await massa('adm', 'transferir', corpo)
    expect(r.corpo).toMatchObject({ aplicados: 2, ignorados: 0 })
    const dono_ = await dono<{ contato_id: string; usuario_id: string; motivo: string | null }[]>`
      SELECT contato_id, usuario_id, motivo FROM carteira_atribuicao WHERE tenant_id = ${A} AND ate IS NULL AND contato_id = ANY(${[C.c1, C.c2]}::uuid[])`
    expect(dono_.map((d) => d.usuario_id)).toEqual([U.vb, U.vb])
    expect(dono_[0]!.motivo).toBe('Redistribuição')
    // Já era o dono → nada mudou → conta como ignorado.
    expect((await massa('adm', 'transferir', corpo)).corpo).toMatchObject({ aplicados: 0, ignorados: 2 })
    // O gestor da filial só transfere o que enxerga.
    expect((await massa('gx', 'transferir', { contatoIds: [C.c3], usuarioId: U.va, motivo: 'x' })).corpo).toMatchObject({ aplicados: 0, ignorados: 1 })
  })

  it('etiquetar / desetiquetar: etiqueta inativa ou de outro tenant → 422; idempotente', async () => {
    expect((await massa('adm', 'etiquetar', { contatoIds: [C.c4], etiquetaIds: [E3] })).status).toBe(422)
    expect((await massa('adm', 'etiquetar', { contatoIds: [C.c4], etiquetaIds: [E_B] })).status).toBe(422)
    expect((await massa('adm', 'etiquetar', { contatoIds: [C.c4], etiquetaIds: [] })).status).toBe(422)

    const r = await massa('adm', 'etiquetar', { contatoIds: [C.c1, C.c4, C.c4], etiquetaIds: [E1, E2] })
    expect(r.corpo).toMatchObject({ aplicados: 2, ignorados: 0 }) // ids repetidos contam uma vez
    const tem = async (c: string) => (await dono<{ etiqueta_id: string }[]>`SELECT etiqueta_id FROM contato_etiqueta WHERE tenant_id = ${A} AND contato_id = ${c}`).map((x) => x.etiqueta_id).sort()
    expect(await tem(C.c4)).toEqual([E1, E2].sort())
    expect((await massa('adm', 'etiquetar', { contatoIds: [C.c4], etiquetaIds: [E1] })).status).toBe(200)
    expect(await tem(C.c4)).toHaveLength(2)

    expect((await massa('adm', 'desetiquetar', { contatoIds: [C.c4, C.c1], etiquetaIds: [E1] })).corpo).toMatchObject({ aplicados: 2 })
    expect(await tem(C.c4)).toEqual([E2])
    expect(await tem(C.c1)).toEqual([E2])
  })

  it('adicionar-lista: lista inexistente/de outro tenant → 422; idempotente', async () => {
    expect((await massa('adm', 'adicionar-lista', { contatoIds: [C.c1], listaId: LISTA_B })).status).toBe(422)
    expect((await massa('adm', 'adicionar-lista', { contatoIds: [C.c1] })).status).toBe(422)
    const r = await massa('adm', 'adicionar-lista', { contatoIds: [C.c1, C.c2, C.b1], listaId: LISTA })
    expect(r.corpo).toMatchObject({ aplicados: 2, ignorados: 1 })
    expect((await massa('adm', 'adicionar-lista', { contatoIds: [C.c1], listaId: LISTA })).status).toBe(200)
    expect(await dono`SELECT 1 FROM lista_membro WHERE tenant_id = ${A} AND lista_id = ${LISTA}`).toHaveLength(2)
  })

  it('criar-tarefa: regra do /v1/tarefas/lote (gestão, validação, escopo) e uma tarefa por contato', async () => {
    const corpo = { contatoIds: [C.c2, C.c4], titulo: 'Reativar', tipo: 'whatsapp', venceEm: futuro(), responsavelId: U.va }
    expect((await massa('va', 'criar-tarefa', corpo)).status).toBe(403)
    expect((await massa('adm', 'criar-tarefa', { ...corpo, titulo: '' })).status).toBe(422)
    expect((await massa('adm', 'criar-tarefa', { ...corpo, venceEm: 'nada' })).status).toBe(422)
    expect((await massa('adm', 'criar-tarefa', { ...corpo, responsavelId: 'a2e00000-0005-4000-8000-0000000000ff' })).status).toBe(422)
    const r = await massa('adm', 'criar-tarefa', corpo)
    expect(r.corpo).toMatchObject({ aplicados: 2, ignorados: 0 })
    const t = await dono<{ contato_id: string; tipo: string; responsavel_id: string }[]>`
      SELECT contato_id, tipo, responsavel_id FROM tarefa WHERE tenant_id = ${A} AND titulo = 'Reativar'`
    expect(t.map((x) => x.contato_id).sort()).toEqual([C.c2, C.c4].sort())
    expect(t.every((x) => x.tipo === 'whatsapp' && x.responsavel_id === U.va)).toBe(true)
    // O gestor de FX só cria tarefa para o que enxerga.
    expect((await massa('gx', 'criar-tarefa', { ...corpo, contatoIds: [C.c3, C.c1] })).corpo).toMatchObject({ aplicados: 1, ignorados: 1 })
  })

  it('limite: 1..500 ids (vazio e 501 → 422); 500 passa; ids que não são UUID → 422', async () => {
    const r0 = await massa('adm', 'qualificar', { contatoIds: [] })
    expect(r0).toMatchObject({ status: 422, corpo: { erro: 'contatos.lote_vazio' } })
    const muitos = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const r1 = await massa('adm', 'qualificar', { contatoIds: muitos })
    expect(r1).toMatchObject({ status: 422, corpo: { erro: 'contatos.lote_grande' } })
    const ok = await massa('adm', 'etiquetar', { contatoIds: muitos.slice(0, 500), etiquetaIds: [E1] })
    expect(ok).toMatchObject({ status: 200, corpo: { aplicados: 0, ignorados: 500 } })
    expect((await massa('adm', 'qualificar', { contatoIds: ['nao-uuid'] })).status).toBe(422)
    expect((await massa('adm', 'qualificar', {})).status).toBe(422)
  })

  it('ação desconhecida → 404; tudo numa transação: 422 de referência não deixa rastro', async () => {
    expect((await massa('adm', 'apagar', { contatoIds: [C.c1] })).status).toBe(404)
    await massa('adm', 'etiquetar', { contatoIds: [C.c4], etiquetaIds: [E1, E3] })
    expect(await auditoria()).toHaveLength(0)
    expect(await dono`SELECT 1 FROM contato_etiqueta WHERE tenant_id = ${A} AND contato_id = ${C.c4}`).toHaveLength(0)
  })

  it('dois tenants: a gestão do tenant B não age em contato do tenant A', async () => {
    const r = await massa('bx', 'qualificar', { contatoIds: [C.c1, C.b1] })
    expect(r.corpo).toMatchObject({ aplicados: 1, ignorados: 1 })
    expect((await estadoDe(C.c1)).qualificado).toBeNull()
    const aud = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${B} AND acao = 'contatos.acao_em_massa'`
    expect(aud).toHaveLength(1)
  })
})
