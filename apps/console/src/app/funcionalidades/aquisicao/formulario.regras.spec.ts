import { describe, it, expect } from 'vitest'
import {
  adicionarCampo, alternarCondicao, alternarReferencia, atualizarCampo, camposVisiveis, errosPorIdDeCampo, linkIncorporado,
  linkPublico, moverPorId, novoCampo, opcoesDeTexto, prepararEnvio, removerCampo, snippetIframe, textoDaResposta,
  validarEstruturaCampos, type CampoFormulario,
} from './formulario.regras.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const reais = (t: string) => Math.round(Number(t.replace(/\./g, '').replace(',', '.')) * 100)
const tel = novoCampo('telefone', id(1))
const nome = { ...novoCampo('texto', id(2)), rotulo: 'Nome', obrigatorio: true }
const cond = { ...novoCampo('selecao_condicional', id(3)), opcoes: ['Empresa', 'Pessoa'] }
const cnpj = { ...novoCampo('cnpj', id(4)), obrigatorio: true }

describe('builder: edição da lista', () => {
  it('adiciona, move e remove, limpando condições que apontavam para o removido', () => {
    let l: CampoFormulario[] = adicionarCampo([], tel)
    l = adicionarCampo(l, cond)
    l = adicionarCampo(l, cnpj)
    l = atualizarCampo(l, id(3), { condicoes: alternarCondicao(cond, 'Empresa', id(4)) })
    expect(l[1]!.condicoes['Empresa']).toEqual([id(4)])
    expect(moverPorId(l, id(4), -1).map((c) => c.id)).toEqual([id(1), id(4), id(3)])
    expect(moverPorId(l, id(1), -1).map((c) => c.id)).toEqual([id(1), id(3), id(4)])
    const sem = removerCampo(l, id(4))
    expect(sem.map((c) => c.id)).toEqual([id(1), id(3)])
    expect(sem[1]!.condicoes['Empresa']).toEqual([])
    expect(validarEstruturaCampos(sem)).toEqual({})
  })
  it('referência é única e só em texto', () => {
    let l: CampoFormulario[] = [tel, nome, { ...novoCampo('texto', id(5)), rotulo: 'Outro' }]
    l = alternarReferencia(l, id(2))
    l = alternarReferencia(l, id(5))
    expect(l.filter((c) => c.referencia).map((c) => c.id)).toEqual([id(5)])
    expect(alternarReferencia(l, id(1)).some((c) => c.id === id(1) && c.referencia)).toBe(false)
  })
  it('trocar o tipo recompõe opções e condições', () => {
    const l = atualizarCampo([cond], id(3), { tipo: 'texto' })
    expect(l[0]!.opcoes).toEqual([])
    expect(l[0]!.condicoes).toEqual({})
  })
  it('opções por linha: sem vazias nem repetidas', () => {
    expect(opcoesDeTexto('A\n\n a \nB\nb')).toEqual(['A', 'B'])
  })
  it('erros da API por posição viram erro por id do campo', () => {
    expect(errosPorIdDeCampo({ 'campos.1': 'x', campos: 'geral' }, [tel, nome])).toEqual({ [id(2)]: 'x' })
  })
})

describe('render: condicionais e envio', () => {
  const campos = [tel, nome, { ...cond, condicoes: { Empresa: [id(4)], Pessoa: [] } }, cnpj]
  it('campo ligado só aparece depois da escolha', () => {
    expect(camposVisiveis(campos, {}).map((c) => c.id)).toEqual([id(1), id(2), id(3)])
    expect(camposVisiveis(campos, { [id(3)]: 'Empresa' }).map((c) => c.id)).toContain(id(4))
  })
  it('prepararEnvio: erros por campo visível, consentimento e descarte do escondido', () => {
    const ruim = prepararEnvio(campos, {}, new Map(), false, reais)
    expect(ruim.ok).toBe(false)
    if (!ruim.ok) expect(Object.keys(ruim.erros).sort()).toEqual([id(1), id(2), 'consentimento'].sort())
    const ok = prepararEnvio(campos, { [id(1)]: '(81) 99999-1111', [id(2)]: 'Ana', [id(3)]: 'Pessoa', [id(4)]: 'lixo' }, new Map(), true, reais)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.respostas[id(4)]).toBeUndefined()
  })
  it('anexo acima de 10 MB, ou soma acima de 20 MB, é barrado antes de enviar', () => {
    const a1 = { ...novoCampo('anexo', id(7)) }
    const a2 = { ...novoCampo('anexo', id(8)) }
    const a3 = { ...novoCampo('anexo', id(9)) }
    const arq = (mb: number) => ({ size: mb * 1024 * 1024 }) as File
    const grande = prepararEnvio([tel, a1], { [id(1)]: '81999991111' }, new Map([[id(7), arq(11)]]), true, reais)
    expect(!grande.ok && grande.erros[id(7)]).toMatch(/10 MB/)
    const soma = prepararEnvio([tel, a1, a2, a3], { [id(1)]: '81999991111' },
      new Map([[id(7), arq(8)], [id(8), arq(8)], [id(9), arq(8)]]), true, reais)
    expect(!soma.ok && soma.erros[id(9)]).toMatch(/20 MB/)
  })
  it('dinheiro vira centavos', () => {
    const m = { ...novoCampo('moeda', id(6)) }
    const r = prepararEnvio([tel, m], { [id(1)]: '81999991111', [id(6)]: '1.234,50' }, new Map(), true, reais)
    expect(r.ok && r.respostas[id(6)]).toBe(123450)
  })
})

describe('textos', () => {
  it('células e links', () => {
    expect(textoDaResposta(novoCampo('multipla', id(7)), ['a', 'b'])).toBe('a | b')
    expect(textoDaResposta(novoCampo('data', id(8)), '2026-03-05')).toBe('05/03/2026')
    expect(linkPublico('https://x.com/', 'abc')).toBe('https://x.com/f/abc')
    expect(linkIncorporado('https://x.com', 'abc')).toBe('https://x.com/f/abc?embed=1')
    expect(snippetIframe('https://x.com/f/abc?embed=1', 'Meu "form"')).toContain('title="Meu &quot;form&quot;"')
  })
})
