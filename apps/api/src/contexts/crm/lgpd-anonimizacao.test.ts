import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { ClienteCanonico, ConectorErp } from '@geracrm/conectores'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { enviarTextoNaConversa } from '../atendimento/envio-conversa.js'
import { ingerirClientes } from '../integracao/ingestao-clientes.js'
import { processarLgpd } from '../../workers/lgpd.js'
import { backoffMidiaMs, processarMidiaLgpd } from '../../workers/lgpd-midia.js'
import { processarTranscricoes } from '../../workers/transcricao.js'
import type { ArquivosBucket } from './arquivos-bucket.js'
import { registrarOptOut } from './opt-out.js'
import {
  anonimizarContato, candidatosDeAnonimizacao, previaAnonimizacao, relatorioAnonimizacao, TEXTO_REMOVIDO_LGPD,
} from './lgpd-anonimizacao.js'

/**
 * RETENÇÃO E ANONIMIZAÇÃO LGPD (raia H2) — banco real, dois tenants, relógio injetado.
 * Os fixtures vão pelo DONO; o código sob teste roda sob o papel da aplicação (RLS vale) e os
 * workers sempre com `somenteTenant` (regra do CLAUDE.md: nunca consumir a fila como dono).
 */
const A = 'c1b20000-0000-4000-8000-000000000001'
const B = 'c1b20000-0000-4000-8000-000000000002'
const PV_A = 'c1b20000-1111-4000-8000-000000000001'
const PV_B = 'c1b20000-1111-4000-8000-000000000002'
const PLANO = 'c1b20000-3333-4000-8000-000000000001'
const MODELO = 'c1b20000-4444-4000-8000-000000000001'
const CONEXAO = 'c1b20000-6666-4000-8000-000000000001'
const CANAL: Record<string, string> = { [A]: 'c1b20000-5555-4000-8000-000000000001', [B]: 'c1b20000-5555-4000-8000-000000000002' }
const U_ADMIN = 'c1b20000-8888-4000-8000-000000000001'
/** O chamador das rotas (sub `dev-A`). */
const U_CHAMADOR = 'c1b20000-8888-4000-8000-000000000002'
const SISTEMA_ERP = `erp:${CONEXAO}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

/** "Hoje" do teste: fixo e injetado, para os prazos não dependerem do relógio da máquina. */
const AGORA = new Date('2027-03-15T12:00:00.000Z')
/** Mensagens de ANTES do descarte (partição `mensagem_anterior`, existe em qualquer banco). */
const MUITO_ANTES = new Date('2025-01-01T00:00:00.000Z')
const ETAPA = 'c1b20000-7777-4000-8000-000000000001'
const mesesAtras = (n: number) => { const d = new Date(AGORA); d.setUTCMonth(d.getUTCMonth() - n); return d }
const diasAtras = (n: number) => new Date(AGORA.getTime() - n * 86_400_000)

let seqFone = 0
const novoFone = () => `558598${String(1_000_000 + ++seqFone + Math.floor(Math.random() * 5000) * 100).slice(-7)}`.slice(0, 13)
const chaveDe = (fone: string) => fone.length === 13 ? fone.slice(0, 4) + fone.slice(5) : fone

interface Opcoes {
  tenant?: string
  descartadoHa?: Date | null
  compra?: boolean
  erp?: boolean
  fone?: string
  chave?: string
}

/** Contato COMPLETO: nome, e-mail, telefone, documento manual e do ERP, endereço, comentário, memória, conversa com texto e imagem. */
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
             VALUES (${t}, ${id}, 1, ${fone}, ${o.chave ?? chaveDe(fone)}, true, true, 'whatsapp')`
  await dono`INSERT INTO contato_nome (tenant_id, contato_id, seq, nome, fonte, preferido) VALUES (${t}, ${id}, 1, 'Maria da Silva', 'manual', true)`
  await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte) VALUES
             (${t}, ${id}, 1, 'cpf', '12345678909', false, 'manual'), (${t}, ${id}, 2, 'cnpj', '11222333000181', true, 'erp:geracloud')`
  await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, cidade, uf, principal, fonte) VALUES
             (${t}, ${id}, 1, 'Rua das Flores 10', 'Recife', 'PE', true, 'manual'), (${t}, ${id}, 2, 'Av. Fiscal 99', 'Recife', 'PE', false, 'erp:geracloud')`
  await dono`INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo) VALUES (${t}, ${id}, 'whatsapp', ${fone})`
  if (o.erp) {
    await dono`INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo) VALUES (${t}, ${id}, ${SISTEMA_ERP}, ${'cli-' + id})`
  }
  await dono`INSERT INTO cliente_memoria (tenant_id, id, contato_id, tipo, fato, fato_normalizado) VALUES (${t}, ${randomUUID()}, ${id}, 'preferencia', 'prefere tamanho G', 'prefere tamanho g')`
  const etiqueta = randomUUID()
  await dono`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (${t}, ${etiqueta}, ${'VIP ' + etiqueta.slice(0, 6)})`
  await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (${t}, ${id}, ${etiqueta})`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_mensagem_em)
             VALUES (${t}, ${conversa}, ${CANAL[t]!}, ${id}, 1, ${mesesAtras(15)})`
  const antes = MUITO_ANTES
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, criado_em) VALUES
             (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto: 'meu cartão é 4111 e moro na Rua das Flores' })}::text::jsonb, 'lida', 3, ${antes}),
             (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'imagem', ${JSON.stringify({ imagem: `tenant/${t}/${id}.jpg`, legenda: 'meu RG' })}::text::jsonb, 'lida', 3, ${antes}),
             (${t}, ${randomUUID()}, ${conversa}, 'entrante', 'imagem', ${JSON.stringify({ imagem: `https://lookaside.test/${id}.jpg` })}::text::jsonb, 'lida', 3, ${antes})`
  if (o.compra) {
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos) VALUES (${t}, ${randomUUID()}, ${id}, ${mesesAtras(20)}, 20000)`
  }
  return { id, conversa, fone, chave: o.chave ?? chaveDe(fone), descartadoEm }
}

/** Mensagem na conversa do contato (padrão: entrante, ontem). */
const mensagem = (t: string, conversa: string, quando: Date, direcao: 'entrante' | 'saliente' = 'entrante', enviadaPor: string | null = null) =>
  dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
       VALUES (${t}, ${randomUUID()}, ${conversa}, ${direcao}, 'texto', '{"texto":"voltei"}'::jsonb, ${enviadaPor}, ${quando})`
const etapaGanho = async () => {
  await dono`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${A}, ${ETAPA}, 99, 'h2_ganho', 'Ganho', 'ganho') ON CONFLICT DO NOTHING`
  return ETAPA
}

const candidatos = (t = A, limite = 200) => comTenantServico(t, (tx) => candidatosDeAnonimizacao(tx, { agora: AGORA, limite }))
const idsCandidatos = async (t = A) => (await candidatos(t)).map((c) => c.id)
const anonimizar = (t: string, id: string, motivo: 'retencao' | 'opt_out' | 'titular' = 'retencao', somenteCanais = false) =>
  comTenantServico(t, (tx) => anonimizarContato(tx, id, { motivo, agora: AGORA, somenteCanais }))
const pedir = (metodo: 'GET' | 'POST' | 'DELETE', url: string, tenant = A, payload?: object) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': tenant }, ...(payload ? { payload } : {}) })
const contar = async (tabela: string, id: string, t = A) =>
  Number((await dono.unsafe(`SELECT count(*)::int AS n FROM ${tabela} WHERE tenant_id = '${t}' AND contato_id = '${id}'`))[0]!.n)
const anonimizadoEm = async (id: string) =>
  (await dono<{ anonimizado_em: Date | null }[]>`SELECT anonimizado_em FROM contato WHERE id = ${id}`)[0]!.anonimizado_em
const ligarAutomatica = (t = A) => dono`UPDATE tenant SET lgpd_auto = true WHERE id = ${t}`

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

function bucketFalso(falhar: (chave: string) => boolean = () => false) {
  const removidos: string[] = []
  const porta: ArquivosBucket = {
    disponivel: () => true,
    async subir() { /* não usado */ },
    async remover(chave) {
      if (falhar(chave)) throw Object.assign(new Error(`Access denied for ${chave}`), { name: 'AccessDenied' })
      removidos.push(chave)
    },
    async urlAssinada(chave) { return `https://assinada.test/${chave}` },
  }
  return { porta, removidos }
}

const TABELAS_LIMPEZA = ['lgpd_falha', 'lgpd_midia_pendente', 'auditoria', 'outbox', 'midia', 'agente_revisao', 'agente_avaliacao',
  'agente_decisao', 'agente_sessao', 'agente_retorno', 'atendimento', 'mensagem', 'notificacao', 'comentario', 'cliente_memoria',
  'contato_etiqueta', 'etiqueta', 'contato_arquivo', 'evento_agenda', 'consentimento_contato', 'contato_identidade_externa',
  'contato_endereco', 'contato_documento', 'contato_nome', 'contato_telefone', 'oportunidade', 'tarefa', 'pedido_proposta', 'pedido',
  'venda', 'conversa', 'lista_bloqueio', 'contato']

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
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel) VALUES (${A}, ${CONEXAO}, 'falso', 'ERP de teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, 'sub-admin-h2', 'Ada', 'ada@h2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_CHAMADOR}, ${`dev-${A}`}, 'Vito', 'vito@h2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${randomUUID()}, ${`dev-${B}`}, 'Beto', 'beto@h2.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  for (const t of TABELAS_LIMPEZA) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  await dono`DELETE FROM usuario_filial WHERE tenant_id = ${A}`
  await dono`UPDATE tenant SET retencao_meses = 12, lgpd_auto = false, lgpd_auto_alterada_em = NULL WHERE id IN (${A}, ${B})`
  // O chamador da rota (sub dev-A) é ADMIN ATRIBUÍDO por padrão; os testes de papel o rebaixam.
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel)
             VALUES (${A}, ${U_ADMIN}, NULL, 'admin'), (${A}, ${U_CHAMADOR}, NULL, 'admin')`
})

afterAll(async () => {
  for (const t of [...TABELAS_LIMPEZA, 'usuario_filial', 'usuario', 'canal_conectado', 'conexao_erp']) {
    if (t === 'usuario_filial') await dono`DELETE FROM funil_etapa WHERE id = ${ETAPA}`
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
    const lista = await candidatos()
    expect(lista).toEqual([{ id: velho.id, motivo: 'retencao' }])
    expect(lista.map((c) => c.id)).not.toContain(noPrazo.id)
    expect(lista.map((c) => c.id)).not.toContain(naoDescartado.id)
  })

  it('o prazo vem de tenant.retencao_meses, calculado no SQL (6 meses antecipa; 24 adia)', async () => {
    const c = await novoContato({ descartadoHa: mesesAtras(8) })
    expect(await idsCandidatos()).not.toContain(c.id)
    await dono`UPDATE tenant SET retencao_meses = 6 WHERE id = ${A}`
    expect(await idsCandidatos()).toContain(c.id)
    await dono`UPDATE tenant SET retencao_meses = 24 WHERE id = ${A}`
    expect(await idsCandidatos()).not.toContain(c.id)
  })

  it('C1: oportunidade GANHA (fechada depois do descarte) é compra — nunca candidato', async () => {
    const c = await novoContato()
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado, criado_em, fechada_em)
               VALUES (${A}, ${randomUUID()}, ${c.id}, ${await etapaGanho()}, 'ganha', ${mesesAtras(20)}, ${mesesAtras(2)})`
    expect(await idsCandidatos()).not.toContain(c.id)
    expect(await anonimizar(A, c.id, 'retencao')).toEqual({ ok: false, erro: 'contato_com_compra' })
  })

  it('C2: pedido aguardando_conferencia (ou confirmado) ANTES do descarte é compra — nunca candidato', async () => {
    const conf = await novoContato(), confirmado = await novoContato()
    for (const [c, estado] of [[conf, 'aguardando_conferencia'], [confirmado, 'confirmado']] as const) {
      await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, origem, criado_em, atualizado_em)
                 VALUES (${A}, ${randomUUID()}, ${c.id}, ${estado}, 'humano', ${mesesAtras(15)}, ${mesesAtras(15)})`
    }
    const ids = await idsCandidatos()
    expect(ids).not.toContain(conf.id)
    expect(ids).not.toContain(confirmado.id)
  })

  it('C3: tarefa CONCLUÍDA depois do descarte, ou comentário recente, tira da lista', async () => {
    const concluida = await novoContato(), comentada = await novoContato()
    await dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em, estado, concluida_em, criado_em)
               VALUES (${A}, ${randomUUID()}, ${concluida.id}, 'ligar', ${mesesAtras(1)}, 'concluida', ${mesesAtras(1)}, ${mesesAtras(15)})`
    await dono`INSERT INTO comentario (tenant_id, id, contato_id, texto, criado_em) VALUES (${A}, ${randomUUID()}, ${comentada.id}, 'falou comigo ontem', ${diasAtras(1)})`
    const ids = await idsCandidatos()
    expect(ids).not.toContain(concluida.id)
    expect(ids).not.toContain(comentada.id)
  })

  it('qualquer sinal de vida depois do descarte tira da lista; a mensagem automática (sem pessoa) não', async () => {
    const entrante = await novoContato(), humana = await novoContato(), doAgente = await novoContato()
    const pedido = await novoContato(), tarefaAberta = await novoContato(), opPerdida = await novoContato()
    const arquivo = await novoContato(), agenda = await novoContato()
    await mensagem(A, entrante.conversa, mesesAtras(2))
    await mensagem(A, humana.conversa, mesesAtras(2), 'saliente', U_ADMIN)
    await mensagem(A, doAgente.conversa, mesesAtras(2), 'saliente', null)
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, origem, criado_em, atualizado_em)
               VALUES (${A}, ${randomUUID()}, ${pedido.id}, 'rascunho', 'humano', ${mesesAtras(3)}, ${mesesAtras(3)})`
    await dono`INSERT INTO tarefa (tenant_id, id, contato_id, titulo, vence_em, estado, criado_em)
               VALUES (${A}, ${randomUUID()}, ${tarefaAberta.id}, 'ligar', ${diasAtras(-3)}, 'aberta', ${mesesAtras(20)})`
    await dono`INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, estado, motivo_perda_codigo, criado_em, fechada_em)
               VALUES (${A}, ${randomUUID()}, ${opPerdida.id}, ${await etapaGanho()}, 'perdida', 'preco', ${mesesAtras(20)}, ${mesesAtras(3)})`
    await dono`INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket, criado_em)
               VALUES (${A}, ${randomUUID()}, ${arquivo.id}, 'proposta.pdf', 'application/pdf', 10, ${`tenant/${A}/arq/${arquivo.id}.pdf`}, ${mesesAtras(2)})`
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, contato_id, responsavel_id, inicio, fim, criado_em)
               VALUES (${A}, ${randomUUID()}, 'visita', ${agenda.id}, ${U_ADMIN}, ${mesesAtras(13)}, ${new Date(mesesAtras(13).getTime() + 3_600_000)}, ${mesesAtras(2)})`
    const ids = await idsCandidatos()
    for (const fora of [entrante, humana, pedido, tarefaAberta, opPerdida, arquivo, agenda]) expect(ids).not.toContain(fora.id)
    expect(ids).toEqual([doAgente.id])
  })

  it('contato com venda ou vindo do ERP (identidade erp:) NUNCA é candidato da retenção', async () => {
    const comVenda = await novoContato({ compra: true })
    const doErp = await novoContato({ erp: true })
    expect(await idsCandidatos()).toEqual([])
    expect(await anonimizar(A, comVenda.id, 'retencao')).toEqual({ ok: false, erro: 'contato_com_compra' })
    expect(await anonimizar(A, doErp.id, 'retencao')).toEqual({ ok: false, erro: 'contato_com_compra' })
    const [l] = await dono<{ nome: string; anonimizado_em: Date | null }[]>`SELECT nome, anonimizado_em FROM contato WHERE id = ${comVenda.id}`
    expect(l).toEqual({ nome: 'Maria da Silva', anonimizado_em: null })
  })

  it('dois tenants: o candidato de B não aparece em A (e vice-versa)', async () => {
    const a = await novoContato({ tenant: A }), b = await novoContato({ tenant: B })
    expect(await idsCandidatos(A)).toEqual([a.id])
    expect(await idsCandidatos(B)).toEqual([b.id])
    expect(await anonimizar(A, b.id)).toEqual({ ok: false, erro: 'contato_nao_encontrado' })
  })
})

describe('candidatos — a regra do opt-out', () => {
  const optOut = (id: string, quando: Date) => comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: id, origem: 'teste', agora: quando }))

  it('opt-out há mais de 15 dias é candidato; há menos, ou revertido, não; com compra entra (modo canais)', async () => {
    const antigo = await novoContato({ descartadoHa: null })
    const recente = await novoContato({ descartadoHa: null })
    const revertido = await novoContato({ descartadoHa: null })
    const comCompra = await novoContato({ descartadoHa: null, compra: true })
    for (const [c, quando] of [[antigo, diasAtras(16)], [recente, diasAtras(14)], [revertido, diasAtras(30)], [comCompra, diasAtras(20)]] as const) {
      await optOut(c.id, quando)
    }
    await dono`INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
               VALUES (${A}, ${revertido.id}, 'whatsapp', true, 'cadastro', ${diasAtras(20)})`
    const lista = await candidatos()
    expect(lista.map((c) => c.id).sort()).toEqual([antigo.id, comCompra.id].sort())
    expect(lista.every((c) => c.motivo === 'opt_out')).toBe(true)
    expect(await anonimizar(A, comCompra.id, 'opt_out')).toMatchObject({ ok: true, modo: 'canais' })
  })

  it('C4: dois telefones, o operador desbloqueou um pela tela → consentimento concedido e fora da lista', async () => {
    const c = await novoContato({ descartadoHa: null })
    const segundo = novoFone()
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
               VALUES (${A}, ${c.id}, 2, ${segundo}, ${chaveDe(segundo)}, false, 'erp')`
    await optOut(c.id, diasAtras(30))
    expect(await idsCandidatos()).toEqual([c.id])
    const del = await pedir('DELETE', `/v1/bloqueios/${c.chave}`)
    expect(del.statusCode).toBe(200)
    const cons = await dono<{ concedido: boolean; origem: string }[]>`
      SELECT concedido, origem FROM consentimento_contato WHERE tenant_id = ${A} AND contato_id = ${c.id} AND tipo = 'whatsapp' ORDER BY registrado_em DESC LIMIT 1`
    expect(cons[0]).toEqual({ concedido: true, origem: 'desbloqueio_manual' })
    expect(await idsCandidatos()).toEqual([])
  })

  it('C5: um telefone marcado "inválido" (não opt-out) e o principal sem bloqueio → fora da lista', async () => {
    const c = await novoContato({ descartadoHa: null })
    const antigo = novoFone()
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
               VALUES (${A}, ${c.id}, 2, ${antigo}, ${chaveDe(antigo)}, false, 'erp')`
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem) VALUES (${A}, ${chaveDe(antigo)}, 'invalido', 'manual')`
    await dono`INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
               VALUES (${A}, ${c.id}, 'whatsapp', false, 'opt_out_mensagem', ${diasAtras(40)})`
    expect(await idsCandidatos()).toEqual([])
    // Mesmo com o principal bloqueado por opt-out, o "inválido" segura: só sai quando TODOS são opt-out.
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem) VALUES (${A}, ${c.chave}, 'opt_out', 'teste')`
    expect(await idsCandidatos()).toEqual([])
  })

  it('mensagem entrante ou pedido depois do opt-out tiram da lista', async () => {
    const falou = await novoContato({ descartadoHa: null }), comprou = await novoContato({ descartadoHa: null })
    await optOut(falou.id, diasAtras(30)); await optOut(comprou.id, diasAtras(30))
    expect((await idsCandidatos()).sort()).toEqual([falou.id, comprou.id].sort())
    await mensagem(A, falou.conversa, diasAtras(2))
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, origem, criado_em, atualizado_em)
               VALUES (${A}, ${randomUUID()}, ${comprou.id}, 'rascunho', 'humano', ${diasAtras(3)}, ${diasAtras(3)})`
    expect(await idsCandidatos()).toEqual([])
  })
})

describe('anonimizarContato', () => {
  it('modo completa pela retenção: apaga dados pessoais, mantém ids/agregados, NÃO bloqueia o número e audita sem dado pessoal', async () => {
    const c = await novoContato()
    const r = await anonimizar(A, c.id)
    expect(r).toEqual({ ok: true, jaAnonimizado: false, modo: 'completa', midiasPendentes: 1 })

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
    // A retenção não grava bloqueio nem consentimento: ninguém pediu nada.
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${A} AND chave_bloqueio = ${c.chave}`).length).toBe(0)
    expect(await contar('consentimento_contato', c.id)).toBe(0)
    const aud = await dono<{ acao: string; entidade_id: string; dados: Record<string, unknown> }[]>`
      SELECT acao, entidade_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`
    expect(aud).toHaveLength(1)
    expect(aud[0]!.entidade_id).toBe(c.id)
    expect(aud[0]!.dados).toEqual({ motivo: 'retencao', modo: 'completa', mensagens: 3, midias: 1 })
    const texto = JSON.stringify(aud)
    for (const pessoal of ['Maria', 'Silva', 'maria@', c.fone, '12345678909', 'Rua das Flores']) expect(texto).not.toContain(pessoal)
  })

  it('titular e opt-out bloqueiam com lgpd_em; motivo existente (denúncia) é preservado', async () => {
    const c = await novoContato({ descartadoHa: null })
    const outro = novoFone()
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
               VALUES (${A}, ${c.id}, 2, ${outro}, ${chaveDe(outro)}, false, 'erp')`
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem) VALUES (${A}, ${chaveDe(outro)}, 'denuncia', 'manual')`
    await anonimizar(A, c.id, 'titular')
    const bl = await dono<{ chave_bloqueio: string; motivo: string; lgpd_em: Date | null }[]>`
      SELECT chave_bloqueio, motivo, lgpd_em FROM lista_bloqueio WHERE tenant_id = ${A} ORDER BY motivo`
    expect(bl).toEqual([
      { chave_bloqueio: chaveDe(outro), motivo: 'denuncia', lgpd_em: AGORA },
      { chave_bloqueio: c.chave, motivo: 'lgpd', lgpd_em: AGORA },
    ])
  })

  it('conteúdo vira "[removido por LGPD]"; só a CHAVE nossa vai para a fila; transcrição e arquivos saem', async () => {
    const c = await novoContato()
    const [img] = await dono<{ id: string; criado_em: Date }[]>`SELECT id, criado_em FROM mensagem WHERE conversa_id = ${c.conversa} AND conteudo ? 'legenda'`
    await dono`INSERT INTO midia (tenant_id, id, mensagem_id, mensagem_criado_em, chave_objeto, mime, transcricao)
               VALUES (${A}, ${randomUUID()}, ${img!.id}, ${img!.criado_em}, ${`tenant/${A}/${c.id}-audio.ogg`}, 'audio/ogg', 'texto falado secreto')`
    await dono`INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket, legenda, criado_em)
               VALUES (${A}, ${randomUUID()}, ${c.id}, 'rg-maria.pdf', 'application/pdf', 10, ${`tenant/${A}/arq/${c.id}.pdf`}, 'RG', ${mesesAtras(15)})`
    const r = await anonimizar(A, c.id)
    expect(r).toMatchObject({ ok: true, midiasPendentes: 3 })
    const msgs = await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE conversa_id = ${c.conversa}`
    expect(msgs).toHaveLength(3)
    for (const m of msgs) expect(m.conteudo).toMatchObject({ texto: TEXTO_REMOVIDO_LGPD, removido_lgpd: true })
    const texto = JSON.stringify(msgs)
    for (const pessoal of ['cartão', 'meu RG', 'lookaside', `${c.id}.jpg`]) expect(texto).not.toContain(pessoal)
    const fila = await dono<{ chave_objeto: string; origem: string; removido_em: Date | null }[]>`
      SELECT chave_objeto, origem, removido_em FROM lgpd_midia_pendente WHERE tenant_id = ${A} AND contato_id = ${c.id} ORDER BY origem`
    expect(fila).toEqual([
      { chave_objeto: `tenant/${A}/arq/${c.id}.pdf`, origem: 'arquivo', removido_em: null },
      { chave_objeto: `tenant/${A}/${c.id}.jpg`, origem: 'mensagem', removido_em: null },
      { chave_objeto: `tenant/${A}/${c.id}-audio.ogg`, origem: 'midia', removido_em: null },
    ])
    expect(await contar('contato_arquivo', c.id)).toBe(0)
    expect((await dono`SELECT 1 FROM midia WHERE tenant_id = ${A} AND mensagem_id = ${img!.id}`).length).toBe(0)
    expect((await dono<{ arquivada: boolean }[]>`SELECT arquivada FROM conversa WHERE id = ${c.conversa}`)[0]!.arquivada).toBe(true)
  })

  it('apaga o que o agente guardou e o texto do pedido/proposta; encerra atendimento, sessão e retornos; avisa a tela só com o id', async () => {
    const c = await novoContato()
    const decisao = randomUUID(), avaliacao = randomUUID(), sessao = randomUUID(), pedido = randomUUID(), atendimento = randomUUID()
    const canal = CANAL[A]!
    await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, resumo, slots, descartados, estado_agente)
               VALUES (${A}, ${sessao}, ${c.conversa}, ${canal}, 'Maria quer tamanho G', '{"nome":"Maria"}', '[{"texto":"Maria disse"}]', '{"memo":"Maria"}')`
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, guardrails)
               VALUES (${A}, ${decisao}, ${c.conversa}, ${canal}, ${sessao}, 'autonomo', 'respondeu', '{"texto":"oi Maria"}',
                       ${JSON.stringify([{ regra: 'numero', trecho: 'Maria, o preço é 10' }])}::text::jsonb)`
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho, justificativas)
               VALUES (${A}, ${avaliacao}, ${decisao}, ${c.conversa}, ${canal}, 'agente', 'regras', 'turno', '{"x":"Maria"}')`
    await dono`INSERT INTO agente_revisao (tenant_id, id, avaliacao_id, revisor_id, conversa_id, canal_id, semana, notas, veredito, concordancia, observacao)
               VALUES (${A}, ${randomUUID()}, ${avaliacao}, ${U_ADMIN}, ${c.conversa}, ${canal}, '2026-W40', '{}', 'ok', '{}', 'a Maria reclamou do filho')`
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, texto)
               VALUES (${A}, ${randomUUID()}, ${c.conversa}, ${canal}, 'combinado', ${diasAtras(-1)}, 'Oi Maria, voltando')`
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, origem, nome, cancelado_motivo, cancelado_em, criado_em, atualizado_em)
               VALUES (${A}, ${pedido}, ${c.id}, 'cancelado', 'humano', 'Pedido da Maria', 'Maria desistiu', ${mesesAtras(15)}, ${mesesAtras(15)}, ${mesesAtras(15)})`
    await dono`INSERT INTO pedido_proposta (tenant_id, id, pedido_id, versao_conteudo, resumo, total_centavos, enviada_em, expira_em)
               VALUES (${A}, ${randomUUID()}, ${pedido}, 1, '2x vestido para Maria', 1000, ${mesesAtras(15)}, ${new Date(mesesAtras(15).getTime() + 86_400_000)})`
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado)
               VALUES (${A}, ${atendimento}, ${c.conversa}, ${canal}, 990001, 'na_fila')`

    expect(await anonimizar(A, c.id, 'titular')).toMatchObject({ ok: true, modo: 'completa' })

    const [s] = await dono<Record<string, unknown>[]>`SELECT resumo, slots, descartados, estado_agente, estado, motivo_saida FROM agente_sessao WHERE id = ${sessao}`
    expect(s).toEqual({ resumo: null, slots: {}, descartados: [], estado_agente: {}, estado: 'encerrada', motivo_saida: 'lgpd' })
    const [d] = await dono<{ resposta: unknown; guardrails: unknown }[]>`SELECT resposta, guardrails FROM agente_decisao WHERE id = ${decisao}`
    expect(d).toEqual({ resposta: null, guardrails: [{ regra: 'numero' }] })
    expect((await dono`SELECT observacao FROM agente_revisao WHERE avaliacao_id = ${avaliacao}`)[0]!.observacao).toBeNull()
    expect((await dono`SELECT justificativas FROM agente_avaliacao WHERE id = ${avaliacao}`)[0]!.justificativas).toBeNull()
    expect((await dono`SELECT estado, texto FROM agente_retorno WHERE conversa_id = ${c.conversa}`)[0]).toEqual({ estado: 'cancelado', texto: null })
    expect((await dono`SELECT nome, cancelado_motivo FROM pedido WHERE id = ${pedido}`)[0]).toEqual({ nome: null, cancelado_motivo: TEXTO_REMOVIDO_LGPD })
    expect((await dono`SELECT resumo FROM pedido_proposta WHERE pedido_id = ${pedido}`)[0]!.resumo).toBe(TEXTO_REMOVIDO_LGPD)
    const [at] = await dono<{ estado: string; encerrado_em: Date | null }[]>`SELECT estado, encerrado_em FROM atendimento WHERE id = ${atendimento}`
    expect(at).toEqual({ estado: 'encerrado', encerrado_em: AGORA })
    const ev = await dono<{ payload: unknown }[]>`SELECT payload FROM outbox WHERE tenant_id = ${A} AND tipo = 'contato.atualizado' AND agregado_id = ${c.id}`
    expect(ev.map((e) => e.payload)).toEqual([{ contatoId: c.id }])
    // Nenhum resto do nome nas tabelas do agente.
    const resto = JSON.stringify(await dono`SELECT * FROM agente_sessao WHERE id = ${sessao}`) + JSON.stringify(await dono`SELECT * FROM agente_decisao WHERE id = ${decisao}`)
    expect(resto).not.toContain('Maria')
  })

  it('a transcrição que termina DEPOIS da anonimização não regrava a mensagem', async () => {
    const c = await novoContato({ descartadoHa: null })
    const msg = randomUUID()
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${A}, ${msg}, ${c.conversa}, 'entrante', 'audio', ${JSON.stringify({ audio: `tenant/${A}/${msg}.ogg`, mime: 'audio/ogg' })}::text::jsonb, ${diasAtras(1)})`
    let chamou = false
    const porta = {
      nome: 'teste', capacidades: { transcreve: true },
      async transcrever() {
        chamou = true
        await anonimizar(A, c.id, 'titular') // o titular foi esquecido enquanto o provedor transcrevia
        return { ok: true as const, texto: 'meu endereço é Rua das Flores 10' }
      },
    }
    // O worker usa uma trava global (advisory lock): outro arquivo pode estar com ela; tenta de novo.
    for (let i = 0; i < 50 && !chamou; i++) {
      await processarTranscricoes(dono as never, {
        porta, somenteTenant: A, baixar: async () => ({ bytes: Buffer.from('x'), mime: 'audio/ogg' }) as never,
      }, AGORA)
      if (!chamou) await new Promise((r) => setTimeout(r, 100))
    }
    expect(chamou).toBe(true)
    const [m] = await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE id = ${msg}`
    expect(m!.conteudo).toMatchObject({ texto: TEXTO_REMOVIDO_LGPD, removido_lgpd: true })
    expect(JSON.stringify(m!.conteudo)).not.toContain('Flores')
  })

  it('é idempotente: a segunda chamada não refaz nem re-audita', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    expect(await anonimizar(A, c.id)).toEqual({ ok: true, jaAnonimizado: true, modo: 'completa', midiasPendentes: 1 })
    expect(Number((await dono`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`)[0]!.n)).toBe(1)
  })

  it('modo canais (compra + somenteCanais): apaga telefones/conversas e mantém o vínculo fiscal', async () => {
    const c = await novoContato({ compra: true, erp: true })
    const r = await anonimizar(A, c.id, 'titular', true)
    expect(r).toMatchObject({ ok: true, jaAnonimizado: false, modo: 'canais' })
    const [l] = await dono<Record<string, unknown>[]>`SELECT * FROM contato WHERE id = ${c.id}`
    expect(l).toMatchObject({ nome: 'Maria da Silva', razao_social: 'Silva Modas LTDA', email: null, observacoes: null, ativo: true, qtd_vendas: 2 })
    expect(await contar('contato_telefone', c.id)).toBe(0)
    expect((await dono<{ fonte: string }[]>`SELECT fonte FROM contato_documento WHERE contato_id = ${c.id}`)).toEqual([{ fonte: 'erp:geracloud' }])
    expect((await dono<{ fonte: string }[]>`SELECT fonte FROM contato_endereco WHERE contato_id = ${c.id}`)).toEqual([{ fonte: 'erp:geracloud' }])
    expect((await dono<{ sistema: string }[]>`SELECT sistema FROM contato_identidade_externa WHERE contato_id = ${c.id}`)).toEqual([{ sistema: SISTEMA_ERP }])
    expect(Number((await dono`SELECT count(*)::int AS n FROM venda WHERE contato_id = ${c.id}`)[0]!.n)).toBe(1)
    expect((await dono<{ lgpd_em: Date | null }[]>`SELECT lgpd_em FROM lista_bloqueio WHERE chave_bloqueio = ${c.chave}`)[0]!.lgpd_em).toEqual(AGORA)
  })
})

describe('ERP: a anonimização não é desfeita pela ingestão', () => {
  it('contato vindo do ERP nunca vai para o modo completa (só canais)', async () => {
    const c = await novoContato({ erp: true, descartadoHa: null })
    expect(await anonimizar(A, c.id, 'titular')).toEqual({ ok: false, erro: 'contato_com_compra' })
    expect(await anonimizar(A, c.id, 'titular', true)).toMatchObject({ ok: true, modo: 'canais' })
  })

  it('anonimiza, roda a ingestão de clientes: nada pessoal volta e não nasce contato novo para o mesmo id externo', async () => {
    const c = await novoContato({ erp: true, descartadoHa: null })
    await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: c.id, origem: 'teste', agora: diasAtras(20) }))
    expect(await anonimizar(A, c.id, 'opt_out')).toMatchObject({ ok: true, modo: 'canais' })
    const antes = Number((await dono`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${A}`)[0]!.n)

    const fone = c.fone.slice(2) // o ERP manda sem DDI
    const r = await ingerirClientes(dono as never, A, CONEXAO, conectorFalso([
      { idExterno: `cli-${c.id}`, nome: 'Maria Ressuscitada', telefones: [fone, '81 99777-1234'], documento: '529.982.247-25', ativo: true },
      // Outro cliente do ERP com o número do titular esquecido: o cliente entra, o número não.
      { idExterno: 'cli-outro', nome: 'Joana Nova', telefones: [fone], ativo: true },
    ]))
    expect(r).toMatchObject({ lidos: 2, criados: 1, vinculados: 0, anonimizadosIgnorados: 1, telefonesBloqueadosLgpd: 1, rejeitados: 0 })
    expect(Number((await dono`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${A}`)[0]!.n)).toBe(antes + 1)
    expect(await contar('contato_telefone', c.id)).toBe(0)
    expect((await dono`SELECT 1 FROM contato_nome WHERE contato_id = ${c.id} AND nome = 'Maria Ressuscitada'`).length).toBe(0)
    expect((await dono`SELECT 1 FROM contato_documento WHERE contato_id = ${c.id} AND numero = '52998224725'`).length).toBe(0)
    expect((await dono`SELECT 1 FROM contato_telefone WHERE tenant_id = ${A} AND chave_bloqueio = ${c.chave}`).length).toBe(0)
    expect((await dono<{ contato_id: string }[]>`SELECT contato_id FROM contato_identidade_externa WHERE tenant_id = ${A} AND id_externo = ${`cli-${c.id}`}`))
      .toEqual([{ contato_id: c.id }])
  })
})

describe('efeitos: gateway, reimportação, bloqueio LGPD e buscas', () => {
  it('o gateway recusa o envio a contato anonimizado (nada sai)', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    expect((await enviarTextoNaConversa(A, c.conversa, 'oi, tudo bem?', null, AGORA)).ok).toBe(false)
  })

  it('a chave do titular esquecido não volta por importação, e o bloqueio LGPD não sai pela tela comum', async () => {
    const c = await novoContato({ fone: '5585988880001', chave: '558588880001' })
    await anonimizar(A, c.id, 'titular')
    const imp = await pedir('POST', '/v1/contatos/importar', A, { csv: 'nome,telefone\nMaria Nova,(85) 98888-0001\nJoana,(85) 97777-0002' })
    expect(imp.statusCode).toBe(200)
    expect(imp.json()).toMatchObject({ criados: 1, bloqueadosLgpd: 1 })
    expect(JSON.stringify(imp.json())).not.toContain('88880001')
    const del = await pedir('DELETE', '/v1/bloqueios/558588880001', A)
    expect(del.statusCode).toBe(422)
    expect(del.json()).toMatchObject({ erro: 'bloqueio.lgpd_irremovivel', acao: { novoConsentimento: true } })
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${A} AND chave_bloqueio = '558588880001'`).length).toBe(1)
    const lista = (await pedir('GET', '/v1/bloqueios', A)).json().itens as { chave: string; lgpd: boolean }[]
    expect(lista.find((b) => b.chave === '558588880001')?.lgpd).toBe(true)
  })

  it('novo consentimento do titular: admin atribuído, com evidência; remove o bloqueio, grava concedido e audita sem o número', async () => {
    const c = await novoContato({ fone: '5585988880002', chave: '558588880002', descartadoHa: null })
    await anonimizar(A, c.id, 'titular')
    // Um contato novo que tem o número hoje (o titular voltou) recebe o consentimento.
    const novo = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${novo}, 'Voltou')`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
               VALUES (${A}, ${novo}, 1, '5585988880002', '558588880002', true, 'whatsapp')`
    const url = '/v1/bloqueios/558588880002/novo-consentimento'
    expect((await pedir('POST', url, A, { origem: 'operador', evidencia: 'e-mail do titular' })).statusCode).toBe(422)
    expect((await pedir('POST', url, A, { origem: 'titular', evidencia: '' })).statusCode).toBe(422)
    // Sem papel atribuído (o outro admin existe): 403.
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${A} AND usuario_id = ${U_CHAMADOR}`
    expect((await pedir('POST', url, A, { origem: 'titular', evidencia: 'e-mail do titular 03/11, protocolo 77' })).statusCode).toBe(403)
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_CHAMADOR}, NULL, 'admin')`
    const ok = await pedir('POST', url, A, { origem: 'titular', evidencia: 'e-mail do titular 03/11, protocolo 77' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true, contatos: 1 })
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${A} AND chave_bloqueio = '558588880002'`).length).toBe(0)
    expect((await dono`SELECT concedido, origem FROM consentimento_contato WHERE contato_id = ${novo}`)[0]).toEqual({ concedido: true, origem: 'novo_consentimento_titular' })
    const [aud] = await dono<{ dados: Record<string, unknown>; ator_id: string }[]>`
      SELECT dados, ator_id FROM auditoria WHERE tenant_id = ${A} AND acao = 'bloqueio.novo_consentimento'`
    expect(aud!.ator_id).toBe(U_CHAMADOR)
    expect(aud!.dados).toMatchObject({ finalChave: '0002', motivoAnterior: 'lgpd', origem: 'titular', contatos: 1 })
    expect(JSON.stringify(aud)).not.toContain('558588880002')
    expect((await pedir('POST', url, A, { origem: 'titular', evidencia: 'de novo, sem bloqueio' })).statusCode).toBe(404)
  })

  it('some das buscas', async () => {
    const c = await novoContato()
    expect((await pedir('GET', '/v1/contatos/busca?q=Maria da Silva', A)).json().itens.map((i: { id: string }) => i.id)).toContain(c.id)
    await anonimizar(A, c.id)
    expect((await pedir('GET', '/v1/contatos/busca?q=Maria', A)).json().itens.map((i: { id: string }) => i.id)).not.toContain(c.id)
  })
})

describe('rota do titular, prévia, automática e relatório', () => {
  it('exige ADMIN ATRIBUÍDO: vendedor e modo fundador recebem 403 e nada é apagado', async () => {
    const c = await novoContato()
    await dono`UPDATE usuario_filial SET papel = 'vendedor' WHERE tenant_id = ${A} AND usuario_id = ${U_CHAMADOR}`
    expect((await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A)).statusCode).toBe(403)
    expect((await pedir('GET', '/v1/lgpd/relatorio', A)).statusCode).toBe(403)
    // Modo fundador (nenhum admin no tenant): vale admin para configurar, NÃO para apagar dado de titular.
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${A}`
    const fundador = await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A)
    expect(fundador.statusCode).toBe(403)
    expect(fundador.json().erro).toBe('acesso.admin_atribuido')
    expect((await pedir('POST', '/v1/lgpd/automatica', A, { ativar: true, confirmo: true })).statusCode).toBe(403)
    expect((await pedir('GET', '/v1/lgpd/previa', A)).statusCode).toBe(200)
    expect(await anonimizadoEm(c.id)).toBeNull()
  })

  it('admin anonimiza já, guarda protocolo e data na auditoria e diz o que segue em remoção; 404 para inexistente/outro tenant', async () => {
    const c = await novoContato({ descartadoHa: null })
    const r = await pedir('POST', `/v1/contatos/${c.id}/anonimizar`, A, { protocolo: 'LGPD-2026/77', solicitadoEm: '2026-10-30' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, modo: 'completa', jaAnonimizado: false, midiasPendentes: 1 })
    expect((await pedir('POST', `/v1/contatos/${randomUUID()}/anonimizar`, A)).statusCode).toBe(404)
    const outro = await novoContato({ tenant: B })
    expect((await pedir('POST', `/v1/contatos/${outro.id}/anonimizar`, A)).statusCode).toBe(404)
    expect((await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE id = ${outro.id}`)[0]!.nome).toBe('Maria da Silva')
    const aud = await dono<{ ator_id: string | null; dados: Record<string, unknown> }[]>`SELECT ator_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'contato.anonimizado'`
    expect(aud).toHaveLength(1)
    expect(aud[0]!.dados).toMatchObject({ motivo: 'titular', protocolo: 'LGPD-2026/77', solicitadoEm: '2026-10-30' })
    expect(aud[0]!.ator_id).toBe(U_CHAMADOR)
    expect((await pedir('POST', `/v1/contatos/${randomUUID()}/anonimizar`, A, { solicitadoEm: '30/10/2026' })).statusCode).toBe(422)
    expect((await pedir('POST', `/v1/contatos/${randomUUID()}/anonimizar`, A, { protocolo: '<script>' })).statusCode).toBe(422)
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

  it('prévia (modo relatório) conta por motivo sem alterar nada; ligar exige confirmação explícita e é auditado', async () => {
    // A rota usa o relógio real: o cenário é montado em relação a ele.
    const real = new Date()
    const realMesesAtras = (n: number) => { const d = new Date(real); d.setUTCMonth(d.getUTCMonth() - n); return d }
    const ret1 = await novoContato({ descartadoHa: realMesesAtras(14) }), ret2 = await novoContato({ descartadoHa: realMesesAtras(15) })
    const opt = await novoContato({ descartadoHa: null })
    await comTenantServico(A, (tx) => registrarOptOut(tx, { contatoId: opt.id, origem: 'teste', agora: new Date(real.getTime() - 20 * 86_400_000) }))
    await novoContato({ tenant: B })
    const previa = await pedir('GET', '/v1/lgpd/previa', A)
    expect(previa.statusCode).toBe(200)
    expect(previa.json()).toMatchObject({ ativa: false, retencaoMeses: 12, porMotivo: { retencao: 2, opt_out: 1 }, total: 3, limitado: false })
    expect(await comTenantServico(A, (tx) => previaAnonimizacao(tx, { agora: AGORA }))).toEqual({ porMotivo: { retencao: 2, opt_out: 1 }, total: 3, limitado: false })
    for (const c of [ret1, ret2, opt]) expect(await anonimizadoEm(c.id)).toBeNull()

    const semConfirmar = await pedir('POST', '/v1/lgpd/automatica', A, { ativar: true })
    expect(semConfirmar.statusCode).toBe(422)
    expect(semConfirmar.json()).toMatchObject({ erro: 'lgpd.confirmacao_exigida', previa: { total: 3 } })
    expect((await dono<{ lgpd_auto: boolean }[]>`SELECT lgpd_auto FROM tenant WHERE id = ${A}`)[0]!.lgpd_auto).toBe(false)

    const ligou = await pedir('POST', '/v1/lgpd/automatica', A, { ativar: true, confirmo: true })
    expect(ligou.statusCode).toBe(200)
    expect(ligou.json()).toMatchObject({ ok: true, ativa: true })
    expect((await pedir('GET', '/v1/lgpd/previa', A)).json().ativa).toBe(true)
    const [aud] = await dono<{ dados: Record<string, unknown>; ator_id: string }[]>`
      SELECT dados, ator_id FROM auditoria WHERE tenant_id = ${A} AND acao = 'lgpd.automatica_alterada'`
    expect(aud).toEqual({ ator_id: U_CHAMADOR, dados: { ativa: true, previa: { retencao: 2, opt_out: 1, limitado: false } } })
    // Desligar não pede confirmação.
    expect((await pedir('POST', '/v1/lgpd/automatica', A, { ativar: false })).json()).toMatchObject({ ativa: false })
    expect((await pedir('POST', '/v1/lgpd/automatica', A, { ativar: 'sim' })).statusCode).toBe(422)
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
    expect(rel.json()).toMatchObject({
      total: 2, porMotivo: { retencao: 1, opt_out: 0, titular: 1 }, porModo: { completa: 2, canais: 0 },
      midiasPendentes: 2, midiasRemovidas: 0, falhas: 0,
    })
    const texto = JSON.stringify(rel.json())
    expect(texto).not.toContain('Maria')
    expect(texto).not.toContain(a.fone)
    expect((await pedir('GET', '/v1/lgpd/relatorio', B)).json().total).toBe(1)
    expect((await pedir('GET', '/v1/lgpd/relatorio?de=2027-13-45', A)).statusCode).toBe(422)
    expect((await pedir('GET', '/v1/lgpd/relatorio?de=2027-03-02&ate=2027-03-01', A)).statusCode).toBe(422)
    const direto = await comTenantServico(A, (tx) => relatorioAnonimizacao(tx, { de: new Date('2000-01-01'), ate: new Date('2001-01-01') }))
    expect(direto.total).toBe(0)
  })
})

describe('worker de retenção (somenteTenant)', () => {
  it('tenant com a automática DESLIGADA (padrão) não é tocado', async () => {
    const c = await novoContato()
    const r = await processarLgpd(dono as never, { somenteTenant: A }, AGORA)
    expect(r).toMatchObject({ tenants: 0, processadas: 0, anonimizados: 0 })
    expect(await anonimizadoEm(c.id)).toBeNull()
  })

  it('ligada: anonimiza só os candidatos do tenant e recontar não acha mais ninguém', async () => {
    await ligarAutomatica(A); await ligarAutomatica(B)
    const velhos = [await novoContato(), await novoContato()]
    const novo = await novoContato({ descartadoHa: mesesAtras(2) })
    const deB = await novoContato({ tenant: B })
    const r = await processarLgpd(dono as never, { somenteTenant: A }, AGORA)
    expect(r).toEqual({ tenants: 1, processadas: 2, anonimizados: 2, falhas: 0, codigosFalha: {}, interrompido: false })
    for (const c of velhos) expect(await anonimizadoEm(c.id)).not.toBeNull()
    expect(await anonimizadoEm(novo.id)).toBeNull()
    expect(await anonimizadoEm(deB.id)).toBeNull()
    expect(await candidatos(A)).toEqual([])
    // Retenção automática não bloqueia número.
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${A}`).length).toBe(0)
  })

  it('contato que falha não trava a fila: registra só o código e vai para o fim', async () => {
    await ligarAutomatica(A)
    const ruim = await novoContato({ descartadoHa: mesesAtras(16) })
    const bons = [await novoContato({ descartadoHa: mesesAtras(15) }), await novoContato({ descartadoHa: mesesAtras(14) })]
    const r = await processarLgpd(dono as never, {
      somenteTenant: A,
      anonimizar: async (tx, id, o) => {
        if (id === ruim.id) throw Object.assign(new Error(`falhou para Maria ${ruim.fone}`), { code: 'XX000' })
        return anonimizarContato(tx, id, o)
      },
    }, AGORA)
    expect(r).toMatchObject({ processadas: 3, anonimizados: 2, falhas: 1, codigosFalha: { pg_XX000: 1 } })
    for (const c of bons) expect(await anonimizadoEm(c.id)).not.toBeNull()
    const falha = await dono<{ codigo: string; tentativas: number }[]>`SELECT codigo, tentativas FROM lgpd_falha WHERE tenant_id = ${A}`
    expect(falha).toEqual([{ codigo: 'pg_XX000', tentativas: 1 }])
    // O mais antigo, por ter falhado, fica atrás de um candidato novo.
    const outro = await novoContato({ descartadoHa: mesesAtras(13) })
    expect((await candidatos(A)).map((c) => c.id)).toEqual([outro.id, ruim.id])
    // Sucesso depois apaga o registro de falha.
    await processarLgpd(dono as never, { somenteTenant: A }, AGORA)
    expect(await anonimizadoEm(ruim.id)).not.toBeNull()
    expect((await dono`SELECT 1 FROM lgpd_falha WHERE tenant_id = ${A}`).length).toBe(0)
  })

  it('para no meio quando estoura o orçamento de tempo e retoma no próximo ciclo', async () => {
    await ligarAutomatica(A)
    const todos = [await novoContato(), await novoContato(), await novoContato()]
    let agoraMs = 0
    // Cada contato processado "gasta" 1 s; o orçamento é 1,5 s → processa 2 e interrompe.
    const relogio = () => agoraMs
    const primeira = await processarLgpd(dono as never, {
      somenteTenant: A, orcamentoMs: 1500, relogio, depoisDoContato: () => { agoraMs += 1000 },
    }, AGORA)
    expect(primeira).toMatchObject({ interrompido: true, anonimizados: 2 })
    expect(await candidatos(A)).toHaveLength(1)
    agoraMs = 0
    const segunda = await processarLgpd(dono as never, { somenteTenant: A, orcamentoMs: 60_000, relogio }, AGORA)
    expect(segunda).toMatchObject({ interrompido: false, anonimizados: 1 })
    for (const c of todos) expect(await anonimizadoEm(c.id)).not.toBeNull()
  })

  it('respeita o tamanho do lote (lote 2 → seletor devolve no máximo 2)', async () => {
    await novoContato(); await novoContato(); await novoContato()
    expect(await candidatos(A, 2)).toHaveLength(2)
  })
})

describe('worker de mídia (somenteTenant)', () => {
  it('apaga do bucket fora de transação, marca removido e o relatório conta', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    const { porta, removidos } = bucketFalso()
    const r = await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: porta }, AGORA)
    expect(r).toEqual({ removidas: 1, falhas: 0, semBucket: false })
    expect(removidos).toEqual([`tenant/${A}/${c.id}.jpg`])
    expect((await dono`SELECT removido_em FROM lgpd_midia_pendente WHERE contato_id = ${c.id}`)[0]!.removido_em).toEqual(AGORA)
    const rel = await comTenantServico(A, (tx) => relatorioAnonimizacao(tx, { de: diasAtras(1), ate: diasAtras(-1) }))
    expect(rel).toMatchObject({ midiasPendentes: 0, midiasRemovidas: 1 })
    expect((await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: porta }, AGORA)).removidas).toBe(0)
  })

  it('falha: guarda só o código, agenda com backoff e tenta de novo quando vencer', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    const falhando = bucketFalso(() => true)
    expect(await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: falhando.porta }, AGORA)).toEqual({ removidas: 0, falhas: 1, semBucket: false })
    const [l] = await dono<{ tentativas: number; ultimo_erro: string; proxima_tentativa_em: Date }[]>`
      SELECT tentativas, ultimo_erro, proxima_tentativa_em FROM lgpd_midia_pendente WHERE contato_id = ${c.id}`
    expect(l).toEqual({ tentativas: 1, ultimo_erro: 'AccessDenied', proxima_tentativa_em: new Date(AGORA.getTime() + backoffMidiaMs(1)) })
    // Antes de vencer: nada. Depois: tenta e remove.
    const ok = bucketFalso()
    expect((await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: ok.porta }, AGORA)).removidas).toBe(0)
    const depois = new Date(AGORA.getTime() + backoffMidiaMs(1) + 1000)
    expect((await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: ok.porta }, depois)).removidas).toBe(1)
    expect([backoffMidiaMs(1), backoffMidiaMs(2), backoffMidiaMs(30)]).toEqual([60_000, 120_000, 24 * 3_600_000])
  })

  it('sem bucket configurado: degrada, não reserva nada', async () => {
    const c = await novoContato()
    await anonimizar(A, c.id)
    const semBucket: ArquivosBucket = { ...bucketFalso().porta, disponivel: () => false }
    expect(await processarMidiaLgpd(dono as never, { somenteTenant: A, bucket: semBucket }, AGORA)).toEqual({ removidas: 0, falhas: 0, semBucket: true })
    expect((await dono`SELECT tentativas FROM lgpd_midia_pendente WHERE contato_id = ${c.id}`)[0]!.tentativas).toBe(0)
  })
})
