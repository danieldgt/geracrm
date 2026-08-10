import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { ResultadoTeste } from '@geracrm/conectores'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { cifrar, decifrar } from './cofre.js'

const T = 'c0f4e100-0000-4000-8000-000000000001'
const OUTRO = 'c0f4e100-0000-4000-8000-000000000002'
const PV = 'c0f4e100-1111-4000-8000-000000000001'
const PV2 = 'c0f4e100-1111-4000-8000-000000000002'
const PLANO = 'c0f4e100-3333-4000-8000-000000000001'
const MODELO = 'c0f4e100-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** O teste de conexão é o único ponto que sai para a rede — substituído aqui. */
let respostaDoTeste: ResultadoTeste = { ok: true, capacidades: { ingestaoClientes: true }, identificacao: 'LOJA TESTE LTDA' }

const credencialGeraCloud = {
  baseUrl: 'https://erp.exemplo.com.br',
  usuario: 'integracao',
  senha: 'senha-secreta-do-cliente',
}

const chamar = (tenant: string, metodo: 'GET' | 'POST' | 'PATCH', url: string, corpo?: unknown) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': tenant }, ...(corpo ? { payload: corpo } : {}) })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.CREDENCIAL_CHAVE = 'chave-de-teste-com-mais-de-32-caracteres-aqui'

  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-rotas-erp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-rotas-erp', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja A'], [OUTRO, PV2, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }

  app = await criarApp()
  // Substitui o decorator: o teste de rota não deve depender de rede.
  ;(app as unknown as { testarConexao: unknown }).testarConexao = async () => respostaDoTeste
  await app.ready()
})

beforeEach(async () => {
  respostaDoTeste = { ok: true, capacidades: { ingestaoClientes: true }, identificacao: 'LOJA TESTE LTDA' }
  for (const t of [T, OUTRO]) await dono`DELETE FROM conexao_erp WHERE tenant_id = ${t}`
})

afterAll(async () => {
  await app.close()
  await encerrarBanco()
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM conexao_erp WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const criar = (corpo: Record<string, unknown> = {}) =>
  chamar(T, 'POST', '/v1/integracao/conexoes', {
    conector: 'geracloud', nomeAmigavel: 'ERP da matriz', credencial: credencialGeraCloud, ...corpo,
  })

describe('Catálogo de conectores', () => {
  it('⚠️ a tela desenha o formulário a partir daqui — GeraCloud pede senha, o genérico pede token', async () => {
    const r = await chamar(T, 'GET', '/v1/integracao/conectores')
    const conectores = r.json() as { codigo: string; esquemaCredencial: { campos: { nome: string; tipo: string }[] } }[]

    const gera = conectores.find((c) => c.codigo === 'geracloud')!
    expect(gera.esquemaCredencial.campos.map((c) => c.nome)).toEqual(['baseUrl', 'usuario', 'senha'])

    const generico = conectores.find((c) => c.codigo === 'generico_token')!
    expect(generico.esquemaCredencial.campos.map((c) => c.nome)).toEqual(['baseUrl', 'token'])

    // ⚠️ Token é campo de senha, não texto: autentica igual a uma, então
    // mascara, não vai para log e não volta em resposta.
    expect(generico.esquemaCredencial.campos.find((c) => c.nome === 'token')!.tipo).toBe('senha')
  })
})

describe('Criar conexão', () => {
  it('dada credencial completa, então cria em estado configurando', async () => {
    const r = await criar()
    expect(r.statusCode).toBe(201)
    // ⚠️ Nasce 'configurando', nunca 'ativa': ativa é o que o TESTE diz.
    expect(r.json().estado).toBe('configurando')
  })

  it('⚠️ dada senha faltando, então diz QUAL campo — não "credencial inválida"', async () => {
    const r = await criar({ credencial: { baseUrl: 'https://x.com.br', usuario: 'a' } })
    expect(r.statusCode).toBe(422)
    expect(r.json().erro).toBe('integracao.credencial_invalida')
    expect(r.json().detalhe.campos).toEqual({ senha: 'Senha é obrigatório.' })
  })

  it('⚠️ dado endereço sem https, então aponta o campo em vez de falhar como indisponível', async () => {
    const r = await criar({ credencial: { ...credencialGeraCloud, baseUrl: 'erp.exemplo.com.br' } })
    // Sem esta validação o sintoma seria "ERP não respondeu", que manda a
    // pessoa procurar problema de rede que não existe.
    expect(r.json().detalhe.campos.baseUrl).toContain('https://')
  })

  it('dado campo que não é deste ERP, então recusa', async () => {
    const r = await criar({ credencial: { ...credencialGeraCloud, token: 'abc' } })
    expect(r.json().detalhe.campos.token).toContain('não faz parte')
  })

  it('dado conector inexistente, então 422 com código próprio', async () => {
    const r = await criar({ conector: 'sap' })
    expect([r.statusCode, r.json().erro]).toEqual([422, 'integracao.conector_desconhecido'])
  })

  it('⚠️ dada segunda fonte de venda, então 409 dizendo como resolver', async () => {
    await criar({ fonteDeVenda: true })
    const r = await criar({ nomeAmigavel: 'Outro', fonteDeVenda: true })
    // Duas fontes de venda tornam o faturamento ambíguo — e ele é o
    // denominador de RFV, de atribuição e do ROI.
    expect([r.statusCode, r.json().erro]).toEqual([409, 'integracao.fonte_de_venda_ja_definida'])
    expect(r.json().detalhe.comoResolver).toBeTruthy()
  })
})

describe('⚠️ A credencial entra e nunca sai', () => {
  it('a listagem não devolve nenhum valor de credencial, nem mascarado', async () => {
    await criar()
    const r = await chamar(T, 'GET', '/v1/integracao/conexoes')
    const corpo = r.body

    // Nem a senha, nem o usuário, nem qualquer pedaço.
    expect(corpo).not.toContain('senha-secreta-do-cliente')
    expect(corpo).not.toContain('integracao')
    // Sai apenas: existe, e quais campos estão preenchidos.
    expect(r.json().itens[0].credencial).toEqual({
      configurada: true, camposPreenchidos: ['baseUrl', 'usuario', 'senha'],
    })
  })

  it('dado tenant diferente, então não enxerga a conexão do outro', async () => {
    await criar()
    const r = await chamar(OUTRO, 'GET', '/v1/integracao/conexoes')
    expect(r.json().itens).toHaveLength(0)
  })

  it('⚠️ o que vai para o banco está cifrado — texto claro nem aparece na coluna', async () => {
    await criar()
    const [linha] = await dono<{ credenciais_cifradas: Buffer }[]>`
      SELECT credenciais_cifradas FROM conexao_erp WHERE tenant_id = ${T}`

    expect(linha!.credenciais_cifradas.toString('utf8')).not.toContain('senha-secreta-do-cliente')
    expect(decifrar(linha!.credenciais_cifradas)).toEqual(credencialGeraCloud)
  })

  it('⚠️ duas cifragens do MESMO valor produzem bytes diferentes', async () => {
    // IV novo a cada cifragem. Reusar IV com GCM revela o XOR dos originais e
    // quebra a autenticação — não é fraqueza teórica.
    expect(cifrar(credencialGeraCloud).equals(cifrar(credencialGeraCloud))).toBe(false)
  })

  it('⚠️ byte alterado no banco faz o decifrar FALHAR, não devolver lixo', async () => {
    const cifrada = cifrar(credencialGeraCloud)
    cifrada[cifrada.length - 1] = cifrada[cifrada.length - 1]! ^ 0xff
    // Sem autenticação, isto viraria uma senha diferente que o ERP recusa — e o
    // erro mandaria a pessoa redigitar uma senha que estava certa.
    expect(() => decifrar(cifrada)).toThrow()
  })
})

describe('Testar conexão', () => {
  it('dado teste bem-sucedido, então vira ativa e guarda em qual empresa conectou', async () => {
    const { id } = (await criar()).json()
    const r = await chamar(T, 'POST', `/v1/integracao/conexoes/${id}/testar`)
    expect(r.json().ok).toBe(true)

    const [linha] = await dono<{ estado: string; identificacao_remota: string; ultima_validacao_em: Date }[]>`
      SELECT estado, identificacao_remota, ultima_validacao_em FROM conexao_erp WHERE tenant_id = ${T}`
    expect(linha!.estado).toBe('ativa')
    // ⚠️ É o único jeito de a pessoa perceber que conectou na loja errada.
    expect(linha!.identificacao_remota).toBe('LOJA TESTE LTDA')
    expect(linha!.ultima_validacao_em).toBeInstanceOf(Date)
  })

  it('⚠️ dado teste que falha, então responde 200 com o motivo — não 502', async () => {
    respostaDoTeste = { ok: false, motivo: 'credencial_invalida' }
    const { id } = (await criar()).json()
    const r = await chamar(T, 'POST', `/v1/integracao/conexoes/${id}/testar`)

    // A REQUISIÇÃO funcionou; o resultado do teste é o corpo. Um 502 faria o
    // cliente tratar "sua senha está errada" como "nossa API caiu".
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: false, motivo: 'credencial_invalida' })

    const [linha] = await dono<{ estado: string; ultimo_erro_motivo: string; ultima_validacao_em: Date | null }[]>`
      SELECT estado, ultimo_erro_motivo, ultima_validacao_em FROM conexao_erp WHERE tenant_id = ${T}`
    expect(linha).toMatchObject({ estado: 'com_erro', ultimo_erro_motivo: 'credencial_invalida', ultima_validacao_em: null })
  })

  it('⚠️ sem_permissao é motivo diferente de credencial_invalida', async () => {
    respostaDoTeste = { ok: false, motivo: 'sem_permissao' }
    const { id } = (await criar()).json()
    const r = await chamar(T, 'POST', `/v1/integracao/conexoes/${id}/testar`)
    // A senha está certa; falta liberar acesso no ERP — e quem libera costuma
    // ser outra pessoa. Colapsar os dois manda a pessoa errada trabalhar.
    expect(r.json().motivo).toBe('sem_permissao')
  })

  it('dada conexão sem credencial, então recusa antes de sair para a rede', async () => {
    const id = 'c0f4e100-9999-4000-8000-000000000001'
    await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel)
               VALUES (${T}, ${id}, 'geracloud', 'Vazia')`
    const r = await chamar(T, 'POST', `/v1/integracao/conexoes/${id}/testar`)
    expect([r.statusCode, r.json().erro]).toEqual([422, 'integracao.credencial_ausente'])
  })
})

describe('Alterar conexão', () => {
  it('⚠️ credencial nova zera a validação anterior', async () => {
    const { id } = (await criar()).json()
    await chamar(T, 'POST', `/v1/integracao/conexoes/${id}/testar`)

    await chamar(T, 'PATCH', `/v1/integracao/conexoes/${id}`, {
      credencial: { ...credencialGeraCloud, senha: 'outra-senha' },
    })

    const [linha] = await dono<{ estado: string; ultima_validacao_em: Date | null }[]>`
      SELECT estado, ultima_validacao_em FROM conexao_erp WHERE tenant_id = ${T}`
    // Manter a data faria a tela dizer "validada hoje" sobre senha nunca testada.
    expect(linha).toMatchObject({ estado: 'configurando', ultima_validacao_em: null })
  })

  it('⚠️ trocar o ERP da conexão é recusado', async () => {
    const { id } = (await criar()).json()
    const r = await chamar(T, 'PATCH', `/v1/integracao/conexoes/${id}`, { conector: 'generico_token' })
    // Manter as identidades externas já importadas faria o id "1234" de um ERP
    // casar com o cliente que veio do outro — mistura sem conserto.
    expect([r.statusCode, r.json().erro]).toEqual([422, 'integracao.conector_imutavel'])
  })

  it('dado renomear, então altera só o nome', async () => {
    const { id } = (await criar()).json()
    await chamar(T, 'PATCH', `/v1/integracao/conexoes/${id}`, { nomeAmigavel: 'ERP da filial 2' })
    const r = await chamar(T, 'GET', '/v1/integracao/conexoes')
    expect(r.json().itens[0]).toMatchObject({ nomeAmigavel: 'ERP da filial 2' })
    expect(r.json().itens[0].credencial.configurada).toBe(true)
  })
})
