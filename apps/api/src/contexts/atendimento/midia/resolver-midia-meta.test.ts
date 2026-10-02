import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../db/index.js'
import { cifrar } from '../../integracao/cofre.js'
import { CanalMetaOficial } from '../canais/meta-oficial.js'
import type { PortaCanal } from '../canais/porta.js'
import { resolverMidiaMeta } from './resolver-midia-meta.js'
import { baixarMidiaDeEntrada } from './baixar-entrada.js'

/**
 * Resolução PÓS-COMMIT da mídia da Meta (R5): o placeholder `meta:media:<id>`
 * vira chave do bucket via o adaptador do canal (token) — ou fica como está se
 * o download falhar. Banco real; Graph API e bucket falsos.
 */
const T = 'c3d30000-0000-4000-8000-000000000001'
const PV = 'c3d30000-1111-4000-8000-000000000001'
const PLANO = 'c3d30000-3333-4000-8000-000000000001'
const MODELO = 'c3d30000-4444-4000-8000-000000000001'
const CANAL = 'c3d30000-5555-4000-8000-000000000001'
const CONTATO = 'c3d30000-6666-4000-8000-000000000001'
const CONVERSA = 'c3d30000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let pedidos: string[] = []
const canalFalso = (ok: boolean): PortaCanal => {
  const real = new CanalMetaOficial({ phoneNumberId: 'P', token: 't' })
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    async baixarMidia(id: string) {
      pedidos.push(id)
      return ok ? { ok: true, bytes: Buffer.from([7, 8, 9]), mime: 'audio/ogg' } : { ok: false, motivo: 'nao_encontrada' }
    },
  }) as PortaCanal
}
const subirFalso = async (tenantId: string, bytes: Buffer, mime: string) => `tenant/${tenantId}/falso-${bytes.length}.${mime.split('/')[1]!.split(';')[0]}`

const mensagemComPlaceholder = async (tipo: 'audio' | 'imagem', midiaId: string) => {
  const id = randomUUID(); const criadoEm = new Date()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', ${tipo}, ${JSON.stringify({ [tipo]: `meta:media:${midiaId}`, mime: 'audio/ogg; codecs=opus' })}::text::jsonb, ${criadoEm})`
  return { mensagemId: id, mensagemCriadoEm: criadoEm, tipo, url: `meta:media:${midiaId}`, mime: 'audio/ogg; codecs=opus' as string | null }
}
const conteudo = async (id: string) => (await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND id = ${id}`)[0]!.conteudo

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-resolver-meta', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-resolver-meta', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Resolver', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${cifrar({ phoneNumberId: 'PHONE-RM', token: 'tok' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => { pedidos = []; await dono`DELETE FROM mensagem WHERE tenant_id = ${T}` })
afterAll(async () => {
  for (const t of ['mensagem', 'conversa', 'contato', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('resolverMidiaMeta', () => {
  it('baixa pelo adaptador do canal (com o media id) e troca o placeholder pela chave do bucket', async () => {
    const m = await mensagemComPlaceholder('audio', 'MEDIA-OK-1')
    const ok = await resolverMidiaMeta(T, CANAL, m, { criar: () => canalFalso(true), subir: subirFalso })
    expect(ok).toBe(true)
    expect(pedidos).toEqual(['MEDIA-OK-1'])
    // O mime sugerido pelo webhook (com codecs) prevalece sobre o do download.
    expect(await conteudo(m.mensagemId)).toMatchObject({ audio: `tenant/${T}/falso-3.ogg`, mime: 'audio/ogg; codecs=opus' })
  })

  it('download que falha mantém o placeholder (o worker ainda sabe baixar pelo id)', async () => {
    const m = await mensagemComPlaceholder('imagem', 'MEDIA-SUMIU')
    const ok = await resolverMidiaMeta(T, CANAL, m, { criar: () => canalFalso(false), subir: subirFalso })
    expect(ok).toBe(false)
    expect(await conteudo(m.mensagemId)).toMatchObject({ imagem: 'meta:media:MEDIA-SUMIU' })
  })

  it('referência que não é da Meta não é assunto deste resolvedor', async () => {
    const m = { ...(await mensagemComPlaceholder('audio', 'X')), url: 'https://provedor.exemplo/x.ogg' }
    expect(await resolverMidiaMeta(T, CANAL, m, { criar: () => canalFalso(true), subir: subirFalso })).toBe(false)
    expect(pedidos).toEqual([])
  })

  it('baixarMidiaDeEntrada: URL http usa fetch direto; chave do bucket sem bucket configurado devolve null', async () => {
    const buscar = (async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => new Uint8Array([1]).buffer })) as unknown as typeof fetch
    const r = await baixarMidiaDeEntrada(T, CANAL, 'https://provedor.exemplo/a.mp3', null, { buscar })
    expect(r).toEqual({ bytes: Buffer.from([1]), mime: 'audio/mpeg' })
    expect(await baixarMidiaDeEntrada(T, CANAL, 'nada-disso', null, { buscar })).toBeNull()
  })
})
