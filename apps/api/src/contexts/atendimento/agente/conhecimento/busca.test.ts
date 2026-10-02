import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { buscarConhecimento } from './busca.js'
import { reindexarDocumento, sincronizarPoliticas, temColunaEmbeddingConhecimento } from './indexador.js'
import { criarConhecimentoReal } from './conhecimento-real.js'
import { EmbeddingIndisponivel } from '../../../catalogo/porta-embedding.js'
import type { ContextoFerramenta } from '../ferramentas/porta.js'

/**
 * Busca híbrida de conhecimento (ADR-026) contra o Postgres real, SOB O PAPEL
 * DA APLICAÇÃO (`comTenantServico` usa DATABASE_URL): o que passa aqui passa
 * pela RLS.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo (Vitest roda em paralelo).
 */
const T = 'c0b10000-0000-4000-8000-000000000001'
const OUTRO = 'c0b10000-0000-4000-8000-000000000002'
const PV = 'c0b10000-1111-4000-8000-000000000001'
const PV2 = 'c0b10000-1111-4000-8000-000000000002'
const PLANO = 'c0b10000-3333-4000-8000-000000000001'
const MODELO = 'c0b10000-4444-4000-8000-000000000001'
const CANAL = 'c0b10000-7777-4000-8000-000000000001'
const CANAL2 = 'c0b10000-7777-4000-8000-000000000002'
const CANAL_OUTRO = 'c0b10000-7777-4000-8000-000000000003'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

async function criarDocumento(tenant: string, d: { canalId: string | null; titulo: string; tipo: string; conteudo: string; publicado?: boolean }): Promise<string> {
  return comTenantServico(tenant, async (tx) => {
    const id = randomUUID()
    await tx`INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, publicado)
             VALUES (tenant_atual(), ${id}, ${d.canalId}, ${d.titulo}, ${d.tipo}, ${d.conteudo}, ${d.publicado ?? true})`
    await reindexarDocumento(tx, id)
    return id
  })
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-conhecimento-busca', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-conhecimento-busca', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja Busca KB'], [OUTRO, PV2, 'Outra']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
             (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado'),
             (${T}, ${CANAL2}, 'whatsapp_nao_oficial', 'Atacado', 'conectado'),
             (${OUTRO}, ${CANAL_OUTRO}, 'whatsapp_nao_oficial', 'Outra', 'conectado') ON CONFLICT DO NOTHING`
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id IN (${T}, ${OUTRO})`

  await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL,
    'ENTREGA\nO prazo de entrega é de 3 dias úteis para todo o Brasil.\n\nPAGAMENTO\nAceitamos PIX e cartão em até 3x sem juros.'))
  await criarDocumento(T, { canalId: null, titulo: 'FAQ de trocas', tipo: 'troca', conteudo: 'Trocas podem ser feitas em até 7 dias após o recebimento, com a etiqueta.' })
  await criarDocumento(T, { canalId: CANAL2, titulo: 'Retirada no atacado', tipo: 'outro', conteudo: 'Retirada na loja do centro em horário comercial, de segunda a sexta.' })
  await criarDocumento(T, { canalId: null, titulo: 'Rascunho de natal', tipo: 'outro', conteudo: 'Promoção secreta de natal com brinde surpresa.', publicado: false })
  await criarDocumento(OUTRO, { canalId: null, titulo: 'Políticas da outra', tipo: 'politicas', conteudo: 'O prazo de entrega aqui é de 10 dias corridos.' })
})

afterAll(async () => {
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM canal_conectado WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco()
  await dono.end()
})

const buscar = (pergunta: string, extra: { canalId?: string; limite?: number; vetorConsulta?: number[] } = {}, tenant = T) =>
  comTenantServico(tenant, (tx) => buscarConhecimento(tx, { pergunta, ...extra }))

describe('Busca de conhecimento — lexical (FTS pt_sem_acento)', () => {
  it('dado "prazo de entrega", então acha o trecho das políticas com documento e versão', async () => {
    const r = await buscar('qual o prazo de entrega?', { canalId: CANAL })
    expect(r.fontes).toContain('lexical')
    const t = r.trechos[0]!
    expect(t.texto).toMatch(/3 dias úteis/)
    expect(t.titulo).toBe('Políticas da loja')
    expect(t.tipo).toBe('politicas')
    expect(t.versao).toBe(1)
    expect(t.fontes).toContain('lexical')
    expect(t.score).toBeGreaterThan(0)
  })

  it('dado acento diferente ("cartao"), então acha "cartão"', async () => {
    const r = await buscar('aceita cartao?', { canalId: CANAL })
    expect(r.trechos.some((t) => /cartão/.test(t.texto))).toBe(true)
  })

  it('dado pergunta vazia, então nada — e nenhuma perna roda', async () => {
    expect(await buscar('   ')).toEqual({ trechos: [], fontes: [] })
  })

  it('dado pergunta sem nada em comum, então lista vazia sem erro', async () => {
    const r = await buscar('xyzzy quântico', { canalId: CANAL })
    expect(r.trechos).toEqual([])
  })
})

describe('Busca de conhecimento — trgm (erro de digitação)', () => {
  it('dado "entrgea", então o trgm ainda acha o trecho de entrega', async () => {
    const r = await buscar('entrgea', { canalId: CANAL })
    const t = r.trechos.find((x) => /3 dias úteis/.test(x.texto))
    expect(t).toBeDefined()
    expect(t!.fontes).toContain('trgm')
  })
})

describe('Escopo por canal e publicação', () => {
  it('dado canal, então entram os documentos do canal E os globais, não os de outro canal', async () => {
    const r = await buscar('troca retirada entrega', { canalId: CANAL, limite: 10 })
    const titulos = r.trechos.map((t) => t.titulo)
    expect(titulos).toContain('Políticas da loja')
    expect(titulos).toContain('FAQ de trocas')
    expect(titulos).not.toContain('Retirada no atacado')
  })

  it('dado o outro canal, então vê o seu documento e os globais, não as políticas do primeiro', async () => {
    const r = await buscar('troca retirada entrega', { canalId: CANAL2, limite: 10 })
    const titulos = r.trechos.map((t) => t.titulo)
    expect(titulos).toContain('Retirada no atacado')
    expect(titulos).toContain('FAQ de trocas')
    expect(titulos).not.toContain('Políticas da loja')
  })

  it('dado busca sem canal (console), então entra tudo que está publicado', async () => {
    const r = await buscar('troca retirada entrega', { limite: 10 })
    const titulos = new Set(r.trechos.map((t) => t.titulo))
    expect(titulos).toEqual(new Set(['Políticas da loja', 'FAQ de trocas', 'Retirada no atacado']))
  })

  it('⚠️ documento despublicado nunca aparece', async () => {
    const r = await buscar('promoção de natal brinde', { limite: 10 })
    expect(r.trechos.map((t) => t.titulo)).not.toContain('Rascunho de natal')
  })

  it('dado limite, então respeita (e nunca passa de 10)', async () => {
    const r = await buscar('troca retirada entrega pagamento', { limite: 1 })
    expect(r.trechos).toHaveLength(1)
  })
})

describe('Isolamento — dois tenants', () => {
  it('dado o outro tenant, então só vê o próprio documento', async () => {
    const r = await buscar('prazo de entrega', {}, OUTRO)
    expect(r.trechos).toHaveLength(1)
    expect(r.trechos[0]!.titulo).toBe('Políticas da outra')
    expect(r.trechos[0]!.texto).toMatch(/10 dias/)
  })

  it('dado o primeiro tenant, então não vê o do outro', async () => {
    const r = await buscar('prazo de entrega', { limite: 10 })
    expect(r.trechos.map((t) => t.titulo)).not.toContain('Políticas da outra')
  })
})

describe('Semântica como capacidade opcional (ADR-026)', () => {
  it('dado vetor de consulta, então a perna semântica só roda se a coluna existir — sem erro em nenhum caso', async () => {
    const vetor = Array.from({ length: 1024 }, () => 0.01)
    const temColuna = await comTenantServico(T, (tx) => temColunaEmbeddingConhecimento(tx))
    const r = await buscar('prazo de entrega', { canalId: CANAL, vetorConsulta: vetor })
    expect(r.trechos[0]!.texto).toMatch(/3 dias úteis/)
    if (temColuna) expect(r.fontes).toContain('semantica')
    else expect(r.fontes).not.toContain('semantica')
  })
})

describe('A porta do vendedor (conhecimentoReal)', () => {
  const ctx: ContextoFerramenta = {
    tenantId: T, conversaId: randomUUID(), contatoId: randomUUID(), canalId: CANAL,
    perfil: 'varejo', sessaoId: null, modo: 'sombra', agora: new Date(),
  }

  it('dado a pergunta do cliente, então devolve até 3 trechos com fonte "Título vN"', async () => {
    const kb = criarConhecimentoReal({ embedding: EmbeddingIndisponivel })
    const r = await kb.buscar(ctx, 'em quantos dias chega?')
    expect(r.trechos.length).toBeGreaterThan(0)
    expect(r.trechos.length).toBeLessThanOrEqual(3)
    expect(r.trechos[0]).toEqual({ texto: expect.stringMatching(/3 dias úteis/), fonte: 'Políticas da loja v1' })
  })

  it('dado o canal do contexto, então o documento de outro canal fica de fora', async () => {
    const kb = criarConhecimentoReal({ embedding: EmbeddingIndisponivel })
    const r = await kb.buscar(ctx, 'retirada na loja do centro')
    expect(r.trechos.map((t) => t.fonte)).not.toContain('Retirada no atacado v1')
  })
})
