import { describe, it, expect } from 'vitest'
import { MENU, menuVisivel } from './menu.js'

describe('menu — itens de módulo opcional', () => {
  const rotas = (g: ReturnType<typeof menuVisivel>) => g.flatMap((x) => x.itens.map((i) => i.rota))

  it('a Agenda está no grupo Vendas, depois de Tarefas, e é item de módulo', () => {
    const vendas = MENU.find((g) => g.titulo === 'Vendas')!
    const r = vendas.itens.map((i) => i.rota)
    expect(r.indexOf('agenda')).toBe(r.indexOf('tarefas') + 1)
    expect(vendas.itens.find((i) => i.rota === 'agenda')).toMatchObject({ modulo: 'agenda', icone: 'calendar', status: 'pronto' })
  })
  it('módulo desligado (ou ausente) esconde o item; ligado mostra', () => {
    expect(rotas(menuVisivel(MENU, { agenda: false }))).not.toContain('agenda')
    expect(rotas(menuVisivel(MENU, {}))).not.toContain('agenda')
    expect(rotas(menuVisivel(MENU, { agenda: true }))).toContain('agenda')
  })
  it('não mexe nos itens sem módulo e não deixa grupo vazio', () => {
    const sem = rotas(menuVisivel(MENU, { agenda: false }))
    expect(sem).toContain('tarefas')
    expect(menuVisivel(MENU, { agenda: false }).every((g) => g.itens.length > 0)).toBe(true)
  })
})
