import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ `height: 100%` no `:host` de uma tela do console NÃO FUNCIONA — e falha em
 * silêncio, que é o pior jeito de falhar.
 *
 * A casca (`shell.componente.ts`) coloca cada tela numa CÉLULA DE GRID com
 * `overflow-y: auto`. Célula de grid não resolve altura percentual do filho:
 * o `100%` vira zero. Numa tela de kanban isso derruba tudo — o board com
 * `flex: 1` colapsa e cada card espreme para 1px de altura.
 *
 * ⚠️ Em 2026-08-27 a tela de CRM (Leads) com 813 cards virou um monte de listras
 * cinza. Não havia erro no console, nem teste vermelho: só o usuário dizendo
 * "não consigo ver nada". As outras TRÊS telas com a mesma regra não reclamavam
 * porque tinham poucos cards — estavam quebradas do mesmo jeito, esperando dado.
 *
 * O caminho certo é `min-height: 100dvh`, que não depende do pai.
 *
 * ⚠️ Este teste também pega o `display` DUPLICADO na mesma regra, que era o outro
 * lado do defeito: `display: block` seguido de `display: flex` na mesma linha.
 * O segundo vence, e quem lê a primeira metade entende errado.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function achar(dir: string, achados: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { achar(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.pagina.ts')) continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')

    for (const regra of src.match(/:host\s*\{[^}]*\}/g) ?? []) {
      if (/height:\s*100%/.test(regra)) {
        achados.push(`${ent.name}: ':host' com height 100% — use min-height: 100dvh`)
      }
      if ((regra.match(/(?:^|[;{\s])display\s*:/g) ?? []).length > 1) {
        achados.push(`${ent.name}: ':host' declara 'display' duas vezes — a segunda vence calada`)
      }
    }
  }
  return achados
}

describe('⚠️ Altura de tela na casca do console', () => {
  it('nenhuma tela depende de height: 100% no :host', () => {
    const achados = achar(raiz)
    expect(
      achados,
      'A casca põe a tela numa célula de grid, que não resolve altura percentual\n'
      + 'do filho: o 100% vira zero e o layout colapsa SEM ERRO NENHUM.\n'
      + 'Use min-height: 100dvh:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
