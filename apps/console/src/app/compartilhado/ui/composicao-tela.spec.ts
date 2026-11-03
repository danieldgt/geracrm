// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { devolverFoco, prenderTab, primeiroAlvoDeFoco } from './foco.js'
import { abaAtiva, proximaAba, type Aba } from './abas.regras.js'
import { itensDaTrilha } from './breadcrumb.regras.js'
import { alternarChip } from './chips-etiqueta.componente.js'
import { valorDefinicao } from './lista-definicao.componente.js'

const aqui = dirname(fileURLToPath(import.meta.url))
const fonte = (nome: string) => readFileSync(resolve(aqui, nome), 'utf8')

function montarDialogo(): { raiz: HTMLElement; campo: HTMLInputElement; ultimo: HTMLButtonElement } {
  document.body.innerHTML = '<div id="d" tabindex="-1"><button id="x">x</button><input id="c"><button id="u">ok</button></div>'
  const raiz = document.getElementById('d')!
  return { raiz, campo: document.getElementById('c') as HTMLInputElement, ultimo: document.getElementById('u') as HTMLButtonElement }
}

describe('ui-modal', () => {
  it('Esc fecha e véu fecha (contrato do template)', () => {
    const src = fonte('modal.componente.ts')
    expect(src).toContain("e.key === 'Escape'")
    expect(src).toMatch(/class="overlay" \(mousedown\)="marcarVeu\(\$event\)" \(mouseup\)="soltarNoVeu\(\$event\)"/)
    expect(src).toContain('role="dialog"')
    expect(src).toContain('aria-modal="true"')
  })
  it('foco vai ao primeiro campo', () => {
    const { raiz, campo } = montarDialogo()
    expect(primeiroAlvoDeFoco(raiz)).toBe(campo)
  })
  it('foco fica preso: Tab no último volta ao primeiro; Shift+Tab no primeiro vai ao último', () => {
    const { raiz, ultimo } = montarDialogo()
    const primeiro = document.getElementById('x')!
    ultimo.focus()
    expect(prenderTab(raiz, { key: 'Tab', shiftKey: false }, document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(primeiro)
    expect(prenderTab(raiz, { key: 'Tab', shiftKey: true }, document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(ultimo)
  })
  it('Tab no meio não é interceptado', () => {
    const { raiz, campo } = montarDialogo()
    campo.focus()
    expect(prenderTab(raiz, { key: 'Tab', shiftKey: false }, campo)).toBe(false)
  })
  it('devolve o foco a quem abriu', () => {
    document.body.innerHTML = '<button id="abre">abrir</button><div id="d"><input id="c"></div>'
    const abre = document.getElementById('abre')!
    abre.focus()
    const antes = document.activeElement
    document.getElementById('c')!.focus()
    devolverFoco(antes)
    expect(document.activeElement).toBe(abre)
  })
})

describe('ui-abas', () => {
  const abas: Aba[] = [{ id: 'a', rotulo: 'A' }, { id: 'b', rotulo: 'B' }]
  it('ativa por estado', () => {
    expect(abaAtiva(abas, 'b', '/x')).toBe('b')
    expect(abaAtiva(abas, 'inexistente', '/x')).toBe('a')
  })
  it('ativa por rota (a mais específica vence)', () => {
    const r: Aba[] = [{ id: 'ger', rotulo: 'G', rota: '/c' }, { id: 'sub', rotulo: 'S', rota: '/c/sub' }]
    expect(abaAtiva(r, '', '/c/sub/1?x=1')).toBe('sub')
    expect(abaAtiva(r, '', '/c')).toBe('ger')
  })
  it('setas circulares, Home e End', () => {
    expect(proximaAba(abas, 'b', 'ArrowRight')).toBe('a')
    expect(proximaAba(abas, 'a', 'ArrowLeft')).toBe('b')
    expect(proximaAba(abas, 'b', 'Home')).toBe('a')
    expect(proximaAba(abas, 'a', 'End')).toBe('b')
    expect(proximaAba(abas, 'a', 'x')).toBeNull()
  })
})

describe('ui-grade-form', () => {
  it('filho largo ocupa a linha toda, por container query', () => {
    const src = fonte('grade-form.componente.ts')
    expect(src).toContain('@container')
    expect(src).toContain('.ui-grade-form > .largo, .ui-grade-form > [largo] { grid-column: 1 / -1; }')
  })
})

describe('ui-breadcrumb', () => {
  it('o último item nunca é link', () => {
    const v = itensDaTrilha([{ rotulo: 'Início', rota: '/' }, { rotulo: 'Atual', rota: '/atual' }])
    expect(v.map((i) => i.link)).toEqual([true, false])
  })
  it('sem rota, não vira link', () => {
    expect(itensDaTrilha([{ rotulo: 'A' }, { rotulo: 'B' }])[0]!.link).toBe(false)
  })
  it('tem aria-label Trilha', () => expect(fonte('breadcrumb.componente.ts')).toContain('aria-label="Trilha"'))
})

describe('ui-chips-etiqueta', () => {
  it('alterna seleção sem mutar', () => {
    const base = ['a']
    expect(alternarChip(base, 'b')).toEqual(['a', 'b'])
    expect(alternarChip(base, 'a')).toEqual([])
    expect(base).toEqual(['a'])
  })
})

describe('ui-lista-definicao', () => {
  it('valor vazio mostra traço', () => {
    expect(valorDefinicao(null)).toBe('—')
    expect(valorDefinicao('  ')).toBe('—')
    expect(valorDefinicao(0)).toBe('0')
    expect(valorDefinicao('x')).toBe('x')
  })
})

describe('ui-form-pagina / ui-secao-form / ui-cabecalho-tela', () => {
  it('estrutura e tokens', () => {
    expect(fonte('form-pagina.componente.ts')).toContain('ui-form-pagina__rodape')
    expect(fonte('secao-form.componente.ts')).toContain('txt-rotulo')
    expect(fonte('secao-form.componente.ts')).toContain('--espacamento-4')
  })
  it('cabeçalho aceita slot trilha e usa txt-titulo', () => {
    const src = fonte('cabecalho-tela.componente.ts')
    expect(src).toContain('select="[trilha]"')
    expect(src).toContain('class="txt-titulo"')
  })
})
