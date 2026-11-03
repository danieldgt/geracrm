import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'

/**
 * B2 — modais do funil: ganhar com dados mínimos (CNPJ válido, razão, fantasia, endereço), perder com motivo,
 * transferir (papel, auditoria, aviso) e criar com etapa inicial. Dois tenants.
 */
const T = 'b2b20000-0000-4000-8000-000000000001'
const OUTRO = 'b2b20000-0000-4000-8000-000000000002'
const PV = 'b2b20000-1111-4000-8000-000000000001'
const PV2 = 'b2b20000-1111-4000-8000-000000000002'
const PLANO = 'b2b20000-3333-4000-8000-000000000001'
const MODELO = 'b2b20000-4444-4000-8000-000000000001'
const U_EU = 'b2b20000-5555-4000-8000-000000000001' // quem chama (sub dev-<tenant>)
const U_ADMIN = 'b2b20000-5555-4000-8000-000000000002'
const U_DESTINO = 'b2b20000-5555-4000-8000-000000000003'
const U_OUTRO = 'b2b20000-5555-4000-8000-000000000004'
const CNPJ = '11222333000181'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const papelDe = (t: string, u: string, p: string) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, NULL, ${p})
       ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

const novoContato = async (t: string, nome: string, extra: { razao?: string; fantasia?: string } = {}) => {
  const id = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, razao_social, nome_fantasia, origem_carga, ativo)
             VALUES (${t}, ${id}, ${nome}, ${extra.razao ?? null}, ${extra.fantasia ?? null}, 'teste', true)`
  return id
}
const completarContato = async (t: string, c: string) => {
  await dono`UPDATE contato SET razao_social = 'Acme Ltda', nome_fantasia = 'Acme' WHERE tenant_id = ${t} AND id = ${c}`
  await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte) VALUES (${t}, ${c}, 1, 'cnpj', ${CNPJ}, true, 'erp')`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, bairro, cidade, uf, cep, principal, fonte)
             VALUES (${t}, ${c}, 1, 'Av. Paulista', '1000', 'Bela Vista', 'São Paulo', 'SP', '01310100', true, 'erp')`
}
const novaOp = async (t: string, contato: string) => {
  const r = await chamar(t, 'POST', '/v1/funil/oportunidades', { contatoId: contato })
  expect(r.statusCode).toBe(201)
  return r.json<{ id: string }>().id
}
const etapaId = async (t: string, chave: string) => {
  const [e] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${t} AND chave = ${chave}`
  return e!.id
}
const op = async (id: string) => {
  const [o] = await dono<{ estado: string; versao: string; pedido_id: string | null; perda_descricao: string | null; motivo_perda_codigo: string | null; responsavel_id: string | null }[]>`
    SELECT estado, versao::text, pedido_id, perda_descricao, motivo_perda_codigo, responsavel_id FROM oportunidade WHERE id = ${id}`
  return o!
}
const dadosOk = {
  cnpj: '11.222.333/0001-81', razaoSocial: 'Acme Ltda', nomeFantasia: 'Acme',
  endereco: { cep: '01310-100', logradouro: 'Av. Paulista', numero: '1000', complemento: 'Sala 2', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'sp' },
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-b2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-b2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
      (${t}, ${randomUUID()}, 1, 'lead', 'Lead', 'aberto'),
      (${t}, ${randomUUID()}, 2, 'conversa', 'Em conversa', 'aberto'),
      (${t}, ${randomUUID()}, 4, 'pedido', '1º pedido', 'ganho'),
      (${t}, ${randomUUID()}, 9, 'perdido', 'Perdido', 'perdido') ON CONFLICT (tenant_id, chave) DO NOTHING`
    await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${t}, 'preco', 'Preço') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_EU}, ${'dev-' + T}, 'Eu', 'eu@b2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_ADMIN}, 'sub-admin-b2', 'Ada', 'ada@b2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_DESTINO}, 'sub-destino-b2', 'Davi', 'davi@b2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${OUTRO}, ${U_OUTRO}, ${'dev-' + OUTRO}, 'Beto', 'beto@b2.test') ON CONFLICT DO NOTHING`
  await papelDe(T, U_ADMIN, 'admin') // tira o tenant do modo fundador
  await papelDe(OUTRO, U_OUTRO, 'admin')
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await papelDe(T, U_EU, 'gestor')
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
  }
})

afterAll(async () => {
  await dono`DROP TRIGGER IF EXISTS b2_falha_endereco ON contato_endereco`
  await dono`DROP FUNCTION IF EXISTS b2_falha_endereco()`
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade_etapa_historico WHERE tenant_id = ${t}`
    await dono`DELETE FROM oportunidade WHERE tenant_id = ${t}`
    await dono`DELETE FROM pedido WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM motivo_perda WHERE tenant_id = ${t}`
    await dono`DELETE FROM funil_etapa WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('mover para ganho', () => {
  it('sem dados mínimos → 422 tipificado por campo e o card NÃO se move', async () => {
    const c = await novoContato(T, 'Sem dados')
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/mover`, { etapaId: await etapaId(T, 'pedido'), versao: 0 })
    expect(r.statusCode).toBe(422)
    const j = r.json<{ erro: string; campos: Record<string, string> }>()
    expect(j.erro).toBe('ganho.dados_minimos')
    expect(Object.keys(j.campos).sort()).toEqual(
      ['bairro', 'cep', 'cidade', 'cnpj', 'logradouro', 'nomeFantasia', 'numero', 'razaoSocial', 'uf'])
    expect((await op(id)).estado).toBe('aberta')
    expect((await op(id)).versao).toBe('0')
  })

  it('contato completo → move e fecha como ganha', async () => {
    const c = await novoContato(T, 'Completo')
    await completarContato(T, c)
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/mover`, { etapaId: await etapaId(T, 'pedido'), versao: 0 })
    expect(r.statusCode).toBe(200)
    expect((await op(id)).estado).toBe('ganha')
  })
})

describe('POST .../ganhar', () => {
  it('grava razão, fantasia, CNPJ e endereço no contato e move, tudo junto', async () => {
    const c = await novoContato(T, 'Nova Cliente')
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, { dados: dadosOk, versao: 0 })
    expect(r.statusCode).toBe(200)
    expect((await op(id)).estado).toBe('ganha')
    const [ct] = await dono<{ razao_social: string; nome_fantasia: string }[]>`SELECT razao_social, nome_fantasia FROM contato WHERE id = ${c}`
    expect(ct).toEqual({ razao_social: 'Acme Ltda', nome_fantasia: 'Acme' })
    const [doc] = await dono<{ tipo: string; numero: string }[]>`SELECT tipo, numero FROM contato_documento WHERE contato_id = ${c}`
    expect(doc).toEqual({ tipo: 'cnpj', numero: CNPJ })
    const [e] = await dono<{ cep: string; uf: string; complemento: string }[]>`SELECT cep, uf, complemento FROM contato_endereco WHERE contato_id = ${c}`
    expect(e).toEqual({ cep: '01310100', uf: 'SP', complemento: 'Sala 2' })
    const [aud] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${T} AND acao = 'funil.ganhar' AND entidade_id = ${id}`
    expect(aud!.n).toBe(1)
  })

  it('aproveita o que o contato já tem: sem corpo, contato completo ganha', async () => {
    const c = await novoContato(T, 'Já completo')
    await completarContato(T, c)
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, {})
    expect(r.statusCode).toBe(200)
    expect((await op(id)).estado).toBe('ganha')
  })

  it('CNPJ inválido e campo faltando → 422 por campo, nada gravado nem movido', async () => {
    const c = await novoContato(T, 'Dados ruins')
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, {
      dados: { ...dadosOk, cnpj: '11.222.333/0001-82', nomeFantasia: '' },
    })
    expect(r.statusCode).toBe(422)
    const j = r.json<{ erro: string; campos: Record<string, string> }>()
    expect(j.erro).toBe('ganho.dados_minimos')
    expect(j.campos).toEqual({ cnpj: 'CNPJ inválido', nomeFantasia: 'Informe o nome fantasia' })
    expect((await op(id)).estado).toBe('aberta')
    const [ct] = await dono<{ razao_social: string | null }[]>`SELECT razao_social FROM contato WHERE id = ${c}`
    expect(ct!.razao_social).toBeNull()
  })

  it('falha no meio da gravação desfaz TUDO (nem contato, nem movimento)', async () => {
    await dono`CREATE OR REPLACE FUNCTION b2_falha_endereco() RETURNS trigger LANGUAGE plpgsql AS $f$
               BEGIN IF NEW.cep = '99999999' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $f$`
    await dono`DROP TRIGGER IF EXISTS b2_falha_endereco ON contato_endereco`
    await dono`CREATE TRIGGER b2_falha_endereco BEFORE INSERT OR UPDATE ON contato_endereco FOR EACH ROW EXECUTE FUNCTION b2_falha_endereco()`
    try {
      const c = await novoContato(T, 'Vai falhar')
      const id = await novaOp(T, c)
      const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, {
        dados: { ...dadosOk, endereco: { ...dadosOk.endereco, cep: '99999-999' } },
      })
      expect(r.statusCode).toBe(500)
      expect((await op(id)).estado).toBe('aberta')
      expect((await op(id)).versao).toBe('0')
      const [ct] = await dono<{ razao_social: string | null }[]>`SELECT razao_social FROM contato WHERE id = ${c}`
      expect(ct!.razao_social).toBeNull()
      const docs = await dono`SELECT 1 FROM contato_documento WHERE contato_id = ${c}`
      expect(docs).toHaveLength(0)
    } finally {
      await dono`DROP TRIGGER IF EXISTS b2_falha_endereco ON contato_endereco`
    }
  })

  it('vincula pedido do contato; pedido de OUTRO contato → 422 e não move', async () => {
    const c = await novoContato(T, 'Com pedido')
    const outro = await novoContato(T, 'Outro contato')
    const pOk = randomUUID(); const pRuim = randomUUID()
    await dono`INSERT INTO pedido (tenant_id, id, contato_id) VALUES (${T}, ${pOk}, ${c}), (${T}, ${pRuim}, ${outro})`
    const id = await novaOp(T, c)
    const ruim = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, { dados: dadosOk, pedidoId: pRuim })
    expect(ruim.statusCode).toBe(422)
    expect(ruim.json<{ erro: string }>().erro).toBe('ganho.pedido_invalido')
    expect((await op(id)).estado).toBe('aberta')

    const bom = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, { dados: dadosOk, pedidoId: pOk })
    expect(bom.statusCode).toBe(200)
    expect((await op(id)).pedido_id).toBe(pOk)
  })

  it('pedido de outro tenant → 422', async () => {
    const c = await novoContato(T, 'Cliente A')
    const cB = await novoContato(OUTRO, 'Cliente B')
    const pB = randomUUID()
    await dono`INSERT INTO pedido (tenant_id, id, contato_id) VALUES (${OUTRO}, ${pB}, ${cB})`
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, { dados: dadosOk, pedidoId: pB })
    expect(r.statusCode).toBe(422)
  })

  it('versão velha → 409 e nada gravado; oportunidade de outro tenant → 404', async () => {
    const c = await novoContato(T, 'Concorrência')
    const id = await novaOp(T, c)
    const velha = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/ganhar`, { dados: dadosOk, versao: 7 })
    expect(velha.statusCode).toBe(409)
    const [ct] = await dono<{ razao_social: string | null }[]>`SELECT razao_social FROM contato WHERE id = ${c}`
    expect(ct!.razao_social).toBeNull()

    const cB = await novoContato(OUTRO, 'Do outro')
    const idB = await novaOp(OUTRO, cB)
    const cruzado = await chamar(T, 'POST', `/v1/funil/oportunidades/${idB}/ganhar`, { dados: dadosOk })
    expect(cruzado.statusCode).toBe(404)
    expect((await op(idB)).estado).toBe('aberta')
  })
})

describe('POST .../perder', () => {
  it('sem motivo → 422; motivo inexistente → 422; com motivo grava descrição', async () => {
    const c = await novoContato(T, 'Perdendo')
    const id = await novaOp(T, c)
    const sem = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/perder`, {})
    expect(sem.statusCode).toBe(422)
    expect(sem.json<{ erro: string }>().erro).toBe('perda.motivo_obrigatorio')
    const falso = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/perder`, { motivoCodigo: 'nao_existe' })
    expect(falso.json<{ erro: string }>().erro).toBe('perda.motivo_invalido')
    expect((await op(id)).estado).toBe('aberta')

    const ok = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/perder`, { motivoCodigo: 'preco', descricao: 'Achou caro' })
    expect(ok.statusCode).toBe(200)
    const o = await op(id)
    expect(o.estado).toBe('perdida')
    expect(o.motivo_perda_codigo).toBe('preco')
    expect(o.perda_descricao).toBe('Achou caro')
  })

  it('motivo de OUTRO tenant não vale', async () => {
    await dono`INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES (${OUTRO}, 'so_do_outro', 'Só do outro') ON CONFLICT DO NOTHING`
    const c = await novoContato(T, 'Cruzado')
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/perder`, { motivoCodigo: 'so_do_outro' })
    expect(r.statusCode).toBe(422)
  })
})

describe('POST .../transferir', () => {
  it('gestor transfere: carteira, responsável, auditoria e aviso (tarefa) ao destino', async () => {
    const c = await novoContato(T, 'Transferida')
    const id = await novaOp(T, c)
    const r = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/transferir`, { usuarioId: U_DESTINO, motivo: 'Mudou de região' })
    expect(r.statusCode).toBe(200)
    expect((await op(id)).responsavel_id).toBe(U_DESTINO)
    const [dono1] = await dono<{ usuario_id: string; motivo: string }[]>`
      SELECT usuario_id, motivo FROM carteira_atribuicao WHERE contato_id = ${c} AND ate IS NULL`
    expect(dono1).toEqual({ usuario_id: U_DESTINO, motivo: 'Mudou de região' })
    const [aud] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${T} AND acao = 'funil.transferir' AND entidade_id = ${id}`
    expect(aud!.n).toBe(1)
    const [tar] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id = ${T} AND responsavel_id = ${U_DESTINO} AND contato_id = ${c}`
    expect(tar!.n).toBe(1)
  })

  it('vendedor não transfere (403); sem motivo → 422; destino de outro tenant → 422; oportunidade de outro tenant → 404', async () => {
    const c = await novoContato(T, 'Protegida')
    const id = await novaOp(T, c)
    await papelDe(T, U_EU, 'vendedor')
    const proibido = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/transferir`, { usuarioId: U_DESTINO, motivo: 'x' })
    expect(proibido.statusCode).toBe(403)
    expect((await op(id)).responsavel_id).toBeNull()

    await papelDe(T, U_EU, 'gestor')
    const semMotivo = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/transferir`, { usuarioId: U_DESTINO })
    expect(semMotivo.statusCode).toBe(422)
    const forasteiro = await chamar(T, 'POST', `/v1/funil/oportunidades/${id}/transferir`, { usuarioId: U_OUTRO, motivo: 'x' })
    expect(forasteiro.statusCode).toBe(422)
    expect(forasteiro.json<{ erro: string }>().erro).toBe('carteira.usuario_invalido')

    const cB = await novoContato(OUTRO, 'Do outro')
    const idB = await novaOp(OUTRO, cB)
    const cruzado = await chamar(T, 'POST', `/v1/funil/oportunidades/${idB}/transferir`, { usuarioId: U_DESTINO, motivo: 'x' })
    expect(cruzado.statusCode).toBe(404)
  })
})

describe('POST /v1/funil/oportunidades (criar)', () => {
  it('aceita contato + etapa inicial aberta; etapa de ganho → 422', async () => {
    const c = await novoContato(T, 'Nova op')
    const conversa = await etapaId(T, 'conversa')
    const r = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c, etapaId: conversa, valorCentavos: 150000 })
    expect(r.statusCode).toBe(201)
    const [o] = await dono<{ etapa_id: string; valor_estimado_centavos: string }[]>`
      SELECT etapa_id, valor_estimado_centavos::text FROM oportunidade WHERE id = ${r.json<{ id: string }>().id}`
    expect(o).toEqual({ etapa_id: conversa, valor_estimado_centavos: '150000' })

    const c2 = await novoContato(T, 'Nova op 2')
    const ganho = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c2, etapaId: await etapaId(T, 'pedido') })
    expect(ganho.statusCode).toBe(422)
    const alheia = await chamar(T, 'POST', '/v1/funil/oportunidades', { contatoId: c2, etapaId: await etapaId(OUTRO, 'conversa') })
    expect(alheia.statusCode).toBe(422)
  })
})
