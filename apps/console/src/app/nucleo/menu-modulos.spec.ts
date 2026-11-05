import { describe, it, expect } from 'vitest'
import { MENU, menuVisivel } from './menu.js'

const rotas = (g: ReturnType<typeof menuVisivel>) => g.flatMap((x) => x.itens.map((i) => i.rota))

describe('menu — Agenda e tarefas', () => {
  it('fica no grupo Vendas, com Tarefas como primeira aba e o Calendário como aba de módulo', () => {
    const vendas = MENU.find((g) => g.titulo === 'Vendas')!
    const item = vendas.itens.find((i) => i.rota === 'agenda-e-tarefas')!
    expect(item.abas?.[0]).toMatchObject({ rota: 'lista' })
    expect(item.abas?.find((a) => a.rota === 'calendario')).toMatchObject({ modulo: 'agenda' })
  })
  it('a entrada não some com o módulo desligado (as tarefas continuam)', () => {
    expect(rotas(menuVisivel(MENU, { agenda: false }))).toContain('agenda-e-tarefas')
    expect(menuVisivel(MENU, { agenda: false }).every((g) => g.itens.length > 0)).toBe(true)
  })
})

describe('menu — Cockpit só para a gestão', () => {
  it('é o primeiro item do grupo Gestão, pronto, com o ícone de gráfico', () => {
    const gestao = MENU.find((g) => g.titulo === 'Gestão')!
    expect(gestao.itens[0]).toMatchObject({ rota: 'cockpit', icone: 'bar-chart-3', status: 'pronto', soGestao: true })
  })
  it('some para quem não é gestão e aparece para a gestão', () => {
    expect(rotas(menuVisivel(MENU, {}))).not.toContain('cockpit')
    expect(rotas(menuVisivel(MENU, {}, false))).not.toContain('cockpit')
    expect(rotas(menuVisivel(MENU, {}, true))).toContain('cockpit')
  })
})
