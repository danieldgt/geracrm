import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../../../../db/index.js'
import { criarProdutoManual } from '../../../catalogo/escrita-manual.js'
import { indexarProduto } from '../../../catalogo/indexador.js'
import { EmbeddingIndisponivel, ErroEmbedding, type PortaEmbedding } from '../../../catalogo/porta-embedding.js'
import { buscarConhecimento } from './busca.js'
import { capacidadesDeBusca, embutirPendentes, passadaDeEmbedding } from './embutir-pendentes.js'
import { reindexarDocumento } from './indexador.js'

/**
 * O passo que embute os pendentes, contra o Postgres real COM pgvector (imagem
 * `pgvector/pgvector` no compose e no CI). Porta de embedding FALSA e
 * determinística: nunca a rede.
 *
 * ⚠️ UUIDs exclusivos deste arquivo.
 */
const T = 'e3b0c442-0000-4000-8000-000000000001'
const PV = 'e3b0c442-1111-4000-8000-000000000001'
const PLANO = 'e3b0c442-3333-4000-8000-000000000001'
const MODELO = 'e3b0c442-4444-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const noTenant = <R>(fn: Parameters<typeof comTenantServico<R>>[1]) => comTenantServico(T, fn)

/** Vetor determinístico: a dimensão 0 marca "moletom/frio", a 1 marca "camiseta/calor". */
function vetorDe(texto: string): number[] {
  const v = Array.from({ length: 1024 }, () => 0)
  const t = texto.toLowerCase()
  v[0] = /moletom|frio|inverno|agasalho|gelad/.test(t) ? 1 : 0.01
  v[1] = /camiseta|calor|verao|verão/.test(t) ? 1 : 0.01
  v[2] = 0.1
  return v
}
function portaFalsa(opcoes: { falhar?: ErroEmbedding; aoEmbutir?: () => Promise<void> } = {}): PortaEmbedding & { chamadas: string[][] } {
  const chamadas: string[][] = []
  return {
    nome: 'falsa:v1', capacidades: { buscaSemantica: true }, dimensoes: 1024, chamadas,
    async embutir(textos) {
      chamadas.push([...textos])
      if (opcoes.falhar) throw opcoes.falhar
      await opcoes.aoEmbutir?.()
      return textos.map(vetorDe)
    },
  }
}

let docId: string
/** Segundo parágrafo longo o bastante (> 1500 chars) para o fatiador abrir um SEGUNDO trecho. */
const PARAGRAFO_VERAO = Array.from({ length: 40 }, () => 'No verão a camiseta de algodão é a mais pedida.').join(' ')
const CONTEUDO_V1 = `Temos moletom e agasalho para o frio.\n\n${PARAGRAFO_VERAO}`
const CONTEUDO_V2 = `Temos moletom, agasalho e touca para o frio.\n\n${PARAGRAFO_VERAO}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-embutir', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-embutir', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Embutir', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
  docId = randomUUID()
  await noTenant(async (tx) => {
    await tx`INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado)
             VALUES (tenant_atual(), ${docId}, NULL, 'FAQ de inverno', 'faq',
                     ${CONTEUDO_V1}, 1, true)`
    await reindexarDocumento(tx, docId)
    const r = await criarProdutoManual(tx, {
      referencia: 'EMB-MOL', descricao: 'Moletom canguru', categoria: 'Moletons',
      skus: [{ atributos: { cor: 'CINZA', tamanho: 'M' }, precos: { varejo: 12990 }, saldo: 4 }],
    })
    if (!r.ok) throw new Error(r.falha.erro)
    await indexarProduto(tx, r.valor.id)
  })
})

afterAll(async () => {
  await dono`DELETE FROM conhecimento_documento WHERE tenant_id = ${T}`
  await dono`DELETE FROM produto WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('capacidadesDeBusca', () => {
  it('com pgvector e SEM chave: semantica=sem_chave, falta VOYAGE_API_KEY, pendentes contam tudo', async () => {
    const cap = await noTenant((tx) => capacidadesDeBusca(tx, EmbeddingIndisponivel))
    expect(cap.pgvector).toBe(true)
    expect(cap).toMatchObject({ semantica: 'sem_chave', embedding: { configurado: false, provedor: null } })
    expect(cap.embedding.falta).toMatch(/CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_AI_TOKEN \(ou VOYAGE_API_KEY\)/)
    expect(cap.pendentes.trechos).toBe(2)
    expect(cap.pendentes.produtos).toBe(1)
    expect(cap.embutidos).toEqual({ produtos: 0, trechos: 0 })
  })

  it('com porta configurada: semantica=ligada e provedor nomeado', async () => {
    const cap = await noTenant((tx) => capacidadesDeBusca(tx, portaFalsa()))
    expect(cap).toMatchObject({ semantica: 'ligada', embedding: { configurado: true, provedor: 'falsa:v1', falta: null } })
  })
})

describe('embutirPendentes', () => {
  it('sem chave: não toca a rede e diz por que parou', async () => {
    const r = await embutirPendentes(noTenant, EmbeddingIndisponivel)
    expect(r).toMatchObject({ produtos: 0, trechos: 0, parou: 'sem_chave' })
  })

  it('falha do fornecedor: para na hora, nada gravado, código preservado', async () => {
    const porta = portaFalsa({ falhar: new ErroEmbedding('limite_excedido', 'rpm') })
    const r = await embutirPendentes(noTenant, porta)
    expect(r.parou).toBe('limite_excedido')
    expect(r.trechos + r.produtos).toBe(0)
    expect(porta.chamadas).toHaveLength(1)
  })

  it('texto que mudou enquanto a rede respondia NÃO recebe o vetor velho (guarda por hash)', async () => {
    const porta = portaFalsa({
      aoEmbutir: async () => {
        // Simula o dono editando o documento no meio do voo: versão nova, trechos regravados.
        await noTenant(async (tx) => {
          await tx`UPDATE conhecimento_documento SET conteudo = ${CONTEUDO_V2}, versao = 2 WHERE id = ${docId}`
          await reindexarDocumento(tx, docId)
        })
      },
    })
    const r = await embutirPendentes(noTenant, porta, { lote: 64, maxLotes: 1 })
    expect(r.parou).toBeNull()
    // O trecho 0 mudou: ficou pendente. O trecho 1 (igual) entrou.
    expect(r.trechos).toBe(1)
    expect(r.restantes.trechos).toBe(1)
  })

  it('passada completa: conhecimento primeiro, catálogo depois; restantes zeram; a busca ganha a perna semântica', async () => {
    const porta = portaFalsa()
    const r = await embutirPendentes(noTenant, porta, { lote: 64 })
    expect(r.parou).toBeNull()
    expect(r.restantes).toEqual({ produtos: 0, trechos: 0 })
    expect(r.trechos).toBe(1)
    expect(r.produtos).toBe(1)
    expect(porta.chamadas[0]![0]).toMatch(/FAQ de inverno/)

    const cap = await noTenant((tx) => capacidadesDeBusca(tx, porta))
    expect(cap.embutidos).toEqual({ produtos: 1, trechos: 2 })

    // "roupa para dias gelados" não tem palavra do trecho — só a semântica acha.
    const busca = await noTenant((tx) => buscarConhecimento(tx, { pergunta: 'roupa para dias gelados', vetorConsulta: vetorDe('gelados'), limite: 3 }))
    expect(busca.fontes).toContain('semantica')
    expect(busca.trechos[0]?.texto).toMatch(/moletom/i)
    expect(busca.trechos[0]?.fontes).toContain('semantica')
    // Vetor de OUTRO provedor não é comparável: com o nome dele, a perna semântica não roda.
    const outra = await noTenant((tx) => buscarConhecimento(tx, { pergunta: 'roupa para dias gelados', vetorConsulta: vetorDe('gelados'), modeloEmbedding: 'outra:v2', limite: 3 }))
    // A perna roda (está em `fontes`), mas não acha nada: nenhum trecho vem marcado como semântico.
    expect(outra.trechos.some((t) => t.fontes.includes('semantica'))).toBe(false)

    // Segunda passada: nada a fazer, nenhuma chamada de rede.
    const porta2 = portaFalsa()
    const r2 = await embutirPendentes(noTenant, porta2)
    expect(r2).toMatchObject({ produtos: 0, trechos: 0, parou: null })
    expect(porta2.chamadas).toHaveLength(0)
  })

  it('trocar de provedor (nome diferente) torna tudo pendente de novo', async () => {
    const cap = await noTenant((tx) => capacidadesDeBusca(tx, { ...portaFalsa(), nome: 'outra:v2' }))
    expect(cap.pendentes.trechos).toBe(2)
    expect(cap.pendentes.produtos).toBe(1)
  })
})

describe('passadaDeEmbedding (worker, dono)', () => {
  // ⚠️ Como DONO a passada enxerga TODOS os tenants do banco de desenvolvimento. A porta
  //    aqui FALHA de propósito: exercita lock e relatório sem gravar vetor falso em
  //    dado de outro tenant (o que já aconteceu uma vez e sujou o tenant demo).
  const portaQueFalha = () => portaFalsa({ falhar: new ErroEmbedding('indisponivel', 'teste') })

  it('sem chave → desligado; com lock tomado → ocupado; livre → relatório (e solta o lock)', async () => {
    expect(await passadaDeEmbedding(dono as never, EmbeddingIndisponivel)).toBe('desligado')
    const outro = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      await outro`SELECT pg_advisory_lock(hashtext('embutir_pendentes'))`
      expect(await passadaDeEmbedding(dono as never, portaQueFalha())).toBe('ocupado')
      await outro`SELECT pg_advisory_unlock(hashtext('embutir_pendentes'))`
      const r = await passadaDeEmbedding(dono as never, portaQueFalha())
      expect(typeof r).toBe('object')
      if (typeof r === 'object') expect(r).toMatchObject({ produtos: 0, trechos: 0 })
      // Lock devolvido: outra conexão consegue pegá-lo.
      const [l] = await outro<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('embutir_pendentes')) AS ok`
      expect(l?.ok).toBe(true)
      await outro`SELECT pg_advisory_unlock(hashtext('embutir_pendentes'))`
    } finally { await outro.end() }
  })
})
