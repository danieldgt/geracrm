import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ `aria-modal="true"` é uma PROMESSA, e ela precisa ser cumprida.
 *
 * Um elemento que se declara diálogo modal mas fica no fluxo da página produz
 * dois defeitos ao mesmo tempo:
 *
 *  · **Visual**: em 27/ago o painel de credenciais da tela de Integrações era um
 *    bloco no fim da página, posicionado por margin-top. Clicar em "Preencher
 *    credenciais" abria o formulário abaixo da lista, das tabelas de preço e das
 *    sincronizações — fora da vista. O usuário relatou que "o botão não
 *    funciona", e funcionava: abria onde ninguém via.
 *
 *  · **Acessibilidade**: o leitor de tela anuncia "diálogo" enquanto o foco
 *    continua atrás, na página. Quem navega por teclado fica preso no conteúdo
 *    de fundo, tentando alcançar um formulário que o software diz estar em foco.
 *
 * ⚠️ Este teste NÃO exige um modal em toda tela — exige que quem se declara
 * modal se comporte como um: sair do fluxo (`position: fixed`) e receber o foco
 * (`tabindex="-1"` no elemento, para poder focá-lo por código).
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface Achado { readonly arquivo: string; readonly falta: string }

function varrer(dir: string, achados: Achado[] = []): Achado[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { varrer(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.spec.ts')) continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    if (!src.includes('aria-modal="true"')) continue

    // A classe do elemento que carrega o aria-modal.
    for (const m of src.matchAll(/class="([\w-]+)"[^>]*aria-modal="true"|aria-modal="true"[^>]*class="([\w-]+)"/g)) {
      const classe = m[1] ?? m[2]
      if (!classe) continue
      const regra = new RegExp(`\\.${classe}\\s*\\{[^}]*\\}`, 's').exec(src)?.[0] ?? ''
      // ⚠️ Vale o PAI também: o padrão `.overlay { position: fixed }` envolvendo
      //    `.modal` está correto — o diálogo já saiu do fluxo. Exigir o fixed no
      //    próprio elemento reprovaria um modal que funciona, e um lint que
      //    grita errado é um lint que alguém desliga.
      const temPaiFixo = /\.(overlay|fundo|backdrop)\s*\{[^}]*position:\s*fixed/s.test(src)
      if (!/position:\s*fixed/.test(regra) && !temPaiFixo) {
        achados.push({ arquivo: ent.name, falta: `.${classe} sem position: fixed — fica no fluxo da página` })
      }
    }
    // E o elemento precisa ser focável por código.
    const trecho = src.slice(src.indexOf('aria-modal="true"') - 400, src.indexOf('aria-modal="true"') + 400)
    if (!trecho.includes('tabindex="-1"')) {
      achados.push({ arquivo: ent.name, falta: 'sem tabindex="-1" — não dá para levar o foco ao abrir' })
    }
  }
  return achados
}

describe('⚠️ Quem se diz modal precisa se comportar como um', () => {
  it('todo aria-modal sai do fluxo e pode receber foco', () => {
    const achados = varrer(raiz).map((a) => `${a.arquivo}: ${a.falta}`)
    expect(
      achados,
      'aria-modal="true" sem position:fixed abre o diálogo NO FIM DA PÁGINA — o\n'
      + 'usuário clica no botão e nada parece acontecer. E sem tabindex="-1" o\n'
      + 'foco não vai para lá, então o leitor de tela mente:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
