import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type { ResumoBuscaInteligente } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { criarProdutoManual } from './escrita-manual.js'
import { indexarProduto, temColunaEmbedding } from './indexador.js'
import { ErroEmbedding, EmbeddingIndisponivel, type PortaEmbedding } from './porta-embedding.js'

/**
 * GET /v1/catalogo/busca-inteligente — a busca híbrida (ADR-026) exposta à tela do Catálogo
 * e ao pedido assistido. A regra de ranking é de `busca.ts` (testada em `busca.test.ts`);
 * aqui vale o CONTRATO HTTP: validação, perfil de preço, filtros, teto com `truncado`,
 * degradação visível da semântica e o isolamento entre tenants.
 *
 * ⚠️ UUIDs e códigos de semente exclusivos deste arquivo (prefixo ca7a2b00).
 */
const T = 'ca7a2b00-0000-4000-8000-000000000001'
const OUTRO = 'ca7a2b00-0000-4000-8000-000000000002'
const PV = 'ca7a2b00-1111-4000-8000-000000000001'
const PV2 = 'ca7a2b00-1111-4000-8000-000000000002'
const PLANO = 'ca7a2b00-3333-4000-8000-000000000001'
const MODELO = 'ca7a2b00-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** Provedor de mentira: um vetor fixo, sem rede. Nome próprio para não colidir no cache global. */
const portaFalsa = (falha = false): PortaEmbedding => ({
  nome: falha ? 'teste-rotas-busca-falha' : 'teste-rotas-busca',
  capacidades: { buscaSemantica: true },
  dimensoes: 1024,
  async embutir(textos) {
    if (falha) throw new ErroEmbedding('tempo_esgotado', 'estourou')
    return textos.map(() => Array.from({ length: 1024 }, () => 0.01))
  },
})

type Resposta = ResumoBuscaInteligente & {
  itens: { id: string; referencia: string; origem: string; score: number; fontes: string[]; skus: { precoCentavos: number | null }[] }[]
}

let semChave: FastifyInstance
let comChave: FastifyInstance
let provedorFora: FastifyInstance
const buscar = async (app: FastifyInstance, qs: string, tenant = T) =>
  app.inject({ method: 'GET', url: `/v1/catalogo/busca-inteligente?${qs}`, headers: { 'x-tenant-id': tenant } })

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-busca', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-busca', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja Busca HTTP'], [OUTRO, PV2, 'Outra loja']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`DELETE FROM produto WHERE tenant_id = ${t}`
  }

  await comTenantServico(T, async (tx) => {
    const criar = async (entrada: Parameters<typeof criarProdutoManual>[1]) => {
      const r = await criarProdutoManual(tx, entrada)
      if (!r.ok) throw new Error(`fixture ${entrada.referencia}: ${r.falha.erro}`)
      await indexarProduto(tx, r.valor.id)
    }
    await criar({
      referencia: 'HTTP-CAM', descricao: 'Camiseta básica algodão', categoria: 'Camisetas',
      skus: [{ atributos: { cor: 'VERDE', tamanho: 'G' }, precos: { varejo: 4990, atacado: 2990 }, saldo: 12 }],
    })
    await criar({
      referencia: 'HTTP-CAM-POLO', descricao: 'Camiseta polo piquet', categoria: 'Camisetas',
      skus: [{ atributos: { cor: 'AZUL', tamanho: 'M' }, precos: { varejo: 8990 }, saldo: 4 }],
    })
    await criar({
      referencia: 'HTTP-CALCA', descricao: 'Calça jeans skinny', categoria: 'Calças',
      skus: [{ atributos: { cor: 'AZUL', tamanho: '40' }, precos: { varejo: 15990, atacado: 9990 }, saldo: 5 }],
    })
  })
  // Um produto "do ERP" (origem gravada no banco) para o filtro de origem.
  await dono`UPDATE produto SET origem = 'erp' WHERE tenant_id = ${T} AND referencia = 'HTTP-CAM-POLO'`
  await comTenantServico(OUTRO, async (tx) => {
    const r = await criarProdutoManual(tx, {
      referencia: 'OUTRO-CAM', descricao: 'Camiseta do outro tenant', categoria: 'Camisetas',
      skus: [{ atributos: { cor: 'ROXO' }, precos: { varejo: 1000 }, saldo: 1 }],
    })
    if (!r.ok) throw new Error('fixture outro tenant')
    await indexarProduto(tx, r.valor.id)
  })

  semChave = await criarApp({ buscaCatalogo: { embedding: EmbeddingIndisponivel } }); await semChave.ready()
  comChave = await criarApp({ buscaCatalogo: { embedding: portaFalsa() } }); await comChave.ready()
  provedorFora = await criarApp({ buscaCatalogo: { embedding: portaFalsa(true) } }); await provedorFora.ready()
})

afterAll(async () => {
  for (const t of [T, OUTRO]) {
    await dono`DELETE FROM produto WHERE tenant_id = ${t}`
    await dono`DELETE FROM tabela_preco WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono`DELETE FROM embedding_consulta_cache WHERE modelo LIKE 'teste-rotas-busca%'`.catch(() => {})
  await Promise.all([semChave.close(), comChave.close(), provedorFora.close()])
  await encerrarBanco(); await dono.end()
})

describe('GET /v1/catalogo/busca-inteligente', () => {
  it('dado erro de digitação ("camisetta"), então acha as camisetas, ranqueadas, com as pernas que rodaram', async () => {
    const r = await buscar(semChave, 'q=camisetta')
    expect(r.statusCode).toBe(200)
    const corpo = r.json() as Resposta
    expect(corpo.itens.map((i) => i.referencia)).toEqual(expect.arrayContaining(['HTTP-CAM', 'HTTP-CAM-POLO']))
    expect(corpo.itens.map((i) => i.referencia)).not.toContain('HTTP-CALCA')
    expect(corpo.fontes).toEqual(expect.arrayContaining(['lexical', 'trgm']))
    expect(corpo.itens[0]!.fontes.length).toBeGreaterThan(0)
    expect(corpo.truncado).toBe(false)
  })

  it('dado perfil, então o preço é cotado NO SERVIDOR por aquele perfil (ADR-025)', async () => {
    const varejo = (await buscar(semChave, 'q=calca%20jeans&perfil=varejo')).json() as Resposta
    const atacado = (await buscar(semChave, 'q=calca%20jeans&perfil=atacado')).json() as Resposta
    expect(varejo.itens[0]!.skus[0]!.precoCentavos).toBe(15990)
    expect(atacado.itens[0]!.skus[0]!.precoCentavos).toBe(9990)
  })

  it('dado filtro de origem e de categoria, então filtra no banco', async () => {
    const erp = (await buscar(semChave, 'q=camiseta&origem=erp')).json() as Resposta
    expect(erp.itens.map((i) => i.referencia)).toEqual(['HTTP-CAM-POLO'])
    const calcas = (await buscar(semChave, 'q=azul&categoria=Cal%C3%A7as')).json() as Resposta
    expect(calcas.itens.map((i) => i.referencia)).toEqual(['HTTP-CALCA'])
  })

  it('dado limite menor que os achados, então corta no limite e avisa truncado', async () => {
    const r = (await buscar(semChave, 'q=camiseta&limite=1')).json() as Resposta
    expect(r.itens.length).toBe(1)
    expect(r.truncado).toBe(true)
  })

  it('dado consulta vazia, longa demais, limite fora da faixa ou origem desconhecida, então 422 com o campo', async () => {
    for (const [qs, campo] of [
      ['q=', 'q'], ['q=%20%20', 'q'], [`q=${'a'.repeat(201)}`, 'q'],
      ['q=camiseta&limite=0', 'limite'], ['q=camiseta&limite=31', 'limite'], ['q=camiseta&limite=abc', 'limite'],
      ['q=camiseta&origem=sap', 'origem'],
    ] as const) {
      const r = await buscar(semChave, qs)
      expect(r.statusCode, qs).toBe(422)
      expect((r.json() as { erro: string; campos: string[] }).campos, qs).toEqual([campo])
    }
  })

  it('isolamento: o tenant A nunca vê produto do tenant B', async () => {
    const a = (await buscar(semChave, 'q=camiseta')).json() as Resposta
    expect(a.itens.map((i) => i.referencia)).not.toContain('OUTRO-CAM')
    const b = (await buscar(semChave, 'q=camiseta', OUTRO)).json() as Resposta
    expect(b.itens.map((i) => i.referencia)).toEqual(['OUTRO-CAM'])
  })
})

describe('Semântica é capacidade — e a tela sabe por que está desligada (ADR-008)', () => {
  it('sem provedor de embedding: busca lexical e semantica = sem_chave', async () => {
    const r = (await buscar(semChave, 'q=camiseta')).json() as Resposta
    expect(r.fontes).not.toContain('semantica')
    expect(r.semantica).toBe('sem_chave')
  })

  it('provedor falhou nesta consulta: ainda responde (lexical) e semantica = indisponivel', async () => {
    const r = await buscar(provedorFora, 'q=camiseta')
    expect(r.statusCode).toBe(200)
    const corpo = r.json() as Resposta
    expect(corpo.itens.length).toBeGreaterThan(0)
    expect(corpo.semantica).toBe('indisponivel')
  })

  it('com provedor: a perna semântica roda se o banco tem pgvector; senão, sem_indice', async () => {
    const r = (await buscar(comChave, 'q=camiseta')).json() as Resposta
    const temColuna = await comTenantServico(T, (tx) => temColunaEmbedding(tx))
    if (temColuna) {
      expect(r.fontes).toContain('semantica')
      expect(r.semantica).toBe('ligada')
    } else {
      expect(r.semantica).toBe('sem_indice')
    }
  })
})
