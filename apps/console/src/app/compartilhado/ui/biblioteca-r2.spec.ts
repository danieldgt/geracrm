import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { adicionarId, limiteAtingido, removerId, rotuloDoChip } from './select-multi.regras.js'
import { iconeDoEstado } from './estado.regras.js'

const aqui = dirname(fileURLToPath(import.meta.url))
const ler = (f: string): string => readFileSync(resolve(aqui, f), 'utf8')

describe('ui-select-multi (regras)', () => {
  it('adiciona sem duplicar e respeita o limite', () => {
    expect(adicionarId(['a'], 'b', null)).toEqual(['a', 'b'])
    const lista = ['a']
    expect(adicionarId(lista, 'a', null)).toBe(lista)
    expect(adicionarId(['a', 'b'], 'c', 2)).toEqual(['a', 'b'])
    expect(limiteAtingido(2, 2)).toBe(true)
    expect(limiteAtingido(5, null)).toBe(false)
  })
  it('remove e devolve a mesma lista quando o id não está', () => {
    expect(removerId(['a', 'b'], 'a')).toEqual(['b'])
    const l = ['a']
    expect(removerId(l, 'x')).toBe(l)
  })
  it('rótulo: cache, depois injetadas, depois id', () => {
    const inj = [{ valor: 'a', rotulo: 'Salvo' }]
    expect(rotuloDoChip('a', new Map([['a', 'Novo']]), inj)).toBe('Novo')
    expect(rotuloDoChip('a', new Map(), inj)).toBe('Salvo')
    expect(rotuloDoChip('z', new Map(), inj)).toBe('z')
  })
  it('casca: CVA com array e opcoesInjetadas', () => {
    const src = ler('select-multi.componente.ts')
    expect(src).toMatch(/selector: 'ui-select-multi'/)
    expect(src).toMatch(/NG_VALUE_ACCESSOR/)
    expect(src).toMatch(/opcoesInjetadas = input/)
    expect(src).toMatch(/max = input<number \| null>/)
  })
})

describe('ui-estado (ícone)', () => {
  it('padrões sem emoji', () => {
    expect(iconeDoEstado('vazio', '')).toEqual({ ehIcone: true, valor: 'inbox' })
    expect(iconeDoEstado('erro', '')).toEqual({ ehIcone: true, valor: 'alert-triangle' })
    expect(iconeDoEstado('sem-permissao', '')).toEqual({ ehIcone: true, valor: 'lock' })
  })
  it('nome Lucide vira ícone; emoji legado vira texto', () => {
    expect(iconeDoEstado('vazio', 'users').ehIcone).toBe(true)
    expect(iconeDoEstado('vazio', '🎯')).toEqual({ ehIcone: false, valor: '🎯' })
    expect(iconeDoEstado('vazio', 'constructor').ehIcone).toBe(false)
  })
})

describe('ui-modal: rodapé dentro de @if com vários nós', () => {
  // `<ng-content select="[rodape]">` só vê filho direto; um @if com 2+ nós raiz vai inteiro para o slot
  // padrão. O rodapé por template é achado por query de conteúdo e renderizado dentro do <footer>.
  const src = ler('modal.componente.ts')
  it('rodapé por template existe e é renderizado dentro do footer', () => {
    expect(src).toMatch(/selector: 'ng-template\[uiModalRodape\]'/)
    expect(src).toMatch(/contentChild\(ModalRodapeDiretiva\)/)
    expect(src).toMatch(/<footer class="rodape">[\s\S]*ngTemplateOutlet[\s\S]*<\/footer>/)
  })
  it('o slot [rodape] continua funcionando', () => {
    expect(src).toMatch(/<ng-content select="\[rodape\]" \/>/)
  })
  it('a campanha não usa mais o contorno display: contents', () => {
    const det = readFileSync(resolve(aqui, '../../funcionalidades/campanha/campanha-detalhe.pagina.ts'), 'utf8')
    expect(det).not.toMatch(/display: contents/)
    expect(det).toMatch(/uiModalRodape/)
  })
})

describe('ui-botao-icone', () => {
  const src = ler('botao-icone.componente.ts')
  it('rótulo obrigatório vira aria-label e title; tamanhos e variante', () => {
    expect(src).toMatch(/rotulo = input\.required<string>/)
    expect(src).toMatch(/\[attr\.aria-label\]="rotulo\(\)"/)
    expect(src).toMatch(/\[attr\.title\]="rotulo\(\)"/)
    expect(src).toMatch(/'p' \| 'm'/)
    expect(src).toMatch(/'neutro' \| 'perigo'/)
  })
})

describe('ui-campo: inputmode', () => {
  it('é repassado ao input, com decimal como padrão do dinheiro', () => {
    const src = ler('campo.componente.ts')
    expect(src).toMatch(/inputmode = input<string \| null>/)
    expect(src).toMatch(/\[attr\.inputmode\]="inputmode\(\) \?\? /)
  })
})
