import { describe, it, expect } from 'vitest'
import { playbookPadrao, type ObjecaoPlaybook } from '@geracrm/shared'
import {
  adicionarGatilho, contadorDaResposta, erroDoPrefixo, errosPorCampo, indicesDaBusca, linhasDoResumoObjecoes, novaObjecao, textoPercentual,
} from './playbook.regras.js'

const obj = (codigo: string, extra: Partial<ObjecaoPlaybook> = {}): ObjecaoPlaybook => ({
  codigo, ativo: true, objecao: 'Achou caro', gatilhos: ['caro'], resposta: 'Entendo a preocupação, posso mostrar opções.', ...extra,
})

describe('Playbook — seção Objeções (G2)', () => {
  it('nova objeção: próximo código OBJ-NN, vazia e ativa; sem espaço devolve null', () => {
    expect(novaObjecao([])).toEqual({ codigo: 'OBJ-01', ativo: true, objecao: '', gatilhos: [], resposta: '' })
    expect(novaObjecao([obj('OBJ-01'), obj('OBJ-04')])?.codigo).toBe('OBJ-05')
    expect(novaObjecao([obj('OBJ-99')])).toBeNull()
    expect(novaObjecao(Array.from({ length: 60 }, (_v, i) => obj(`OBJ-${String(i + 1).padStart(2, '0')}`)))).toBeNull()
  })

  it('busca devolve os índices (código, objeção, gatilho, resposta; sem acento/caixa); vazia = todos', () => {
    const l = [obj('OBJ-01'), obj('OBJ-02', { objecao: 'Vai pensar', gatilhos: ['depois eu vejo'], resposta: 'Sem pressa, deixo o resumo.' })]
    expect(indicesDaBusca(l, '')).toEqual([0, 1])
    expect(indicesDaBusca(l, 'PENSAR')).toEqual([1])
    expect(indicesDaBusca(l, 'obj-01')).toEqual([0])
    expect(indicesDaBusca(l, 'depois')).toEqual([1])
    expect(indicesDaBusca(l, 'nada disso')).toEqual([])
  })

  it('gatilho: texto livre 2–60, sem repetir (sem acento/caixa/pontuação), até 10', () => {
    expect(adicionarGatilho([], '  tá   caro ')).toEqual({ lista: ['tá caro'], erro: null })
    expect(adicionarGatilho(['tá caro'], 'TA CARO!').erro).toMatch(/já está/)
    expect(adicionarGatilho([], 'x').erro).toMatch(/ao menos 2/)
    expect(adicionarGatilho([], 'x'.repeat(61)).erro).toMatch(/no máximo 60/)
    expect(adicionarGatilho([], '!!').erro).toMatch(/letras ou números/)
    expect(adicionarGatilho(Array.from({ length: 10 }, (_v, i) => `g${i}`), 'mais um').erro).toMatch(/10 gatilhos/)
  })

  it('contador da resposta mostra n/1200 e acusa excesso', () => {
    expect(contadorDaResposta('abc')).toEqual({ texto: '3/1200', excedeu: false })
    expect(contadorDaResposta('x'.repeat(1201)).excedeu).toBe(true)
  })

  it('erro da publicação chega ao item pelo prefixo do campo', () => {
    const e = errosPorCampo([{ campo: 'objecoes[1].resposta', mensagem: 'A resposta de referência não pode citar preço' }])
    expect(erroDoPrefixo(e, 'objecoes[1].resposta')).toMatch(/preço/)
    expect(erroDoPrefixo(e, 'objecoes[0].resposta')).toBeNull()
    expect(erroDoPrefixo(errosPorCampo([{ campo: 'objecoes[0].gatilhos[2]', mensagem: 'repetido' }]), 'objecoes[0].gatilhos')).toBe('repetido')
  })

  it('o playbook padrão já vem com a seção vazia e a ação ligada', () => {
    const p = playbookPadrao()
    expect(p.objecoes).toEqual([])
    expect(p.acoes.objecoes).toBe(true)
  })

  it('resumo: linhas da tabela com % ou travessão', () => {
    expect(textoPercentual(null)).toBe('—')
    expect(linhasDoResumoObjecoes([
      { codigo: 'OBJ-01', objecao: 'Achou caro', vezes: 1200, revertidas: 400, percentualRevertida: 33 },
    ])).toEqual([{ id: 'OBJ-01', codigo: 'OBJ-01', objecao: 'Achou caro', vezes: (1200).toLocaleString('pt-BR'), revertida: '33%' }])
  })
})
