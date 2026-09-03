import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ Card dentro de coluna rolável PRECISA de `flex: none`.
 *
 * A coluna do kanban é `display: flex; flex-direction: column; overflow-y: auto`.
 * Num flex container, o `flex-shrink` padrão é **1**: se o conteúdo não cabe, o
 * navegador ESMAGA os filhos até caberem em vez de transbordar — e como nada
 * transborda, o `overflow-y` nunca vira rolagem. O resultado não é um erro: é
 * uma coluna de listras.
 *
 * ⚠️ Em 2026-09-03 a tela de CRM (Leads) chegou assim ao usuário: 50 cards de
 * **10px** de altura na coluna, sem rolagem, com o print mostrando um bloco
 * riscado onde deveriam estar os leads. As outras duas telas de kanban (Funil e
 * Painel de Atendimentos) estavam idênticas — só não reclamavam porque tinham
 * poucos cards, esperando dado para quebrar.
 *
 * É primo do `altura-de-tela.spec.ts`: mesmo sintoma (card espremido), causa
 * diferente (lá a altura do host, aqui o encolhimento do filho).
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Extrai `seletor { ... }` de um bloco de estilos. */
function regras(css: string): { seletor: string; corpo: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    seletor: m[1]!.trim().split('\n').pop()!.trim(),
    corpo: m[2]!,
  }))
}

function estilosDe(src: string): string {
  const i = src.indexOf('styles: `')
  if (i < 0) return ''
  const j = src.indexOf('`,', i + 9)
  return src.slice(i + 9, j < 0 ? undefined : j)
}

function achar(dir: string, achados: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { achar(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.pagina.ts')) continue
    const css = estilosDe(readFileSync(resolve(dir, ent.name), 'utf8'))
    if (!css) continue
    const rs = regras(css)

    // Container rolável EM COLUNA: é onde o encolhimento acontece.
    const temColunaRolavel = rs.some((r) =>
      /overflow-y:\s*auto/.test(r.corpo) && /flex-direction:\s*column/.test(r.corpo))
    if (!temColunaRolavel) continue

    // O item é `.card` por convenção nas três telas de kanban do console.
    const card = rs.find((r) => r.seletor === '.card')
    if (!card) continue
    if (!/flex:\s*none/.test(card.corpo) && !/flex-shrink:\s*0/.test(card.corpo)) {
      achados.push(`${ent.name}: '.card' sem 'flex: none' dentro de coluna rolável — vai esmagar`)
    }
  }
  return achados
}

describe('⚠️ Card em coluna rolável não pode encolher', () => {
  it('toda tela com coluna rolável declara flex: none no card', () => {
    const achados = achar(raiz)
    expect(
      achados,
      'Num flex column com overflow-y, o flex-shrink padrão (1) esmaga os cards\n'
      + 'até caberem — a rolagem nunca dispara e a coluna vira listras de 10px.\n'
      + 'Foi o defeito visto pelo usuário no CRM (Leads) em 03/set:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
