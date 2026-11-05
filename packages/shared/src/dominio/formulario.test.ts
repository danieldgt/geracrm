import { describe, it, expect } from 'vitest'
import {
  camposVisiveis, moverCampo, slugDeNome, validarEstruturaCampos, validarRespostas, type CampoFormulario,
} from './formulario.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const campo = (n: number, p: Partial<CampoFormulario> = {}): CampoFormulario => ({
  id: id(n), tipo: 'texto', rotulo: `Campo ${n}`, obrigatorio: false, opcoes: [], condicoes: {}, referencia: false, ...p,
})
const tel = (n = 1) => campo(n, { tipo: 'telefone', rotulo: 'Telefone', obrigatorio: true })
const cond = (n: number, alvos: Record<string, string[]>) =>
  campo(n, { tipo: 'selecao_condicional', opcoes: Object.keys(alvos), condicoes: alvos })

describe('estrutura do builder', () => {
  it('aceita formulário mínimo com telefone', () => {
    expect(validarEstruturaCampos([tel()])).toEqual({})
  })
  it('exige ao menos um campo e um telefone', () => {
    expect(validarEstruturaCampos([]).campos).toMatch(/ao menos um/)
    expect(validarEstruturaCampos([campo(1)]).campos).toMatch(/telefone/)
  })
  it('limita a 60 campos', () => {
    const muitos = Array.from({ length: 61 }, (_, i) => campo(i + 1))
    expect(validarEstruturaCampos(muitos).campos).toMatch(/60/)
  })
  it('seleção exige opções, sem repetição', () => {
    expect(validarEstruturaCampos([tel(), campo(2, { tipo: 'selecao' })])['campos.1']).toMatch(/opções/)
    expect(validarEstruturaCampos([tel(), campo(2, { tipo: 'selecao', opcoes: ['A', 'a'] })])['campos.1']).toMatch(/repetidas/)
  })
  it('condicional só referencia campos do mesmo formulário e não a si mesma', () => {
    expect(validarEstruturaCampos([tel(), cond(2, { Sim: [id(99)] })])['campos.1']).toMatch(/não existe/)
    expect(validarEstruturaCampos([tel(), cond(2, { Sim: [id(2)] })])['campos.1']).toMatch(/si mesmo/)
    expect(validarEstruturaCampos([tel(), campo(3), cond(2, { Sim: [id(3)] })])).toEqual({})
  })
  it('recusa ciclo entre condicionais', () => {
    const a = cond(2, { x: [id(3)] })
    const b = cond(3, { y: [id(2)] })
    expect(validarEstruturaCampos([tel(), a, b]).campos).toMatch(/ciclo/)
  })
  it('no máximo uma referência, e de texto', () => {
    expect(validarEstruturaCampos([tel(), campo(2, { referencia: true }), campo(3, { referencia: true })])['campos.2']).toMatch(/Só um/)
    expect(validarEstruturaCampos([tel(), campo(2, { tipo: 'email', referencia: true })])['campos.1']).toMatch(/texto/)
  })
  it('o telefone de identificação não pode ser condicional', () => {
    expect(validarEstruturaCampos([cond(2, { Sim: [id(1)] }), tel()])['campos.1']).toMatch(/condição/)
  })
})

describe('visibilidade condicional', () => {
  const campos = [tel(), cond(2, { Empresa: [id(3)], Pessoa: [id(4)] }), campo(3, { tipo: 'cnpj' }), campo(4, { tipo: 'cpf' })]
  it('campo controlado fica escondido até a opção ser escolhida', () => {
    expect(camposVisiveis(campos, {}).map((c) => c.id)).toEqual([id(1), id(2)])
    expect(camposVisiveis(campos, { [id(2)]: 'Empresa' }).map((c) => c.id)).toEqual([id(1), id(2), id(3)])
    expect(camposVisiveis(campos, { [id(2)]: 'Pessoa' }).map((c) => c.id)).toEqual([id(1), id(2), id(4)])
  })
  it('cadeia: o controlador também precisa estar visível', () => {
    const c = [tel(), cond(2, { A: [id(3)] }), cond(3, { B: [id(4)] }), campo(4)]
    expect(camposVisiveis(c, { [id(3)]: 'B' }).map((x) => x.id)).toEqual([id(1), id(2)])
    expect(camposVisiveis(c, { [id(2)]: 'A', [id(3)]: 'B' }).map((x) => x.id)).toEqual([id(1), id(2), id(3), id(4)])
  })
})

describe('validação das respostas', () => {
  const campos = [
    tel(), campo(2, { rotulo: 'Nome', obrigatorio: true, referencia: true }),
    cond(3, { Empresa: [id(4)], Pessoa: [] }), campo(4, { tipo: 'cnpj', obrigatorio: true }),
    campo(5, { tipo: 'multipla', opcoes: ['a', 'b'] }), campo(6, { tipo: 'moeda' }), campo(7, { tipo: 'anexo', obrigatorio: true }),
  ]
  it('normaliza telefone, dinheiro e descarta o que está escondido', () => {
    const r = validarRespostas(campos, {
      [id(1)]: '(81) 99999-8888', [id(2)]: ' Ana ', [id(3)]: 'Pessoa', [id(4)]: '123', [id(5)]: ['a', 'a'], [id(6)]: 1500,
    }, new Set([id(7)]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dados.valores[id(1)]).toBe('+5581999998888')
      expect(r.dados.valores[id(2)]).toBe('Ana')
      expect(r.dados.valores[id(4)]).toBeUndefined()
      expect(r.dados.valores[id(5)]).toEqual(['a'])
    }
  })
  it('obrigatório visível falha por campo; obrigatório escondido não', () => {
    const r = validarRespostas(campos, { [id(1)]: 'x', [id(3)]: 'Empresa' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.campos).sort()).toEqual([id(1), id(2), id(4), id(7)].sort())
  })
  it('opção fora da lista é inválida', () => {
    const r = validarRespostas([tel(), cond(2, { A: [] })], { [id(1)]: '81999998888', [id(2)]: 'Z' })
    expect(r.ok).toBe(false)
  })
})

describe('utilitários', () => {
  it('moverCampo reordena e respeita limites', () => {
    expect(moverCampo([1, 2, 3], 0, 2)).toEqual([2, 3, 1])
    expect(moverCampo([1, 2, 3], 0, -1)).toEqual([1, 2, 3])
  })
  it('slugDeNome', () => {
    expect(slugDeNome('  Cadastro de Clientes — 2026! ')).toBe('cadastro-de-clientes-2026')
    expect(slugDeNome('!!!')).toBe('formulario')
  })
})
