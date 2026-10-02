import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { fatiarDocumento, reindexarDocumento, sincronizarPoliticas, ALVO_TRECHO, MAX_TRECHO } from './indexador.js'

/**
 * O fatiador (puro) e o indexador (banco real, papel da aplicação): tamanho dos
 * trechos, título na primeira linha, hash que poupa regravação, e o
 * sincronismo das políticas que sobe versão só quando o texto mudou.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo.
 */
const T = 'c0b20000-0000-4000-8000-000000000001'
const PV = 'c0b20000-1111-4000-8000-000000000001'
const PLANO = 'c0b20000-3333-4000-8000-000000000001'
const MODELO = 'c0b20000-4444-4000-8000-000000000001'
const CANAL = 'c0b20000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-conhecimento-indexador', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-conhecimento-indexador', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Indexador', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco()
  await dono.end()
})

const trechosDe = (documentoId: string) => dono<{ ordem: number; texto: string; texto_hash: string; modelo_embedding: string | null }[]>`
  SELECT ordem, texto, texto_hash, modelo_embedding FROM conhecimento_trecho
   WHERE tenant_id = ${T} AND documento_id = ${documentoId} ORDER BY ordem`

describe('fatiarDocumento (puro)', () => {
  it('dado parágrafos curtos, então junta até o alvo e prefixa o título na primeira linha', () => {
    const r = fatiarDocumento('Políticas', 'Entrega em 3 dias.\n\nPagamento por PIX.\n\n\nTroca em 7 dias.')
    expect(r).toEqual(['Políticas\nEntrega em 3 dias.\n\nPagamento por PIX.\n\nTroca em 7 dias.'])
  })

  it('dado conteúdo que passa do alvo, então abre trecho novo no limite de parágrafo', () => {
    const p = 'a'.repeat(700) // 2 cabem no alvo (1.402), o 3º não (2.104)
    const r = fatiarDocumento('T', `${p}\n\n${p}\n\n${p}`)
    expect(r).toHaveLength(2)
    expect(r[0]).toBe(`T\n${p}\n\n${p}`)
    expect(r[1]).toBe(`T\n${p}`)
    for (const t of r) expect(t.length).toBeLessThanOrEqual(ALVO_TRECHO + 'T\n'.length)
  })

  it('dado parágrafo maior que o teto, então parte por frases e nenhum trecho passa do teto', () => {
    const frase = 'Esta é uma frase de política com umas quarenta letras. '
    const paragrafo = frase.repeat(120).trim() // ≈ 6.600 chars, sem linha em branco
    const r = fatiarDocumento('Longo', paragrafo)
    expect(r.length).toBeGreaterThan(3)
    for (const t of r) {
      expect(t.startsWith('Longo\n')).toBe(true)
      expect(t.length).toBeLessThanOrEqual(MAX_TRECHO + 'Longo\n'.length)
      expect(t.endsWith('.')).toBe(true) // cortou em fim de frase, não no meio da palavra
    }
    expect(r.join(' ').replace(/Longo\n/g, '').replace(/\s+/g, ' ')).toBe(paragrafo.replace(/\s+/g, ' '))
  })

  it('dado frase única maior que o teto, então corta no espaço e nada se perde', () => {
    const palavra = 'palavra '
    const frase = palavra.repeat(600).trim() // 4.799 chars sem pontuação
    const r = fatiarDocumento('X', frase, { alvo: 1000, max: 1000 })
    expect(r.length).toBeGreaterThanOrEqual(5)
    for (const t of r) expect(t.length).toBeLessThanOrEqual(1000 + 'X\n'.length)
    expect(r.map((t) => t.slice(2)).join(' ')).toBe(frase)
  })

  it('dado conteúdo vazio ou só espaços, então nenhum trecho', () => {
    expect(fatiarDocumento('T', '')).toEqual([])
    expect(fatiarDocumento('T', '\n\n   \n')).toEqual([])
  })
})

describe('reindexarDocumento — hash poupa regravação', () => {
  it('dado o mesmo texto duas vezes, então a segunda é inalterado e os trechos não mudam', async () => {
    const id = randomUUID()
    const r1 = await comTenantServico(T, async (tx) => {
      await tx`INSERT INTO conhecimento_documento (tenant_id, id, titulo, tipo, conteudo)
               VALUES (tenant_atual(), ${id}, 'FAQ', 'faq', 'Pergunta um.\n\nPergunta dois.')`
      return reindexarDocumento(tx, id)
    })
    expect(r1).toBe('indexado')
    const antes = await trechosDe(id)
    expect(antes).toHaveLength(1)
    expect(antes[0]!.texto).toBe('FAQ\nPergunta um.\n\nPergunta dois.')

    const r2 = await comTenantServico(T, (tx) => reindexarDocumento(tx, id))
    expect(r2).toBe('inalterado')
    expect(await trechosDe(id)).toEqual(antes)
  })

  it('dado texto que encolheu, então regrava o que mudou e apaga a cauda', async () => {
    const id = randomUUID()
    const grande = 'x'.repeat(1400)
    await comTenantServico(T, async (tx) => {
      await tx`INSERT INTO conhecimento_documento (tenant_id, id, titulo, tipo, conteudo)
               VALUES (tenant_atual(), ${id}, 'Frete', 'frete', ${`${grande}\n\n${grande}\n\n${grande}`})`
      await reindexarDocumento(tx, id)
    })
    expect(await trechosDe(id)).toHaveLength(3)
    // Marca o primeiro como embutido para provar que o inalterado preserva a marca.
    await dono`UPDATE conhecimento_trecho SET modelo_embedding = 'teste' WHERE tenant_id = ${T} AND documento_id = ${id} AND ordem = 0`

    const mudou = 'y'.repeat(200) // 1.400 + 2 + 200 passa do alvo: continua trecho próprio
    const r = await comTenantServico(T, async (tx) => {
      await tx`UPDATE conhecimento_documento SET conteudo = ${`${grande}\n\n${mudou}`} WHERE tenant_id = tenant_atual() AND id = ${id}`
      return reindexarDocumento(tx, id)
    })
    expect(r).toBe('indexado')
    const depois = await trechosDe(id)
    expect(depois.map((t) => t.ordem)).toEqual([0, 1])
    expect(depois[0]!.modelo_embedding).toBe('teste') // ordem 0 não mudou
    expect(depois[1]!.texto).toBe(`Frete\n${mudou}`)
    expect(depois[1]!.modelo_embedding).toBeNull()
  })

  it('dado documento inexistente, então nao_encontrado', async () => {
    expect(await comTenantServico(T, (tx) => reindexarDocumento(tx, randomUUID()))).toBe('nao_encontrado')
  })
})

describe('sincronizarPoliticas — espelho de agente_config.politicas', () => {
  const politicasDoCanal = () => dono<{ id: string; versao: number; publicado: boolean; conteudo: string }[]>`
    SELECT id, versao, publicado, conteudo FROM conhecimento_documento
     WHERE tenant_id = ${T} AND canal_id = ${CANAL} AND tipo = 'politicas'`

  it('dado canal sem documento, então cria v1 e indexa', async () => {
    const r = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, 'Entrega em 3 dias.'))
    expect(r.situacao).toBe('criado')
    expect(r.versao).toBe(1)
    const docs = await politicasDoCanal()
    expect(docs).toHaveLength(1)
    expect((await trechosDe(docs[0]!.id))[0]!.texto).toBe('Políticas da loja\nEntrega em 3 dias.')
  })

  it('dado o mesmo texto de novo, então nada muda — nem versão, nem trechos (migra uma vez só)', async () => {
    const docs = await politicasDoCanal()
    const antes = await trechosDe(docs[0]!.id)
    const r = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, '  Entrega em 3 dias.\n'))
    expect(r).toEqual({ documentoId: docs[0]!.id, versao: 1, situacao: 'inalterado' })
    expect(await politicasDoCanal()).toHaveLength(1)
    expect(await trechosDe(docs[0]!.id)).toEqual(antes)
  })

  it('dado o trecho gravado pela migração de dados (título + parágrafo), então o indexador o reconhece pelo hash', async () => {
    // A migração 0089 grava o mesmo formato e o mesmo sha256 — provado aqui.
    const docs = await politicasDoCanal()
    const [t] = await trechosDe(docs[0]!.id)
    const [h] = await dono<{ h: string }[]>`SELECT encode(sha256(convert_to(${t!.texto}, 'UTF8')), 'hex') AS h`
    expect(t!.texto_hash).toBe(h!.h)
  })

  it('dado texto diferente, então sobe para v2 e reindexa', async () => {
    const r = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, 'Entrega em 5 dias.\n\nPIX com 5% de desconto.'))
    expect(r.situacao).toBe('atualizado')
    expect(r.versao).toBe(2)
    const docs = await politicasDoCanal()
    expect(docs).toHaveLength(1)
    expect(docs[0]!.conteudo).toBe('Entrega em 5 dias.\n\nPIX com 5% de desconto.')
    expect((await trechosDe(docs[0]!.id))[0]!.texto).toMatch(/5 dias/)
  })

  it('dado texto vazio, então despublica sem apagar; texto de novo republica e sobe a versão', async () => {
    const r1 = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, ''))
    expect(r1.situacao).toBe('despublicado')
    expect((await politicasDoCanal())[0]!.publicado).toBe(false)

    const r2 = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, ''))
    expect(r2.situacao).toBe('inalterado')

    const r3 = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, CANAL, 'Entrega em 2 dias.'))
    expect(r3.situacao).toBe('atualizado')
    expect(r3.versao).toBe(3)
    expect((await politicasDoCanal())[0]!.publicado).toBe(true)
  })

  it('dado canal de outro tenant (ou inexistente), então canal_nao_encontrado e nada é gravado', async () => {
    const r = await comTenantServico(T, (tx) => sincronizarPoliticas(tx, randomUUID(), 'x'))
    expect(r.situacao).toBe('canal_nao_encontrado')
    expect(await politicasDoCanal()).toHaveLength(1)
  })
})
