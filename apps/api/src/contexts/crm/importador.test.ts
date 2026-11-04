import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { normalizarTelefone } from '@geracrm/shared'
import { encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { ErroDeTeste, processarImportacoes } from '../../workers/importacao.js'
import { rotasImportacao } from './rotas-importacao.js'

/**
 * IMPORTADOR (raia H1) — banco real, papel da aplicação (RLS), DOIS tenants.
 *
 * Identidade: o header `x-teste-sub` vira `usuarioSub` (como o Cognito faria).
 *   Tenant A (com admin → regra estrita): adm (admin), ges (gestor, filial X), vend (vendedor, filial X).
 *   Tenant B: adm B (admin).
 */
const A = 'b1e00000-0000-4000-8000-00000000000a'
const B = 'b1e00000-0000-4000-8000-00000000000b'
const PLANO = 'b1e00000-0001-4000-8000-000000000001'
const MODELO = 'b1e00000-0002-4000-8000-000000000001'
const PV_A = 'b1e00000-0003-4000-8000-00000000000a'
const PV_B = 'b1e00000-0003-4000-8000-00000000000b'
const FX = 'b1e00000-0004-4000-8000-000000000001'
const U = {
  adm: 'b1e00000-0005-4000-8000-000000000001',
  ges: 'b1e00000-0005-4000-8000-000000000002',
  vend: 'b1e00000-0005-4000-8000-000000000003',
  admB: 'b1e00000-0005-4000-8000-000000000004',
}
const ERP = 'b1e00000-0006-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

type Quem = keyof typeof U
const sub = (k: Quem) => `h1-sub-${k}`
const emailDe = (k: Quem) => `${k}@h1.test`

function multipart(campos: Record<string, string>, nome: string, conteudo: string | Buffer) {
  const b = '----h1' + Math.random().toString(16).slice(2)
  const partes: Buffer[] = []
  for (const [k, v] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  partes.push(
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="arquivo"; filename="${nome}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(conteudo), Buffer.from(`\r\n--${b}--\r\n`),
  )
  return { payload: Buffer.concat(partes), type: `multipart/form-data; boundary=${b}` }
}

async function pedir(quem: Quem, method: 'GET' | 'POST', url: string, corpo?: { payload: Buffer; type: string }) {
  const tenant = quem === 'admB' ? B : A
  const headers: Record<string, string> = { 'x-tenant-id': tenant, 'x-teste-sub': sub(quem) }
  if (corpo) headers['content-type'] = corpo.type
  const r = await app.inject({ method, url, headers, ...(corpo ? { payload: corpo.payload } : {}) })
  const json = () => r.json() as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: r.statusCode, texto: r.body, json, headers: r.headers }
}

const simular = (quem: Quem, tipo: string, csv: string | Buffer, extra: Record<string, string> = {}, nome = 'arquivo.csv') =>
  pedir(quem, 'POST', `/v1/importacoes/${tipo}/simular`, multipart(extra, nome, csv))
const executar = (quem: Quem, id: string, csv: string | Buffer, extra: Record<string, string> = {}) =>
  pedir(quem, 'POST', `/v1/importacoes/${id}/executar`, multipart(extra, 'arquivo.csv', csv))
const rodarWorker = (tenant = A, deps: Parameters<typeof processarImportacoes>[1] = {}, agora?: Date) =>
  processarImportacoes(dono as never, { somenteTenant: tenant, ...deps }, agora)

/** Simula e executa de ponta a ponta; devolve o id e o detalhe final. */
async function importar(tipo: string, csv: string, extra: Record<string, string> = {}) {
  const s = await simular('ges', tipo, csv, extra)
  expect(s.status).toBe(201)
  const id = s.json().importacaoId as string
  const e = await executar('ges', id, csv, extra.opcoes ? { opcoes: extra.opcoes } : {})
  expect(e.status).toBe(202)
  await rodarWorker()
  const d = await pedir('ges', 'GET', `/v1/importacoes/${id}`)
  return { id, detalhe: d.json(), simulacao: s.json() }
}

const contarContatos = async (t = A) =>
  (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${t}`)[0]!.n

async function limpar(): Promise<void> {
  for (const t of [A, B]) {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM importacao WHERE tenant_id = ${t}`
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${t}`
    await dono`DELETE FROM tarefa WHERE tenant_id = ${t}`
    await dono`DELETE FROM venda_identidade_externa WHERE tenant_id = ${t}`
    await dono`DELETE FROM venda WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM carteira_atribuicao WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_endereco WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_documento WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`DELETE FROM etiqueta WHERE tenant_id = ${t}`
    await dono`DELETE FROM origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${t}`
    await dono`DELETE FROM usuario WHERE tenant_id = ${t}`
    await dono`DELETE FROM filial WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limpar()
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-importador-h1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-importador-h1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[A, PV_A, 'Importador A'], [B, PV_B, 'Importador B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FX}, 'Filial X')`
  for (const k of Object.keys(U) as Quem[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${k === 'admB' ? B : A}, ${U[k]}, ${sub(k)}, ${'Pessoa ' + k}, ${emailDe(k)}, true)`
  }
  const vinc = (t: string, u: string, f: string | null, p: string) =>
    dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${u}, ${f}, ${p})`
  await vinc(A, U.adm, null, 'admin')
  await vinc(A, U.ges, FX, 'gestor')
  await vinc(A, U.vend, FX, 'vendedor')
  await vinc(B, U.admB, null, 'admin')

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s.replace('h1-sub-', '')}@h1.test` }
  })
  await app.register(rotasImportacao)
  await app.ready()
})

afterAll(async () => {
  await limpar()
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

const CSV_CONTATOS = [
  'Nome;Telefone;E-mail;CNPJ;Origem;Etiquetas;Vendedor;Qualificação;Criado em;Observações',
  'Maria Souza;(81) 99861-7049;maria@x.com;11.222.333/0001-81;Instagram;atacado|vip;vend@h1.test;qualificado;15/03/2024;"Prefere tarde; ligar antes"',
  'João Lima;81988887777;;;Instagram;vip;;;;',
  'Sem Fone;abc;;;;;;;;',
  ';81977776666;;;;;;;;',
].join('\r\n')

describe('H1 — modelo e papel', () => {
  it('modelo.csv traz cabeçalho e 2 linhas de exemplo; só gestão acessa; tipo desconhecido → 404', async () => {
    const r = await pedir('ges', 'GET', '/v1/importacoes/contatos/modelo.csv')
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('text/csv')
    const linhas = r.texto.replace(/^﻿/, '').trim().split(/\r\n/)
    expect(linhas).toHaveLength(3)
    expect(linhas[0]).toContain('Nome')
    expect((await pedir('vend', 'GET', '/v1/importacoes/contatos/modelo.csv')).status).toBe(403)
    expect((await pedir('vend', 'GET', '/v1/importacoes')).status).toBe(403)
    expect((await simular('vend', 'contatos', CSV_CONTATOS)).status).toBe(403)
    expect((await pedir('ges', 'GET', '/v1/importacoes/xpto/modelo.csv')).status).toBe(404)
  })
})

describe('H1 — simulação', () => {
  it('lê ; com BOM e aspas, sugere o de-para, prevê o resultado e NÃO grava contato', async () => {
    const antes = await contarContatos()
    const r = await simular('ges', 'contatos', '﻿' + CSV_CONTATOS)
    expect(r.status).toBe(201)
    const j = r.json()
    expect(j.colunas).toContain('Observações')
    expect(j.deParaSugerido).toMatchObject({ nome: 'Nome', telefone: 'Telefone', email: 'E-mail', documento: 'CNPJ', origem: 'Origem', vendedor: 'Vendedor' })
    expect(j.contagens).toEqual({ linhas: 4, criados: 2, atualizados: 0, ignorados: 0, rejeitados: 2 })
    expect(j.amostraRejeicoes.map((x: { linha: number; motivo: string }) => [x.linha, x.motivo])).toEqual([[4, 'telefone_invalido'], [5, 'nome_vazio']])
    expect(await contarContatos()).toBe(antes)
    const [i] = await dono<{ estado: string; arquivo_hash: string }[]>`SELECT estado, arquivo_hash FROM importacao WHERE id = ${j.importacaoId}`
    expect(i!.estado).toBe('simulada')
    expect(i!.arquivo_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(i!.arquivo_hash).toBe(j.arquivoHash)
  })

  it('separador vírgula funciona; planilha em latin1 não vira lixo', async () => {
    const virg = await simular('ges', 'contatos', 'nome,telefone\nAna,81998617049')
    expect(virg.json().contagens).toMatchObject({ criados: 1 })
    const latin = await simular('ges', 'contatos', Buffer.from('Nome;Telefone\nJosé Ação;81998617049', 'latin1'))
    expect(latin.status).toBe(201)
  })

  it('coluna obrigatória faltando → 422 com a sugestão e as colunas', async () => {
    const r = await simular('ges', 'contatos', 'Cliente;E-mail\nAna;a@x.com')
    expect(r.status).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'importacao.colunas_obrigatorias', faltando: ['telefone'], colunas: ['Cliente', 'E-mail'] })
    expect(r.json().deParaSugerido).toEqual({ nome: 'Cliente', email: 'E-mail' })
  })

  it('de-para enviado vale por inteiro (coluna com nome estranho mapeada à mão)', async () => {
    const dePara = JSON.stringify({ nome: 'Quem', telefone: 'Zap' })
    const r = await simular('ges', 'contatos', 'Quem;Zap\nAna;81998617049', { dePara })
    expect(r.status).toBe(201)
    expect(r.json().contagens.criados).toBe(1)
    const ruim = await simular('ges', 'contatos', 'Quem;Zap\nAna;81998617049', { dePara: JSON.stringify({ nome: 'Quem' }) })
    expect(ruim.status).toBe(422)
  })

  it('arquivo vazio e sem dados → 422', async () => {
    expect((await simular('ges', 'contatos', 'Nome;Telefone\n')).status).toBe(422)
  })

  it('duplicada no arquivo é prevista como ignorada', async () => {
    const r = await simular('ges', 'contatos', 'Nome;Telefone\nAna;81998617049\nAna de novo;81998617049')
    expect(r.json().contagens).toMatchObject({ criados: 1, ignorados: 1 })
  })
})

describe('H1 — gate da simulação (hash)', () => {
  it('executar com arquivo diferente do simulado → 409 importacao.nao_simulada; nada roda', async () => {
    const s = await simular('ges', 'contatos', 'Nome;Telefone\nAna;81998617049')
    const id = s.json().importacaoId
    const e = await executar('ges', id, 'Nome;Telefone\nAna;81998617049\nBia;81988887777')
    expect(e.status).toBe(409)
    expect(e.json().erro).toBe('importacao.nao_simulada')
    const [i] = await dono<{ estado: string }[]>`SELECT estado FROM importacao WHERE id = ${id}`
    expect(i!.estado).toBe('simulada')
  })

  it('executar uma importação inexistente → 404; de-para diferente do simulado → 409; já executada → 409', async () => {
    const csv = 'Nome;Telefone\nGate Um;81955550001'
    expect((await executar('ges', 'b1e00000-9999-4000-8000-000000000001', csv)).status).toBe(404)
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    const mudou = await executar('ges', id, csv, { deParaConfirmado: JSON.stringify({ nome: 'Telefone', telefone: 'Nome' }) })
    expect(mudou.status).toBe(409)
    expect(mudou.json().erro).toBe('importacao.de_para_mudou')
    expect((await executar('ges', id, csv, { deParaConfirmado: JSON.stringify(s.json().dePara) })).status).toBe(202)
    expect((await executar('ges', id, csv)).status).toBe(409)
  })
})

let idPrimeira = ''

describe('H1 — execução de contatos', () => {
  it('cria contato com telefone, documento, origem, etiquetas, carteira, filial, qualificação e criado_em; relatório sem dado pessoal', async () => {
    const { id, detalhe, simulacao } = await importar('contatos', CSV_CONTATOS, { opcoes: JSON.stringify({ criarOrigens: true, criarEtiquetas: true }) })
    idPrimeira = id
    expect(simulacao.contagens.criados).toBe(2)
    expect(detalhe.estado).toBe('concluida')
    expect(detalhe.contagens).toEqual({ linhas: 4, criados: 2, atualizados: 0, ignorados: 0, rejeitados: 2 })
    expect(detalhe.progresso).toMatchObject({ percentual: 100, terminou: true })

    const [m] = await dono<{ id: string; email: string; origem: string; filial_id: string; qualificado: boolean; observacoes: string; criado_em: Date; origem_carga: string }[]>`
      SELECT c.id, c.email, o.nome AS origem, c.filial_id, c.qualificado, c.observacoes, c.criado_em, c.origem_carga
        FROM contato c LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
       WHERE c.tenant_id = ${A} AND c.nome = 'Maria Souza'`
    expect(m).toMatchObject({ email: 'maria@x.com', origem: 'Instagram', filial_id: FX, qualificado: true, origem_carga: 'importacao' })
    expect(m!.observacoes).toBe('Prefere tarde; ligar antes')
    expect(m!.criado_em.toISOString()).toBe('2024-03-15T15:00:00.000Z')
    const tags = await dono<{ nome: string }[]>`
      SELECT e.nome FROM contato_etiqueta ce JOIN etiqueta e ON e.tenant_id = ce.tenant_id AND e.id = ce.etiqueta_id
       WHERE ce.tenant_id = ${A} AND ce.contato_id = ${m!.id} ORDER BY e.nome`
    expect(tags.map((t) => t.nome)).toEqual(['atacado', 'vip'])
    const [cart] = await dono<{ usuario_id: string }[]>`SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${m!.id} AND ate IS NULL`
    expect(cart!.usuario_id).toBe(U.vend)
    const [tel] = await dono<{ e164: string; principal: boolean }[]>`SELECT e164, principal FROM contato_telefone WHERE tenant_id = ${A} AND contato_id = ${m!.id}`
    expect(tel).toMatchObject({ e164: '+5581998617049', principal: true })
    const [doc] = await dono<{ numero: string }[]>`SELECT numero FROM contato_documento WHERE tenant_id = ${A} AND contato_id = ${m!.id}`
    expect(doc!.numero).toBe('11222333000181')

    // Itens por resultado, por cursor.
    const rej = await pedir('ges', 'GET', `/v1/importacoes/${id}/itens?resultado=rejeitado`)
    expect(rej.json().itens.map((i: { linha: number; motivo: string }) => [i.linha, i.motivo])).toEqual([[4, 'telefone_invalido'], [5, 'nome_vazio']])
    const pag = await pedir('ges', 'GET', `/v1/importacoes/${id}/itens`)
    expect(pag.json().itens).toHaveLength(4)
    expect((await pedir('ges', 'GET', `/v1/importacoes/${id}/itens?resultado=zzz`)).status).toBe(422)

    // Relatório: só códigos, nunca célula do arquivo.
    const rel = await pedir('ges', 'GET', `/v1/importacoes/${id}/relatorio.csv`)
    expect(rel.status).toBe(200)
    expect(rel.texto).toContain('telefone_invalido')
    for (const pessoal of ['Maria', 'Souza', 'João', 'maria@x.com', '81998617049', '11222333000181', 'Sem Fone']) expect(rel.texto).not.toContain(pessoal)
    const motivos = await dono<{ motivo: string | null }[]>`SELECT motivo FROM importacao_item WHERE importacao_id = ${id}`
    for (const x of motivos) expect(x.motivo === null || /^[a-z0-9_]+$/.test(x.motivo)).toBe(true)
  })

  it('conferência: filial × qualificação × origem no banco para os contatos da importação', async () => {
    const r = await pedir('ges', 'GET', `/v1/importacoes/${idPrimeira}/conferencia`)
    expect(r.status).toBe(200)
    expect(r.json().linhas).toEqual([
      { filial: 'Filial X', qualificacao: 'qualificado', origem: 'Instagram', total: 1 },
      { filial: null, qualificacao: 'novo', origem: 'Instagram', total: 1 },
    ])
    expect(r.json().total).toBe(2)
  })

  it('⚠️ idempotente: simular e executar o MESMO arquivo de novo não duplica nada', async () => {
    const antes = await contarContatos()
    const { detalhe } = await importar('contatos', CSV_CONTATOS)
    expect(detalhe.contagens).toMatchObject({ criados: 0, atualizados: 0, ignorados: 2, rejeitados: 2 })
    expect(await contarContatos()).toBe(antes)
    const [t] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_telefone WHERE tenant_id = ${A}`
    expect(t!.n).toBe(antes)
  })

  it('origem/etiqueta inexistente sem a opção "criar" → importa a linha e avisa por código', async () => {
    const { id, detalhe } = await importar('contatos', 'Nome;Telefone;Origem\nCarla;81933330001;Feira Inexistente')
    expect(detalhe.contagens.criados).toBe(1)
    const [i] = await dono<{ motivo: string }[]>`SELECT motivo FROM importacao_item WHERE importacao_id = ${id}`
    expect(i!.motivo).toBe('origem_inexistente')
    const [o] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM origem WHERE tenant_id = ${A} AND nome = 'Feira Inexistente'`
    expect(o!.n).toBe(0)
  })

  it('⚠️ nunca sobrescreve dado de fonte ERP: só completa o que está em branco', async () => {
    await dono`INSERT INTO contato (tenant_id, id, nome, email, razao_social, origem_carga) VALUES (${A}, ${ERP}, 'Cliente do ERP', 'erp@cliente.com', 'Razão do ERP', 'erp')`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte) VALUES (${A}, ${ERP}, 1, '+5581966660000', ${normalizarTelefone('81966660000')!.chaveBloqueio}, true, 'erp')`
    await dono`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte) VALUES (${A}, ${ERP}, 1, 'cnpj', '11444777000161', true, 'erp')`
    const csv = 'Nome;Telefone;E-mail;Razão social;CNPJ;Observações\nNome Diferente;81966660000;outro@mail.com;Razão Diferente;11.444.777/0001-61;vinda do arquivo'
    const { id, detalhe } = await importar('contatos', csv)
    // Só `observações` estava em branco: é preenchida; e-mail, razão social e nome ficam.
    expect(detalhe.contagens).toMatchObject({ criados: 0, atualizados: 1 })
    const [c] = await dono<{ nome: string; email: string; razao_social: string; observacoes: string }[]>`SELECT nome, email, razao_social, observacoes FROM contato WHERE id = ${ERP}`
    expect(c).toEqual({ nome: 'Cliente do ERP', email: 'erp@cliente.com', razao_social: 'Razão do ERP', observacoes: 'vinda do arquivo' })
    const docs = await dono<{ numero: string; fonte: string; fiscal: boolean }[]>`SELECT numero, fonte, fiscal FROM contato_documento WHERE contato_id = ${ERP}`
    expect(docs).toEqual([{ numero: '11444777000161', fonte: 'erp', fiscal: true }])
    const tels = await dono<{ fonte: string; principal: boolean }[]>`SELECT fonte, principal FROM contato_telefone WHERE contato_id = ${ERP}`
    expect(tels).toEqual([{ fonte: 'erp', principal: true }])
    // Reexecutar: nada mais a completar → ignorado.
    const outra = await importar('contatos', csv)
    expect(outra.detalhe.contagens).toMatchObject({ atualizados: 0, ignorados: 1 })
    expect(id).not.toBe(outra.id)
  })
})

describe('H1 — vendas históricas', () => {
  it('grava a venda em centavos, alimenta o RFV, é idempotente e rejeita contato desconhecido', async () => {
    const csv = [
      'Telefone;CNPJ;Data;Valor;Número;Descrição',
      '81998617049;;20/05/2024;1.234,56;NF-1001;Pedido de camisetas',
      ';11.444.777/0001-61;21/05/2024;R$ 100,00;NF-1002;',
      '81900000000;;22/05/2024;50,00;NF-1003;',
      '81998617049;;32/13/2024;50,00;NF-1004;',
      '81998617049;;22/05/2024;zero;NF-1005;',
    ].join('\n')
    const { id, detalhe } = await importar('vendas', csv)
    expect(detalhe.contagens).toEqual({ linhas: 5, criados: 2, atualizados: 0, ignorados: 0, rejeitados: 3 })
    const motivos = await dono<{ linha: number; motivo: string }[]>`SELECT linha, motivo FROM importacao_item WHERE importacao_id = ${id} AND resultado = 'rejeitado' ORDER BY linha`
    expect(motivos.map((m) => m.motivo)).toEqual(['contato_nao_encontrado', 'data_invalida', 'valor_invalido'])

    const [v] = await dono<{ valor_centavos: string; descricao: string }[]>`SELECT valor_centavos::text, descricao FROM venda WHERE tenant_id = ${A} AND ocorrida_em = '2024-05-20T15:00:00Z'`
    expect(v).toEqual({ valor_centavos: '123456', descricao: 'Pedido de camisetas' })
    const [ident] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda_identidade_externa WHERE tenant_id = ${A} AND sistema = 'importacao'`
    expect(ident!.n).toBe(2)

    // RFV: a MV enxerga as vendas importadas.
    await dono`SELECT atualizar_metricas_contato()`
    const [rfv] = await dono<{ qtd_vendas: string; total_centavos: string }[]>`
      SELECT m.qtd_vendas::text, m.total_centavos::text FROM mv_metricas_contato m
        JOIN contato_telefone ct ON ct.tenant_id = m.tenant_id AND ct.contato_id = m.contato_id AND ct.principal
       WHERE m.tenant_id = ${A} AND ct.e164 = '+5581998617049'`
    expect(rfv).toEqual({ qtd_vendas: '1', total_centavos: '123456' })

    // Reexecutar não duplica (dedupe por referência externa).
    const outra = await importar('vendas', csv)
    expect(outra.detalhe.contagens).toMatchObject({ criados: 0, ignorados: 2, rejeitados: 3 })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda WHERE tenant_id = ${A}`
    expect(n!.n).toBe(2)
    // Conferência só existe para contatos.
    expect((await pedir('ges', 'GET', `/v1/importacoes/${id}/conferencia`)).status).toBe(422)
  })
})

describe('H1 — tarefas', () => {
  it('cria a tarefa ligada ao contato, com tipo, responsável e vencimento; não duplica; avulsa sem contato', async () => {
    const csv = [
      'Telefone;Título;Tipo;Vence em;Responsável;Descrição',
      '81998617049;Ligar para oferecer coleção;ligação;30/11/2030;vend@h1.test;Cliente pediu retorno',
      ';Tarefa avulsa;;01/12/2030;ninguem@h1.test;',
      '81900000000;Contato inexistente;;01/12/2030;;',
      '81998617049;Tipo ruim;viagem;01/12/2030;;',
    ].join('\n')
    const { id, detalhe } = await importar('tarefas', csv)
    expect(detalhe.contagens).toEqual({ linhas: 4, criados: 2, atualizados: 0, ignorados: 0, rejeitados: 2 })
    const [t] = await dono<{ contato_nome: string; tipo: string; responsavel_id: string; vence_em: Date; estado: string }[]>`
      SELECT c.nome AS contato_nome, t.tipo, t.responsavel_id, t.vence_em, t.estado FROM tarefa t JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
       WHERE t.tenant_id = ${A} AND t.titulo = 'Ligar para oferecer coleção'`
    expect(t).toMatchObject({ contato_nome: 'Maria Souza', tipo: 'ligacao', responsavel_id: U.vend, estado: 'aberta' })
    expect(t!.vence_em.toISOString()).toBe('2030-11-30T12:00:00.000Z')
    const [avulsa] = await dono<{ contato_id: string | null; responsavel_id: string | null }[]>`SELECT contato_id, responsavel_id FROM tarefa WHERE tenant_id = ${A} AND titulo = 'Tarefa avulsa'`
    expect(avulsa).toEqual({ contato_id: null, responsavel_id: null })
    const aviso = await dono<{ motivo: string }[]>`SELECT motivo FROM importacao_item WHERE importacao_id = ${id} AND linha = 3`
    expect(aviso[0]!.motivo).toBe('responsavel_inexistente')
    const outra = await importar('tarefas', csv)
    expect(outra.detalhe.contagens).toMatchObject({ criados: 0, ignorados: 2, rejeitados: 2 })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id = ${A}`
    expect(n!.n).toBe(2)
  })
})

describe('H1 — worker retoma', () => {
  it('cair no meio da execução não perde nem duplica: o arrendamento vence e a próxima passada continua', async () => {
    const linhas = ['Nome;Telefone']
    for (let i = 1; i <= 5; i++) linhas.push(`Retoma ${i};8194000000${i}`)
    const csv = linhas.join('\n')
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    expect((await executar('ges', id, csv)).status).toBe(202)

    // Primeira passada: lote de 2; o processo "cai" depois do primeiro lote.
    await expect(rodarWorker(A, { lote: 2, depoisDoLote: () => { throw new ErroDeTeste('cai') } })).rejects.toBeInstanceOf(ErroDeTeste)
    const [i] = await dono<{ estado: string; itens: number; conteudo: string | null }[]>`
      SELECT estado, (SELECT count(*)::int FROM importacao_item WHERE importacao_id = importacao.id) AS itens, conteudo FROM importacao WHERE id = ${id}`
    expect(i).toMatchObject({ estado: 'executando', itens: 2 })
    expect(i!.conteudo).not.toBeNull()

    // Dentro do arrendamento ninguém mais pega (outro processo ainda "vivo").
    expect((await rodarWorker(A, { lote: 2 })).processadas).toBe(0)

    // Arrendamento vencido: a próxima passada retoma de onde parou.
    const r = await rodarWorker(A, { lote: 2 }, new Date(Date.now() + 5 * 60_000))
    expect(r.concluidas).toBe(1)
    const [fim] = await dono<{ estado: string; itens: number; conteudo: string | null }[]>`
      SELECT estado, (SELECT count(*)::int FROM importacao_item WHERE importacao_id = importacao.id) AS itens, conteudo FROM importacao WHERE id = ${id}`
    expect(fim).toMatchObject({ estado: 'concluida', itens: 5, conteudo: null })
    const d = await pedir('ges', 'GET', `/v1/importacoes/${id}`)
    expect(d.json().contagens).toEqual({ linhas: 5, criados: 5, atualizados: 0, ignorados: 0, rejeitados: 0 })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${A} AND nome LIKE 'Retoma %'`
    expect(n!.n).toBe(5)
  })

  it('cancelar uma importação em execução a interrompe e apaga o CSV guardado', async () => {
    const csv = 'Nome;Telefone\nCancela 1;81930000001'
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    await executar('ges', id, csv)
    expect((await pedir('ges', 'POST', `/v1/importacoes/${id}/cancelar`)).status).toBe(200)
    await rodarWorker()
    const [i] = await dono<{ estado: string; conteudo: string | null }[]>`SELECT estado, conteudo FROM importacao WHERE id = ${id}`
    expect(i).toEqual({ estado: 'cancelada', conteudo: null })
    expect((await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE nome = 'Cancela 1'`)[0]!.n).toBe(0)
  })
})

describe('H1 — histórico e isolamento entre tenants', () => {
  it('lista por cursor, só as do próprio tenant; detalhe de outro tenant → 404', async () => {
    const p1 = await pedir('ges', 'GET', '/v1/importacoes')
    expect(p1.status).toBe(200)
    expect(p1.json().itens.length).toBeGreaterThan(0)
    expect(p1.json().itens.length).toBeLessThanOrEqual(20)
    expect((await pedir('ges', 'GET', '/v1/importacoes?cursor=lixo')).status).toBe(422)

    const idA = p1.json().itens[0].id as string
    expect((await pedir('admB', 'GET', `/v1/importacoes/${idA}`)).status).toBe(404)
    expect((await pedir('admB', 'GET', `/v1/importacoes/${idA}/itens`)).status).toBe(404)
    expect((await pedir('admB', 'GET', `/v1/importacoes/${idA}/relatorio.csv`)).status).toBe(404)
    expect((await pedir('admB', 'GET', `/v1/importacoes/${idA}/conferencia`)).status).toBe(404)
    expect((await pedir('admB', 'POST', `/v1/importacoes/${idA}/cancelar`)).status).toBe(404)
    expect((await pedir('admB', 'GET', '/v1/importacoes')).json().itens).toEqual([])
  })

  it('o mesmo telefone importado no tenant B cria o contato do B e não toca o do A', async () => {
    const csv = 'Nome;Telefone\nMaria no B;81998617049'
    const s = await simular('admB', 'contatos', csv)
    expect(s.json().contagens.criados).toBe(1)
    await executar('admB', s.json().importacaoId, csv)
    await rodarWorker(B)
    expect(await contarContatos(B)).toBe(1)
    const [c] = await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = ${A} AND nome = 'Maria Souza'`
    expect(c!.nome).toBe('Maria Souza')
  })
})

// ---------------------------------------------------------------------------
// Correções da revisão adversarial
// ---------------------------------------------------------------------------

const itensDe = async (id: string) =>
  dono<{ linha: number; resultado: string; motivo: string | null }[]>`SELECT linha, resultado, motivo FROM importacao_item WHERE importacao_id = ${id} ORDER BY linha`
const contar = async (consulta: Promise<{ n: number }[]>) => (await consulta)[0]!.n

describe('H1 revisão — LGPD', () => {
  const ANON = 'b1e00000-0006-4000-8000-0000000000a1'

  it('⚠️ chave com lgpd_em é ignorada (bloqueado_lgpd) e contato anonimizado nunca é completado nem recebe venda/tarefa', async () => {
    const lgpd = normalizarTelefone('81955551111')!
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, lgpd_em) VALUES (${A}, ${lgpd.chaveBloqueio}, 'lgpd', now())`
    const anon = normalizarTelefone('81955552222')!
    await dono`INSERT INTO contato (tenant_id, id, nome, anonimizado_em, anonimizacao_modo) VALUES (${A}, ${ANON}, 'Anonimizado', now(), 'completa')`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte) VALUES (${A}, ${ANON}, 1, ${anon.e164}, ${anon.chaveBloqueio}, true, 'erp')`

    const csv = 'Nome;Telefone;E-mail\nTitular;81955551111;t@x.com\nAnon;81955552222;novo@x.com'
    const s = await simular('ges', 'contatos', csv)
    expect(s.json().contagens).toMatchObject({ criados: 0, ignorados: 2 })
    const antes = await contarContatos()
    const { id, detalhe } = await importar('contatos', csv)
    expect(detalhe.contagens).toMatchObject({ criados: 0, atualizados: 0, ignorados: 2 })
    expect((await itensDe(id)).map((i) => i.motivo)).toEqual(['bloqueado_lgpd', 'contato_anonimizado'])
    expect(await contarContatos()).toBe(antes)
    const [c] = await dono<{ email: string | null }[]>`SELECT email FROM contato WHERE id = ${ANON}`
    expect(c!.email).toBeNull()

    const v = await importar('vendas', 'Telefone;Data;Valor\n81955552222;20/05/2024;10,00\n81955551111;20/05/2024;10,00')
    expect((await itensDe(v.id)).map((i) => i.motivo)).toEqual(['contato_anonimizado', 'bloqueado_lgpd'])
    const t = await importar('tarefas', 'Telefone;Título;Vence em\n81955552222;Ligar;30/11/2030\n81955551111;Ligar 2;30/11/2030')
    expect((await itensDe(t.id)).map((i) => i.motivo)).toEqual(['contato_anonimizado', 'bloqueado_lgpd'])
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda WHERE contato_id = ${ANON}`)).toBe(0)
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE contato_id = ${ANON}`)).toBe(0)
  })
})

describe('H1 revisão — simulação = execução', () => {
  it('(a) doc+tel na linha 1 e só o tel na 2; (b) existente repetido: simulação e execução batem', async () => {
    const EX = 'b1e00000-0006-4000-8000-0000000000b1'
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${EX}, 'Já existente')`
    const ex = normalizarTelefone('81944440001')!
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte) VALUES (${A}, ${EX}, 1, ${ex.e164}, ${ex.chaveBloqueio}, true, 'erp')`
    const csv = [
      'Nome;Telefone;CNPJ;Observações',
      'Empresa D;81944440002;529.982.247-25;a',
      'Empresa D só fone;81944440002;;b',
      'Existente 1;81944440001;;c',
      'Existente 2;81944440001;;d',
    ].join('\n')
    const s = await simular('ges', 'contatos', csv)
    const previsto = (await itensDe(s.json().importacaoId)).map((i) => i.resultado)
    const { id, detalhe } = await importar('contatos', csv)
    expect(detalhe.contagens).toEqual(s.json().contagens)
    const real = await itensDe(id)
    expect(real.map((i) => i.resultado)).toEqual(previsto)
    expect(real.map((i) => i.resultado)).toEqual(['criado', 'ignorado', 'atualizado', 'ignorado'])
    expect(real[3]!.motivo).toBe('duplicada_no_arquivo')
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${A} AND nome LIKE 'Empresa D%'`)).toBe(1)
  })

  it('venda sem referência: reenviar arquivo corrigido (linhas deslocadas) não duplica', async () => {
    await importar('contatos', 'Nome;Telefone\nComprador;81933339999')
    const l1 = '81933339999;10/04/2024;100,00;Camisetas'
    const l2 = '81933339999;11/04/2024;200,00;Calças'
    await importar('vendas', `Telefone;Data;Valor;Descrição\n${l1}\n${l2}`)
    const r = await importar('vendas', `Telefone;Data;Valor;Descrição\n81933339999;12/04/2024;50,00;Nova\n81933339999;11/04/2024;200,00; calças \n${l1}`)
    expect(r.detalhe.contagens).toMatchObject({ criados: 1, ignorados: 2 })
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda WHERE tenant_id = ${A} AND ocorrida_em >= '2024-04-01' AND ocorrida_em < '2024-05-01'`)).toBe(3)
  })

  it('a sonda do horizonte de partições não grava nada e aceita o passado', async () => {
    const antes = await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda WHERE tenant_id = ${A}`)
    const s = await simular('ges', 'vendas', 'Telefone;Data;Valor\n81933339999;01/01/1999;10,00')
    expect(s.json().contagens.criados).toBe(1)
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM venda WHERE tenant_id = ${A}`)).toBe(antes)
  })
})

describe('H1 revisão — gates da simulação e da execução', () => {
  it('simulação incompleta não executa; opções enviadas no executar são ignoradas; simulação abandonada expira', async () => {
    const csv = 'Nome;Telefone;Origem\nGate Dois;81955550002;Origem Nova'
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    await dono`UPDATE importacao SET simulada_em = NULL WHERE id = ${id}`
    const e = await executar('ges', id, csv)
    expect(e.status).toBe(409)
    expect(e.json().erro).toBe('importacao.simulacao_incompleta')
    await dono`UPDATE importacao SET simulada_em = now() WHERE id = ${id}`
    expect((await executar('ges', id, csv, { opcoes: JSON.stringify({ criarOrigens: true }) })).status).toBe(202)
    await rodarWorker()
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM origem WHERE tenant_id = ${A} AND nome = 'Origem Nova'`)).toBe(0)

    const velha = await simular('ges', 'contatos', 'Nome;Telefone\nExpira;81955550003')
    const velhaId = velha.json().importacaoId
    await rodarWorker(A, {}, new Date(Date.now() + 25 * 3600_000))
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM importacao WHERE id = ${velhaId}`)).toBe(0)
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM importacao_item WHERE importacao_id = ${velhaId}`)).toBe(0)
  })

  it('conferência: 409 enquanto não concluída; conta só criados e atualizados', async () => {
    const csv = 'Nome;Telefone\nConf Um;81955550010'
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    await executar('ges', id, csv)
    expect((await pedir('ges', 'GET', `/v1/importacoes/${id}/conferencia`)).status).toBe(409)
    await rodarWorker()
    const outra = await importar('contatos', csv) // reexecução: 1 ignorado
    const r = await pedir('ges', 'GET', `/v1/importacoes/${outra.id}/conferencia`)
    expect(r.status).toBe(200)
    expect(r.json().total).toBe(0)
  })
})

describe('H1 revisão — encoding e WhatsApp', () => {
  it('Windows-1252 (aspas 0x93/0x94) é lido certo; UTF-16 e NUL → 422 importacao.encoding', async () => {
    const win = Buffer.concat([Buffer.from('Nome;Telefone\n'), Buffer.from([0x93, 0x41, 0x6e, 0x61, 0x94]), Buffer.from(';81955550020')])
    const s = await simular('ges', 'contatos', win)
    expect(s.status).toBe(201)
    await executar('ges', s.json().importacaoId, win)
    await rodarWorker()
    const [c] = await dono<{ nome: string }[]>`SELECT nome FROM contato WHERE tenant_id = ${A} AND nome LIKE '%Ana%' AND nome <> 'Ana'`
    expect(c!.nome).toBe('“Ana”')
    const u16 = await simular('ges', 'contatos', Buffer.from('﻿Nome;Telefone\nA;81955550021', 'utf16le'))
    expect(u16.status).toBe(422)
    expect(u16.json().erro).toBe('importacao.encoding')
    expect((await simular('ges', 'contatos', Buffer.from('Nome;Telefone\nA\u0000;81955550022'))).json().erro).toBe('importacao.encoding')
  })

  it('whatsapp vazio ou ilegível fica NULL; só "sim"/"não" definem', async () => {
    await importar('contatos', 'Nome;Telefone;Tem WhatsApp\nWa Vazio;81955550030;\nWa Lixo;81955550031;talvez\nWa Sim;81955550032;sim\nWa Nao;81955550033;não')
    const r = await dono<{ nome: string; whatsapp: boolean | null }[]>`
      SELECT c.nome, t.whatsapp FROM contato c JOIN contato_telefone t ON t.tenant_id = c.tenant_id AND t.contato_id = c.id
       WHERE c.tenant_id = ${A} AND c.nome LIKE 'Wa %' ORDER BY c.nome`
    expect(Object.fromEntries(r.map((x) => [x.nome, x.whatsapp]))).toEqual({ 'Wa Lixo': null, 'Wa Nao': false, 'Wa Sim': true, 'Wa Vazio': null })
  })
})

describe('H1 revisão — worker concorrente', () => {
  it('outra réplica termina enquanto a primeira ainda tem lote: contagens = itens, sem duplicar', async () => {
    const linhas = ['Nome;Telefone']
    for (let i = 1; i <= 6; i++) linhas.push(`Conc ${i};8195000004${i}`)
    const csv = linhas.join('\n')
    const s = await simular('ges', 'contatos', csv)
    const id = s.json().importacaoId
    await executar('ges', id, csv)
    let segunda = false
    await rodarWorker(A, {
      lote: 2,
      depoisDoLote: async () => {
        if (segunda) return
        segunda = true
        // Arrendamento "vencido" para a outra réplica: ela processa o resto.
        await rodarWorker(A, { lote: 2 }, new Date(Date.now() + 10 * 60_000))
      },
    })
    const d = (await pedir('ges', 'GET', `/v1/importacoes/${id}`)).json()
    const [it] = await dono<{ n: number; c: number }[]>`SELECT count(*)::int AS n, count(*) FILTER (WHERE resultado = 'criado')::int AS c FROM importacao_item WHERE importacao_id = ${id}`
    expect(it).toEqual({ n: 6, c: 6 })
    expect(d.contagens).toEqual({ linhas: 6, criados: 6, atualizados: 0, ignorados: 0, rejeitados: 0 })
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${A} AND nome LIKE 'Conc %'`)).toBe(6)
  })

  it('duas passadas simultâneas: só uma reivindica', async () => {
    const csv = 'Nome;Telefone\nSim 1;81955550051\nSim 2;81955550052'
    const s = await simular('ges', 'contatos', csv)
    await executar('ges', s.json().importacaoId, csv)
    const [a, b] = await Promise.all([rodarWorker(), rodarWorker()])
    expect(a.concluidas + b.concluidas).toBe(1)
    const d = (await pedir('ges', 'GET', `/v1/importacoes/${s.json().importacaoId}`)).json()
    expect(d.contagens.criados).toBe(2)
  })
})
