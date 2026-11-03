import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { definirArquivosBucket, type ArquivosBucket } from '../crm/arquivos-bucket.js'

/**
 * F3 — formulários públicos. A pergunta de segurança é a mesma da LP: uma rota SEM token escreve no
 * tenant certo e só nele? Fixa também: CRUD + papel, validação dos campos, merge por telefone,
 * honeypot, rate-limit, consentimento, anexo, etapa destino e CSV.
 */
const T = 'f3f00000-0000-4000-8000-000000000001'
const T2 = 'f3f00000-0000-4000-8000-000000000002'
const PV = 'f3f00000-1111-4000-8000-000000000001'
const PV2 = 'f3f00000-1111-4000-8000-000000000002'
const PLANO = 'f3f00000-3333-4000-8000-000000000001'
const MODELO = 'f3f00000-4444-4000-8000-000000000001'
const U_T = 'f3f00000-5555-4000-8000-000000000001'
const U_ADMIN = 'f3f00000-5555-4000-8000-000000000002'
const U_T2 = 'f3f00000-5555-4000-8000-000000000003'
const ETAPA = 'f3f00000-6666-4000-8000-000000000001'
const ETAPA_GANHO = 'f3f00000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const objetos = new Map<string, Buffer>()
let bucketOn = true
const bucketFalso: ArquivosBucket = {
  disponivel: () => bucketOn,
  subir: async (k, b) => { objetos.set(k, b) },
  remover: async (k) => { objetos.delete(k) },
  urlAssinada: async (k) => `https://fake/${k}`,
}

const adm = (t: string, m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
/** SEM cabeçalho de tenant: é assim que o navegador de quem preenche chama. */
const pub = (m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>, ip?: string) =>
  app.inject({ method: m, url, headers: ip ? { 'x-forwarded-for': ip } : {}, ...(corpo ? { payload: corpo } : {}) })
const papelDe = (t: string, u: string, p: string) =>
  dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, NULL, ${p})
       ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

const uid = (n: number) => `f3f00000-9999-4000-8000-${String(n).padStart(12, '0')}`
const CAMPOS = [
  { id: uid(1), tipo: 'texto', rotulo: 'Nome', obrigatorio: true, referencia: true, opcoes: [], condicoes: {} },
  { id: uid(2), tipo: 'telefone', rotulo: 'WhatsApp', obrigatorio: true, referencia: false, opcoes: [], condicoes: {} },
  { id: uid(3), tipo: 'email', rotulo: 'E-mail', obrigatorio: false, referencia: false, opcoes: [], condicoes: {} },
  { id: uid(4), tipo: 'selecao_condicional', rotulo: 'Tipo', obrigatorio: true, referencia: false,
    opcoes: ['Empresa', 'Pessoa'], condicoes: { Empresa: [uid(5)], Pessoa: [] } },
  { id: uid(5), tipo: 'cnpj', rotulo: 'CNPJ', obrigatorio: true, referencia: false, opcoes: [], condicoes: {} },
  { id: uid(6), tipo: 'anexo', rotulo: 'Contrato', obrigatorio: false, referencia: false, opcoes: [], condicoes: {} },
]
const CNPJ = '11222333000181'

async function criarForm(t: string, extra: Record<string, unknown> = {}, campos: unknown[] = CAMPOS) {
  const r = await adm(t, 'POST', '/v1/formularios', { nome: 'Cadastro de clientes', ...extra })
  expect(r.statusCode).toBe(201)
  const f = r.json() as { id: string; chavePublica: string; slug: string }
  const c = await adm(t, 'PUT', `/v1/formularios/${f.id}/campos`, { campos })
  expect(c.statusCode).toBe(200)
  return f
}

function multipart(dados: unknown, arquivo?: { campo: string; nome: string; mime: string; bytes: Buffer }) {
  const f = 'frontEIRAf3x'
  const partes: Buffer[] = [Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n${JSON.stringify(dados)}\r\n`)]
  if (arquivo) {
    partes.push(Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="${arquivo.campo}"; filename="${arquivo.nome}"\r\nContent-Type: ${arquivo.mime}\r\n\r\n`))
    partes.push(arquivo.bytes, Buffer.from('\r\n'))
  }
  partes.push(Buffer.from(`--${f}--\r\n`))
  return { payload: Buffer.concat(partes), headers: { 'content-type': `multipart/form-data; boundary=${f}` } }
}

let ipN = 0
const novoIp = () => `10.3.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`
const envio = (chave: string, respostas: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  pub('POST', `/publico/f/${chave}/respostas`, { respostas, consentimento: true, ...extra }, novoIp())
const PESSOA = (tel = '81 99999-1111', nome = 'Ana Souza') => ({ [uid(1)]: nome, [uid(2)]: tel, [uid(4)]: 'Pessoa' })

async function limpar() {
  for (const tb of ['formulario_resposta', 'formulario_campo', 'formulario', 'contato_arquivo', 'consentimento_contato',
    'oportunidade_etapa_historico', 'oportunidade', 'carteira_atribuicao', 'contato_documento', 'contato_telefone', 'contato', 'origem']) {
    await dono.unsafe(`DELETE FROM ${tb} WHERE tenant_id IN ('${T}', '${T2}')`)
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  definirArquivosBucket(bucketFalso)
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-f3f', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-f3f', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [T2, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_T}, ${'dev-' + T}, 'Vera', 'vera@f3.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U_ADMIN}, 'sub-admin-f3', 'Ada', 'ada@f3.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T2}, ${U_T2}, ${'dev-' + T2}, 'Beto', 'beto@f3.test') ON CONFLICT DO NOTHING`
  await papelDe(T, U_ADMIN, 'admin')
  await papelDe(T2, U_T2, 'admin')
  for (const [t, id, chave, tipo, ordem] of [[T, ETAPA, 'f3_novo', 'aberto', 1], [T, ETAPA_GANHO, 'f3_ganho', 'ganho', 2]] as const) {
    await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${t}, ${id}, ${ordem}, ${chave}, ${chave}, ${tipo}) ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  await limpar()
  await papelDe(T, U_T, 'gestor')
  bucketOn = true
  objetos.clear()
})

afterAll(async () => {
  await limpar()
  await dono`DELETE FROM funil_etapa WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario_filial WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${T2})`
  for (const t of [T, T2]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  definirArquivosBucket()
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('admin: CRUD e papel', () => {
  it('cria com slug do nome, chave pública aleatória e lista por cursor', async () => {
    const f = await criarForm(T)
    expect(f.slug).toBe('cadastro-de-clientes')
    expect(f.chavePublica).toMatch(/^[a-z0-9]{24}$/)
    const lista = await adm(T, 'GET', '/v1/formularios')
    expect(lista.json().itens).toHaveLength(1)
    expect(lista.json().itens[0].totalRespostas).toBe(0)
    expect(lista.json().proximoCursor).toBeNull()
    expect((await adm(T, 'GET', '/v1/formularios?cursor=lixo')).statusCode).toBe(422)
  })

  it('slug repetido: automático ganha sufixo, explícito dá 409', async () => {
    await criarForm(T)
    const auto = await adm(T, 'POST', '/v1/formularios', { nome: 'Cadastro de clientes' })
    expect(auto.json().slug).toBe('cadastro-de-clientes-2')
    const explicito = await adm(T, 'POST', '/v1/formularios', { nome: 'X', slug: 'cadastro-de-clientes' })
    expect(explicito.statusCode).toBe(409)
  })

  it('PATCH altera, valida referências do tenant e DELETE remove', async () => {
    const f = await criarForm(T)
    const ok = await adm(T, 'PATCH', `/v1/formularios/${f.id}`, { titulo: 'Novo título', ativo: false, etapaDestinoId: ETAPA })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ titulo: 'Novo título', ativo: false, etapaDestinoId: ETAPA })
    const ganho = await adm(T, 'PATCH', `/v1/formularios/${f.id}`, { etapaDestinoId: ETAPA_GANHO })
    expect(ganho.statusCode).toBe(422)
    expect(ganho.json().campos.etapaDestinoId).toBeTruthy()
    const alheia = await adm(T, 'PATCH', `/v1/formularios/${f.id}`, { origemId: randomUUID() })
    expect(alheia.statusCode).toBe(422)
    expect((await adm(T, 'DELETE', `/v1/formularios/${f.id}`)).statusCode).toBe(204)
    expect((await adm(T, 'GET', `/v1/formularios/${f.id}`)).statusCode).toBe(404)
  })

  it('só gestor+: vendedor recebe 403 em tudo', async () => {
    const f = await criarForm(T)
    await papelDe(T, U_T, 'vendedor')
    for (const [m, url] of [['GET', '/v1/formularios'], ['GET', `/v1/formularios/${f.id}`], ['GET', `/v1/formularios/${f.id}/respostas`],
      ['GET', `/v1/formularios/${f.id}/respostas.csv`]] as const) {
      expect((await adm(T, m, url)).statusCode).toBe(403)
    }
    expect((await adm(T, 'POST', '/v1/formularios', { nome: 'x' })).statusCode).toBe(403)
    expect((await adm(T, 'POST', `/v1/formularios/${f.id}/token`)).statusCode).toBe(403)
  })

  it('outro tenant não enxerga nem altera (RLS)', async () => {
    const f = await criarForm(T)
    expect((await adm(T2, 'GET', `/v1/formularios/${f.id}`)).statusCode).toBe(404)
    expect((await adm(T2, 'PATCH', `/v1/formularios/${f.id}`, { nome: 'x' })).statusCode).toBe(404)
    expect((await adm(T2, 'PUT', `/v1/formularios/${f.id}/campos`, { campos: CAMPOS })).statusCode).toBe(404)
    expect((await adm(T2, 'GET', '/v1/formularios')).json().itens).toHaveLength(0)
  })

  it('token: devolvido uma vez, só o hash fica, regerar invalida o anterior', async () => {
    const f = await criarForm(T)
    const t1 = (await adm(T, 'POST', `/v1/formularios/${f.id}/token`)).json().token as string
    expect(t1).toMatch(/^fmt_[0-9a-f]{48}$/)
    const [linha] = await dono`SELECT token_hash FROM formulario WHERE id = ${f.id}`
    expect(linha!['token_hash']).not.toBe(t1)
    expect(JSON.stringify((await adm(T, 'GET', `/v1/formularios/${f.id}`)).json())).not.toContain(t1)
    expect((await adm(T, 'GET', `/v1/formularios/${f.id}`)).json().temToken).toBe(true)
    const t2 = (await adm(T, 'POST', `/v1/formularios/${f.id}/token`)).json().token as string
    expect(t2).not.toBe(t1)
  })
})

describe('admin: campos', () => {
  it('substitui a lista, preserva ids e força o telefone obrigatório', async () => {
    const f = await criarForm(T, {}, [
      { ...CAMPOS[0] }, { ...CAMPOS[1], obrigatorio: false },
    ])
    const r = (await adm(T, 'GET', `/v1/formularios/${f.id}`)).json()
    expect(r.campos.map((c: { id: string }) => c.id)).toEqual([uid(1), uid(2)])
    expect(r.campos[1].obrigatorio).toBe(true)
    const novo = await adm(T, 'PUT', `/v1/formularios/${f.id}/campos`, { campos: [CAMPOS[1], CAMPOS[0]] })
    expect(novo.json().campos.map((c: { id: string }) => c.id)).toEqual([uid(2), uid(1)])
  })

  it('validações: sem telefone, condicional para campo de fora, duas referências, mais de 60', async () => {
    const f = await criarForm(T)
    const put = (campos: unknown[]) => adm(T, 'PUT', `/v1/formularios/${f.id}/campos`, { campos })
    const semTel = await put([CAMPOS[0]])
    expect(semTel.statusCode).toBe(422)
    expect(semTel.json()).toMatchObject({ erro: 'validacao', campos: { campos: expect.stringMatching(/telefone/) } })
    const fora = await put([CAMPOS[1], { ...CAMPOS[3], condicoes: { Empresa: [uid(77)], Pessoa: [] } }])
    expect(fora.json().campos['campos.1']).toMatch(/não existe/)
    const duas = await put([CAMPOS[0], { ...CAMPOS[1] }, { ...CAMPOS[2], tipo: 'texto', referencia: true }, { ...CAMPOS[0], id: uid(9) }])
    expect(duas.statusCode).toBe(422)
    const muitos = await put(Array.from({ length: 61 }, (_, i) => ({ ...CAMPOS[0], id: uid(100 + i), referencia: false, tipo: i === 0 ? 'telefone' : 'texto' })))
    expect(muitos.json().campos.campos).toMatch(/60/)
    expect((await put([{ ...CAMPOS[1], tipo: 'inventado' }])).statusCode).toBe(422)
  })
})

describe('público: definição', () => {
  it('devolve a definição SEM dados internos', async () => {
    const f = await criarForm(T, { etapaDestinoId: ETAPA, responsavelPadraoId: U_T, descricao: 'Preencha' })
    const r = await pub('GET', `/publico/f/${f.chavePublica}`)
    expect(r.statusCode).toBe(200)
    const corpo = r.json()
    expect(corpo.titulo).toBe('Cadastro de clientes')
    expect(corpo.campos).toHaveLength(6)
    expect(corpo.textoConsentimento).toMatch(/autoriza/)
    const bruto = r.body
    for (const proibido of [T, U_T, ETAPA, 'etapa', 'responsavel', 'tenant', 'token', 'filial', 'origem']) {
      expect(bruto.toLowerCase()).not.toContain(proibido.toLowerCase())
    }
  })

  it('usa o texto de consentimento do tenant', async () => {
    const f = await criarForm(T)
    await dono`UPDATE tenant SET texto_consentimento = 'Aceito o tratamento dos meus dados pela Loja A.' WHERE id = ${T}`
    const r = await pub('GET', `/publico/f/${f.chavePublica}`)
    expect(r.json().textoConsentimento).toBe('Aceito o tratamento dos meus dados pela Loja A.')
    await dono`UPDATE tenant SET texto_consentimento = NULL WHERE id = ${T}`
  })

  it('inativo, inexistente e chave malformada são o mesmo 404', async () => {
    const f = await criarForm(T)
    await adm(T, 'PATCH', `/v1/formularios/${f.id}`, { ativo: false })
    expect((await pub('GET', `/publico/f/${f.chavePublica}`)).statusCode).toBe(404)
    expect((await pub('GET', `/publico/f/${'a'.repeat(24)}`)).statusCode).toBe(404)
    expect((await pub('GET', '/publico/f/..%2F..')).statusCode).toBe(404)
    expect((await envio(f.chavePublica, PESSOA())).statusCode).toBe(404)
  })
})

describe('público: envio', () => {
  it('cria contato novo com origem, filial, responsável, consentimento e oportunidade', async () => {
    const filial = randomUUID()
    await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${T}, ${filial}, 'Matriz')`
    const f = await criarForm(T, { filialId: filial, responsavelPadraoId: U_T, etapaDestinoId: ETAPA })
    const r = await envio(f.chavePublica, { ...PESSOA(), [uid(3)]: 'ANA@exemplo.com' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ ok: true, mensagem: expect.any(String) })

    const [c] = await dono`SELECT c.id, c.nome, c.email, c.filial_id, c.origem_carga, o.nome AS origem
                            FROM contato c JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
                           WHERE c.tenant_id = ${T}`
    expect(c).toMatchObject({ nome: 'Ana Souza', email: 'ana@exemplo.com', filial_id: filial, origem_carga: 'formulario', origem: 'Formulário: Cadastro de clientes' })
    const [tel] = await dono`SELECT e164, principal FROM contato_telefone WHERE tenant_id = ${T} AND contato_id = ${c!['id']}`
    expect(tel).toMatchObject({ e164: '+5581999991111', principal: true })
    const [cons] = await dono`SELECT tipo, concedido FROM consentimento_contato WHERE tenant_id = ${T}`
    expect(cons).toMatchObject({ tipo: 'whatsapp', concedido: true })
    const [cart] = await dono`SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${T} AND contato_id = ${c!['id']} AND ate IS NULL`
    expect(cart!['usuario_id']).toBe(U_T)
    const [op] = await dono`SELECT etapa_id, responsavel_id, estado FROM oportunidade WHERE tenant_id = ${T}`
    expect(op).toMatchObject({ etapa_id: ETAPA, responsavel_id: U_T, estado: 'aberta' })
    const [resp] = await dono`SELECT respostas, ip_hash, consentimento_texto, contato_novo FROM formulario_resposta WHERE tenant_id = ${T}`
    expect(resp!['contato_novo']).toBe(true)
    expect(resp!['ip_hash']).toMatch(/^[0-9a-f]{64}$/)
    expect(resp!['consentimento_texto']).toMatch(/autoriza/)
    expect((resp!['respostas'] as Record<string, unknown>)[uid(4)]).toBe('Pessoa')
  })

  it('usa a origem do formulário quando configurada', async () => {
    const origem = randomUUID()
    await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, ${origem}, 'Feira')`
    const f = await criarForm(T, { origemId: origem })
    await envio(f.chavePublica, PESSOA())
    const [c] = await dono`SELECT origem_id FROM contato WHERE tenant_id = ${T}`
    expect(c!['origem_id']).toBe(origem)
    expect(await dono`SELECT 1 FROM origem WHERE tenant_id = ${T} AND nome LIKE 'Formulário:%'`).toHaveLength(0)
  })

  it('telefone já cadastrado MESCLA: não duplica, só preenche o que faltava, e a resposta é igual', async () => {
    const f = await criarForm(T, { etapaDestinoId: ETAPA })
    const existente = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${existente}, 'Nome do ERP', 'erp', true)`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${existente}, 1, '+5581999991111', ${'558199991111'}, true, true, 'erp')`
    const novo = await envio(f.chavePublica, { ...PESSOA('(81) 99999-1111', 'Outro Nome'), [uid(3)]: 'a@b.com' })
    expect(novo.statusCode).toBe(201)
    const contatos = await dono`SELECT id, nome, email FROM contato WHERE tenant_id = ${T}`
    expect(contatos).toHaveLength(1)
    expect(contatos[0]).toMatchObject({ id: existente, nome: 'Nome do ERP', email: 'a@b.com' })
    const [resp] = await dono`SELECT contato_id, contato_novo FROM formulario_resposta WHERE tenant_id = ${T}`
    expect(resp).toMatchObject({ contato_id: existente, contato_novo: false })
    expect(await dono`SELECT 1 FROM oportunidade WHERE tenant_id = ${T} AND contato_id = ${existente}`).toHaveLength(1)
    // segundo envio: mesma resposta, sem segunda oportunidade aberta
    const de_novo = await envio(f.chavePublica, PESSOA('81999991111'))
    expect(de_novo.statusCode).toBe(201)
    expect(de_novo.json()).toEqual(novo.json())
    expect(await dono`SELECT 1 FROM oportunidade WHERE tenant_id = ${T} AND contato_id = ${existente}`).toHaveLength(1)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(1)
  })

  it('CNPJ do campo condicional vira o documento do contato', async () => {
    const f = await criarForm(T)
    const r = await envio(f.chavePublica, { [uid(1)]: 'Loja Z', [uid(2)]: '81988887777', [uid(4)]: 'Empresa', [uid(5)]: '11.222.333/0001-81' })
    expect(r.statusCode).toBe(201)
    const [d] = await dono`SELECT tipo, numero FROM contato_documento WHERE tenant_id = ${T}`
    expect(d).toMatchObject({ tipo: 'cnpj', numero: CNPJ })
  })

  it('validação por campo → 422 { erro: validacao, campos }; escondido não é exigido e é descartado', async () => {
    const f = await criarForm(T)
    const ruim = await envio(f.chavePublica, { [uid(2)]: '123', [uid(3)]: 'nao-e-email', [uid(4)]: 'Empresa', [uid(5)]: '111' })
    expect(ruim.statusCode).toBe(422)
    const campos = ruim.json().campos
    expect(ruim.json().erro).toBe('validacao')
    expect(Object.keys(campos).sort()).toEqual([uid(1), uid(2), uid(3), uid(5)].sort())
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)

    const ok = await envio(f.chavePublica, { ...PESSOA(), [uid(5)]: 'lixo que a pessoa nunca viu' })
    expect(ok.statusCode).toBe(201)
    const [resp] = await dono`SELECT respostas FROM formulario_resposta WHERE tenant_id = ${T}`
    expect((resp!['respostas'] as Record<string, unknown>)[uid(5)]).toBeUndefined()
  })

  it('consentimento é obrigatório', async () => {
    const f = await criarForm(T)
    const r = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA(), consentimento: false }, novoIp())
    expect(r.statusCode).toBe(422)
    expect(r.json().campos.consentimento).toBeTruthy()
    const sem = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA() }, novoIp())
    expect(sem.statusCode).toBe(422)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)
  })

  it('honeypot preenchido: responde sucesso e NÃO grava', async () => {
    const f = await criarForm(T)
    const r = await envio(f.chavePublica, PESSOA(), { apelido: 'sou um robo' })
    expect(r.statusCode).toBe(201)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM formulario_resposta WHERE tenant_id = ${T}`).toHaveLength(0)
  })

  it('rate-limit por IP+chave → 429 e nada além do teto é gravado', async () => {
    const f = await criarForm(T)
    const ip = novoIp()
    const codigos: number[] = []
    for (let i = 0; i < 10; i++) {
      const r = await pub('POST', `/publico/f/${f.chavePublica}/respostas`,
        { respostas: PESSOA(`81 9${String(1000 + i).padStart(4, '0')}-0000`), consentimento: true }, ip)
      codigos.push(r.statusCode)
    }
    expect(codigos.filter((c) => c === 201)).toHaveLength(8)
    expect(codigos.filter((c) => c === 429)).toHaveLength(2)
    expect(await dono`SELECT 1 FROM formulario_resposta WHERE tenant_id = ${T}`).toHaveLength(8)
    // outro IP não é afetado
    expect((await envio(f.chavePublica, PESSOA('81 98888-0000'))).statusCode).toBe(201)
  })

  it('dois tenants: a chave de um só escreve no tenant dele', async () => {
    const a = await criarForm(T)
    const b = await criarForm(T2)
    await envio(a.chavePublica, PESSOA('81 91111-0001', 'Da A'))
    await envio(b.chavePublica, PESSOA('81 91111-0001', 'Da B'))
    const emA = await dono`SELECT nome FROM contato WHERE tenant_id = ${T}`
    const emB = await dono`SELECT nome FROM contato WHERE tenant_id = ${T2}`
    expect(emA.map((x) => x['nome'])).toEqual(['Da A'])
    expect(emB.map((x) => x['nome'])).toEqual(['Da B'])
    expect((await adm(T2, 'GET', `/v1/formularios/${a.id}/respostas`)).statusCode).toBe(404)
  })

  it('anexo: sobe ao bucket com o prefixo do tenant e vira contato_arquivo; tipo e tamanho são recusados', async () => {
    const f = await criarForm(T)
    const dados = { respostas: PESSOA(), consentimento: true }
    const ok = multipart(dados, { campo: uid(6), nome: 'contrato.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 teste') })
    const r = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`, headers: { ...ok.headers, 'x-forwarded-for': novoIp() }, payload: ok.payload })
    expect(r.statusCode).toBe(201)
    const [arq] = await dono`SELECT nome, chave_bucket, tipo_mime FROM contato_arquivo WHERE tenant_id = ${T}`
    expect(arq).toMatchObject({ nome: 'contrato.pdf', tipo_mime: 'application/pdf' })
    expect(String(arq!['chave_bucket'])).toMatch(new RegExp(`^tenant/${T}/`))
    expect(objetos.has(String(arq!['chave_bucket']))).toBe(true)
    const [resp] = await dono`SELECT respostas FROM formulario_resposta WHERE tenant_id = ${T}`
    expect((resp!['respostas'] as Record<string, { nome: string }>)[uid(6)]!.nome).toBe('contrato.pdf')

    const exe = multipart({ respostas: PESSOA('81 97777-0000'), consentimento: true }, { campo: uid(6), nome: 'virus.exe', mime: 'application/x-msdownload', bytes: Buffer.from('MZ') })
    const rExe = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`, headers: { ...exe.headers, 'x-forwarded-for': novoIp() }, payload: exe.payload })
    expect(rExe.statusCode).toBe(422)
    expect(rExe.json().campos[uid(6)]).toMatch(/Tipo não permitido/)

    const grande = multipart({ respostas: PESSOA('81 96666-0000'), consentimento: true }, { campo: uid(6), nome: 'grande.pdf', mime: 'application/pdf', bytes: Buffer.alloc(10 * 1024 * 1024 + 10, 1) })
    const rG = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`, headers: { ...grande.headers, 'x-forwarded-for': novoIp() }, payload: grande.payload })
    expect(rG.statusCode).toBe(422)
    expect(rG.json().campos[uid(6)]).toMatch(/10 MB/)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(1)
  })

  it('anexo sem bucket configurado → 503 tipado, nada gravado', async () => {
    bucketOn = false
    const f = await criarForm(T)
    const m = multipart({ respostas: PESSOA(), consentimento: true }, { campo: uid(6), nome: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
    const r = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`, headers: { ...m.headers, 'x-forwarded-for': novoIp() }, payload: m.payload })
    expect(r.statusCode).toBe(503)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)
  })
})

describe('admin: respostas e CSV', () => {
  it('lista por cursor e exporta CSV com as colunas dos campos', async () => {
    const f = await criarForm(T)
    for (let i = 0; i < 3; i++) await envio(f.chavePublica, { ...PESSOA(`81 9000${i}-0000`, `Pessoa ${i}`), [uid(3)]: `p${i}@x.com` })
    await envio(f.chavePublica, { [uid(1)]: '=HYPERLINK("http://x")', [uid(2)]: '81 95555-0000', [uid(4)]: 'Empresa', [uid(5)]: CNPJ })

    const pg = await adm(T, 'GET', `/v1/formularios/${f.id}/respostas`)
    expect(pg.statusCode).toBe(200)
    expect(pg.json().itens).toHaveLength(4)
    expect(pg.json().itens[0]).toMatchObject({ contatoNovo: true, contatoNome: expect.any(String) })
    expect((await adm(T, 'GET', `/v1/formularios/${f.id}/respostas?cursor=x`)).statusCode).toBe(422)
    const lista = (await adm(T, 'GET', '/v1/formularios')).json()
    expect(lista.itens[0].totalRespostas).toBe(4)

    const csv = await adm(T, 'GET', `/v1/formularios/${f.id}/respostas.csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toMatch(/text\/csv/)
    const linhas = csv.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(linhas[0]).toBe('Data;Contato;Contato novo;Nome;WhatsApp;E-mail;Tipo;CNPJ;Contrato')
    expect(linhas).toHaveLength(5)
    expect(csv.body).toContain('p1@x.com')
    // proteção contra fórmula
    expect(csv.body).toContain(`'=HYPERLINK`)
    // outro tenant não exporta
    expect((await adm(T2, 'GET', `/v1/formularios/${f.id}/respostas.csv`)).statusCode).toBe(404)
  })
})
