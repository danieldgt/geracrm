import { describe, it, expect, vi, afterEach } from 'vitest'
import { ICONES } from './icones-lucide.js'
import { atributosDeAcessibilidade, marcacaoDoIcone } from './icone.regras.js'
import { itensDoMenu } from '../../nucleo/menu.js'

/**
 * Sem TestBed (o ambiente de teste do console é node). A regra do componente
 * mora em `icone.regras.ts`; o template só cola os atributos. Por isso o teste
 * confere os atributos que o template recebe, não o DOM.
 */

afterEach(() => vi.restoreAllMocks())

describe('ui-icone — atributos de acessibilidade', () => {
  it('sem rótulo: decorativo, escondido do leitor de tela (aria-hidden="true")', () => {
    const a = atributosDeAcessibilidade(undefined)
    expect(a['aria-hidden']).toBe('true')
    expect(a.role).toBeNull()
    expect(a['aria-label']).toBeNull()
  })

  it('com rótulo: role="img" e aria-label, sem aria-hidden', () => {
    const a = atributosDeAcessibilidade('Conversas')
    expect(a.role).toBe('img')
    expect(a['aria-label']).toBe('Conversas')
    expect(a['aria-hidden']).toBeNull()
  })

  it('rótulo vazio conta como sem rótulo', () => {
    expect(atributosDeAcessibilidade('')['aria-hidden']).toBe('true')
  })
})

describe('ui-icone — marcação', () => {
  it('nome conhecido devolve o desenho do mapa', () => {
    const m = marcacaoDoIcone('house')
    expect(m.conhecido).toBe(true)
    expect(m.markup).toBe(ICONES['house'])
  })

  it('nome desconhecido desenha o círculo de reserva e avisa no console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = marcacaoDoIcone('nome-que-nao-existe-xyz')
    expect(m.conhecido).toBe(false)
    expect(m.markup).toBe('<circle cx="12" cy="12" r="10"/>')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('o aviso sai uma vez por nome, mesmo que o nome se repita', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    marcacaoDoIcone('repetido-zz')
    marcacaoDoIcone('repetido-zz')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('nome herdado do Object.prototype NÃO é tratado como ícone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = marcacaoDoIcone('constructor')
    expect(m.conhecido).toBe(false)
    expect(typeof m.markup).toBe('string')
  })
})

describe('ICONES — o mapa Lucide', () => {
  it('todo desenho usa só elementos SVG permitidos (sem script, sem atributo de evento)', () => {
    const permitidos = new Set(['path', 'circle', 'rect', 'line', 'polyline'])
    for (const [nome, markup] of Object.entries(ICONES)) {
      const elementos = [...markup.matchAll(/<([a-z]+)\b/g)].map((m) => m[1])
      expect(elementos.length, `${nome} sem elementos`).toBeGreaterThan(0)
      for (const el of elementos) expect(permitidos.has(el!), `${nome}: <${el}>`).toBe(true)
      expect(/\son[a-z]+=/i.test(markup), `${nome}: atributo de evento`).toBe(false)
    }
  })
})

describe('menu — todo ícone do menu existe no mapa', () => {
  it('cada item de itensDoMenu() tem um nome presente em ICONES', () => {
    const faltando = itensDoMenu()
      .filter((item) => !Object.hasOwn(ICONES, item.icone))
      .map((item) => `${item.rota} → "${item.icone}"`)
    expect(faltando, `ícones do menu sem desenho:\n${faltando.join('\n')}`).toEqual([])
  })
})
