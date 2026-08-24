import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { emSavepoint } from './index.js'
import type { Sql } from './index.js'

/**
 * ⚠️ A ARMADILHA QUE ESTES TESTES FIXAM.
 *
 * `try { await passoAcessorio() } catch {}` parece proteger a transação e NÃO
 * protege: no Postgres, um comando que falha aborta a transação INTEIRA. Os
 * comandos seguintes respondem `current transaction is aborted`, e o COMMIT vira
 * ROLLBACK — longe de onde o erro nasceu.
 *
 * No caminho da ingestão isso significa perder a MENSAGEM DO CLIENTE porque um
 * passo secundário (confirmar pedido pela resposta, atribuir origem de mídia)
 * falhou. O primeiro teste existe para provar que o perigo é real; o segundo,
 * para provar que o savepoint o remove.
 */

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

afterAll(async () => { await dono.end() })

describe('Falha de um passo acessório dentro de uma transação', () => {
  it('⚠️ com try/catch apenas, a transação INTEIRA cai — o catch não salva', async () => {
    // ⚠️ E é PIOR do que "os próximos comandos falham": o postgres.js registra a
    //    falha, faz ROLLBACK e rejeita o `begin()` com o erro original. O
    //    `catch` lá dentro dá a impressão de ter tratado, e o trabalho já feito
    //    na transação — no caso da ingestão, a MENSAGEM DO CLIENTE — desaparece.
    await expect(dono.begin(async (tx) => {
      try { await tx`SELECT 1 / 0` } catch { /* "tratado" — e é aqui que engana */ }
      return tx`SELECT 1 AS ok`
    })).rejects.toThrow(/division by zero/)
  })

  it('com savepoint, o estrago fica no trecho e a transação segue', async () => {
    const [r] = await dono.begin(async (tx) => {
      try {
        await emSavepoint(tx as unknown as Sql, (sp) => sp`SELECT 1 / 0`)
      } catch { /* isolar e engolir são decisões separadas — esta é a segunda */ }

      return tx<{ ok: number }[]>`SELECT 1 AS ok`
    }) as unknown as { ok: number }[]

    expect(r!.ok).toBe(1)
  })

  it('o valor de retorno atravessa o savepoint quando dá certo', async () => {
    const valor = await dono.begin((tx) =>
      emSavepoint(tx as unknown as Sql, async (sp) => {
        const [r] = await sp<{ n: number }[]>`SELECT 7 AS n`
        return r!.n
      }))

    expect(valor).toBe(7)
  })

  /**
   * ⚠️ Fora de transação não há savepoint para criar — e também não há transação
   * para proteger. Rodar direto é melhor do que estourar num caminho legítimo.
   */
  it('chamado fora de transação, roda direto em vez de quebrar', async () => {
    const [r] = await emSavepoint(dono as unknown as Sql, (sp) => sp<{ ok: number }[]>`SELECT 1 AS ok`)
    expect(r!.ok).toBe(1)
  })
})
