import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { enviarTextoNaConversa } from '../atendimento/envio-conversa.js'
import { processarLgpd } from '../../workers/lgpd.js'
import { registrarOptOut } from './opt-out.js'
import {
  anonimizarContato, candidatosDeAnonimizacao, relatorioAnonimizacao, TEXTO_REMOVIDO_LGPD,
} from './lgpd-anonimizacao.js'

/**
 * RETENÇÃO E ANONIMIZAÇÃO LGPD (raia H2) — banco real, dois tenants, relógio injetado.
 * Os fixtures vão pelo DONO; o código sob teste roda sob o papel da aplicação (RLS vale).
 */
const A = 'c1b20000-0000-4000-8000-000000000001'
const B = 'c1b20000-0000-4000-8000-000000000002'
const PV_A = 'c1b20000-1111-4000-8000-000000000001'
const PV_B = 'c1b20000-1111-4000-8000-000000000002'
const PLANO = 'c1b20000-3333-4000-8000-000000000001'
const MODELO = 'c1b20000-4444-4000-8000-000000000001'
const CANAL: Record<string, string> = { [A]: 'c1b20000-5555-4000-8000-000000000001', [B]: 'c1b20000-5555-4000-8000-000000000002' }
const U_ADMIN = 'c1b20000-8888-4000-8000-000000000001'
const U_VENDEDOR = 'c1b20000-8888-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** "Hoje" do teste: fixo, para os prazos não dependerem do relógio da máquina. */
const AGORA = new Date('2027-03-15T12:00:00.000Z')
const mesesAtras = (n: number) => { const d = new Date(AGORA); d.setUTCMonth(d.getUTCMonth() - n); return d }
const diasAtras = (n: number) => new Date(AGORA.getTime() - n * 86_400_000)

let seqFone = 0
const novoFone = () => `558598${String(1_000_000 + ++seqFone + Math.floor(Math.random() * 5000) * 100).slice(-7)}`.slice(0, 13)

interface Opcoes {
  tenant?: string
  descartadoHa?: Date | null
  compra?: boolean
  pedidoEfetivado?: boolean
  tarefaAberta?: boolean
  oportunidadeAberta?: boolean
  mensagemEm?: Date
  fone?: string
  chave?: string
}

/** Contato COMPLETO: nome, e-mail, telefones, documento manual e do ERP, endereço, comentário, memória, conversa com texto e imagem. */
async function novoContato(o: Opcoes = {}) {
  const t = o.tenant ?? A
  const id = randomUUID(), conversa = randomUUID()
  const fone = o.fone ?? novoFone()
  const descartadoEm = o.descartadoHa === undefined ? mesesAtras(14) : o.descartadoHa
  await dono`INSERT INTO contato (tenant_id, id, nome, razao_social, nome_fantasia, email, observacoes, ativo,
                                  qualificado, qualificado_em, qtd_vendas, ultima_venda_em, total_vendas_centavos)
             VALUES (${t}, ${id}, 'Maria da Silva', 'Silva Modas LTDA', 'Maria Modas', 'maria@silva.test', 'cliente chata do bairro', true,
                     ${descartadoEm ? false : null}, ${descartadoEm}, ${o.compra ? 2 : 0}, ${o.compra ? mesesAtras(20) : null}, ${o.compra ? 20000 : 0})`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${t}, ${id}, 1, ${fone}, ${o.chave ?? fone}, true, true, 'whatsapp')`
  await dono`INSERT INTO contato_nome (tenant_id, contato_id, seq, nome, fonte, preferido) VALUES (${t}, ${id}, 1, 'Maria da Silva', 'manual', true)`
  await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte) VALUES
             (${t}, ${id}, 1, 'cpf', '12345678909', false, 'manual'), (${t}, ${id}, 2, 'cnpj', '11222333000181', true, 'erp:geracloud')`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, cidade, uf, principal, fonte) VALUES
             (${t}, ${id}, 1, 'Rua das Flores 10', 'Recife', 'PE', true, 'manual'), (${t}, ${id}, 2, 'Av. Fiscal 99', 'Recife', 'PE', false, 'erp:geracloud')`
  await dono`INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo) VALUES
             (${t}, ${id}, 'whatsapp', ${fone}), (${t}, ${id}, 'erp:geracloud', ${'cli-' + id})`
  await dono`INSERT INTO comentario (tenant_id, id, contato_id, texto) VALUES (${t}, ${randomUUID()}, ${id}, 'pagou atrasado, ligar para a irmã')`
  await dono`INSERT INTO cliente_memoria (tenant_id, id, contato_id, tipo, fato, fato_normalizado) VALUES (${t}, ${randomUUID()}, ${id}, 'preferencia', 'prefere tamanho G', 'prefere tamanho g')`
  const etiqueta = randomUUID()
  await dono`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (${t}, ${etiqueta}, ${'VIP ' + etiqueta.slice(0, 6)})`
  await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (${t}, ${id}, ${etiqueta})`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_mensagem_em)
             VALUES (${t}, ${conversa}, ${CANAL[t]!}, ${id}, 1, ${o.mensagemEm ?? mesesAtras(14)})`
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, criado_em) VALUES
             (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto: 'meu cartão é 4111 e moro na Rua das Flores' })}::text::jsonb, 'lida', 3, ${mesesAtras(14)}),
             (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'imagem', ${JSON.stringify({ imagem: `https://bucket.test/${id}/foto.jpg`, legenda: 'meu RG' })}::text::jsonb, 'lida', 3, ${mesesAtras(14)})`
  if (o.mensagemEm) {
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'texto', '{"texto":"voltei"}'::jsonb, ${o.mensagemEm})`
  }
  if (o.compra) {
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos) VALUES (${t}, ${randomUUID()}, ${id}, ${mesesAtras(20)}, 20000)`
  }
  if (o.pedidoEfetivado) {
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, origem, criado_em, atualizado_em, efetivado_em)
               VALUES (${t}, ${randomUUID()}, ${id}, 'efetivado', 'humano', ${mesesAtras(20)}, ${mesesAtras(20)}, ${mesesAtras(20)})`
  }
  if (o.tarefaAberta) {
    await dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em, estado, criado_em)
               VALUES (${t}, ${randomUUID()}, ${id}, 'ligar para a Maria', ${diasAtras(-3)}, 'aberta', ${mesesAtras(20)})`
  }
  if (o.oportunidadeAberta) {
    const [etapa] = await dono<{ id: string }[]>`SELECT id FROM funil_etapa WHERE tenant_id = ${t} LIMIT 1`
    if (etapa) {
      await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado, criado_em) VALUES (${t}, ${randomUUID()}, ${id}, ${etapa.id}, 'aberta', ${mesesAtras(20)})`
    }
  }
  return { id, conversa, fone }
}

const candidatos = (t = A, agora = AGORA, limite = 200) => comTenantServico(t, (tx) => candidatosDeAnonimizacao(tx, { agora, limite }))
const anonimizar = (t: string, id: string, motivo: 'retencao' | 'opt_out' | 'titular' = 'retencao', somenteCanais = false) =>
  comTenantServico(t, (tx) => anonimizarContato(tx, id, { motivo, agora: AGORA, somenteCanais }))
const pedir = (metodo: 'GET' | 'POST' | 'DELETE', url: string, tenant = A, payload?: object) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': tenant }, ...(payload ? { payload } : {}) })
const contar = async (tabela: string, id: string, t = A) =>
  Number((await dono.unsafe(`SELECT count(*)::int AS n FROM ${tabela} WHERE tenant_id = '${t}' AND contato_id = '${id}'`))[0]!.n)

const TABELAS_LIMPEZA = ['lgpd_midia_pendente', 'auditoria', 'mensagem', 'notificacao', 'comentario', 'cliente_memoria', 'contato_etiqueta', 'etiqueta',
  'consentimento_contato', 'contato_identidade_externa', 'contato_endereco', 'contato_documento', 'contato_nome', 'contato_telefone',
  'oportunidade', 'tarefa', 'pedido', 'venda', 'conversa', 'lista_bloqueio', 'contato']

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-h2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-h2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`H2 ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${CANAL[t]!}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, 'sub-admin-h2', 'Ada', 'ada@h2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_VENDEDOR}, ${`dev-${A}`}, 'Vito', 'vito@h2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${randomUUID()}, ${`dev-${B}`}, 'Beto', 'beto@h2.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  for (const t of TABELAS_LIMPEZA) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  await dono`DELETE FROM usuario_filial WHERE tenant_id = ${A}`
  await dono`UPDATE tenant SET retencao_meses = 12 WHERE id IN (${A}, ${B})`
  // O chamador da rota (sub dev-A) é ADMIN por padrão; os testes de papel o rebaixam.
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel)
             VALUES (${A}, ${U_ADMIN}, NULL, 'admin'), (${A}, ${U_VENDEDOR}, NULL, 'admin')`
})

afterAll(async () => {
  for (const t of [...TABELAS_LIMPEZA, 'usuario_filial', 'usuario', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('candidatos — a regra de retenção', () => {
  it('descartado além do prazo, sem interação e sem compra é candidato; dentro do prazo, não', async () => {
    const velho = await novoContato({ descartadoHa: mesesAtras(13) })
    const noPrazo = await novoContato({ descartadoHa: mesesAtras(11) })
    const naoDescartado = await novoContato({ descartadoHa: null })
    const ids = (await candidatos()).map((c) => c.id)
    expect(ids).toContain(velho.id)
    expect(ids).not.toContain(noPrazo.id)
    expect(ids).not.toContain(naoDescartado.id)
    expect((await candidatos()).find((c) => c.id === velho.id)!.motivo).toBe('retencao')
  })

  it('o prazo vem de tenant.retencao_meses (6 meses antecipa; 24 adia)', async () => {
    const c = await novoContato({ descartadoHa: mesesAtras(8) })
    expect((await candidatos()).map((x) => x.id)).not.toContain(c.id)
    await dono`UPDATE tenant SET retencao_meses = 6 WHERE id = ${A}`
    expect((await candidatos()).map((x) => x.id)).toContain(c.id)
    await dono`UPDATE tenant SET retencao_meses = 24 WHERE id = ${A}`
    expect((await candidatos()).map((x) => x.id)).not.toContain(c.id)
  })

  it('interação depois do descarte (mensagem, tarefa aberta) tira o contato da lista', async () => {
    const comMensagem = await novoContato({ mensagemEm: mesesAtras(2) })
    const comTarefa = await novoContato({ tarefaAberta: true })
    const ids = (await candidatos()).map((c) => c.id)
    expect(ids).not.toContain(comMensagem.id)
    expect(ids).not.toContain(comTarefa.id)
  })

  it('contato com compra (venda ou pedido efetivado) NUNCA é candidato da retenção', async () => {
    const comVenda = await novoContato({ compra: true })
    const comPedido = await novoContato({ pedidoEfetivado: true })
    const ids = (await candidatos()).map((c) => c.id)
    expect(ids).not.toContain(comVenda.id)
    expect(ids).not.toContain(comPedido.id)
    // E a função recusa mesmo se alguém a chamar à mão com motivo de retenção.
    expect(await anonimizar(A, comVenda.id, 'retencao')).toEqual({ ok: false, erro: 'contato_com_compra' })
    expect(await anonimizar(A, comPedido.id, 'retencao')).toEqual({ ok: false, erro: 'contato_com_compra' })
    const [l] = await dono<{ nome: string; anonimizado_em: Date | null }[]>`SELECT nome, anonimizado_em FROM contato WHERE id = ${comVenda.id}`
    expect(l).toEqual({ nome: 'Maria da Silva', anonimizado_em: null })
  })

  it('opt-out há mais de 15 dias é candidato; há menos, ou revertido, não; com compra entra (modo canais)', async () => {
    const antigo = await novoContato({ descartadoHa: null })
    const recente = await novoContato({ descartadoHa: null })
    const revertido = await novoContato({ descartadoHa: null })
    const comCompra = await novoContato({ descartadoHa: null, compra: true })
    for (const [c, quando] of [[antigo, diasAtras(16)], [recente, diasAtras(14)], [revertido, diasAtras(30)], [comCompra, diasAtras(20)]] as const) {
      await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: c.id, origem: 'teste', agora: quando }))
    }
    await dono`INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
               VALUES (${A}, ${revertido.id}, 'whatsapp', true, 'cadastro', ${diasAtras(20)})`
    const lista = await candidatos()
    const ids = lista.map((c) => c.id)
    expect(ids).toContain(antigo.id)
    expect(ids).toContain(comCompra.id)
    expect(ids).not.toContain(recente.id)
    expect(ids).not.toContain(revertido.id)
    expect(lista.find((c) => c.id === antigo.id)!.motivo).toBe('opt_out')
    // Com compra: anonimização de opt-out cai no modo `canais`.
    expect(await anonimizar(A, comCompra.id, 'opt_out')).toMatchObject({ ok: true, modo: 'canais' })
  })

  it('dois tenants: o candidato de B não aparece em A (e vice-versa)', async () => {
    const a = await novoContato({ tenant: A }), b = await novoContato({ tenant: B })
    expect((await candidatos(A)).map((c) => c.id)).toEqual([a.id])
    expect((await candidatos(B)).map((c) => c.id)).toEqual([b.id])
    // A função sob o tenant A não enxerga o contato de B.
    expect(await anonimizar(A, b.id)).toEqual({ ok: false, erro: 'contato_nao_encontrado' })
  })
})

describe('anonimizarContato', () => {
  it('modo completa: apaga dados pessoais, mantém ids/agregados, bloqueia o número e audita sem dado pessoal', async () => {
    const c = await novoContato()
    const r = await anonimizar(A, c.id)
    expect(r).toEqual({ ok: true, jaAnonimizado: false, modo: 'completa' })

    const [l] = await dono<Record<string, unknown>[]>`SELECT * FROM contato WHERE id = ${c.id}`
    expect(l).toMatchObject({
      nome: 'Contato anonimizado', email: null, razao_social: null, nome_fantasia: null, observacoes: null,
      ativo: false, recebe_campanhas: false, recebe_automacoes: false, anonimizacao_modo: 'completa', qtd_vendas: 0,
    })
    expect(l!.anonimizado_em).toEqual(AGORA)
    for (const tabela of ['contato_telefone', 'contato_nome', 'contato_documento', 'contato_endereco', 'contato_identidade_externa',
      'comentario', 'cliente_memoria', 'contato_etiqueta']) {
      expect(await contar(tabela, c.id), tabela).toBe(0)
    }
    // O número não volta: chave em lista_bloqueio com motivo 'lgpd'.
    const [b] = await dono<{ motivo: string }[]>`SELECT motivo FROM lista_bloqueio WHERE tenant_id = ${A} AND chave_bloqueio = ${c.fone}`
    expect(b?.motivo).toBe('lgpd')
    // Auditoria: ids, motivo, modo e contagens — NENHUM dado pessoal.
    const aud = await dono<{ acao: string; entidade_id: string; dados: Record<string, unknown> }[]>`
      SELECT acao, entidade_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`
    expect(aud).toHaveLength(1)
    expect(aud[0]!.entidade_id).toBe(c.id)
    expect(aud[0]!.dados).toEqual({ motivo: 'retencao', modo: 'completa', mensagens: 2, midias: 1 })
    const texto = JSON.stringify(aud)
    for (const pessoal of ['Maria', 'Silva', 'maria@', c.fone, '12345678909', 'Rua das Flores']) expect(texto).not.toContain(pessoal)
  })

  it('o conteúdo das mensagens vira "[removido por LGPD]", a contagem fica e a mídia vai para a fila de remoção', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    const msgs = await dono<{ tipo: string; conteudo: Record<string, unknown> }[]>`SELECT tipo, conteudo FROM mensagem WHERE conversa_id = ${c.conversa} ORDER BY tipo`
    expect(msgs).toHaveLength(2)
    for (const m of msgs) {
      expect(m.conteudo.texto).toBe(TEXTO_REMOVIDO_LGPD)
      expect(m.conteudo.removido_lgpd).toBe(true)
    }
    const texto = JSON.stringify(msgs)
    expect(texto).not.toContain('cartão')
    expect(texto).not.toContain('meu RG')
    expect(texto).not.toContain('bucket.test')
    const fila = await dono<{ referencia: string; removido_em: Date | null }[]>`SELECT referencia, removido_em FROM lgpd_midia_pendente WHERE tenant_id = ${A} AND contato_id = ${c.id}`
    expect(fila).toEqual([{ referencia: `https://bucket.test/${c.id}/foto.jpg`, removido_em: null }])
    const [conv] = await dono<{ arquivada: boolean }[]>`SELECT arquivada FROM conversa WHERE id = ${c.conversa}`
    expect(conv!.arquivada).toBe(true)
  })

  it('é idempotente: a segunda chamada não refaz nem re-audita', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    expect(await anonimizar(A, c.id)).toEqual({ ok: true, jaAnonimizado: true, modo: 'completa' })
    expect(Number((await dono`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`)[0]!.n)).toBe(1)
  })

  it('modo canais (compra + somenteCanais): apaga telefones/conversas e mantém o vínculo fiscal', async () => {
    const c = await novoContato({ compra: true })
    const r = await anonimizar(A, c.id, 'titular', true)
    expect(r).toEqual({ ok: true, jaAnonimizado: false, modo: 'canais' })
    const [l] = await dono<Record<string, unknown>[]>`SELECT * FROM contato WHERE id = ${c.id}`
    expect(l).toMatchObject({ nome: 'Maria da Silva', razao_social: 'Silva Modas LTDA', email: null, observacoes: null, ativo: true, qtd_vendas: 2 })
    expect(await contar('contato_telefone', c.id)).toBe(0)
    expect(await contar('comentario', c.id)).toBe(0)
    // Documento e endereço do ERP ficam (fiscal); os manuais saem.
    const docs = await dono<{ fonte: string }[]>`SELECT fonte FROM contato_documento WHERE contato_id = ${c.id}`
    expect(docs).toEqual([{ fonte: 'erp:geracloud' }])
    const ends = await dono<{ fonte: string }[]>`SELECT fonte FROM contato_endereco WHERE contato_id = ${c.id}`
    expect(ends).toEqual([{ fonte: 'erp:geracloud' }])
    const ids = await dono<{ sistema: string }[]>`SELECT sistema FROM contato_identidade_externa WHERE contato_id = ${c.id}`
    expect(ids).toEqual([{ sistema: 'erp:geracloud' }])
    expect(Number((await dono`SELECT count(*)::int AS n FROM venda WHERE contato_id = ${c.id}`)[0]!.n)).toBe(1)
    const [m] = await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE conversa_id = ${c.conversa} LIMIT 1`
    expect(m!.conteudo.texto).toBe(TEXTO_REMOVIDO_LGPD)
    expect((await dono<{ motivo: string }[]>`SELECT motivo FROM lista_bloqueio WHERE chave_bloqueio = ${c.fone}`)[0]!.motivo).toBe('lgpd')
  })
})

describe('efeitos: gateway, reimportação e buscas', () => {
  it('o gateway recusa o envio a contato anonimizado (nada sai)', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    const r = await enviarTextoNaConversa(A, c.conversa, 'oi, tudo bem?', null, AGORA)
    expect(r.ok).toBe(false)
  })

  it('a chave do telefone anonimizado não volta por importação, e o bloqueio lgpd não sai pela tela', async () => {
    const c = await novoContato({ fone: '5585988880001', chave: '558588880001' })
    await anonimizar(A, c.id)
    const imp = await pedir('POST', '/v1/contatos/importar', A, { csv: 'nome,telefone\nMaria Nova,(85) 98888-0001\nJoana,(85) 97777-0002' })
    expect(imp.statusCode).toBe(200)
    expect(imp.json()).toMatchObject({ criados: 1, bloqueadosLgpd: 1 })
    expect(JSON.stringify(imp.json())).not.toContain('88880001')
    expect(Number((await dono`SELECT count(*)::int AS n FROM contato_telefone WHERE tenant_id = ${A} AND chave_bloqueio = '558588880001'`)[0]!.n)).toBe(0)
    const del = await pedir('DELETE', '/v1/bloqueios/558588880001', A)
    expect(del.statusCode).toBe(422)
    expect(del.json().erro).toBe('bloqueio.lgpd_irremovivel')
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${A} AND chave_bloqueio = '558588880001'`).length).toBe(1)
  })

  it('some das buscas', async () => {
    const c = await novoContato()
    expect((await pedir('GET', '/v1/contatos/busca?q=Maria da Silva', A)).json().itens.map((i: { id: string }) => i.id)).toContain(c.id)
    await anonimizar(A, c.id)
    const depois = (await pedir('GET', '/v1/contatos/busca?q=Maria', A)).json().itens.map((i: { id: string }) => i.id)
    expect(depois).not.toContain(c.id)
  })
})

describe('rota POST /v1/contatos/:id/anonimizar e relatório', () => {
  it('exige admin: vendedor recebe 403 e nada é apagado', async () => {
    const c = await novoContato()
    await dono`UPDATE usuario_filial SET papel = 'vendedor' WHERE tenant_id = ${A} AND usuario_id = ${U_VENDEDOR}`
    const r = await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A)
    expect(r.statusCode).toBe(403)
    expect((await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE id = ${c.id}`)[0]!.nome).toBe('Maria da Silva')
    expect((await pedir('GET', '/v1/lgpd/relatorio', A)).statusCode).toBe(403)
  })

  it('admin anonimiza já, mesmo sem prazo; contato inexistente ou de outro tenant dá 404', async () => {
    const c = await novoContato({ descartadoHa: null })
    const r = await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, modo: 'completa', jaAnonimizado: false })
    expect((await pedir('POST', `/v1/contatos/${randomUUID()}/anonimizar`, A)).statusCode).toBe(404)
    const outro = await novoContato({ tenant: B })
    expect((await pedir('POST', `/v1/contatos/${outro.id}/anonimizar`, A)).statusCode).toBe(404)
    expect((await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE id = ${outro.id}`)[0]!.nome).toBe('Maria da Silva')
    const aud = await dono<{ ator_id: string | null; dados: { motivo: string } }[]>`SELECT ator_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`
    expect(aud).toHaveLength(1)
    expect(aud[0]!.dados.motivo).toBe('titular')
    expect(aud[0]!.ator_id).toBe(U_VENDEDOR)
  })

  it('com compra: 422 tipificado lgpd.contato_com_compra; com ?somenteCanais=true apaga só canais e conversas', async () => {
    const c = await novoContato({ compra: true })
    const recusa = await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A)
    expect(recusa.statusCode).toBe(422)
    expect(recusa.json()).toMatchObject({ erro: 'lgpd.contato_com_compra', acao: { somenteCanais: true } })
    expect(await contar('contato_telefone', c.id)).toBe(1)
    const ok = await pedir('POST', `/v1/contatos/${c.id}/anonimizar?somenteCanais=true`, A)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().modo).toBe('canais')
    expect(await contar('contato_telefone', c.id)).toBe(0)
  })

  it('relatório: conta por motivo e modo, sem dado pessoal; período inválido dá 422', async () => {
    const a = await novoContato(), b = await novoContato({ descartadoHa: null }), outroTenant = await novoContato({ tenant: B })
    await anonimizar(A, a.id, 'retencao')
    await anonimizar(A, b.id, 'titular')
    await anonimizar(B, outroTenant.id, 'retencao')
    const hoje = new Date().toISOString().slice(0, 10)
    // A auditoria foi escrita com o relógio real do banco (now()): o período cobre hoje.
    const rel = await pedir('GET', `/v1/lgpd/relatorio?de=${hoje}&ate=${hoje}`, A)
    expect(rel.statusCode).toBe(200)
    expect(rel.json()).toMatchObject({ total: 2, porMotivo: { retencao: 1, opt_out: 0, titular: 1 }, porModo: { completa: 2, canais: 0 } })
    const texto = JSON.stringify(rel.json())
    expect(texto).not.toContain('Maria')
    expect(texto).not.toContain(a.fone)
    // O relatório de B só vê o próprio.
    expect((await pedir('GET', '/v1/lgpd/relatorio', B)).json().total).toBe(1)
    expect((await pedir('GET', '/v1/lgpd/relatorio?de=2027-13-45', A)).statusCode).toBe(422)
    expect((await pedir('GET', '/v1/lgpd/relatorio?de=2027-03-02&ate=2027-03-01', A)).statusCode).toBe(422)
    const direto = await comTenantServico(A, (tx) => relatorioAnonimizacao(tx, { de: new Date('2000-01-01'), ate: new Date('2001-01-01') }))
    expect(direto.total).toBe(0)
  })
})

describe('worker em lote', () => {
  it('anonimiza só os candidatos, de cada tenant, e recontar não acha mais ninguém', async () => {
    const velhos = [await novoContato(), await novoContato()]
    const novo = await novoContato({ descartadoHa: mesesAtras(2) })
    const deB = await novoContato({ tenant: B })
    const r = await processarLgpd(dono as never, {}, AGORA)
    expect(r.anonimizados).toBeGreaterThanOrEqual(3)
    expect(r.falhas).toBe(0)
    for (const c of [...velhos, deB]) {
      expect((await dono<{ anonimizado_em: Date | null }[]>`SELECT anonimizado_em FROM contato WHERE id = ${c.id}`)[0]!.anonimizado_em).not.toBeNull()
    }
    expect((await dono<{ anonimizado_em: Date | null }[]>`SELECT anonimizado_em FROM contato WHERE id = ${novo.id}`)[0]!.anonimizado_em).toBeNull()
    expect(await candidatos(A)).toEqual([])
    expect(await candidatos(B)).toEqual([])
  })

  it('para no meio quando estoura o orçamento de tempo e retoma no próximo ciclo', async () => {
    const todos = [await novoContato(), await novoContato(), await novoContato()]
    let agoraMs = 0
    // Cada contato processado "gasta" 1 s; o orçamento é 1,5 s → processa 2 e interrompe.
    const relogio = () => agoraMs
    const primeira = await processarLgpd(dono as never, {
      somenteTenant: A, orcamentoMs: 1500, relogio, depoisDoContato: () => { agoraMs += 1000 },
    }, AGORA)
    expect(primeira.interrompido).toBe(true)
    expect(primeira.anonimizados).toBe(2)
    expect(await candidatos(A)).toHaveLength(1)
    // Próximo ciclo: orçamento novo, termina o resto.
    agoraMs = 0
    const segunda = await processarLgpd(dono as never, { somenteTenant: A, orcamentoMs: 60_000, relogio }, AGORA)
    expect(segunda.interrompido).toBe(false)
    expect(segunda.anonimizados).toBe(1)
    for (const c of todos) {
      expect((await dono<{ anonimizado_em: Date | null }[]>`SELECT anonimizado_em FROM contato WHERE id = ${c.id}`)[0]!.anonimizado_em).not.toBeNull()
    }
  })

  it('respeita o tamanho do lote (lote 2 → seletor devolve no máximo 2)', async () => {
    await novoContato(); await novoContato(); await novoContato()
    expect(await candidatos(A, AGORA, 2)).toHaveLength(2)
  })
})
