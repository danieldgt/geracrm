import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { ConectorErp, VendaCanonica, ClienteCanonico } from '@geracrm/conectores'
import { ingerirVendas } from './ingestao-vendas.js'
import { ingerirClientes } from './ingestao-clientes.js'
import { conciliarVendas, aceitarConciliacao } from './conciliacao.js'

// ⚠️ Fixtures exclusivos deste arquivo — o Vitest roda arquivos em paralelo
// contra o mesmo banco.
const T = 'be5da500-0000-4000-8000-000000000001'
const PV = 'be5da500-1111-4000-8000-000000000001'
const CONEXAO = 'be5da500-2222-4000-8000-000000000001'
const PLANO = 'be5da500-3333-4000-8000-000000000001'
const MODELO = 'be5da500-4444-4000-8000-000000000001'
const USUARIO = 'be5da500-5555-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const conectorFalso = (vendas: VendaCanonica[], clientes: ClienteCanonico[] = []): ConectorErp => ({
  nome: 'falso',
  capacidades: {
    ingestaoClientes: true, ingestaoProdutos: false, ingestaoPedidos: true,
    cargaHistorica: true, saldoSincrono: false, tabelaPrecoSincrona: false,
    creditoCliente: false, escritaPedido: false, webhookDeVenda: false, fidelidade: false,
  },
  async listarClientes() { return { itens: clientes } },
  async listarSkus() { return { itens: [] } },
  async listarVendas() { return { itens: vendas } },
})

const venda = (p: Partial<VendaCanonica> & { idExterno: string }): VendaCanonica => ({
  clienteExterno: 'CLI-1', ocorridaEm: new Date('2026-07-15T10:00:00Z'),
  valorCentavos: 15000, itens: [], ...p,
})

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-vendas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-vendas', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Vendas', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, fonte_de_venda)
             VALUES (${T}, ${CONEXAO}, 'falso', 'ERP', true) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM conciliacao_divergencia WHERE tenant_id = ${T}`
  await dono`DELETE FROM conciliacao WHERE tenant_id = ${T}`
  await dono`DELETE FROM item_venda WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${T}`
  await dono`DELETE FROM correspondencia_pendente WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM item_venda WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda_identidade_externa WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await dono`DELETE FROM conciliacao_divergencia WHERE tenant_id = ${T}`
  await dono`DELETE FROM conciliacao WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM conexao_erp WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const comCliente = () =>
  dono.begin((tx) => ingerirClientes(tx as never, T, CONEXAO, conectorFalso([], [
    { idExterno: 'CLI-1', nome: 'Maria', telefones: ['81998617049'], ativo: true },
  ])))

const ingerir = (vendas: VendaCanonica[]) =>
  dono.begin((tx) => ingerirVendas(tx as never, T, CONEXAO, conectorFalso(vendas), new Date('2020-01-01')))

describe('Ingestão de vendas', () => {
  it('dada venda de cliente conhecido, então importa e atualiza os contadores', async () => {
    await comCliente()
    const r = await ingerir([venda({ idExterno: 'V-1', valorCentavos: 15000 })])

    expect(r).toMatchObject({ importadas: 1, semContato: 0, valorTotalCentavos: 15000 })
    const [c] = await dono<{ qtd_vendas: number; total: string }[]>`
      SELECT qtd_vendas, total_vendas_centavos::text AS total FROM contato WHERE tenant_id = ${T}`
    expect(c).toMatchObject({ qtd_vendas: 1, total: '15000' })
  })

  it('⚠️ dada a mesma venda duas vezes, então não duplica nem soma de novo', async () => {
    await comCliente()
    const v = [venda({ idExterno: 'V-1', valorCentavos: 15000 })]
    await ingerir(v)
    const r2 = await ingerir(v)

    expect(r2).toMatchObject({ importadas: 0, jaExistiam: 1 })
    const [c] = await dono<{ qtd_vendas: number; total: string }[]>`
      SELECT qtd_vendas, total_vendas_centavos::text AS total FROM contato WHERE tenant_id = ${T}`
    // Se o contador somasse de novo, o RFV e o ticket médio ficariam errados
    // em toda reimportação.
    expect(c).toMatchObject({ qtd_vendas: 1, total: '15000' })
  })

  it('dada venda de balcão sem cliente, então importa e conta como sem contato', async () => {
    const r = await ingerir([venda({ idExterno: 'V-2', clienteExterno: 'DESCONHECIDO' })])
    // ⚠️ Conta para o faturamento, não entra no RFV — e a lacuna precisa ser
    // visível, senão "os totais não batem" fica sem explicação.
    expect(r).toMatchObject({ importadas: 1, semContato: 1 })
  })

  it('dada venda antiga, então cai na partição de escape em vez de falhar', async () => {
    await comCliente()
    // Cliente com 5 anos de base: sem partição de escape, a carga histórica
    // falharia na primeira linha antiga — e falharia no meio, não no começo.
    const r = await ingerir([venda({ idExterno: 'V-3', ocorridaEm: new Date('2019-03-10T10:00:00Z') })])
    expect(r.importadas).toBe(1)
  })

  it('dada venda sem data válida, então rejeita com o motivo', async () => {
    const r = await ingerir([venda({ idExterno: 'V-4', ocorridaEm: new Date('inválido') })])
    expect(r.rejeitadas).toBe(1)
    expect(r.rejeicoes[0]!.motivo).toContain('data')
  })

  it('dado vendedor com correspondência, então a venda fica atribuída', async () => {
    await comCliente()
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${T}, ${USUARIO}, 'Eduarda', 'e@x.com')`
    await dono`INSERT INTO usuario_identidade_externa (tenant_id, usuario_id, conexao_id, id_externo)
               VALUES (${T}, ${USUARIO}, ${CONEXAO}, 'EDUARDA')`

    await ingerir([venda({ idExterno: 'V-5', vendedorExterno: 'EDUARDA' })])
    const [v] = await dono`SELECT usuario_id, vendedor_externo FROM venda WHERE tenant_id = ${T}`
    // ⚠️ Guarda o texto original também: quando a correspondência for criada
    // depois, dá para reprocessar sem reimportar do ERP.
    expect(v).toMatchObject({ usuario_id: USUARIO, vendedor_externo: 'EDUARDA' })
  })
})

describe('Conciliação — o que fecha o critério de saída da Onda 0', () => {
  const periodo = {
    periodoDe: new Date('2026-07-01T00:00:00Z'),
    periodoAte: new Date('2026-08-01T00:00:00Z'),
  }

  it('dados totais iguais aos do ERP, então não há divergência', async () => {
    await comCliente()
    await ingerir([
      venda({ idExterno: 'V-1', valorCentavos: 10000 }),
      venda({ idExterno: 'V-2', valorCentavos: 5000 }),
    ])

    const [r] = await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, registros: 2, valorCentavos: 15000 },
    ]))
    // ⚠️ Bate, mas o estado é 'pendente': conferir é ato de pessoa.
    expect(r).toMatchObject({
      divergenciaRegistros: 0, divergenciaValorCentavos: 0, bate: true, estado: 'pendente',
    })
  })

  it('⚠️ relatório só com VALOR (sem contagem) concilia por valor', async () => {
    // O faturamento do GeraCloud dá só o total — não contagem nem ids. Sem
    // `registros` opcional, isto viraria "0 − nosso total" e acusaria divergência
    // gigante e falsa em toda venda importada.
    await comCliente()
    await ingerir([
      venda({ idExterno: 'V-1', valorCentavos: 10000 }),
      venda({ idExterno: 'V-2', valorCentavos: 5000 }),
    ])

    const [bate] = await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, valorCentavos: 15000 }, // sem registros
    ]))
    expect(bate).toMatchObject({ divergenciaRegistros: 0, divergenciaValorCentavos: 0, bate: true })

    const [difere] = await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, valorCentavos: 99999 },
    ]))
    // Divergência de valor detectada; contagem não entra no veredito.
    expect(difere).toMatchObject({ bate: false, estado: 'divergente' })
    expect(difere!.divergenciaValorCentavos).toBe(84999)
  })

  it('⚠️ dada divergência, então nomeia QUAIS faltam — não só quantos', async () => {
    await comCliente()
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])

    const [r] = await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, registros: 3, valorCentavos: 40000, idsExternos: ['V-1', 'V-2', 'V-3'] },
    ]))
    expect(r!.estado).toBe('divergente')
    expect(r!.divergenciaRegistros).toBe(2)
    // "Faltam 2" não se investiga; "faltam V-2 e V-3" sim.
    expect(r!.faltantes).toEqual(['V-2', 'V-3'])

    // ⚠️ E gravado como ARRAY jsonb, não como string JSON. Gravar
    // `${JSON.stringify(x)}::jsonb` guarda um jsonb do tipo 'string' — a tela
    // recebe texto, e nenhum erro aparece em lugar nenhum.
    const [linha] = await dono<{ tipo: string; faltantes: string[] }[]>`
      SELECT jsonb_typeof(faltantes) AS tipo, faltantes FROM conciliacao WHERE tenant_id = ${T}`
    expect(linha!.tipo).toBe('array')
    expect(linha!.faltantes).toEqual(['V-2', 'V-3'])

    // E cada uma vira uma linha com dono possível e estado — não só amostra.
    const divs = await dono<{ codigo: string; chave: string; estado: string }[]>`
      SELECT codigo, chave, estado FROM conciliacao_divergencia
       WHERE tenant_id = ${T} ORDER BY chave`
    expect(divs.map((d) => [d.codigo, d.chave, d.estado])).toEqual([
      ['DIV-01', 'V-2', 'aberta'],
      ['DIV-01', 'V-3', 'aberta'],
    ])
  })

  it('⚠️ dada só divergência de VALOR, então abre DIV-03 — contar linhas não acharia', async () => {
    await comCliente()
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])

    // Mesma quantidade de vendas, total diferente: algo entrou com valor errado.
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, registros: 1, valorCentavos: 12000 },
    ]))

    const [d] = await dono<{ codigo: string; valor_erp: string; valor_geracrm: string }[]>`
      SELECT codigo, valor_erp, valor_geracrm FROM conciliacao_divergencia WHERE tenant_id = ${T}`
    expect(d!.codigo).toBe('DIV-03')
    // ⚠️ Os DOIS lados reais, não a diferença: ERP=12000, nosso=10000.
    // Guardar 2000 em valor_erp mentiria sobre quanto o ERP tem.
    expect(d!.valor_erp).toBe('12000')
    expect(d!.valor_geracrm).toBe('10000')
  })

  it('⚠️ reapurar com número novo ATUALIZA a divergência de total (não fica stale)', async () => {
    await comCliente()
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [{ ...periodo, valorCentavos: 12000 }]))
    // O ERP passa a reportar outro total; o de antes está aberto (ninguém aceitou).
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [{ ...periodo, valorCentavos: 15000 }]))

    const [d] = await dono<{ valor_erp: string }[]>`
      SELECT valor_erp FROM conciliacao_divergencia WHERE tenant_id = ${T} AND codigo = 'DIV-03'`
    // Antes ficava travado no 12000 por ON CONFLICT DO NOTHING — mostrando um
    // número que não é mais verdade.
    expect(d!.valor_erp).toBe('15000')
  })

  it('⚠️ dada reapuração, então divergência já resolvida NÃO reabre', async () => {
    await comCliente()
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${T}, ${USUARIO}, 'Gestor', 'g@x.com')`
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])
    const totais = [{ ...periodo, registros: 2, valorCentavos: 10000, idsExternos: ['V-1', 'V-9'] }]
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, totais))

    await dono`UPDATE conciliacao_divergencia
                  SET estado = 'aceita', responsavel_id = ${USUARIO},
                      resolucao = 'venda cancelada no ERP', resolvido_em = now()
                WHERE tenant_id = ${T} AND chave = 'V-9'`

    // A apuração noturna roda de novo.
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, totais))

    const divs = await dono<{ estado: string }[]>`
      SELECT estado FROM conciliacao_divergencia WHERE tenant_id = ${T} AND chave = 'V-9'`
    // Reabrir todo dia desfaria o trabalho da véspera e a lista nunca zeraria.
    expect(divs.map((d) => d.estado)).toEqual(['aceita'])
  })

  it('⚠️ mesmo batendo, a apuração nasce PENDENTE — só pessoa marca conferida', async () => {
    await comCliente()
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, registros: 1, valorCentavos: 10000 },
    ]))

    const [c] = await dono`SELECT id, estado, aceito_por FROM conciliacao WHERE tenant_id = ${T}`
    // Apuração que se auto-aprova não é conferência.
    expect(c!.estado).toBe('pendente')
    expect(c!.aceito_por).toBeNull()
  })

  it('dado aceite por uma pessoa, então fica conferida com responsável', async () => {
    await comCliente()
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${T}, ${USUARIO}, 'Gestor', 'g@x.com')`
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [
      { ...periodo, registros: 1, valorCentavos: 10000 },
    ]))

    const [c] = await dono<{ id: string }[]>`SELECT id FROM conciliacao WHERE tenant_id = ${T}`
    await dono.begin((tx) => aceitarConciliacao(tx as never, T, c!.id, USUARIO, 'conferido com o relatório'))

    const [depois] = await dono`SELECT estado, aceito_por FROM conciliacao WHERE tenant_id = ${T}`
    expect(depois).toMatchObject({ estado: 'conferida', aceito_por: USUARIO })
  })

  it('⚠️ reapurar limpa o aceite anterior — o número mudou, a conferência não vale mais', async () => {
    await comCliente()
    await dono`INSERT INTO usuario (tenant_id, id, nome, email) VALUES (${T}, ${USUARIO}, 'Gestor', 'g@x.com')`
    await ingerir([venda({ idExterno: 'V-1', valorCentavos: 10000 })])
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [{ ...periodo, registros: 1, valorCentavos: 10000 }]))

    const [c] = await dono<{ id: string }[]>`SELECT id FROM conciliacao WHERE tenant_id = ${T}`
    await dono.begin((tx) => aceitarConciliacao(tx as never, T, c!.id, USUARIO))

    // O ERP passa a reportar outro número.
    await dono.begin((tx) => conciliarVendas(tx as never, T, CONEXAO, [{ ...periodo, registros: 9, valorCentavos: 90000 }]))

    const [depois] = await dono`SELECT estado, aceito_por FROM conciliacao WHERE tenant_id = ${T}`
    expect(depois).toMatchObject({ estado: 'divergente', aceito_por: null })
  })
})

describe('Métricas derivadas', () => {
  it('dada segunda compra, então a média entre vendas passa a existir', async () => {
    await comCliente()
    await ingerir([
      venda({ idExterno: 'V-1', ocorridaEm: new Date('2026-05-01T10:00:00Z'), valorCentavos: 10000 }),
      venda({ idExterno: 'V-2', ocorridaEm: new Date('2026-07-01T10:00:00Z'), valorCentavos: 20000 }),
    ])
    await dono`SELECT atualizar_metricas_contato()`

    const [m] = await dono<{ qtd_vendas: string; media: string | null; atraso: string | null }[]>`
      SELECT qtd_vendas::text, media_entre_vendas_dias::text AS media, atraso_relativo::text AS atraso
        FROM mv_metricas_contato WHERE tenant_id = ${T}`
    expect(Number(m!.qtd_vendas)).toBe(2)
    // 61 dias entre as duas compras, com uma única lacuna.
    expect(Number(m!.media)).toBeCloseTo(61, 0)
    // ⚠️ O atraso é relativo ao ritmo DELE — é o que a predição explicável usa.
    expect(Number(m!.atraso)).toBeGreaterThan(0)
  })

  it('⚠️ dada uma compra só, então a média NÃO é inventada', async () => {
    await comCliente()
    await ingerir([venda({ idExterno: 'V-1' })])
    await dono`SELECT atualizar_metricas_contato()`

    const [m] = await dono<{ media: string | null }[]>`
      SELECT media_entre_vendas_dias::text AS media FROM mv_metricas_contato WHERE tenant_id = ${T}`
    // Com uma compra não há intervalo. Inventar um produziria atraso fictício.
    expect(m!.media).toBeNull()
  })
})
