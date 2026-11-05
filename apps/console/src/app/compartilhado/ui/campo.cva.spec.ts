import '@angular/compiler'
import { describe, it, expect, vi } from 'vitest'
import { Injector, runInInjectionContext, ɵSIGNAL as SIGNAL } from '@angular/core'
import { CampoComponente } from './campo.componente.js'
import { SelectComponente } from './select.componente.js'
import { SelectPaginadoComponente } from './select-paginado.componente.js'

/**
 * CVA sem DOM: instancia a classe em contexto de injeção e fala com ela como o
 * Reactive Forms falaria (writeValue / registerOnChange). O render é coberto
 * pela tipagem do template no build (typecheck).
 */
const criar = <T>(Classe: new () => T): T => runInInjectionContext(Injector.create({ providers: [] }), () => new Classe())

describe('ui-campo como ControlValueAccessor', () => {
  it('writeValue reflete no texto exibido e o modelo legado continua valendo', () => {
    const c = criar(CampoComponente)
    c.writeValue('Ana')
    expect(c.valor()).toBe('Ana')
    c.writeValue(null)
    expect(c.valor()).toBe('')
  })

  it('com máscara, o [valor] em dígitos crus (formulário pré-preenchido) aparece formatado', () => {
    const c = criar(CampoComponente)
    const no = (c.mascara as unknown as Record<symbol, { applyValueToInputSignal: (n: unknown, v: unknown) => void }>)[SIGNAL]!
    no.applyValueToInputSignal(no, 'cnpj')
    c.valor.set('11222333000181')
    expect((c as unknown as { exibido: () => string }).exibido()).toBe('11.222.333/0001-81')
    c.valor.set('11.222.333/0001-81')
    expect((c as unknown as { exibido: () => string }).exibido()).toBe('11.222.333/0001-81')
  })

  it('digitar avisa o controle e atualiza o model (uso [(valor)])', () => {
    const c = criar(CampoComponente)
    const aoMudar = vi.fn()
    const emitido = vi.fn()
    c.registerOnChange(aoMudar)
    c.valor.subscribe(emitido)
    ;(c as unknown as { digitou(t: string): void }).digitou('Bia')
    expect(aoMudar).toHaveBeenCalledWith('Bia')
    expect(emitido).toHaveBeenCalledWith('Bia')
  })

  it('setDisabledState desabilita sem depender do input', () => {
    const c = criar(CampoComponente)
    c.setDisabledState(true)
    expect((c as unknown as { desabilitadoEfetivo(): boolean }).desabilitadoEfetivo()).toBe(true)
  })
})

describe('ui-select e ui-select-paginado como CVA', () => {
  it('select: valor vazio vira null no controle', () => {
    const s = criar(SelectComponente)
    const aoMudar = vi.fn()
    s.registerOnChange(aoMudar)
    ;(s as unknown as { escolheu(v: string): void }).escolheu('a')
    ;(s as unknown as { escolheu(v: string): void }).escolheu('')
    expect(aoMudar.mock.calls).toEqual([['a'], [null]])
    s.writeValue('b')
    expect(s.valor()).toBe('b')
  })

  it('select-paginado: escolher grava o valor e writeValue troca', () => {
    const s = criar(SelectPaginadoComponente)
    const aoMudar = vi.fn()
    s.registerOnChange(aoMudar)
    ;(s as unknown as { escolher(o: { valor: string; rotulo: string }): void }).escolher({ valor: 'x', rotulo: 'X' })
    expect(aoMudar).toHaveBeenCalledWith('x')
    expect(s.valor()).toBe('x')
    s.writeValue(null)
    expect(s.valor()).toBeNull()
  })
})
