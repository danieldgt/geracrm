import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { definirProvedorConsulta, criarProvedorBrasilApi, comCache, type ProvedorConsulta } from './consulta-externa.js'

/** A1 — cadastro completo do contato. Consultas externas sempre com adaptador falso. */
const T = 'a1c00000-0000-4000-8000-000000000001'
const OUTRO = 'a1c00000-0000-4000-8000-000000000002'
const PV = 'a1c00000-1111-4000-8000-000000000001'
const PV2 = 'a1c00000-1111-4000-8000-000000000002'
const PLANO = 'a1c00000-3333-4000-8000-000000000001'
const MODELO = 'a1c00000-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST' | 'PUT', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const TABELAS = ['contato_telefone', 'contato_documento', 'contato_endereco', 'contato', 'origem']
async function limpar() {
  for (const tb of TABELAS) for (const t of [T, OUTRO]) await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id = '${t}'`)
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(limpar)

afterAll(async () => {
  await limpar()
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

let chamadasCnpj = 0
const falso: ProvedorConsulta = {
  async consultarCnpj(cnpj) {
    chamadasCnpj++
    if (cnpj === '11222333000181') {
      return { ok: true, dado: { razaoSocial: 'Saturno e Alves LTDA', nomeFantasia: 'Saturno Modas', situacao: 'ATIVA',
        endereco: { cep: '50000000', logradouro: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', cidade: 'Recife', uf: 'PE' } } }
    }
    return { ok: false, erro: 'consulta.indisponivel' }
  },
  async consultarCep(cep) {
    if (cep === '50000000') return { ok: true, dado: { cep, logradouro: 'Rua A', numero: null, complemento: null, bairro: 'Centro', cidade: 'Recife', uf: 'PE' } }
    if (cep === '99999999') return { ok: false, erro: 'consulta.nao_encontrado' }
    return { ok: false, erro: 'consulta.indisponivel' }
  },
}

const completo = {
  nome: 'Saturno Modas', razaoSocial: 'Saturno e Alves LTDA', nomeFantasia: 'Saturno', email: 'contato@saturno.com.br',
  telefone: '(81) 99861-7049', whatsapp: true, documento: '11.222.333/0001-81',
  endereco: { cep: '50.000-000', logradouro: 'Rua A', numero: '10', complemento: 'Sala 2', bairro: 'Centro', cidade: 'Recife', uf: 'pe' },
  modalidade: 'atacado', prioridade: 'alta', temperatura: 'quente', valorEstimadoCentavos: 1500000, observacoes: 'Pediu catálogo',
}

describe('POST/PUT /v1/contatos completos', () => {
  it('cria completo e a ficha devolve os campos novos', async () => {
    const r = await chamar(T, 'POST', '/v1/contatos', completo)
    expect(r.statusCode).toBe(201)
    const { id } = r.json() as { id: string }
    const [c] = await dono`SELECT * FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c).toMatchObject({ razao_social: 'Saturno e Alves LTDA', email: 'contato@saturno.com.br', prioridade: 'alta',
      temperatura: 'quente', modalidade: 'atacado', observacoes: 'Pediu catálogo' })
    expect(String(c!['valor_estimado_centavos'])).toBe('1500000')
    const [d] = await dono`SELECT tipo, numero FROM contato_documento WHERE tenant_id=${T} AND contato_id=${id}`
    expect(d).toMatchObject({ tipo: 'cnpj', numero: '11222333000181' })
    const [e] = await dono`SELECT cep, uf, complemento FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${id}`
    expect(e).toMatchObject({ cep: '50000000', uf: 'PE', complemento: 'Sala 2' })
    const ficha = (await chamar(T, 'GET', `/v1/contatos/${id}`)).json() as Record<string, unknown>
    expect(ficha).toMatchObject({ razaoSocial: 'Saturno e Alves LTDA', prioridade: 'alta', valorEstimadoCentavos: 1500000 })
    expect((ficha['endereco'] as { cidade: string }).cidade).toBe('Recife')
  })

  it('POST antigo (nome + telefone) continua valendo e é idempotente pelo telefone', async () => {
    const a = await chamar(T, 'POST', '/v1/contatos', { nome: 'Maria', telefone: '81988887777' })
    expect(a.statusCode).toBe(201)
    const b = await chamar(T, 'POST', '/v1/contatos', { nome: 'Maria 2', telefone: '81988887777' })
    expect(b.statusCode).toBe(200)
    expect((b.json() as { novo: boolean }).novo).toBe(false)
    expect((b.json() as { id: string }).id).toBe((a.json() as { id: string }).id)
  })

  it('edita: troca campos, telefone principal, documento e endereço; vazio vira null', async () => {
    const { id } = (await chamar(T, 'POST', '/v1/contatos', completo)).json() as { id: string }
    const r = await chamar(T, 'PUT', `/v1/contatos/${id}`, {
      nome: 'Saturno Atacado', telefone: '81977776666', email: '', prioridade: 'urgente', temperatura: '',
      documento: '', endereco: { cidade: 'Olinda', uf: 'PE' }, valorEstimadoCentavos: 0,
    })
    expect(r.statusCode).toBe(200)
    const [c] = await dono`SELECT * FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c).toMatchObject({ nome: 'Saturno Atacado', email: null, prioridade: 'urgente', temperatura: null, razao_social: null })
    const tels = await dono`SELECT e164, principal FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${id}`
    expect(tels).toHaveLength(1)
    expect(tels[0]).toMatchObject({ e164: '+5581977776666', principal: true })
    expect(await dono`SELECT 1 FROM contato_documento WHERE tenant_id=${T} AND contato_id=${id}`).toHaveLength(0)
    const [e] = await dono`SELECT cidade, logradouro FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${id}`
    expect(e).toMatchObject({ cidade: 'Olinda', logradouro: null })
  })

  it('PUT com telefone principal de OUTRO contato → 422 no campo telefone', async () => {
    await chamar(T, 'POST', '/v1/contatos', { nome: 'Outro', telefone: '81955554444' })
    const { id } = (await chamar(T, 'POST', '/v1/contatos', { nome: 'Eu', telefone: '81944443333' })).json() as { id: string }
    const r = await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'Eu', telefone: '81955554444' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'validacao', campos: { telefone: expect.any(String) } })
  })

  it('422 tipificado POR CAMPO (vários de uma vez)', async () => {
    const r = await chamar(T, 'POST', '/v1/contatos', {
      nome: '  ', telefone: '123', documento: '11222333000180', email: 'sem-arroba',
      prioridade: 'critica', temperatura: 'gelado', valorEstimadoCentavos: 10.5, endereco: { cep: '123', uf: 'Pernambuco' },
    })
    expect(r.statusCode).toBe(422)
    const j = r.json() as { erro: string; campos: Record<string, string> }
    expect(j.erro).toBe('validacao')
    expect(j.campos).toMatchObject({ documento: 'CNPJ inválido', email: 'E-mail inválido', prioridade: 'Prioridade inválida',
      temperatura: 'Temperatura inválida', cep: 'CEP inválido', uf: 'UF inválida' })
    expect(Object.keys(j.campos)).toEqual(expect.arrayContaining(['nome', 'telefone', 'valorEstimadoCentavos']))
  })

  it('PUT em contato inexistente → 404; id inválido → 400', async () => {
    expect((await chamar(T, 'PUT', '/v1/contatos/a1c00000-9999-4000-8000-000000000009', { nome: 'x', telefone: '81999990000' })).statusCode).toBe(404)
    expect((await chamar(T, 'PUT', '/v1/contatos/xx', { nome: 'x', telefone: '81999990000' })).statusCode).toBe(400)
  })

  it('isolamento (RLS): outro tenant não edita; mesmo telefone/CNPJ lá é outro cadastro', async () => {
    const { id } = (await chamar(T, 'POST', '/v1/contatos', completo)).json() as { id: string }
    const r = await chamar(OUTRO, 'PUT', `/v1/contatos/${id}`, { nome: 'invasor', telefone: '81933332222' })
    expect(r.statusCode).toBe(404)
    const [c] = await dono`SELECT nome FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c!['nome']).toBe('Saturno Modas')
    const b = await chamar(OUTRO, 'POST', '/v1/contatos', completo)
    expect(b.statusCode).toBe(201)
    expect((b.json() as { id: string }).id).not.toBe(id)
  })

  it('CHECK do banco barra prioridade fora do domínio mesmo sem passar pela API', async () => {
    const { id } = (await chamar(T, 'POST', '/v1/contatos', { nome: 'Z', telefone: '81922221111' })).json() as { id: string }
    await expect(dono`UPDATE contato SET prioridade = 'x' WHERE tenant_id=${T} AND id=${id}`).rejects.toThrow()
  })
})

describe('PUT não pisa no dado do ERP; telefone duplicado; origem validada', () => {
  const O1 = 'a1c00000-5555-4000-8000-000000000001'
  const O_INATIVA = 'a1c00000-5555-4000-8000-000000000002'
  const O_OUTRO = 'a1c00000-5555-4000-8000-000000000003'
  const criar = async (corpo: Record<string, unknown>) => (await chamar(T, 'POST', '/v1/contatos', corpo)).json() as { id: string }
  const deErp = async (id: string) => {
    for (const tb of ['contato_telefone', 'contato_documento', 'contato_endereco'])
      await dono.unsafe(`UPDATE ${tb} SET fonte = 'erp' WHERE tenant_id = '${T}' AND contato_id = '${id}'`)
  }

  it('contato do ERP editado: linha do ERP intacta, manual vira principal, sem 500', async () => {
    const { id } = await criar({ ...completo, telefone: '81988887777' })
    await deErp(id)
    const r = await chamar(T, 'PUT', `/v1/contatos/${id}`, {
      nome: 'Saturno', telefone: '81977776666', whatsapp: false, documento: '52998224725',
      endereco: { logradouro: 'Rua Nova', cidade: 'Olinda', uf: 'PE' },
    })
    expect(r.statusCode).toBe(200)
    const tels = await dono`SELECT e164, principal, fonte, whatsapp FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${id} ORDER BY seq`
    expect(tels).toHaveLength(2)
    expect(tels[0]).toMatchObject({ e164: '+5581988887777', principal: false, fonte: 'erp', whatsapp: true })
    expect(tels[1]).toMatchObject({ e164: '+5581977776666', principal: true, fonte: 'manual', whatsapp: false })
    const docs = await dono`SELECT numero, fiscal, fonte FROM contato_documento WHERE tenant_id=${T} AND contato_id=${id} ORDER BY seq`
    expect(docs).toMatchObject([{ numero: '11222333000181', fiscal: false, fonte: 'erp' }, { numero: '52998224725', fiscal: true, fonte: 'manual' }])
    const ends = await dono`SELECT logradouro, cidade, principal, fonte FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${id} ORDER BY seq`
    expect(ends).toMatchObject([{ logradouro: 'Rua A', cidade: 'Recife', principal: false, fonte: 'erp' },
      { logradouro: 'Rua Nova', cidade: 'Olinda', principal: true, fonte: 'manual' }])

    // Segunda edição atualiza a linha manual no lugar (sem novas linhas); o ERP segue intacto.
    const r2 = await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'Saturno', telefone: '81977776666', endereco: { cidade: 'Paulista', uf: 'PE' } })
    expect(r2.statusCode).toBe(200)
    expect(await dono`SELECT 1 FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${id}`).toHaveLength(2)
    expect(await dono`SELECT 1 FROM contato_telefone WHERE tenant_id=${T} AND contato_id=${id}`).toHaveLength(2)
    // Apagar o endereço manual devolve o principal ao ERP.
    await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'Saturno', telefone: '81977776666', endereco: {} })
    const [e] = await dono`SELECT cidade, principal, fonte FROM contato_endereco WHERE tenant_id=${T} AND contato_id=${id}`
    expect(e).toMatchObject({ cidade: 'Recife', principal: true, fonte: 'erp' })
  })

  it('reenviar o que o ERP já mostra não cria linha manual', async () => {
    const { id } = await criar(completo)
    await deErp(id)
    const r = await chamar(T, 'PUT', `/v1/contatos/${id}`, completo)
    expect(r.statusCode).toBe(200)
    for (const tb of ['contato_telefone', 'contato_documento', 'contato_endereco'])
      expect(await dono.unsafe(`SELECT 1 FROM ${tb} WHERE tenant_id='${T}' AND contato_id='${id}' AND fonte='manual'`)).toHaveLength(0)
  })

  it('corrida no telefone principal (23505) → 422 no campo, no PUT e no POST', async () => {
    const a = await criar({ nome: 'A', telefone: '81911110001' })
    const b = await criar({ nome: 'B', telefone: '81911110002' })
    const alvo = '+5581900000000'
    // Outra transação (B) pega o número e só commita depois que a requisição já passou
    // do pré-check e travou no índice único — a corrida, determinística.
    const segurar = async (acao: () => Promise<{ statusCode: number; json: () => unknown }>) => {
      let soltar!: () => void
      const aberta = new Promise<void>((res) => { soltar = res })
      const tx = dono.begin(async (t) => {
        await t`UPDATE contato_telefone SET e164 = ${alvo}, chave_bloqueio = '558100000000' WHERE tenant_id=${T} AND contato_id=${b.id}`
        await aberta
      })
      await new Promise((r) => setTimeout(r, 200))
      const resposta = acao()
      await new Promise((r) => setTimeout(r, 300))
      soltar(); await tx
      return resposta
    }
    const put = await segurar(() => chamar(T, 'PUT', `/v1/contatos/${a.id}`, { nome: 'A', telefone: '81900000000' }))
    expect(put.statusCode).toBe(422)
    expect(put.json()).toMatchObject({ erro: 'validacao', campos: { telefone: 'Este telefone já é o principal de outro contato.' } })

    await dono`UPDATE contato_telefone SET e164 = '+5581911110002', chave_bloqueio = '558111110002' WHERE tenant_id=${T} AND contato_id=${b.id}`
    const post = await segurar(() => chamar(T, 'POST', '/v1/contatos', { nome: 'C', telefone: '81900000000' }))
    expect(post.statusCode).toBe(422)
    expect(post.json()).toMatchObject({ campos: { telefone: expect.any(String) } })
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id=${T} AND nome='C'`).toHaveLength(0)
  })

  it('origemId: inexistente, de outro tenant e inativa → 422; ativa passa; PUT sem origemId preserva', async () => {
    await dono`INSERT INTO origem (tenant_id, id, nome, ativa) VALUES (${T}, ${O1}, 'Feira', true), (${T}, ${O_INATIVA}, 'Antiga', false), (${OUTRO}, ${O_OUTRO}, 'Alheia', true)`
    for (const origemId of ['a1c00000-5555-4000-8000-0000000000ff', O_OUTRO, O_INATIVA]) {
      const p = await chamar(T, 'POST', '/v1/contatos', { nome: 'X', telefone: '81933330001', origemId })
      expect(p.statusCode).toBe(422)
      expect(p.json()).toMatchObject({ campos: { origemId: expect.any(String) } })
    }
    const { id } = await criar({ nome: 'Com origem', telefone: '81933330002', origemId: O1 })
    const [c] = await dono`SELECT origem_id FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c!['origem_id']).toBe(O1)
    expect((await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'Com origem', telefone: '81933330002', origemId: O_OUTRO })).statusCode).toBe(422)
    expect((await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'Novo nome', telefone: '81933330002' })).statusCode).toBe(200)
    const [c2] = await dono`SELECT origem_id, nome FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c2).toMatchObject({ origem_id: O1, nome: 'Novo nome' })
    // Desativada depois: a mesma origem já gravada segue aceita; null explícito limpa.
    await dono`UPDATE origem SET ativa = false WHERE tenant_id=${T} AND id=${O1}`
    expect((await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'N', telefone: '81933330002', origemId: O1 })).statusCode).toBe(200)
    expect((await chamar(T, 'PUT', `/v1/contatos/${id}`, { nome: 'N', telefone: '81933330002', origemId: null })).statusCode).toBe(200)
    const [c3] = await dono`SELECT origem_id FROM contato WHERE tenant_id=${T} AND id=${id}`
    expect(c3!['origem_id']).toBeNull()
  })
})

describe('consultas externas (porta + adaptador falso)', () => {
  beforeEach(() => { definirProvedorConsulta(falso) })

  it('CNPJ: sucesso no formato do domínio', async () => {
    const r = await chamar(T, 'GET', '/v1/consultas/cnpj/11.222.333%2F0001-81')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ razaoSocial: 'Saturno e Alves LTDA', nomeFantasia: 'Saturno Modas', situacao: 'ATIVA',
      endereco: { cep: '50000000', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Recife', uf: 'PE' } })
  })

  it('CNPJ com dígito errado → 422 por campo, sem chamar o fornecedor', async () => {
    const antes = chamadasCnpj
    const r = await chamar(T, 'GET', '/v1/consultas/cnpj/11222333000180')
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'validacao', campos: { cnpj: 'CNPJ inválido' } })
    expect(chamadasCnpj).toBe(antes)
  })

  it('fornecedor fora → 503 consulta.indisponivel (nunca 500)', async () => {
    const r = await chamar(T, 'GET', '/v1/consultas/cnpj/45723174000110')
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ erro: 'consulta.indisponivel' })
    expect((await chamar(T, 'GET', '/v1/consultas/cep/12345678')).statusCode).toBe(503)
  })

  it('CEP: sucesso, não encontrado e inválido', async () => {
    const ok = await chamar(T, 'GET', '/v1/consultas/cep/50000-000')
    expect(ok.json()).toMatchObject({ cep: '50000000', logradouro: 'Rua A', cidade: 'Recife', uf: 'PE' })
    expect((await chamar(T, 'GET', '/v1/consultas/cep/99999999')).json()).toMatchObject({ erro: 'consulta.nao_encontrado' })
    expect((await chamar(T, 'GET', '/v1/consultas/cep/123')).statusCode).toBe(422)
  })

  it('exige tenant', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/consultas/cep/50000000' })
    expect(r.statusCode).toBe(401)
  })
})

describe('adaptador BrasilAPI e cache (fetch simulado)', () => {
  it('mapeia o JSON do fornecedor e vira indisponível em erro/timeout', async () => {
    const fetchOk = (async () => new Response(JSON.stringify({
      razao_social: 'ACME LTDA', nome_fantasia: '', descricao_situacao_cadastral: 'ATIVA', cep: '50000000',
      descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '5', complemento: '', bairro: 'CENTRO', municipio: 'RECIFE', uf: 'PE',
    }), { status: 200 })) as typeof fetch
    const r = await criarProvedorBrasilApi(fetchOk).consultarCnpj('11222333000181')
    expect(r).toMatchObject({ ok: true, dado: { razaoSocial: 'ACME LTDA', nomeFantasia: null,
      endereco: { logradouro: 'RUA DAS FLORES', cidade: 'RECIFE', complemento: null } } })

    const fetch502 = (async () => new Response('x', { status: 502 })) as typeof fetch
    expect(await criarProvedorBrasilApi(fetch502).consultarCep('50000000')).toEqual({ ok: false, erro: 'consulta.indisponivel' })
    const fetchLanca = (async () => { throw new Error('timeout') }) as typeof fetch
    expect(await criarProvedorBrasilApi(fetchLanca).consultarCep('50000000')).toEqual({ ok: false, erro: 'consulta.indisponivel' })
    const fetch404 = (async () => new Response('x', { status: 404 })) as typeof fetch
    expect(await criarProvedorBrasilApi(fetch404).consultarCep('50000000')).toEqual({ ok: false, erro: 'consulta.nao_encontrado' })
  })

  it('cache de 24 h: sucesso é reaproveitado e expira; indisponível não é cacheado', async () => {
    let t = 0
    let n = 0
    const base: ProvedorConsulta = {
      consultarCnpj: async () => { n++; return { ok: false, erro: 'consulta.indisponivel' } },
      consultarCep: async (cep) => { n++; return { ok: true, dado: { cep, logradouro: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null } } },
    }
    const c = comCache(base, () => t)
    await c.consultarCep('50000000'); await c.consultarCep('50000000')
    expect(n).toBe(1)
    t += 24 * 60 * 60 * 1000 + 1
    await c.consultarCep('50000000')
    expect(n).toBe(2)
    await c.consultarCnpj('11222333000181'); await c.consultarCnpj('11222333000181')
    expect(n).toBe(4)
  })
})
