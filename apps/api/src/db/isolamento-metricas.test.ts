import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

/**
 * Isolamento da view materializada de métricas e da outbox.
 *
 * ⚠️ Roda com o papel geracrm_api — sem superusuário e sem BYPASSRLS. Testar
 * isolamento com a conexão de dono passa sempre e não prova nada: superusuário
 * ignora RLS mesmo com FORCE.
 */

const A = 'd15c0a11-0000-4000-8000-000000000001'
const B = 'd15c0a11-0000-4000-8000-000000000002'
const PVA = 'd15c0a11-1111-4000-8000-000000000001'
const PVB = 'd15c0a11-1111-4000-8000-000000000002'
const PLANO = 'd15c0a11-3333-4000-8000-000000000001'
const MODELO = 'd15c0a11-4444-4000-8000-000000000001'
const CONTATO_A = 'd15c0a11-6666-4000-8000-00000000000a'
const CONTATO_B = 'd15c0a11-6666-4000-8000-00000000000b'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const api = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

/** Executa como a API executa: SET LOCAL dentro da transação. */
async function comoTenant<T>(tenantId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return api.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as postgres.Sql)
  }) as Promise<T>
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-isolamento', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-isolamento', 'Varejo') ON CONFLICT DO NOTHING`

  for (const [t, pv, nome] of [[A, PVA, 'Loja A'], [B, PVB, 'Loja B']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }

  // Cada tenant com um contato e uma venda — para a MV ter linha dos dois.
  for (const [t, contato, valor] of [[A, CONTATO_A, 10000], [B, CONTATO_B, 99999]] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${t}, ${contato}, 'Cliente') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (${t}, gen_random_uuid(), ${contato}, now() - interval '10 days', ${valor})`
  }
  await dono`SELECT atualizar_metricas_contato()`
})

afterAll(async () => {
  for (const t of [A, B]) {
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`DELETE FROM venda WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato WHERE tenant_id = ${t}`
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`SELECT atualizar_metricas_contato()`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
  await api.end()
})

describe('mv_metricas_contato — o vazamento que a 0016 tinha deixado aberto', () => {
  it('⚠️ o papel da API NÃO lê a view materializada direto', async () => {
    // A 0016 dava GRANT SELECT ao geracrm_app. Como matview não aceita policy,
    // isso era leitura irrestrita de TODOS os tenants: uma consulta esquecida
    // no dashboard mostraria o faturamento de outra loja.
    await expect(
      comoTenant(A, (tx) => tx`SELECT count(*) FROM mv_metricas_contato`),
    ).rejects.toThrow(/permission denied/i)
  })

  it('dada a view metricas_contato, então enxerga só o próprio tenant', async () => {
    const linhasA = await comoTenant(A, (tx) => tx`SELECT contato_id, total_centavos::text AS total FROM metricas_contato`)
    expect(linhasA).toHaveLength(1)
    expect(linhasA[0]!.contato_id).toBe(CONTATO_A)

    const linhasB = await comoTenant(B, (tx) => tx`SELECT contato_id FROM metricas_contato`)
    expect(linhasB.map((l) => l.contato_id)).toEqual([CONTATO_B])
  })

  it('⚠️ o filtro é garantia, não disciplina: pedir o contato do OUTRO tenant devolve vazio', async () => {
    const vazio = await comoTenant(A, (tx) =>
      tx`SELECT * FROM metricas_contato WHERE contato_id = ${CONTATO_B}`)
    // A consulta está "errada" e mesmo assim não vaza — que é a diferença entre
    // mecanismo e lembrar de filtrar.
    expect(vazio).toHaveLength(0)
  })

  it('dado cliente cuja primeira compra está na borda da carga, então confiavel = false', async () => {
    // A venda mais antiga do tenant É a primeira compra dele: não dá para ver o
    // começo da história, então a média entre compras e o atraso não são
    // confiáveis — e a coluna diz isso em vez de deixar a tela afirmar.
    const [m] = await comoTenant(A, (tx) => tx`SELECT confiavel, apurado_desde FROM metricas_contato`)
    expect(m!.confiavel).toBe(false)
    expect(m!.apurado_desde).toBeInstanceOf(Date)
  })
})

describe('outbox — INV-40', () => {
  it('dado evento do tenant A, então o tenant B não o enxerga', async () => {
    await comoTenant(A, (tx) => tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id)
      VALUES (${A}, 'contato.criado', 'contato', ${CONTATO_A})`)

    const vistoPorB = await comoTenant(B, (tx) => tx`SELECT id FROM outbox`)
    expect(vistoPorB).toHaveLength(0)

    const vistoPorA = await comoTenant(A, (tx) => tx`SELECT tipo FROM outbox`)
    expect(vistoPorA.map((l) => l.tipo)).toEqual(['contato.criado'])
  })

  it('⚠️ dado rollback, então o evento NÃO fica — nem meio-gravado', async () => {
    await expect(
      comoTenant(A, async (tx) => {
        await tx`INSERT INTO outbox (tenant_id, tipo, agregado) VALUES (${A}, 'x.fantasma', 'contato')`
        throw new Error('falha depois de escrever')
      }),
    ).rejects.toThrow('falha depois de escrever')

    // O evento nasce no MESMO commit do fato. Se o fato não aconteceu, a tela
    // não pode ser avisada de que aconteceu.
    const [n] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${A} AND tipo = 'x.fantasma'`
    expect(n!.n).toBe(0)
  })

  it('dada inserção, então o NOTIFY (geracrm_evento) chega com ids e SEM conteúdo', async () => {
    const ouvinte = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      // ⚠️ `geracrm_evento` é UM canal global no servidor; os testes rodam em
      // paralelo. Não basta pegar o PRÓXIMO NOTIFY — pode ser de outro arquivo.
      // Filtra pelo tenant deste teste (A) e ignora os alheios, com timeout.
      const recebido = new Promise<string>((resolve, reject) => {
        const prazo = setTimeout(() => reject(new Error('NOTIFY de A não chegou a tempo')), 5000)
        void ouvinte.listen('geracrm_evento', (payload) => {
          try {
            if ((JSON.parse(payload) as { tenantId?: string }).tenantId === A) {
              clearTimeout(prazo)
              resolve(payload)
            }
          } catch { /* payload não-JSON de outro produtor: ignora */ }
        })
      })
      // Espera o LISTEN estar de fato registrado antes de inserir.
      await new Promise((r) => setTimeout(r, 200))

      await comoTenant(A, (tx) => tx`
        INSERT INTO outbox (tenant_id, tipo, agregado, payload)
        VALUES (${A}, 'mensagem.recebida', 'conversa',
                ${JSON.stringify({ conversaId: 'c-1', versao: 5 })}::text::jsonb)`)

      // ⚠️ ADR-007: um ÚNICO canal, payload MÍNIMO (ids). O conteúdo o cliente
      // busca pela API sob RLS — o NOTIFY nunca carrega mensagem (defesa em
      // profundidade e, de quebra, o limite de 8000 bytes vira irrelevante).
      const bruto = await recebido
      const ev = JSON.parse(bruto) as { tenantId: string; tipo: string; conversaId?: string }
      expect(ev.tenantId).toBe(A)
      expect(ev.tipo).toBe('mensagem.recebida')
      expect(ev.conversaId).toBe('c-1')
      expect(bruto).not.toMatch(/texto|"message"|conteudo/i)
    } finally {
      await ouvinte.end()
    }
  })
})
