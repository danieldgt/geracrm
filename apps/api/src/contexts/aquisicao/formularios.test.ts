import { createHash, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { definirArquivosBucket, type ArquivosBucket } from '../crm/arquivos-bucket.js'
import { definirMaxUploadsSimultaneos } from './rotas-formulario-publico.js'

/**
 * F3 — formulários públicos. A pergunta de segurança é a mesma da LP: uma rota SEM token escreve no
 * tenant certo e só nele? Fixa também: CRUD + papel, validação dos campos, merge por telefone,
 * honeypot, rate-limit, consentimento, anexo, etapa destino e CSV.
 *
 * Revisão de segurança (F3b): upload FORA da transação com compensação, IP real (`trustProxy`) no
 * limite, contato existente INTOCADO (resposta pendente + "Aplicar ao contato"), multipart com tetos e
 * semáforo, assinatura do arquivo, hash do texto de consentimento e formulário que nasce inativo.
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
/**
 * Sonda do A1: no instante do upload, existe transação da API parada no meio da gravação do formulário?
 * (antes da correção o `subir` rodava DENTRO da transação, segurando a conexão do pool durante a rede.)
 */
const transacoesDuranteUpload: number[] = []
const bucketFalso: ArquivosBucket = {
  disponivel: () => bucketOn,
  subir: async (k, b) => {
    const [r] = await dono`SELECT count(*)::int AS n FROM pg_stat_activity
                            WHERE state LIKE 'idle in transaction%'
                              AND (query ILIKE '%consentimento_contato%' OR query ILIKE '%INSERT INTO contato%'
                                   OR query ILIKE '%formulario_resposta%')`
    transacoesDuranteUpload.push(Number(r!['n']))
    objetos.set(k, b)
  },
  remover: async (k) => { objetos.delete(k) },
  urlAssinada: async (k) => `https://fake/${k}`,
}

const adm = (t: string, m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })
/** SEM cabeçalho de tenant: é assim que o navegador de quem preenche chama. */
const pub = (m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>, ip?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: m, url, headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), ...extra }, ...(corpo ? { payload: corpo } : {}) })
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

/** Cria, põe os campos e PUBLICA (o formulário nasce inativo). `ativar: false` deixa como nasceu. */
async function criarForm(t: string, extra: Record<string, unknown> = {}, campos: unknown[] = CAMPOS, ativar = true) {
  const r = await adm(t, 'POST', '/v1/formularios', { nome: 'Cadastro de clientes', ...extra })
  expect(r.statusCode).toBe(201)
  const f = r.json() as { id: string; chavePublica: string; slug: string }
  const c = await adm(t, 'PUT', `/v1/formularios/${f.id}/campos`, { campos })
  expect(c.statusCode).toBe(200)
  if (ativar) expect((await adm(t, 'PATCH', `/v1/formularios/${f.id}`, { ativo: true })).statusCode).toBe(200)
  return f
}

interface Arquivo { campo: string; nome: string; mime: string; bytes: Buffer }
function multipart(dados: unknown, arquivo?: Arquivo | Arquivo[], dadosRepetido = false) {
  const f = 'frontEIRAf3x'
  const parteDados = Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n${JSON.stringify(dados)}\r\n`)
  const partes: Buffer[] = dadosRepetido ? [parteDados, parteDados] : [parteDados]
  for (const a of arquivo === undefined ? [] : Array.isArray(arquivo) ? arquivo : [arquivo]) {
    partes.push(Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="${a.campo}"; filename="${a.nome}"\r\nContent-Type: ${a.mime}\r\n\r\n`))
    partes.push(a.bytes, Buffer.from('\r\n'))
  }
  partes.push(Buffer.from(`--${f}--\r\n`))
  return { payload: Buffer.concat(partes), headers: { 'content-type': `multipart/form-data; boundary=${f}` } }
}

let ipN = 0
const novoIp = () => `10.3.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`
/** O hash do texto de consentimento que a página recebeu no GET (M4): o POST tem de devolvê-lo. */
const hashDe = async (chave: string): Promise<string | undefined> =>
  (await pub('GET', `/publico/f/${chave}`)).json().textoConsentimentoHash
const envio = async (chave: string, respostas: Record<string, unknown>, extra: Record<string, unknown> = {}, ip = novoIp()) =>
  pub('POST', `/publico/f/${chave}/respostas`, { respostas, consentimento: true, textoConsentimentoHash: await hashDe(chave), ...extra }, ip)
const enviarMultipart = async (chave: string, m: { payload: Buffer; headers: Record<string, string> }, ip = novoIp()) =>
  app.inject({ method: 'POST', url: `/publico/f/${chave}/respostas`, headers: { ...m.headers, 'x-forwarded-for': ip }, payload: m.payload })
const PDF = Buffer.from('%PDF-1.4 teste')
const PESSOA = (tel = '81 99999-1111', nome = 'Ana Souza') => ({ [uid(1)]: nome, [uid(2)]: tel, [uid(4)]: 'Pessoa' })

async function limpar() {
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${T2})`
  for (const tb of ['formulario_resposta_anexo', 'formulario_resposta', 'formulario_campo', 'formulario', 'contato_arquivo', 'consentimento_contato',
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
  transacoesDuranteUpload.length = 0
  definirMaxUploadsSimultaneos()
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
    expect(corpo.textoConsentimentoHash).toBe(createHash('sha256').update(corpo.textoConsentimento).digest('hex'))
    expect(r.headers['x-content-type-options']).toBe('nosniff')
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
    const consents = await dono`SELECT tipo, concedido, origem, formulario_resposta_id FROM consentimento_contato WHERE tenant_id = ${T}`
    const [respId] = await dono`SELECT id FROM formulario_resposta WHERE tenant_id = ${T}`
    // LGPD: origem `formulario`, apontando para a resposta; marketing NÃO foi pedido → nem registro, nem flag.
    expect(consents).toEqual([{ tipo: 'whatsapp', concedido: true, origem: 'formulario', formulario_resposta_id: respId!['id'] }])
    const [flags] = await dono`SELECT recebe_campanhas FROM contato WHERE tenant_id = ${T}`
    expect(flags!['recebe_campanhas']).toBe(false)
    const [cart] = await dono`SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${T} AND contato_id = ${c!['id']} AND ate IS NULL`
    expect(cart!['usuario_id']).toBe(U_T)
    const [op] = await dono`SELECT etapa_id, responsavel_id, estado FROM oportunidade WHERE tenant_id = ${T}`
    expect(op).toMatchObject({ etapa_id: ETAPA, responsavel_id: U_T, estado: 'aberta' })
    const [resp] = await dono`SELECT respostas, ip_hash, consentimento_texto, contato_novo, verificacao FROM formulario_resposta WHERE tenant_id = ${T}`
    expect(resp!['contato_novo']).toBe(true)
    expect(resp!['ip_hash']).toMatch(/^[0-9a-f]{64}$/)
    expect(resp!['verificacao']).toBe('nao_se_aplica')
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

  /**
   * ⚠️ A3 — antes, o anônimo que digitasse o telefone de um cliente GRAVAVA e-mail, origem, filial e
   * documento na ficha dele, registrava consentimento em nome dele e o punha no funil. Agora o contato
   * fica intocado: só nasce a resposta `pendente`, e a resposta HTTP é idêntica (não vira oráculo).
   */
  it('telefone já cadastrado NÃO altera o contato: resposta pendente, e a resposta HTTP é igual', async () => {
    const filial = randomUUID()
    await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${T}, ${filial}, 'Matriz')`
    const f = await criarForm(T, { etapaDestinoId: ETAPA, filialId: filial, responsavelPadraoId: U_T })
    const existente = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, recebe_campanhas) VALUES (${T}, ${existente}, 'Nome do ERP', 'erp', true, false)`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${existente}, 1, '+5581999991111', ${'558199991111'}, true, true, 'erp')`
    await dono`INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem) VALUES (${T}, ${existente}, 'whatsapp', false, 'opt_out_mensagem')`
    const antes = await dono`SELECT * FROM contato WHERE tenant_id = ${T} AND id = ${existente}`

    const m = multipart({ respostas: { [uid(1)]: 'Outro Nome', [uid(2)]: '(81) 99999-1111', [uid(3)]: 'invasor@b.com', [uid(4)]: 'Empresa', [uid(5)]: CNPJ },
      consentimento: true, textoConsentimentoHash: await hashDe(f.chavePublica) }, { campo: uid(6), nome: 'doc.pdf', mime: 'application/pdf', bytes: PDF })
    const r = await enviarMultipart(f.chavePublica, m)
    expect(r.statusCode).toBe(201)

    // contato: nem uma coluna mudou; nada de documento, consentimento novo, oportunidade, carteira ou arquivo na ficha
    expect(await dono`SELECT * FROM contato WHERE tenant_id = ${T} AND id = ${existente}`).toEqual(antes)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(1)
    expect(await dono`SELECT 1 FROM contato_documento WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT tipo, concedido, origem FROM consentimento_contato WHERE tenant_id = ${T}`)
      .toEqual([{ tipo: 'whatsapp', concedido: false, origem: 'opt_out_mensagem' }])
    expect(await dono`SELECT 1 FROM oportunidade WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM carteira_atribuicao WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM contato_arquivo WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM origem WHERE tenant_id = ${T}`).toHaveLength(0)

    // a resposta guarda tudo, PENDENTE, e o anexo fica preso a ela
    const [resp] = await dono`SELECT id, contato_id, contato_novo, verificacao FROM formulario_resposta WHERE tenant_id = ${T}`
    expect(resp).toMatchObject({ contato_id: existente, contato_novo: false, verificacao: 'pendente' })
    const [anexo] = await dono`SELECT resposta_id, nome, chave_bucket FROM formulario_resposta_anexo WHERE tenant_id = ${T}`
    expect(anexo).toMatchObject({ resposta_id: resp!['id'], nome: 'doc.pdf' })
    expect(objetos.has(String(anexo!['chave_bucket']))).toBe(true)

    // mesma resposta HTTP de um contato novo
    const novo = await envio(f.chavePublica, PESSOA('81 98888-2222'))
    expect(novo.json()).toEqual(r.json())
    const de_novo = await envio(f.chavePublica, PESSOA('81999991111'))
    expect(de_novo.statusCode).toBe(201)
    expect(de_novo.json()).toEqual(r.json())
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T} AND id = ${existente}`).toHaveLength(1)
  })

  it('aplicar ao contato: gestor confirma, só o que faltava entra, anexo vai à ficha, auditado e uma vez só', async () => {
    const f = await criarForm(T)
    const existente = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${existente}, 'Nome do ERP', 'erp', true)`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${existente}, 1, '+5581999991111', ${'558199991111'}, true, true, 'erp')`
    const m = multipart({ respostas: { [uid(1)]: 'Outro Nome', [uid(2)]: '81999991111', [uid(3)]: 'dono@b.com', [uid(4)]: 'Empresa', [uid(5)]: CNPJ },
      consentimento: true, textoConsentimentoHash: await hashDe(f.chavePublica) }, { campo: uid(6), nome: 'doc.pdf', mime: 'application/pdf', bytes: PDF })
    expect((await enviarMultipart(f.chavePublica, m)).statusCode).toBe(201)
    const [resp] = await dono`SELECT id FROM formulario_resposta WHERE tenant_id = ${T}`
    const rid = String(resp!['id'])

    // lista de respostas e feed avisam
    const lista = (await adm(T, 'GET', `/v1/formularios/${f.id}/respostas`)).json()
    expect(lista.itens[0]).toMatchObject({ verificacao: 'pendente', contatoNovo: false })
    const feed = (await adm(T, 'GET', `/v1/contatos/${existente}/feed`)).json()
    const item = feed.itens.find((i: { tipo: string }) => i.tipo === 'formulario')
    expect(item).toMatchObject({ texto: expect.stringMatching(/não verificada.*confirme antes de usar/), ref: { tipo: 'formulario_resposta_pendente', id: rid } })
    const [anexoPendente] = await dono`SELECT id FROM formulario_resposta_anexo WHERE tenant_id = ${T}`
    const url = await adm(T, 'GET', `/v1/formularios/respostas/${rid}/anexos/${anexoPendente!['id']}/url`)
    expect(url.statusCode).toBe(200)

    await papelDe(T, U_T, 'vendedor')
    expect((await adm(T, 'POST', `/v1/formularios/respostas/${rid}/aplicar`)).statusCode).toBe(403)
    await papelDe(T, U_T, 'gestor')
    expect((await adm(T2, 'POST', `/v1/formularios/respostas/${rid}/aplicar`)).statusCode).toBe(404)
    const ok = await adm(T, 'POST', `/v1/formularios/respostas/${rid}/aplicar`)
    expect(ok.statusCode).toBe(200)

    const [c] = await dono`SELECT nome, email FROM contato WHERE tenant_id = ${T} AND id = ${existente}`
    expect(c).toMatchObject({ nome: 'Nome do ERP', email: 'dono@b.com' })
    expect(await dono`SELECT numero FROM contato_documento WHERE tenant_id = ${T} AND contato_id = ${existente}`).toEqual([{ numero: CNPJ }])
    const [arq] = await dono`SELECT id, contato_id FROM contato_arquivo WHERE tenant_id = ${T}`
    expect(arq).toMatchObject({ id: anexoPendente!['id'], contato_id: existente })
    expect(await dono`SELECT 1 FROM formulario_resposta_anexo WHERE tenant_id = ${T}`).toHaveLength(0)
    expect(await dono`SELECT verificacao FROM formulario_resposta WHERE tenant_id = ${T}`).toEqual([{ verificacao: 'aplicada' }])
    const [aud] = await dono`SELECT acao, entidade_id, ator_id FROM auditoria WHERE tenant_id = ${T} AND acao = 'formulario.resposta_aplicada'`
    expect(aud).toMatchObject({ entidade_id: existente, ator_id: U_T })
    // consentimento do anônimo não foi copiado
    expect(await dono`SELECT 1 FROM consentimento_contato WHERE tenant_id = ${T}`).toHaveLength(0)
    expect((await adm(T, 'POST', `/v1/formularios/respostas/${rid}/aplicar`)).statusCode).toBe(409)
  })

  it('envios SIMULTÂNEOS do mesmo telefone novo: um contato só, sem 500 (o 23505 vira "já cadastrado")', async () => {
    const f = await criarForm(T)
    const hash = await hashDe(f.chavePublica)
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA('81 97777-3333', `Nome ${i}`), consentimento: true, textoConsentimentoHash: hash }, novoIp())))
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201, 201])
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(1)
    const resps = await dono`SELECT contato_novo, verificacao FROM formulario_resposta WHERE tenant_id = ${T} ORDER BY contato_novo DESC`
    expect(resps).toHaveLength(4)
    expect(resps.filter((r) => r['contato_novo'])).toHaveLength(1)
    expect(resps.filter((r) => r['verificacao'] === 'pendente')).toHaveLength(3)
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
    const hash = await hashDe(f.chavePublica)
    const r = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA(), consentimento: false, textoConsentimentoHash: hash }, novoIp())
    expect(r.statusCode).toBe(422)
    expect(r.json().campos.consentimento).toBeTruthy()
    const sem = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA(), textoConsentimentoHash: hash }, novoIp())
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
      const r = await envio(f.chavePublica, PESSOA(`81 9${String(1000 + i).padStart(4, '0')}-0000`), {}, ip)
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
    const ok = multipart({ ...dados, textoConsentimentoHash: await hashDe(f.chavePublica) }, { campo: uid(6), nome: 'contrato.pdf', mime: 'application/pdf', bytes: PDF })
    const r = await enviarMultipart(f.chavePublica, ok)
    expect(r.statusCode).toBe(201)
    const [arq] = await dono`SELECT nome, chave_bucket, tipo_mime FROM contato_arquivo WHERE tenant_id = ${T}`
    expect(arq).toMatchObject({ nome: 'contrato.pdf', tipo_mime: 'application/pdf' })
    const [resp] = await dono`SELECT id, respostas FROM formulario_resposta WHERE tenant_id = ${T}`
    // A1: a chave usa o id da RESPOSTA (gerado antes de abrir a transação), com o tenant no prefixo
    expect(String(arq!['chave_bucket'])).toMatch(new RegExp(`^tenant/${T}/formulario/${resp!['id']}/[0-9a-f-]{36}\\.pdf$`))
    expect(objetos.has(String(arq!['chave_bucket']))).toBe(true)
    // A1: nenhuma transação da gravação estava aberta enquanto os bytes subiam
    expect(transacoesDuranteUpload).toEqual([0])
    expect((resp!['respostas'] as Record<string, { nome: string }>)[uid(6)]!.nome).toBe('contrato.pdf')

    const hash = await hashDe(f.chavePublica)
    const exe = multipart({ respostas: PESSOA('81 97777-0000'), consentimento: true, textoConsentimentoHash: hash }, { campo: uid(6), nome: 'virus.exe', mime: 'application/x-msdownload', bytes: Buffer.from('MZ') })
    const rExe = await enviarMultipart(f.chavePublica, exe)
    expect(rExe.statusCode).toBe(422)
    expect(rExe.json().campos[uid(6)]).toMatch(/Tipo não permitido/)

    const grande = multipart({ respostas: PESSOA('81 96666-0000'), consentimento: true, textoConsentimentoHash: hash }, { campo: uid(6), nome: 'grande.pdf', mime: 'application/pdf', bytes: Buffer.alloc(10 * 1024 * 1024 + 10, 1) })
    const rG = await enviarMultipart(f.chavePublica, grande)
    expect(rG.statusCode).toBe(422)
    expect(rG.json().campos[uid(6)]).toMatch(/10 MB/)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(1)
  })

  it('anexo sem bucket configurado → 503 tipado, nada gravado', async () => {
    bucketOn = false
    const f = await criarForm(T)
    const m = multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: await hashDe(f.chavePublica) }, { campo: uid(6), nome: 'a.pdf', mime: 'application/pdf', bytes: PDF })
    const r = await enviarMultipart(f.chavePublica, m)
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
    expect(linhas[0]).toBe('Data;Contato;Contato novo;Verificação;Nome;WhatsApp;E-mail;Tipo;CNPJ;Contrato')
    expect(linhas).toHaveLength(5)
    expect(csv.body).toContain('p1@x.com')
    // proteção contra fórmula
    expect(csv.body).toContain(`'=HYPERLINK`)
    // outro tenant não exporta
    expect((await adm(T2, 'GET', `/v1/formularios/${f.id}/respostas.csv`)).statusCode).toBe(404)
  })
})

describe('revisão de segurança (F3b)', () => {
  it('A1: transação que falha remove os objetos já enviados (compensação) e não grava nada', async () => {
    const f = await criarForm(T)
    await dono.unsafe(`
      CREATE OR REPLACE FUNCTION f3b_falha() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha forçada'; END $$;
      CREATE TRIGGER f3b_falha BEFORE INSERT ON formulario_resposta FOR EACH ROW
        WHEN (NEW.tenant_id = '${T}') EXECUTE FUNCTION f3b_falha();`)
    try {
      const m = multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: await hashDe(f.chavePublica) },
        { campo: uid(6), nome: 'a.pdf', mime: 'application/pdf', bytes: PDF })
      const r = await enviarMultipart(f.chavePublica, m)
      expect(r.statusCode).toBe(500)
      expect(r.json().erro).toBe('erro.interno')
    } finally {
      await dono.unsafe('DROP TRIGGER IF EXISTS f3b_falha ON formulario_resposta; DROP FUNCTION IF EXISTS f3b_falha();')
    }
    expect(transacoesDuranteUpload).toEqual([0])
    expect(objetos.size).toBe(0)
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)
  })

  it('A2: X-Forwarded-For forjado não contorna o limite por IP (vale o IP que o proxy acrescentou)', async () => {
    const f = await criarForm(T)
    const real = novoIp()
    const codigos: number[] = []
    for (let i = 0; i < 10; i++) {
      // o cliente escreve um "IP" novo a cada envio; o proxy acrescenta o real no fim
      const r = await envio(f.chavePublica, PESSOA(`81 9${String(2000 + i).padStart(4, '0')}-0000`), {}, `203.0.113.${i + 1}, ${real}`)
      codigos.push(r.statusCode)
    }
    expect(codigos.filter((c) => c === 201)).toHaveLength(8)
    expect(codigos.filter((c) => c === 429)).toHaveLength(2)
  })

  it('A2/BAIXA: o limite vem ANTES do banco — chave inexistente também esgota e dá 429', async () => {
    const ip = novoIp()
    const chave = 'z'.repeat(24)
    const codigos: number[] = []
    for (let i = 0; i < 9; i++) codigos.push((await pub('POST', `/publico/f/${chave}/respostas`, { respostas: {} }, ip)).statusCode)
    expect(codigos.slice(0, 8)).toEqual(Array(8).fill(404))
    expect(codigos[8]).toBe(429)
  })

  it('M1: parte repetida é recusada antes de ler; nada sobe ao bucket', async () => {
    const f = await criarForm(T)
    const hash = await hashDe(f.chavePublica)
    const arq = { campo: uid(6), nome: 'a.pdf', mime: 'application/pdf', bytes: PDF }
    const dup = await enviarMultipart(f.chavePublica, multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: hash }, [arq, arq]))
    expect(dup.statusCode).toBe(422)
    expect(dup.json().campos[uid(6)]).toMatch(/um arquivo por campo/)
    const dadosDup = await enviarMultipart(f.chavePublica, multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: hash }, undefined, true))
    expect(dadosDup.statusCode).toBe(422)
    expect(dadosDup.json().erro).toBe('formulario.envio_invalido')
    expect(objetos.size).toBe(0)
    expect(await dono`SELECT 1 FROM formulario_resposta WHERE tenant_id = ${T}`).toHaveLength(0)
  })

  it('M1: soma dos arquivos acima de 20 MB → 413 tipificado; sem vaga de upload → 503 formulario.ocupado com Retry-After', async () => {
    const extras = [7, 8].map((n) => ({ id: uid(n), tipo: 'anexo', rotulo: `Anexo ${n}`, obrigatorio: false, referencia: false, opcoes: [], condicoes: {} }))
    const f = await criarForm(T, {}, [...CAMPOS, ...extras])
    const hash = await hashDe(f.chavePublica)
    const pedaco = Buffer.concat([PDF, Buffer.alloc(7 * 1024 * 1024, 1)])
    const grande = multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: hash },
      [uid(6), uid(7), uid(8)].map((c) => ({ campo: c, nome: `${c}.pdf`, mime: 'application/pdf', bytes: pedaco })))
    const r = await enviarMultipart(f.chavePublica, grande)
    expect(r.statusCode).toBe(413)
    expect(r.json().erro).toBe('formulario.grande_demais')

    definirMaxUploadsSimultaneos(0)
    const m = multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: hash }, { campo: uid(6), nome: 'a.pdf', mime: 'application/pdf', bytes: PDF })
    const ocupado = await enviarMultipart(f.chavePublica, m)
    expect(ocupado.statusCode).toBe(503)
    expect(ocupado.json().erro).toBe('formulario.ocupado')
    expect(ocupado.headers['retry-after']).toBe('5')
    expect(objetos.size).toBe(0)
  })

  it('M1/BAIXA: JSON inválido (corpo ou `dados`) vira 422 tipificado, nunca 500', async () => {
    const f = await criarForm(T)
    const corpo = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': novoIp() }, payload: '{"respostas":' })
    expect(corpo.statusCode).toBe(422)
    expect(corpo.json().erro).toBe('formulario.envio_invalido')
    const fb = 'frontEIRAf3x'
    const quebrado = await app.inject({ method: 'POST', url: `/publico/f/${f.chavePublica}/respostas`,
      headers: { 'content-type': `multipart/form-data; boundary=${fb}`, 'x-forwarded-for': novoIp() },
      payload: `--${fb}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n{nao json\r\n--${fb}--\r\n` })
    expect(quebrado.statusCode).toBe(422)
    expect(quebrado.json().erro).toBe('formulario.envio_invalido')
  })

  it('M2: .exe renomeado para .pdf (mime e extensão "certos") é recusado pela assinatura', async () => {
    const f = await criarForm(T)
    const m = multipart({ respostas: PESSOA(), consentimento: true, textoConsentimentoHash: await hashDe(f.chavePublica) },
      { campo: uid(6), nome: 'contrato.pdf', mime: 'application/pdf', bytes: Buffer.from('MZ\x90\x00\x03\x00\x00\x00') })
    const r = await enviarMultipart(f.chavePublica, m)
    expect(r.statusCode).toBe(422)
    expect(r.json().campos[uid(6)]).toMatch(/não corresponde/)
    expect(objetos.size).toBe(0)
  })

  it('M4: o POST exige o hash do texto exibido; texto mudou depois do GET → 409 formulario.texto_mudou', async () => {
    const f = await criarForm(T)
    const hash = await hashDe(f.chavePublica)
    const sem = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA(), consentimento: true }, novoIp())
    expect(sem.statusCode).toBe(409)
    expect(sem.json().erro).toBe('formulario.texto_mudou')
    await dono`UPDATE tenant SET texto_consentimento = 'Texto novo da Loja A.' WHERE id = ${T}`
    try {
      const velho = await pub('POST', `/publico/f/${f.chavePublica}/respostas`, { respostas: PESSOA(), consentimento: true, textoConsentimentoHash: hash }, novoIp())
      expect(velho.statusCode).toBe(409)
      expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T}`).toHaveLength(0)
      expect((await envio(f.chavePublica, PESSOA())).statusCode).toBe(201)
      const [r] = await dono`SELECT consentimento_texto FROM formulario_resposta WHERE tenant_id = ${T}`
      expect(r!['consentimento_texto']).toBe('Texto novo da Loja A.')
    } finally {
      await dono`UPDATE tenant SET texto_consentimento = NULL WHERE id = ${T}`
    }
  })

  it('M4: consentimento de marketing só com a flag do formulário — e aí o texto exibido diz isso', async () => {
    const f = await criarForm(T, { consentimentoMarketing: true })
    const def = (await pub('GET', `/publico/f/${f.chavePublica}`)).json()
    expect(def.textoConsentimento).toMatch(/ofertas e novidades/)
    expect((await envio(f.chavePublica, PESSOA())).statusCode).toBe(201)
    const [c] = await dono`SELECT recebe_campanhas FROM contato WHERE tenant_id = ${T}`
    expect(c!['recebe_campanhas']).toBe(true)
    expect((await dono`SELECT tipo FROM consentimento_contato WHERE tenant_id = ${T} ORDER BY tipo`).map((x) => x['tipo']))
      .toEqual(['campanhas', 'whatsapp'])
  })

  it('BAIXA: formulário nasce inativo e não publica sem campo telefone (422)', async () => {
    const r = await adm(T, 'POST', '/v1/formularios', { nome: 'Sem campos' })
    expect(r.statusCode).toBe(201)
    expect(r.json().ativo).toBe(false)
    expect((await pub('GET', `/publico/f/${r.json().chavePublica}`)).statusCode).toBe(404)
    const ativar = await adm(T, 'PATCH', `/v1/formularios/${r.json().id}`, { ativo: true })
    expect(ativar.statusCode).toBe(422)
    expect(ativar.json().campos.ativo).toMatch(/telefone/)
    const nascerAtivo = await adm(T, 'POST', '/v1/formularios', { nome: 'Já ativo', ativo: true })
    expect(nascerAtivo.statusCode).toBe(422)
  })

  it('BAIXA: ip_hash é HMAC com segredo do servidor, não sha256 reversível do IP', async () => {
    const f = await criarForm(T)
    const ip = novoIp()
    await envio(f.chavePublica, PESSOA(), {}, ip)
    const [r] = await dono`SELECT ip_hash FROM formulario_resposta WHERE tenant_id = ${T}`
    expect(r!['ip_hash']).toMatch(/^[0-9a-f]{64}$/)
    expect(r!['ip_hash']).not.toBe(createHash('sha256').update(`${f.chavePublica}:${ip}`).digest('hex'))
  })

  it('BAIXA: POST público responde nosniff e no-store', async () => {
    const f = await criarForm(T)
    const r = await envio(f.chavePublica, PESSOA())
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('dois tenants: x-tenant-id no cabeçalho e tenantId no corpo são ignorados — vale a chave', async () => {
    const a = await criarForm(T)
    const r = await pub('POST', `/publico/f/${a.chavePublica}/respostas`,
      { respostas: PESSOA('81 92222-0001', 'Forjado'), consentimento: true, textoConsentimentoHash: await hashDe(a.chavePublica), tenantId: T2 },
      novoIp(), { 'x-tenant-id': T2 })
    expect(r.statusCode).toBe(201)
    expect((await dono`SELECT nome FROM contato WHERE tenant_id = ${T}`).map((x) => x['nome'])).toEqual(['Forjado'])
    expect(await dono`SELECT 1 FROM contato WHERE tenant_id = ${T2}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM formulario_resposta WHERE tenant_id = ${T2}`).toHaveLength(0)
  })
})
