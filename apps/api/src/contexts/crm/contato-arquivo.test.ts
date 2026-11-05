import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { definirArquivosBucket, type ArquivosBucket } from './arquivos-bucket.js'
import { chaveDoArquivo, nomeSeguro, tipoPermitido } from './arquivos-regras.js'

/**
 * A3 — arquivos do contato, com adaptador FALSO de bucket (em memória). Fixa: upload, limite de
 * 15 MB, tipo permitido, chave com o tenant no prefixo, URL assinada curta, remoção, lista por
 * cursor e isolamento entre tenants (RLS).
 */
const T = 'a3a00000-0000-4000-8000-000000000001'
const OUTRO = 'a3a00000-0000-4000-8000-000000000002'
const PV = 'a3a00000-1111-4000-8000-000000000001'
const PV2 = 'a3a00000-1111-4000-8000-000000000002'
const PLANO = 'a3a00000-3333-4000-8000-000000000001'
const MODELO = 'a3a00000-4444-4000-8000-000000000001'
const C = 'a3a00000-5555-4000-8000-000000000001'
const C_OUTRO = 'a3a00000-5555-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const objetos = new Map<string, { bytes: Buffer; mime: string }>()
let disponivel = true
const bucketFalso: ArquivosBucket = {
  disponivel: () => disponivel,
  subir: async (chave, bytes, mime) => { objetos.set(chave, { bytes, mime }) },
  remover: async (chave) => { objetos.delete(chave) },
  urlAssinada: async (chave, ttl) => `https://bucket.fake/${chave}?ttl=${ttl}`,
}

function multipart(nome: string, mime: string, bytes: Buffer, legenda?: string) {
  const f = 'frontEIRA3917'
  const partes: Buffer[] = []
  if (legenda) partes.push(Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="legenda"\r\n\r\n${legenda}\r\n`))
  partes.push(Buffer.from(`--${f}\r\nContent-Disposition: form-data; name="arquivo"; filename="${nome}"\r\nContent-Type: ${mime}\r\n\r\n`))
  partes.push(bytes, Buffer.from(`\r\n--${f}--\r\n`))
  return { payload: Buffer.concat(partes), headers: { 'content-type': `multipart/form-data; boundary=${f}` } }
}
const enviar = (t: string, c: string, nome: string, mime: string, bytes: Buffer, legenda?: string) => {
  const m = multipart(nome, mime, bytes, legenda)
  return app.inject({ method: 'POST', url: `/v1/contatos/${c}/arquivos`, headers: { 'x-tenant-id': t, ...m.headers }, payload: m.payload })
}
const chamar = (t: string, m: 'GET' | 'DELETE', url: string) => app.inject({ method: m, url, headers: { 'x-tenant-id': t } })

async function limpar() {
  await dono`DELETE FROM contato_arquivo WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM auditoria WHERE tenant_id IN (${T}, ${OUTRO})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-a3a', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-a3a', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'A'], [OUTRO, PV2, 'B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES
    (${T}, ${C}, 'Zé dos Arquivos', 'teste', true), (${OUTRO}, ${C_OUTRO}, 'De Outro', 'teste', true) ON CONFLICT DO NOTHING`
  definirArquivosBucket(bucketFalso)
  app = await criarApp(); await app.ready()
})
beforeEach(async () => { await limpar(); objetos.clear(); disponivel = true })
afterAll(async () => {
  definirArquivosBucket()
  await limpar()
  await dono`DELETE FROM contato WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM usuario WHERE tenant_id IN (${T}, ${OUTRO})`
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('regras puras', () => {
  it('tipo e extensão têm de combinar; nome vira basename sem controle', () => {
    expect(tipoPermitido('application/pdf', 'contrato.PDF')).toBe(true)
    expect(tipoPermitido('application/pdf', 'contrato.exe')).toBe(false)
    expect(tipoPermitido('application/x-msdownload', 'a.exe')).toBe(false)
    expect(tipoPermitido('text/plain', 'a.txt')).toBe(true)
    expect(nomeSeguro('..\\..\\etc/passwd\u0000.txt')).toBe('passwd.txt')
    expect(chaveDoArquivo('T1', 'C1', 'A1', 'x.pdf')).toBe('tenant/T1/contato/C1/A1.pdf')
  })
})

describe('A3 — arquivos do contato', () => {
  it('sobe, lista, gera URL assinada curta e remove; a chave leva o tenant no prefixo', async () => {
    const r = await enviar(T, C, 'proposta.pdf', 'application/pdf', Buffer.from('%PDF-1.4 teste'), 'Proposta v2')
    expect(r.statusCode).toBe(201)
    const { id } = r.json() as { id: string }
    const chaves = [...objetos.keys()]
    expect(chaves).toHaveLength(1)
    expect(chaves[0]).toBe(`tenant/${T}/contato/${C}/${id}.pdf`)

    const lista = (await chamar(T, 'GET', `/v1/contatos/${C}/arquivos`)).json() as {
      itens: { id: string; nome: string; legenda: string | null; tamanhoBytes: number; enviadoPor: { nome: string } | null }[]; proximoCursor: string | null
    }
    expect(lista.itens).toHaveLength(1)
    expect(lista.itens[0]).toMatchObject({ id, nome: 'proposta.pdf', legenda: 'Proposta v2', tamanhoBytes: 14 })
    expect(lista.itens[0]!.enviadoPor).not.toBeNull()

    const u = (await chamar(T, 'GET', `/v1/contatos/${C}/arquivos/${id}/url`)).json() as { url: string; expiraEmSegundos: number }
    expect(u.url).toContain(chaves[0])
    expect(u.expiraEmSegundos).toBeLessThanOrEqual(300)

    expect((await chamar(T, 'DELETE', `/v1/contatos/${C}/arquivos/${id}`)).statusCode).toBe(200)
    expect(objetos.size).toBe(0)
    expect((await chamar(T, 'GET', `/v1/contatos/${C}/arquivos`)).json().itens).toHaveLength(0)
    expect((await chamar(T, 'DELETE', `/v1/contatos/${C}/arquivos/${id}`)).statusCode).toBe(404)
  })

  it('tipo não permitido → 415 e nada vai ao bucket', async () => {
    const r = await enviar(T, C, 'virus.exe', 'application/x-msdownload', Buffer.from('MZ'))
    expect(r.statusCode).toBe(415)
    expect(r.json().erro).toBe('arquivos.tipo_nao_permitido')
    expect(objetos.size).toBe(0)
    // mime permitido com extensão trocada também é recusado
    expect((await enviar(T, C, 'foto.exe', 'image/png', Buffer.from('x'))).statusCode).toBe(415)
  })

  it('acima de 15 MB → 413 e nada vai ao bucket', async () => {
    const r = await enviar(T, C, 'grande.pdf', 'application/pdf', Buffer.alloc(15 * 1024 * 1024 + 10, 1))
    expect(r.statusCode).toBe(413)
    expect(r.json().erro).toBe('arquivos.grande_demais')
    expect(objetos.size).toBe(0)
    expect((await dono`SELECT 1 FROM contato_arquivo WHERE tenant_id = ${T}`).length).toBe(0)
  })

  it('sem bucket configurado → 503 tipado (degrada, não quebra)', async () => {
    disponivel = false
    const r = await enviar(T, C, 'a.txt', 'text/plain', Buffer.from('oi'))
    expect(r.statusCode).toBe(503)
    expect(r.json().erro).toBe('arquivos.bucket_indisponivel')
  })

  it('lista por cursor', async () => {
    for (let i = 0; i < 32; i++) {
      await dono`INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket)
                 VALUES (${T}, ${randomUUID()}, ${C}, ${'f' + i + '.txt'}, 'text/plain', 1, ${`tenant/${T}/contato/${C}/x${i}.txt`})`
    }
    const p1 = (await chamar(T, 'GET', `/v1/contatos/${C}/arquivos`)).json() as { itens: { id: string }[]; proximoCursor: string | null }
    expect(p1.itens).toHaveLength(30)
    expect(p1.proximoCursor).not.toBeNull()
    const p2 = (await chamar(T, 'GET', `/v1/contatos/${C}/arquivos?cursor=${p1.proximoCursor}`)).json() as { itens: { id: string }[]; proximoCursor: string | null }
    expect(p2.itens).toHaveLength(2)
    expect(p2.proximoCursor).toBeNull()
    expect(new Set([...p1.itens, ...p2.itens].map((i) => i.id)).size).toBe(32)
  })

  it('RLS: outro tenant não lista, não baixa nem remove; e a chave do banco não aceita outro prefixo', async () => {
    const id = ((await enviar(T, C, 'a.txt', 'text/plain', Buffer.from('segredo'))).json() as { id: string }).id
    expect((await chamar(OUTRO, 'GET', `/v1/contatos/${C}/arquivos`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'GET', `/v1/contatos/${C_OUTRO}/arquivos`)).json().itens).toHaveLength(0)
    expect((await chamar(OUTRO, 'GET', `/v1/contatos/${C_OUTRO}/arquivos/${id}/url`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'DELETE', `/v1/contatos/${C_OUTRO}/arquivos/${id}`)).statusCode).toBe(404)
    expect(objetos.size).toBe(1)
    await expect(dono`INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket)
      VALUES (${T}, ${randomUUID()}, ${C}, 'x.txt', 'text/plain', 1, ${`tenant/${OUTRO}/x.txt`})`).rejects.toThrow()
  })
})
