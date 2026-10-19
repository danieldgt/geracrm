import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ No celular o trilho de conversas vira um botão FLUTUANTE no canto
 * inferior direito. A casca reserva uma folga no fim do seu conteúdo para o
 * último botão da tela não ficar embaixo dele — mas essa folga só protege a
 * rolagem DA CASCA.
 *
 * Tela com rolagem INTERNA (coluna de kanban com altura fixa, tela que rola o
 * próprio :host) tem o seu próprio fim de lista: lá o último card ficava sob o
 * botão, sem jeito de rolar mais. Por isso a casca expõe a folga como variável
 * herdada, `--folga-flutuante` (0 fora do celular), e toda área de rolagem
 * interna de tela soma essa folga ao seu padding-bottom.
 *
 * O que conta como "área de rolagem interna": regra com overflow(-y) auto que
 * é o :host ou que cresce para ocupar a altura (flex: 1). Modal, painel e
 * dropdown (position fixed/absolute, max-height) ficam de fora: não chegam ao
 * canto da tela, ou ficam acima do botão (camadas em casca.regras.ts).
 *
 * O inbox fica de fora: no celular ele só existe dentro do trilho aberto, que
 * cobre a tela — o botão flutuante não está à vista.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FORA = new Set(['inbox.pagina.ts'])

function varrer(dir: string, achados: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { varrer(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.pagina.ts') || FORA.has(ent.name)) continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const seletor = (m[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
      const corpo = m[2] ?? ''
      if (!/overflow(-y)?:\s*auto/.test(corpo)) continue
      if (/position:\s*(fixed|absolute)|max-height/.test(corpo)) continue
      const rolaSozinha = seletor === ':host' || /(^|[;\s])flex:\s*1\b/.test(corpo)
      if (rolaSozinha && !corpo.includes('--folga-flutuante')) achados.push(`${ent.name}: '${seletor}'`)
    }
  }
  return achados
}

describe('⚠️ Rolagem interna de tela não termina embaixo do botão flutuante', () => {
  it('a casca expõe a folga como variável e a usa no próprio conteúdo', () => {
    const casca = readFileSync(resolve(raiz, 'nucleo/shell.componente.ts'), 'utf8')
    expect(casca).toMatch(/--folga-flutuante:\s*calc\(56px/)
    expect(casca).toMatch(/\.conteudo::after\s*\{[^}]*var\(--folga-flutuante\)/)
  })

  it('toda área de rolagem interna de tela soma --folga-flutuante ao fim', () => {
    const achados = varrer(raiz)
    expect(
      achados,
      'Área de rolagem interna sem a folga do botão flutuante: no celular o último\n'
      + 'item fica sob o 💬 e não há como rolar mais. Some\n'
      + 'var(--folga-flutuante, 0px) ao padding-bottom:\n' + achados.join('\n'),
    ).toEqual([])
  })
})
