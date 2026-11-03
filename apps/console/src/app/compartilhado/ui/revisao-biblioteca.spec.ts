// @vitest-environment jsdom
import '@angular/compiler'
import { describe, it, expect, vi } from 'vitest'
import { Injector, runInInjectionContext } from '@angular/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SelectPaginadoComponente } from './select-paginado.componente.js'
import { CampoComponente } from './campo.componente.js'
import { FiltrosComponente } from './filtros.componente.js'
import { FiltroPeriodoComponente } from './filtro-periodo.componente.js'
import { ModalComponente } from './modal.componente.js'
import { TabelaComponente } from './tabela.componente.js'
import { periodoInvertido } from './periodo.js'
import { abaFocada, seletorDaAba } from './abas.regras.js'
import { chavePadraoDaLinha, podarSelecao, rotuloSelecaoDaLinha } from './lista.regras.js'

/** Regressões da revisão adversarial da biblioteca de componentes. */
const criar = <T>(Classe: new () => T): T => runInInjectionContext(Injector.create({ providers: [] }), () => new Classe())
const aqui = dirname(fileURLToPath(import.meta.url))
const fonte = (nome: string): string => readFileSync(resolve(aqui, nome), 'utf8')
type Aberto = { [k: string]: (...a: unknown[]) => unknown }
const interno = (c: unknown): Aberto => c as Aberto

const tecla = (key: string) => ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() })

describe('select paginado (teclado e foco)', () => {
  function aberto(): SelectPaginadoComponente {
    const s = criar(SelectPaginadoComponente)
    ;(s as unknown as { aberto: { set(v: boolean): void } }).aberto.set(true)
    return s
  }
  const estaAberto = (s: SelectPaginadoComponente): boolean => (s as unknown as { aberto(): boolean }).aberto()

  it('Esc com a lista aberta fecha a lista e NÃO propaga (não fecha o ui-modal pai)', () => {
    const s = aberto()
    const e = tecla('Escape')
    interno(s)['teclou']?.(e)
    expect(estaAberto(s)).toBe(false)
    expect(e.stopPropagation).toHaveBeenCalled()
  })

  it('Esc com a lista fechada propaga (o modal pode fechar)', () => {
    const s = criar(SelectPaginadoComponente)
    const e = tecla('Escape')
    interno(s)['teclou']?.(e)
    expect(e.stopPropagation).not.toHaveBeenCalled()
  })

  it('blur com o foco indo para fora da âncora (Tab) fecha a lista', () => {
    document.body.innerHTML = '<div class="ancora"><input id="i"></div><button id="fora"></button>'
    const s = aberto()
    interno(s)['aoSairFoco']?.({
      currentTarget: document.getElementById('i'), relatedTarget: document.getElementById('fora'),
    })
    expect(estaAberto(s)).toBe(false)
  })

  it('blur com o foco ficando dentro da âncora não fecha', () => {
    document.body.innerHTML = '<div class="ancora"><input id="i"><button id="dentro"></button></div>'
    const s = aberto()
    interno(s)['aoSairFoco']?.({
      currentTarget: document.getElementById('i'), relatedTarget: document.getElementById('dentro'),
    })
    expect(estaAberto(s)).toBe(true)
  })

  it('digitar com a lista fechada reabre a lista', () => {
    const s = criar(SelectPaginadoComponente)
    s.registerOnChange(() => undefined)
    expect(estaAberto(s)).toBe(false)
    interno(s)['digitou']?.('ab')
    expect(estaAberto(s)).toBe(true)
    interno(s)['fechar']?.()
  })

  it('mostra "Tentar novamente" quando a página falha', () => {
    const src = fonte('select-paginado.componente.ts')
    expect(src).toContain('Tentar novamente')
    expect(src).toContain('estado.tentarNovamente()')
  })
})

describe('modal', () => {
  const veu = { }
  const novo = (): Aberto & { emitiu: ReturnType<typeof vi.fn> } => {
    const emitiu = vi.fn()
    const ctx = { comecouNoVeu: false, fechar: { emit: emitiu } }
    const proto = ModalComponente.prototype as unknown as Aberto
    return {
      emitiu,
      marcarVeu: (e) => proto['marcarVeu']!.call(ctx, e),
      soltarNoVeu: (e) => proto['soltarNoVeu']!.call(ctx, e),
    }
  }
  const ev = (alvo: object) => ({ target: alvo, currentTarget: veu })

  it('mousedown no véu + mouseup no véu fecha', () => {
    const m = novo()
    m['marcarVeu']!(ev(veu))
    m['soltarNoVeu']!(ev(veu))
    expect(m.emitiu).toHaveBeenCalledTimes(1)
  })

  it('arrastar de dentro da caixa e soltar no véu NÃO fecha', () => {
    const m = novo()
    m['marcarVeu']!(ev({}))
    m['soltarNoVeu']!(ev(veu))
    expect(m.emitiu).not.toHaveBeenCalled()
  })

  it('mousedown no véu e mouseup dentro da caixa NÃO fecha', () => {
    const m = novo()
    m['marcarVeu']!(ev(veu))
    m['soltarNoVeu']!(ev({}))
    expect(m.emitiu).not.toHaveBeenCalled()
  })

  it('Tab tratado pelo modal para a propagação', () => {
    document.body.innerHTML = '<div id="c"><button id="a">a</button><button id="b">b</button></div>'
    const caixa = document.getElementById('c')!
    document.getElementById('b')!.focus()
    const ctx = { caixa: () => ({ nativeElement: caixa }), fechar: { emit: vi.fn() } }
    const e = { key: 'Tab', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    ;(ModalComponente.prototype as unknown as Aberto)['aoTeclar']!.call(ctx, e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
})

describe('abas', () => {
  it('abaFocada lê o data-aba do elemento focado (ou de um filho)', () => {
    document.body.innerHTML = '<a data-aba="b" id="x"><span id="y">B</span></a>'
    expect(abaFocada(document.getElementById('x'))).toBe('b')
    expect(abaFocada(document.getElementById('y'))).toBe('b')
    expect(abaFocada(document.body)).toBeNull()
    expect(abaFocada(null)).toBeNull()
  })

  it('seletorDaAba escapa o id: aspas e barras não quebram o querySelector', () => {
    const id = 'a"b\\c]'
    document.body.innerHTML = ''
    const el = document.createElement('a')
    el.setAttribute('data-aba', id)
    document.body.appendChild(el)
    expect(document.querySelector(seletorDaAba(id))).toBe(el)
  })

  it('o teclado parte da aba focada, não da ativa (contrato do componente)', () => {
    const src = fonte('abas.componente.ts')
    expect(src).toContain('abaFocada(e.target')
    expect(src).toContain('seletorDaAba(prox)')
    expect(src).toContain('idPainel')
  })
})

describe('tabela e seleção em lote', () => {
  it('podarSelecao tira o que não está visível e preserva a referência quando nada sai', () => {
    const sel = new Set(['a', 'x'])
    expect([...podarSelecao(sel, ['a', 'b'])]).toEqual(['a'])
    const igual = new Set(['a'])
    expect(podarSelecao(igual, ['a', 'b'])).toBe(igual)
    expect(podarSelecao(new Set(), ['a']).size).toBe(0)
  })

  it('chave padrão lança erro claro em dev quando a linha não tem id', () => {
    expect(() => chavePadraoDaLinha({ nome: 'x' })).toThrow(/sem "id"/)
    expect(chavePadraoDaLinha({ id: 7 })).toBe('7')
    expect(chavePadraoDaLinha({ id: 0 })).toBe('0')
  })

  it('rótulo do checkbox: da linha, ou "Selecionar linha N"', () => {
    expect(rotuloSelecaoDaLinha('Ana Souza', 0)).toBe('Selecionar Ana Souza')
    expect(rotuloSelecaoDaLinha(undefined, 2)).toBe('Selecionar linha 3')
    expect(rotuloSelecaoDaLinha('  ', 0)).toBe('Selecionar linha 1')
  })

  it('o checkbox usa o rótulo da linha (rotuloLinha) e cai em "Selecionar linha N"', () => {
    const proto = TabelaComponente.prototype as unknown as { rotuloCheckbox(l: object, i: number): string }
    const sem = { rotuloLinha: () => null }
    const com = { rotuloLinha: () => (l: { nome: string }) => l.nome }
    expect(proto.rotuloCheckbox.call(sem, { id: '1' }, 0)).toBe('Selecionar linha 1')
    expect(proto.rotuloCheckbox.call(com, { nome: 'Ana' }, 0)).toBe('Selecionar Ana')
    expect(fonte('tabela.componente.ts')).toContain('readonly rotuloLinha')
  })

  it('o efeito de poda existe e não roda enquanto carregando', () => {
    const src = fonte('tabela.componente.ts')
    expect(src).toContain('podarSelecao(atual, chaves)')
    expect(src).toMatch(/if \(this\.carregando\(\)\) return/)
  })
})

describe('filtros', () => {
  it('campo de busca com rótulo visível não repete aria-label (WCAG 2.5.3)', () => {
    expect(fonte('filtros.componente.ts')).not.toContain('aria-label')
  })

  it('submit emite só aplicar; buscar sai pelo debounce e, se pendente, uma única vez', () => {
    vi.useFakeTimers()
    const f = criar(FiltrosComponente)
    const buscar = vi.fn()
    const aplicar = vi.fn()
    f.buscar.subscribe(buscar)
    f.aplicar.subscribe(aplicar)
    // sem digitação: submit só aplica
    interno(f)['enviar']!()
    expect(buscar).not.toHaveBeenCalled()
    expect(aplicar).toHaveBeenCalledTimes(1)
    // digitou e deu Enter antes do debounce: o texto vai UMA vez
    interno(f)['digitou']!({ target: { value: 'ana' } })
    interno(f)['enviar']!()
    vi.advanceTimersByTime(1000)
    expect(buscar).toHaveBeenCalledTimes(1)
    expect(buscar).toHaveBeenCalledWith('ana')
    // digitou, debounce entregou, Enter: não duplica
    interno(f)['digitou']!({ target: { value: 'ana b' } })
    vi.advanceTimersByTime(300)
    interno(f)['enviar']!()
    expect(buscar).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('filtro de período', () => {
  it('início depois do fim é inválido; vazio e igual não são', () => {
    expect(periodoInvertido('2026-02-10', '2026-02-01')).toBe(true)
    expect(periodoInvertido('2026-02-01', '2026-02-01')).toBe(false)
    expect(periodoInvertido('', '2026-02-01')).toBe(false)
  })

  it('o componente marca invertido e o template desabilita Aplicar', () => {
    const p = criar(FiltroPeriodoComponente)
    const invertido = (): boolean => (p as unknown as { invertido(): boolean }).invertido()
    p.inicio.set('2026-03-10')
    p.fim.set('2026-03-01')
    expect(invertido()).toBe(true)
    p.fim.set('2026-03-20')
    expect(invertido()).toBe(false)
    expect(fonte('filtro-periodo.componente.ts')).toContain('[disabled]="invertido()"')
  })
})

describe('campo: dinheiro negativo e máscara', () => {
  it('writeValue com negativo vira vazio e avisa em dev', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const c = criar(CampoComponente)
    ;(c as unknown as { tipo: () => string }).tipo = () => 'dinheiro'
    c.writeValue(-1500)
    expect(c.valor()).toBe('')
    expect(aviso).toHaveBeenCalled()
    c.writeValue(1500)
    expect(c.valor()).toBe('15,00')
    aviso.mockRestore()
  })

  it('digitar com máscara escreve o formatado no elemento mesmo sem o signal mudar', () => {
    const c = criar(CampoComponente)
    ;(c as unknown as { mascara: () => string }).mascara = () => 'cpf'
    const el = document.createElement('input')
    document.body.appendChild(el)
    el.focus()
    el.value = '123.456.789-01'
    interno(c)['aoInput']!(el)
    expect(c.valor()).toBe('123.456.789-01')
    el.value = '123.456.789-01a'
    el.setSelectionRange(15, 15)
    interno(c)['aoInput']!(el)
    expect(el.value).toBe('123.456.789-01')
  })
})
