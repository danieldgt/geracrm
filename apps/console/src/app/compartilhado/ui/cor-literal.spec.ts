import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Lint anti-cor-literal (R-12). ⚠️ A biblioteca de componentes (bloco 1) NÃO
 * pode ter `#hex`: cor vem SÓ de token. É o mecanismo nº 1 da biblioteca — sem
 * ele, a primeira tela inventa uma cor e a segunda copia.
 *
 * Escopo atual: a biblioteca `compartilhado/ui`. Estender para o console
 * inteiro depois que as telas migrarem para os componentes (ver docs/onde-estamos.md).
 */
const HEX = /#[0-9a-fA-F]{3,8}\b/g
const aqui = dirname(fileURLToPath(import.meta.url))

function coresLiterais(dir: string): string[] {
  const achados: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { achados.push(...coresLiterais(resolve(dir, ent.name))); continue }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.test.ts')) continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    src.split('\n').forEach((linha: string, i: number) => {
      // Ignora linhas marcadas como exceção consciente.
      if (linha.includes('cor-literal-ok')) return
      const m = linha.match(HEX)
      if (m) achados.push(`${ent.name}:${i + 1}: ${m.join(' ')}`)
    })
  }
  return achados
}

describe('R-12: biblioteca de componentes sem cor literal', () => {
  it('nenhum #hex em compartilhado/ui — cor só de token', () => {
    const achados = coresLiterais(aqui)
    expect(achados, `cores literais na biblioteca:\n${achados.join('\n')}`).toEqual([])
  })
})
