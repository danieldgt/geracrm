import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ A ARMADILHA DAS CRASES, DO LADO DA API — a mesma que já mordeu no console
 * três vezes, e que mordeu aqui na quarta.
 *
 * Toda consulta deste projeto vive num template literal (`tx` + crases). Uma
 * crase dentro de um comentário SQL (`-- … `assim` …`) FECHA o literal ali, e o
 * erro que aparece é do parser, apontando para um ponto qualquer depois:
 *
 *     ERROR: Expected ")" but found "roteamento"
 *
 * Nada nele menciona crase, comentário ou a linha certa. Este teste diz onde.
 *
 * ⚠️ O escopo é `-- ` no começo da linha: comentário SQL só existe dentro de
 * consulta. JSDoc e `//` ficam de fora — ali crase é a forma certa de citar
 * código, e um lint que grita errado é um lint que alguém desliga.
 */
const COMENTARIO_SQL = /^\s*--.*`/
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function crasesEmSql(dir: string): string[] {
  const achados: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { achados.push(...crasesEmSql(resolve(dir, ent.name))); continue }
    if (!ent.name.endsWith('.ts')) continue
    const caminho = resolve(dir, ent.name)
    readFileSync(caminho, 'utf8').split('\n').forEach((linha, i) => {
      if (COMENTARIO_SQL.test(linha)) achados.push(`${ent.name}:${i + 1}: ${linha.trim().slice(0, 70)}`)
    })
  }
  return achados
}

describe('⚠️ Crase em comentário SQL', () => {
  it('nenhum comentário SQL da API contém crase', () => {
    const achados = crasesEmSql(raiz)
    expect(
      achados,
      'Crase dentro de comentário SQL FECHA o template literal da consulta. O erro\n'
      + 'que aparece é do parser, longe da causa e sem mencionar crase.\n'
      + 'Escreva o nome sem marcação:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
