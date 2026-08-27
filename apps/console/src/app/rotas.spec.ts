import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MENU } from './nucleo/menu.js'

/**
 * ⚠️ A ARMADILHA DO `status`: ele não é um rótulo, é um DESVIO.
 *
 *     if (item.status === 'pronto' && real) { ...a tela real... }
 *     return { ...EmConstrucaoPagina }
 *
 * Uma tela pode estar escrita, testada, registrada em `TELAS_REAIS` e no ar — e
 * mesmo assim o usuário ver "em construção", porque alguém marcou o item do menu
 * como `construcao` achando que era só um aviso sobre o roadmap. Foi o que
 * aconteceu com o Agente SDR em 26/08: a tela existia e ninguém conseguia abrir.
 *
 * ⚠️ Não há erro, não há log, não há teste que quebre. O sintoma é uma pessoa
 * dizendo "não achei o menu" — e o tempo até alguém desconfiar do `status`.
 */
const itens = MENU.flatMap((g) => g.itens)

/**
 * ⚠️ Lido como TEXTO, não importado: `rotas.ts` arrasta o Router do Angular, que
 * exige compilador JIT no ambiente de teste. Ler o arquivo é o mesmo caminho dos
 * outros lints desta casa (cor literal, crase em template).
 */
function telasRegistradas(): readonly string[] {
  const caminho = resolve(dirname(fileURLToPath(import.meta.url)), 'rotas.ts')
  const texto = readFileSync(caminho, 'utf8')
  const bloco = texto.slice(texto.indexOf('TELAS_REAIS'), texto.indexOf('export const ROTAS'))
  return [...bloco.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]!)
}
const TELAS = telasRegistradas()

describe('⚠️ Tela real não pode ficar escondida atrás do placeholder', () => {
  it('todo item com tela registrada está marcado como pronto', () => {
    const escondidas = TELAS
      .map((rota) => itens.find((i) => i.rota === rota))
      .filter((i) => i && i.status !== 'pronto')
      .map((i) => `${i!.rota} (${i!.rotulo}) está como '${i!.status}'`)

    expect(
      escondidas,
      'Estas telas EXISTEM e o usuário vê "em construção" no lugar delas.\n'
      + 'O campo status decide qual componente a rota carrega — marque como\n'
      + "'pronto' quando a tela existir, mesmo que a funcionalidade siga evoluindo:\n"
      + escondidas.join('\n'),
    ).toEqual([])
  })

  it('todo item marcado pronto tem tela registrada (ou é rail)', () => {
    const prometidas = itens
      .filter((i) => i.status === 'pronto' && i.acao !== 'rail' && !TELAS.includes(i.rota))
      .map((i) => `${i.rota} (${i.rotulo})`)
    expect(prometidas, 'Marcadas como prontas, mas sem tela — caem no placebo:\n' + prometidas.join('\n'))
      .toEqual([])
  })
})
