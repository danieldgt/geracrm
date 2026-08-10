import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp, ClienteCanonico } from '@geracrm/conectores'
import { ingerirClientes } from './ingestao-clientes.js'

/**
 * Ingestão contra o banco real.
 *
 * ⚠️ Roda com a conexão de DONO porque a ingestão é um worker, não uma
 * requisição de usuário — ela não tem tenant de sessão. O isolamento aqui vem
 * do `tenantId` passado explicitamente, e é por isso que o teste verifica que
 * nada vaza para o segundo tenant.
 */

// ⚠️ UUIDs EXCLUSIVOS deste arquivo. Vitest roda arquivos em paralelo contra o
// mesmo banco — compartilhar id de tenant com outro teste faz um apagar o dado
// do outro, e a falha aparece de forma diferente a cada execução.
const A = 'a11e5720-0000-4000-8000-000000000001'
const B = 'a11e5720-0000-4000-8000-000000000002'
const CONEXAO = 'a11e5720-2222-4000-8000-000000000001'
const PLANO = 'a11e5720-3333-4000-8000-000000000001'
const MODELO = 'a11e5720-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

function conectorFalso(clientes: ClienteCanonico[]): ConectorErp {
  return {
    nome: 'falso',
    capacidades: {
      ingestaoClientes: true, ingestaoProdutos: false, ingestaoPedidos: false,
      cargaHistorica: true, saldoSincrono: false, tabelaPrecoSincrona: false,
      creditoCliente: false, escritaPedido: false, webhookDeVenda: false, fidelidade: false,
    },
    async listarClientes() { return { itens: clientes } },
    async listarSkus() { return { itens: [] } },
    async listarVendas() { return { itens: [] } },
  }
}

const cliente = (p: Partial<ClienteCanonico> & { idExterno: string; nome: string }): ClienteCanonico => ({
  telefones: [], ativo: true, ...p,
})

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-ingestao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-ingestao', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [id, nome, pv] of [[A, 'Loja A', 'a11e5720-1111-4000-8000-000000000001'],
                                [B, 'Loja B', 'a11e5720-1111-4000-8000-000000000002']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${id}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${id}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel)
               VALUES (${id}, ${CONEXAO}, 'falso', 'ERP de teste') ON CONFLICT DO NOTHING`
  }
})

beforeEach(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM correspondencia_pendente WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_identidade_externa WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
  }
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM conexao_erp WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const ingerir = (clientes: ClienteCanonico[], tenant = A) =>
  dono.begin((tx) => ingerirClientes(tx as never, tenant, CONEXAO, conectorFalso(clientes)))

describe('Ingestão de clientes', () => {
  it('dado cliente novo com telefone, então cria com telefone normalizado e principal', async () => {
    const r = await ingerir([cliente({ idExterno: '1', nome: 'Maria', telefones: ['(81) 99861-7049'] })])
    expect(r).toMatchObject({ lidos: 1, criados: 1, vinculados: 0, rejeitados: 0 })

    const [tel] = await dono`SELECT e164, chave_bloqueio, principal FROM contato_telefone WHERE tenant_id = ${A}`
    // ⚠️ Normalizado na escrita: o ERP mandou com pontuação.
    expect(tel!.e164).toBe('+5581998617049')
    expect(tel!.chave_bloqueio).toBe('558198617049')
    expect(tel!.principal).toBe(true)
  })

  it('⚠️ dada carga rodada duas vezes, então não duplica — é o que permite reprocessar', async () => {
    const dados = [cliente({ idExterno: '1', nome: 'Maria', telefones: ['81998617049'] })]
    await ingerir(dados)
    const r2 = await ingerir(dados)

    expect(r2).toMatchObject({ criados: 0, vinculados: 1 })
    const [linha] = await dono<{ total: number }[]>`SELECT count(*)::int AS total FROM contato WHERE tenant_id = ${A}`
    expect(linha!.total).toBe(1)
  })

  it('dado cliente sem documento e sem telefone, então cria — é o normal no varejo', async () => {
    const r = await ingerir([cliente({ idExterno: '9', nome: 'Cliente Balcão' })])
    expect(r).toMatchObject({ criados: 1, rejeitados: 0 })
  })

  it('⚠️ mesmo telefone, CNPJs DIFERENTES → dois contatos (o limiar da MONICA)', async () => {
    // A demo tinha 566 CNPJs distintos no mesmo telefone virando UM contato. Com
    // o limiar, cada CNPJ é uma empresa: não funde por telefone quando o
    // documento conflita.
    const r = await ingerir([
      cliente({ idExterno: 'e1', nome: 'Loja A', telefones: ['81998617049'], documento: '11.111.111/0001-11' }),
      cliente({ idExterno: 'e2', nome: 'Loja B', telefones: ['81998617049'], documento: '22.222.222/0001-22' }),
    ])
    expect(r.criados).toBe(2)
    expect(r.vinculados).toBe(0)
    const [linha] = await dono<{ total: number }[]>`
      SELECT count(*)::int AS total FROM contato WHERE tenant_id = ${A}`
    expect(linha!.total).toBe(2)
  })

  it('mesmo telefone, MESMO CNPJ → um contato (é a mesma empresa)', async () => {
    // O limiar não é paranoia: mesmo documento no mesmo telefone É a mesma
    // empresa (recadastro), e deve fundir.
    const r = await ingerir([
      cliente({ idExterno: 'f1', nome: 'Loja X', telefones: ['81998617049'], documento: '33.333.333/0001-33' }),
      cliente({ idExterno: 'f2', nome: 'Loja X (recadastro)', telefones: ['81998617049'], documento: '33.333.333/0001-33' }),
    ])
    expect(r.criados).toBe(1)
    expect(r.vinculados).toBe(1)
  })

  it('⚠️ varejo sem documento, mesmo telefone → funde (o limiar não penaliza quem não tem CNPJ)', async () => {
    // ADR-019: no varejo a maioria não tem documento. Sem documento não há
    // conflito a detectar — o telefone segue segurando, como antes.
    const r = await ingerir([
      cliente({ idExterno: 'g1', nome: 'Cliente', telefones: ['81998617049'] }),
      cliente({ idExterno: 'g2', nome: 'Cliente', telefones: ['81998617049'] }),
    ])
    expect(r.criados).toBe(1)
    expect(r.vinculados).toBe(1)
  })

  it('dado cliente sem nome, então rejeita COM o motivo', async () => {
    const r = await ingerir([cliente({ idExterno: '2', nome: '   ' })])
    expect(r.rejeitados).toBe(1)
    // ⚠️ Contagem sem exemplo não permite corrigir nada.
    expect(r.rejeicoes[0]).toMatchObject({ idExterno: '2', motivo: 'cliente sem nome' })
  })

  it('dado telefone inválido, então ignora o telefone mas mantém o cliente', async () => {
    const r = await ingerir([cliente({ idExterno: '3', nome: 'Ana', telefones: ['20999999999'] })])
    expect(r.criados).toBe(1)
    const tels = await dono`SELECT 1 FROM contato_telefone WHERE tenant_id = ${A}`
    expect(tels.length).toBe(0)
  })

  it('dado vendedor sem correspondência, então registra pendência em vez de descartar', async () => {
    const r = await ingerir([cliente({ idExterno: '4', nome: 'João', vendedorExterno: 'EDUARDA' })])
    expect(r.vendedoresPendentes).toBe(1)

    const [p] = await dono`SELECT id_externo, ocorrencias FROM correspondencia_pendente WHERE tenant_id = ${A}`
    expect(p!.id_externo).toBe('EDUARDA')
  })

  it('dadas várias ocorrências do mesmo vendedor, então conta — para priorizar a resolução', async () => {
    await ingerir([
      cliente({ idExterno: '5', nome: 'A', vendedorExterno: 'EDUARDA' }),
      cliente({ idExterno: '6', nome: 'B', vendedorExterno: 'EDUARDA' }),
      cliente({ idExterno: '7', nome: 'C', vendedorExterno: 'JANAINA' }),
    ])
    // ⚠️ `ocorrencias` é bigint e o driver devolve STRING — somar sem cast
    // concatena em vez de adicionar. Cast explícito, sempre.
    const linhas = await dono<{ id_externo: string; ocorrencias: number }[]>`
      SELECT id_externo, ocorrencias::int AS ocorrencias FROM correspondencia_pendente
       WHERE tenant_id = ${A} ORDER BY ocorrencias DESC`
    expect(linhas[0]).toMatchObject({ id_externo: 'EDUARDA', ocorrencias: 2 })
  })

  it('dado vendedor com correspondência, então atribui a carteira', async () => {
    const usuarioId = 'a11e5720-5555-4000-8000-000000000001'
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${A}, ${usuarioId}, 'Eduarda', 'e@x.com')`
    await dono`INSERT INTO usuario_identidade_externa (tenant_id, usuario_id, conexao_id, id_externo)
               VALUES (${A}, ${usuarioId}, ${CONEXAO}, 'EDUARDA')`

    const r = await ingerir([cliente({ idExterno: '8', nome: 'Cliente', vendedorExterno: 'EDUARDA' })])
    expect(r.vendedoresPendentes).toBe(0)

    const [c] = await dono`SELECT usuario_id, origem FROM carteira_atribuicao WHERE tenant_id = ${A} AND ate IS NULL`
    expect(c).toMatchObject({ usuario_id: usuarioId, origem: 'carga' })
  })

  it('⚠️ dada carteira atribuída à mão, então a carga NÃO sobrescreve', async () => {
    const eduarda = 'a11e5720-5555-4000-8000-000000000001'
    const janaina = 'a11e5720-5555-4000-8000-000000000002'
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES
               (${A}, ${eduarda}, 'Eduarda', 'e@x.com'), (${A}, ${janaina}, 'Janaina', 'j@x.com')`
    await dono`INSERT INTO usuario_identidade_externa (tenant_id, usuario_id, conexao_id, id_externo)
               VALUES (${A}, ${eduarda}, ${CONEXAO}, 'EDUARDA')`

    await ingerir([cliente({ idExterno: '10', nome: 'Cliente', vendedorExterno: 'EDUARDA' })])
    const [linhaContato] = await dono<{ id: string }[]>`SELECT id FROM contato WHERE tenant_id = ${A}`
    const contatoId = linhaContato!.id

    // A gestora transfere na tela.
    await dono`SELECT transferir_carteira(${A}, ${contatoId}, ${janaina}, NULL, 'manual')`

    // O ERP continua dizendo EDUARDA. A carga não pode desfazer a decisão humana.
    await ingerir([cliente({ idExterno: '10', nome: 'Cliente', vendedorExterno: 'EDUARDA' })])

    const [c] = await dono`SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${A} AND ate IS NULL`
    expect(c!.usuario_id).toBe(janaina)
  })

  it('⚠️ dado o mesmo id externo em dois tenants, então não se misturam', async () => {
    await ingerir([cliente({ idExterno: '1', nome: 'Cliente do A', telefones: ['81998617049'] })], A)
    await ingerir([cliente({ idExterno: '1', nome: 'Cliente do B', telefones: ['81998617049'] })], B)

    const [a] = await dono`SELECT nome FROM contato WHERE tenant_id = ${A}`
    const [b] = await dono`SELECT nome FROM contato WHERE tenant_id = ${B}`
    expect(a!.nome).toBe('Cliente do A')
    expect(b!.nome).toBe('Cliente do B')
  })
})
