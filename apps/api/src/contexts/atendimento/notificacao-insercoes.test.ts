import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * GUARDA D4: todo `INSERT INTO notificacao` precisa consultar a preferência do destinatário
 * (`canaisDosUsuarios`). Um produtor novo que insere direto ignora "desliguei este aviso" — e o aviso volta
 * a chegar. O teste falha se aparecer INSERT fora da lista.
 *
 * `EXCECOES` é a lista explícita do que ainda NÃO consulta; cada entrada tem dono e prazo de saída.
 */
const RAIZ = join(import.meta.dirname, '..', '..')

// Hoje vazia: todo produtor consulta a preferência. Só entra arquivo com motivo escrito.
const EXCECOES: Readonly<Record<string, string>> = {}

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho)
    return caminho.endsWith('.ts') && !caminho.endsWith('.test.ts') ? [caminho] : []
  })
}

describe('INSERT INTO notificacao só onde a preferência é consultada', () => {
  const comInsert = arquivosTs(RAIZ)
    .map((f) => ({ rel: relative(RAIZ, f).split('\\').join('/'), fonte: readFileSync(f, 'utf8') }))
    .filter((f) => /INSERT\s+INTO\s+notificacao\b/i.test(f.fonte))

  it('há produtores (a varredura está olhando o lugar certo)', () => {
    expect(comInsert.length).toBeGreaterThanOrEqual(4)
  })

  it('cada arquivo que insere consulta canaisDosUsuarios, ou está na lista de exceções', () => {
    const sem = comInsert.filter((f) => !f.fonte.includes('canaisDosUsuarios') && !(f.rel in EXCECOES)).map((f) => f.rel)
    expect(sem).toEqual([])
  })

  it('a lista de exceções não guarda arquivo que já consulta (limpe-a)', () => {
    const obsoletas = comInsert.filter((f) => f.rel in EXCECOES && f.fonte.includes('canaisDosUsuarios')).map((f) => f.rel)
    expect(obsoletas).toEqual([])
  })
})
