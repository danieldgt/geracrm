import { describe, it, expect } from 'vitest'
import { MENU, ROTAS_ANTIGAS, abasVisiveis, menuVisivel } from './menu.js'

const itens = MENU.flatMap((g) => g.itens)
const rotasDoMenu = new Set(itens.map((i) => i.rota))

/** `/base/rfv?x=1` → item `base` e aba `rfv`. */
function destino(url: string): { item: string; aba: string | undefined } {
  const [caminho] = url.split('?')
  const [item, aba] = caminho!.replace(/^\//, '').split('/')
  return { item: item!, aba }
}

describe('menu reorganizado (docs/plano-reorganizacao-console.md)', () => {
  it('cabe numa tela: no máximo 22 entradas para quem é gestão, staff incluso', () => {
    const visiveis = menuVisivel(MENU, { agenda: true }, true).flatMap((g) => g.itens)
    expect(visiveis.length).toBeLessThanOrEqual(22)
  })

  it('nenhuma rota antiga continua no menu (senão o redirect esconderia a tela)', () => {
    const conflito = Object.keys(ROTAS_ANTIGAS).filter((r) => rotasDoMenu.has(r))
    expect(conflito).toEqual([])
  })

  it('todo redirect cai num item do menu e, quando aponta aba, numa aba que existe', () => {
    const quebrados = Object.entries(ROTAS_ANTIGAS).filter(([, para]) => {
      const { item, aba } = destino(para)
      const alvo = itens.find((i) => i.rota === item)
      if (!alvo) return true
      if (aba && !alvo.abas?.some((a) => a.rota === aba)) return true
      return false
    })
    expect(quebrados.map(([de, para]) => `${de} → ${para}`)).toEqual([])
  })

  it('rotas de aba são únicas dentro do item', () => {
    for (const i of itens) {
      const r = (i.abas ?? []).map((a) => a.rota)
      expect(new Set(r).size, i.rota).toBe(r.length)
    }
  })
})

describe('abas visíveis', () => {
  const agenda = itens.find((i) => i.rota === 'agenda-e-tarefas')!
  const config = itens.find((i) => i.rota === 'config')!

  it('o Calendário só aparece com o módulo Agenda ligado', () => {
    expect(abasVisiveis(agenda, {}).map((a) => a.rota)).toEqual(['lista'])
    expect(abasVisiveis(agenda, { agenda: true }).map((a) => a.rota)).toEqual(['lista', 'calendario'])
  })

  it('Importar (em Configurações) só aparece para a gestão', () => {
    expect(abasVisiveis(config, {}, false).map((a) => a.rota)).not.toContain('importar')
    expect(abasVisiveis(config, {}, true).map((a) => a.rota)).toContain('importar')
  })
})
