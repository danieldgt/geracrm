import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { EstadoBuscaPaginada, moverAtivo, rotuloDoValor, type PaginaOpcoes } from './select-paginado.estado.js'

const pagina = (n: number, temMais: boolean): PaginaOpcoes => ({
  itens: [{ valor: `v${n}a`, rotulo: `Item ${n}a` }, { valor: `v${n}b`, rotulo: `Item ${n}b` }],
  proximoCursor: temMais ? `c${n + 1}` : null,
})
const numDoCursor = (c: string | null): number => (c === null ? 1 : Number(c.slice(1)))

describe('EstadoBuscaPaginada', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('debounce: várias teclas viram UMA chamada, 300 ms depois da última', async () => {
    const carregar = vi.fn(async (_c: string | null, _t: string) => pagina(1, false))
    const e = new EstadoBuscaPaginada(() => carregar)
    e.digitar('a'); e.digitar('ab'); e.digitar('abc')
    await vi.advanceTimersByTimeAsync(299)
    expect(carregar).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(carregar).toHaveBeenCalledTimes(1)
    expect(carregar).toHaveBeenCalledWith(null, 'abc')
    expect(e.itens()).toHaveLength(2)
  })

  it('próxima página acrescenta; sem temMais não chama de novo', async () => {
    const carregar = vi.fn(async (c: string | null, _t: string) => pagina(numDoCursor(c), numDoCursor(c) < 2))
    const e = new EstadoBuscaPaginada(() => carregar)
    await e.iniciar('')
    expect(e.temMais()).toBe(true)
    await e.proximaPagina()
    expect(carregar).toHaveBeenLastCalledWith('c2', '')
    expect(e.itens().map((o) => o.valor)).toEqual(['v1a', 'v1b', 'v2a', 'v2b'])
    expect(e.temMais()).toBe(false)
    await e.proximaPagina()
    expect(carregar).toHaveBeenCalledTimes(2)
  })

  it('resposta atrasada de busca antiga não sobrescreve a nova', async () => {
    let soltarVelha: (p: PaginaOpcoes) => void = () => undefined
    const carregar = vi.fn((_c: string | null, t: string) =>
      t === 'velha' ? new Promise<PaginaOpcoes>((r) => { soltarVelha = r }) : Promise.resolve(pagina(9, false)))
    const e = new EstadoBuscaPaginada(() => carregar)
    const velha = e.iniciar('velha')
    await e.iniciar('nova')
    soltarVelha(pagina(1, true))
    await velha
    expect(e.itens().map((o) => o.valor)).toEqual(['v9a', 'v9b'])
    expect(e.temMais()).toBe(false)
  })

  it('falha em página seguinte mantém temMais e a nova tentativa retoma do mesmo cursor', async () => {
    let falhar = false
    const carregar = vi.fn(async (c: string | null, _t: string) => {
      if (falhar && c !== null) throw new Error('rede')
      return pagina(numDoCursor(c), numDoCursor(c) < 3)
    })
    const e = new EstadoBuscaPaginada(() => carregar)
    await e.iniciar('')
    falhar = true
    await e.proximaPagina()
    expect(e.falhou()).toBe(true)
    expect(e.temMais()).toBe(true)
    expect(e.itens()).toHaveLength(2)
    await e.proximaPagina()
    expect(carregar).toHaveBeenCalledTimes(2) // não repete sozinho
    falhar = false
    await e.tentarNovamente()
    expect(carregar).toHaveBeenLastCalledWith('c2', '')
    expect(e.falhou()).toBe(false)
    expect(e.itens()).toHaveLength(4)
  })

  it('falha na primeira página zera temMais', async () => {
    const e = new EstadoBuscaPaginada(() => async () => { throw new Error('x') })
    await e.iniciar('')
    expect(e.temMais()).toBe(false)
  })

  it('falha vira estado, não exceção', async () => {
    const e = new EstadoBuscaPaginada(() => async () => { throw new Error('x') })
    await e.iniciar('')
    expect(e.falhou()).toBe(true)
    expect(e.carregando()).toBe(false)
  })
})

describe('teclado e opcaoInjetada', () => {
  it('setas ficam nos limites', () => {
    expect(moverAtivo(-1, 3, 'ArrowDown')).toBe(0)
    expect(moverAtivo(2, 3, 'ArrowDown')).toBe(2)
    expect(moverAtivo(0, 3, 'ArrowUp')).toBe(0)
    expect(moverAtivo(2, 3, 'ArrowUp')).toBe(1)
    expect(moverAtivo(0, 0, 'ArrowDown')).toBe(-1)
  })

  it('opcaoInjetada dá o rótulo do valor salvo; a lista carregada tem precedência', () => {
    const inj = { valor: 'x1', rotulo: 'Cliente Salvo' }
    expect(rotuloDoValor('x1', [], inj)).toBe('Cliente Salvo')
    expect(rotuloDoValor('x1', [{ valor: 'x1', rotulo: 'Da lista' }], inj)).toBe('Da lista')
    expect(rotuloDoValor('outro', [], inj)).toBe('')
    expect(rotuloDoValor(null, [], inj)).toBe('')
  })
})
