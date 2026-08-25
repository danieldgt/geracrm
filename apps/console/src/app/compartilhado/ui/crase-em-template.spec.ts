import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ A ARMADILHA DAS CRASES — mordeu TRÊS vezes neste repositório.
 *
 * `template:` e `styles:` são template literals. Uma crase dentro de um
 * comentário HTML (`<!-- … -->`) ou CSS (`/* … *\/`) FECHA o literal ali, e o
 * erro que aparece é `NG1002: Incorrect number of arguments to @Component
 * decorator` — que não menciona crase, nem comentário, nem a linha certa. Quem
 * pega o erro procura o defeito no decorador.
 *
 * O compilador já reprova; este teste existe para dizer ONDE e POR QUÊ, em
 * segundos, em vez de mandar alguém caçar. Mesmo espírito do lint anti-cor-literal.
 *
 * ⚠️ JSDoc (`/** … *\/`) fica de fora de propósito: ele vive FORA do template
 * literal, e ali crase é a forma correta de citar código.
 */
const COMENTARIO_HTML = /<!--[\s\S]*?-->/g
/** CSS/bloco comum — exclui JSDoc, que começa com duas estrelas. */
const COMENTARIO_BLOCO = /\/\*(?!\*)[\s\S]*?\*\//g

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function crasesEmComentario(dir: string): string[] {
  const achados: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { achados.push(...crasesEmComentario(resolve(dir, ent.name))); continue }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.spec.ts')) continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    // ⚠️ Comentário HTML só existe dentro de template — varre o arquivo todo.
    //    Já `/* */` aparece em atributo (`image/*`) e dentro de JSDoc, então só
    //    vale a partir de `styles:`, que é onde o CSS começa. Lint que grita
    //    errado é lint que alguém desliga.
    const regioes: [RegExp, string][] = [[COMENTARIO_HTML, src]]
    const iStyles = src.indexOf('styles:')
    if (iStyles >= 0) regioes.push([COMENTARIO_BLOCO, src.slice(iStyles)])

    for (const [re, regiao] of regioes) {
      for (const bloco of regiao.match(re) ?? []) {
        if (bloco.includes('`')) {
          const linha = src.slice(0, src.indexOf(bloco)).split('\n').length
          achados.push(`${ent.name}:${linha}: crase dentro de comentário — ${bloco.slice(0, 60).replace(/\n/g, ' ')}…`)
        }
      }
    }
  }
  return achados
}

describe('⚠️ Crase em comentário dentro de template literal', () => {
  it('nenhum comentário HTML/CSS do console contém crase', () => {
    const achados = crasesEmComentario(raiz)
    expect(
      achados,
      'Crase dentro de comentário FECHA o template literal do componente. O erro\n'
      + 'que aparece é NG1002 no @Component, longe da causa. Troque por aspas ou\n'
      + 'escreva sem marcação:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
