import { describe, it, expect } from 'vitest'
import {
  OBSERVACAO_MAX, badgeOrigem, citacoesDaDecisao, compactarDiff, diffLinhas, mensagemFalhaVersao, resumoDiff, rotuloAutor,
  validarObservacao, type LinhaDiff,
} from './conhecimento.regras.js'

/** Histórico do conhecimento (raia P9): diff, citações da decisão e textos da tela — tudo puro. */

const DOC = '0199a3f0-0b1c-7000-8000-00000000d0c1'
const DOC2 = '0199a3f0-0b1c-7000-8000-00000000d0c2'

const marcas = (ls: readonly LinhaDiff[]) => ls.map((l) => `${l.tipo === 'igual' ? ' ' : l.tipo === 'removida' ? '-' : '+'}${l.texto}`)

describe('diffLinhas', () => {
  it('dado textos iguais, então só linhas iguais e "sem diferença"', () => {
    const d = diffLinhas('a\nb', 'a\nb')
    expect(marcas(d.linhas)).toEqual([' a', ' b'])
    expect(resumoDiff(d)).toBe('sem diferença no texto')
  })

  it('dado uma linha trocada no meio, então remove a antiga e adiciona a nova, mantendo o resto', () => {
    const d = diffLinhas('Frete:\nGrátis acima de R$ 300.\nPIX', 'Frete:\nGrátis acima de R$ 250.\nPIX')
    expect(marcas(d.linhas)).toEqual([' Frete:', '-Grátis acima de R$ 300.', '+Grátis acima de R$ 250.', ' PIX'])
    expect(d).toMatchObject({ adicionadas: 1, removidas: 1, aproximado: false })
    expect(resumoDiff(d)).toBe('+1 −1 linhas')
  })

  it('numera as linhas nos dois lados (antes/depois), null onde a linha não existe', () => {
    const d = diffLinhas('a\nb\nc', 'a\nx\nb\nc')
    expect(d.linhas).toEqual([
      { tipo: 'igual', texto: 'a', antes: 1, depois: 1 },
      { tipo: 'adicionada', texto: 'x', antes: null, depois: 2 },
      { tipo: 'igual', texto: 'b', antes: 2, depois: 3 },
      { tipo: 'igual', texto: 'c', antes: 3, depois: 4 },
    ])
  })

  it('acha a maior subsequência comum quando as mudanças se intercalam', () => {
    const d = diffLinhas('a\nb\nc\nd\ne', 'a\nc\nd\nf\ne')
    expect(marcas(d.linhas)).toEqual([' a', '-b', ' c', ' d', '+f', ' e'])
  })

  it('texto vazio de um lado: tudo adicionado ou tudo removido', () => {
    expect(marcas(diffLinhas('', 'a\nb').linhas)).toEqual(['+a', '+b'])
    expect(marcas(diffLinhas('a', '').linhas)).toEqual(['-a'])
    expect(diffLinhas('', '').linhas).toEqual([])
  })

  it('trata \\r\\n como quebra de linha (texto colado do Windows não vira "tudo mudou")', () => {
    expect(diffLinhas('a\r\nb', 'a\nb').adicionadas).toBe(0)
  })

  it('dado um miolo grande demais para o LCS, então sai como bloco removido + adicionado, marcado aproximado', () => {
    const d = diffLinhas('x\na\nb\ny', 'x\nc\nd\ny', 4)
    expect(marcas(d.linhas)).toEqual([' x', '-a', '-b', '+c', '+d', ' y'])
    expect(d.aproximado).toBe(true)
  })

  it('documento grande com uma mudança só: prefixo e sufixo cortados, rápido e exato', () => {
    const base = Array.from({ length: 5000 }, (_, i) => `linha ${i}`)
    const novo = [...base]; novo[2500] = 'mudou'
    const d = diffLinhas(base.join('\n'), novo.join('\n'))
    expect(d).toMatchObject({ adicionadas: 1, removidas: 1, aproximado: false })
  })
})

describe('compactarDiff', () => {
  it('esconde trechos iguais longe das mudanças, mantendo o contexto', () => {
    const antes = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const depois = [...antes]; depois[10] = 'novo'
    const blocos = compactarDiff(diffLinhas(antes.join('\n'), depois.join('\n')).linhas, 2)
    expect(blocos[0]).toEqual({ tipo: 'omitidas', quantidade: 8 })
    expect(blocos.filter((b) => b.tipo !== 'omitidas')).toHaveLength(6) // 2 + removida + adicionada + 2
    expect(blocos[blocos.length - 1]).toEqual({ tipo: 'omitidas', quantidade: 7 })
  })

  it('sem mudança nenhuma, tudo vira um único bloco omitido', () => {
    expect(compactarDiff(diffLinhas('a\nb\nc', 'a\nb\nc').linhas)).toEqual([{ tipo: 'omitidas', quantidade: 3 }])
  })
})

describe('citacoesDaDecisao', () => {
  it('lê documento + versão de saida.citacoes, sem repetir', () => {
    const cs = citacoesDaDecisao([
      { nome: 'catalogo_buscar', saida: { itens: [] } },
      { nome: 'conhecimento_buscar', saida: { citacoes: [
        { documentoId: DOC, versao: 3, titulo: 'Frete' }, { documentoId: DOC, versao: 3, titulo: 'Frete' },
        { documentoId: DOC2, versao: 1, titulo: 'Pagamento' },
      ], trechos: [] } },
    ])
    expect(cs).toEqual([{ documentoId: DOC, versao: 3, titulo: 'Frete' }, { documentoId: DOC2, versao: 1, titulo: 'Pagamento' }])
  })

  it('saída cortada em 4.000 caracteres: as citações (que vêm primeiro) são lidas do texto', () => {
    const s = JSON.stringify({ citacoes: [{ documentoId: DOC, versao: 2, titulo: 'Troca "rápida"' }], trechos: [{ texto: 'x'.repeat(5000), fonte: 'Troca v2' }] })
    const cs = citacoesDaDecisao([{ nome: 'conhecimento_buscar', saida: { truncado: true, inicio: s.slice(0, 4000) } }])
    expect(cs).toEqual([{ documentoId: DOC, versao: 2, titulo: 'Troca "rápida"' }])
  })

  it('decisão anterior ao histórico (só "Título vN"): citação sem documento, que a tela não abre', () => {
    const cs = citacoesDaDecisao([{ nome: 'conhecimento_buscar', saida: { trechos: [{ texto: 't', fonte: 'Políticas da loja v4' }] } }])
    expect(cs).toEqual([{ documentoId: null, versao: 4, titulo: 'Políticas da loja' }])
  })

  it('ignora chamada com erro, id inválido e versão não inteira', () => {
    expect(citacoesDaDecisao([
      { nome: 'conhecimento_buscar', saida: null, erro: 'timeout' },
      { nome: 'conhecimento_buscar', saida: { citacoes: [{ documentoId: 'x', versao: 1 }, { documentoId: DOC, versao: 1.5 }] } },
    ])).toEqual([])
  })
})

describe('Textos do histórico', () => {
  it('origem: restaurada nomeia a versão de origem; desconhecida sai crua', () => {
    expect(badgeOrigem('restauracao', 2)).toEqual({ rotulo: 'restaurada da v2', tom: 'info' })
    expect(badgeOrigem('edicao').rotulo).toBe('editada')
    expect(badgeOrigem('importacao')).toEqual({ rotulo: 'importacao', tom: 'neutro' })
  })

  it('autor: staff, usuário ou sistema', () => {
    expect(rotuloAutor({ autor: null, autorStaff: true })).toBe('equipe GeraCRM')
    expect(rotuloAutor({ autor: { nome: 'ana' }, autorStaff: false })).toBe('ana')
    expect(rotuloAutor({ autor: null, autorStaff: false })).toBe('sistema')
  })

  it('versão anterior ao histórico é explicada, com onde o histórico começa', () => {
    expect(mensagemFalhaVersao('conhecimento.versao_anterior_ao_historico', 4)).toMatch(/sobrescrita.*começa na v4/)
    expect(mensagemFalhaVersao('conhecimento.restaurar_sem_mudanca')).toMatch(/mesmo título e texto/)
    expect(mensagemFalhaVersao(undefined)).toMatch(/Tente de novo/)
  })

  it('nota da versão: até o teto da API', () => {
    expect(validarObservacao('x'.repeat(OBSERVACAO_MAX))).toBeNull()
    expect(validarObservacao('x'.repeat(OBSERVACAO_MAX + 1))).toMatch(/280/)
  })
})
