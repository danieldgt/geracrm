import { describe, it, expect } from 'vitest'
import { REGRAS_AGENTE_PADRAO } from '@geracrm/shared'
import {
  reaisParaCentavos, centavosParaTexto, formatarReais,
  errosDoServidor, validarFormulario, corpoParaSalvar, mudouDoPadrao,
  badgeDesfecho, badgeModo, resumoDeUso, formatarConfianca, resumoExtraido, jsonLegivel,
  type FormularioAgente,
} from './agente.regras.js'

const FORM_OK: FormularioAgente = {
  modo: 'sombra',
  politicas: '',
  persona: { nome: 'Ana', loja: 'Loja Centro', tom: 'neutro', usaEmojis: false, saudacao: '', identificaComoRobo: true },
  objetivo: 'vender',
  qualificacao: ['cidade'],
  alcada: { valorMaxTexto: '1.500,00', descontoMaxPct: 0, efetivaSozinho: false },
  regras: REGRAS_AGENTE_PADRAO,
  modelo: '',
  limiarConfianca: 0.6,
  maxRodadas: 6,
  prazoTurnoMs: 20000,
  orcamentoDiaTexto: '',
}

describe('Dinheiro: a tela fala em reais, a API em centavos', () => {
  it('dado texto brasileiro com milhar e vírgula, então converte em centavos inteiros', () => {
    expect(reaisParaCentavos('1.234,56')).toBe(123456)
    expect(reaisParaCentavos('R$ 1.234,56')).toBe(123456)
    expect(reaisParaCentavos('1234,5')).toBe(123450)
  })

  it('dado ponto decimal ou só inteiro, então também aceita', () => {
    // ⚠️ Quem digita no teclado numérico do celular manda "1234.56".
    expect(reaisParaCentavos('1234.56')).toBe(123456)
    expect(reaisParaCentavos('10')).toBe(1000)
    expect(reaisParaCentavos('1.234')).toBe(123400)
  })

  it('dado texto inválido ou vazio, então null — nunca zero nem NaN', () => {
    // ⚠️ Zero é alçada legítima ("nada sozinho"); não pode nascer de erro de digitação.
    expect(reaisParaCentavos('')).toBeNull()
    expect(reaisParaCentavos('abc')).toBeNull()
    expect(reaisParaCentavos('-5')).toBeNull()
    expect(reaisParaCentavos('1,234.56')).toBeNull()
  })

  it('dado centavos, então formata com milhar, vírgula e símbolo', () => {
    expect(centavosParaTexto(123456)).toBe('1.234,56')
    expect(centavosParaTexto(5)).toBe('0,05')
    expect(formatarReais(0)).toBe('R$ 0,00')
    expect(formatarReais(1_000_000_00)).toBe('R$ 1.000.000,00')
  })

  it('ida e volta preserva o valor', () => {
    expect(reaisParaCentavos(centavosParaTexto(987654321))).toBe(987654321)
  })
})

describe('Erro 422 cai no campo certo', () => {
  it('dado agente.sem_politicas, então vai para o campo políticas, não para o banner', () => {
    const r = errosDoServidor({ erro: 'agente.sem_politicas', mensagem: 'Escreva as políticas.' })
    expect(r.campos['politicas']).toBe('Escreva as políticas.')
    expect(r.geral).toBeNull()
  })

  it('dado campos nomeados pela API, então cada um recebe a mensagem', () => {
    const r = errosDoServidor({ erro: 'agente.regra_invalida', mensagem: 'fora da faixa', campos: ['maxTurnos', 'persona.nome'] })
    expect(r.campos).toEqual({ maxTurnos: 'fora da faixa', 'persona.nome': 'fora da faixa' })
  })

  it('dado erro sem campo (chave do servidor), então é geral', () => {
    const r = errosDoServidor({ erro: 'agente.sem_chave', mensagem: 'Falta IA_CHAVE.' })
    expect(r.geral).toBe('Falta IA_CHAVE.')
    expect(r.campos).toEqual({})
  })

  it('dado erro sem mensagem, então frase padrão — nunca texto vazio', () => {
    expect(errosDoServidor({ erro: 'x' }).geral).toBe('Não foi possível salvar.')
  })
})

describe('Validação de borda com os mesmos limites da API', () => {
  it('dado formulário válido, então nenhum erro', () => {
    expect(validarFormulario(FORM_OK)).toEqual({})
  })

  it('dado modo autônomo sem políticas, então erro no campo políticas', () => {
    const erros = validarFormulario({ ...FORM_OK, modo: 'autonomo' })
    expect(Object.keys(erros)).toEqual(['politicas'])
  })

  it('dado sombra sem políticas, então passa — sombra não exige', () => {
    expect(validarFormulario({ ...FORM_OK, modo: 'sombra', politicas: '' })).toEqual({})
  })

  it('dado nome vazio ou alçada ilegível, então aponta o campo', () => {
    const erros = validarFormulario({
      ...FORM_OK,
      persona: { ...FORM_OK.persona, nome: '  ' },
      alcada: { ...FORM_OK.alcada, valorMaxTexto: 'mil reais' },
    })
    expect(erros['persona.nome']).toBeDefined()
    expect(erros['alcada.valorMaxAutonomoCentavos']).toBeDefined()
  })

  it('dado regra de entrada fora da faixa, então usa a frase do domínio compartilhado', () => {
    const erros = validarFormulario({ ...FORM_OK, regras: { ...REGRAS_AGENTE_PADRAO, maxTurnos: 99 } })
    expect(erros['maxTurnos']).toContain('entre 1 e 20')
  })

  it('dado avançado fora da faixa, então cada campo com a sua mensagem', () => {
    const erros = validarFormulario({ ...FORM_OK, limiarConfianca: 2, maxRodadas: 0, prazoTurnoMs: 100, orcamentoDiaTexto: 'x' })
    expect(Object.keys(erros).sort()).toEqual(['limiarConfianca', 'maxRodadas', 'orcamentoDiaCentavos', 'prazoTurnoMs'])
  })
})

describe('Corpo do PUT', () => {
  it('dado o formulário, então manda centavos inteiros, regras achatadas e textos aparados', () => {
    const corpo = corpoParaSalvar({ ...FORM_OK, modelo: '  ', orcamentoDiaTexto: '50,00', politicas: ' ok ' })
    expect(corpo['alcada']).toEqual({ valorMaxAutonomoCentavos: 150000, descontoMaxPct: 0, efetivaSozinho: false })
    expect(corpo['orcamentoDiaCentavos']).toBe(5000)
    expect(corpo['modelo']).toBeNull()
    expect(corpo['politicas']).toBe('ok')
    expect(corpo['maxTurnos']).toBe(REGRAS_AGENTE_PADRAO.maxTurnos)
  })

  it('dado orçamento em branco, então null — sem limite, não zero', () => {
    expect(corpoParaSalvar(FORM_OK)['orcamentoDiaCentavos']).toBeNull()
  })

  it('"voltar ao padrão" só aparece quando há o que voltar', () => {
    expect(mudouDoPadrao(REGRAS_AGENTE_PADRAO, REGRAS_AGENTE_PADRAO)).toBe(false)
    expect(mudouDoPadrao({ ...REGRAS_AGENTE_PADRAO, maxTurnos: 3 }, REGRAS_AGENTE_PADRAO)).toBe(true)
  })
})

describe('Badges em ordem fixa, cor por tom', () => {
  it('desfecho conhecido tem rótulo em português e tom semântico', () => {
    expect(badgeDesfecho('respondeu')).toEqual({ rotulo: 'Respondeu', tom: 'sucesso' })
    expect(badgeDesfecho('handoff')).toEqual({ rotulo: 'Entregou ao humano', tom: 'atencao' })
    expect(badgeDesfecho('falha').tom).toBe('erro')
  })

  it('desfecho desconhecido (API mais nova) sai cru e neutro — a tela não quebra', () => {
    expect(badgeDesfecho('novo_desfecho')).toEqual({ rotulo: 'novo_desfecho', tom: 'neutro' })
  })

  it('modo: autônomo é o único verde; simulação existe só no playground', () => {
    expect(badgeModo('autonomo').tom).toBe('sucesso')
    expect(badgeModo('assistido').tom).toBe('info')
    expect(badgeModo('simulacao').rotulo).toBe('Simulação')
  })
})

describe('Bastidores em uma linha', () => {
  it('tokens com milhar abreviado e cache só quando houve', () => {
    expect(resumoDeUso({ entrada: 1234, saida: 340 })).toBe('1,2k entrada · 340 saída')
    expect(resumoDeUso({ entrada: 10, saida: 5, cacheLeitura: 900 })).toBe('10 entrada · 5 saída · 900 cache')
    expect(resumoDeUso(null)).toBe('—')
  })

  it('confiança vira porcentagem; ausente vira travessão', () => {
    expect(formatarConfianca(0.724)).toBe('72%')
    expect(formatarConfianca(null)).toBe('—')
  })

  it('resumo do que foi colhido ignora vazios', () => {
    expect(resumoExtraido({ cidade: 'Recife', volume: '', prazo: null })).toBe('Colheu — cidade: Recife')
    expect(resumoExtraido({})).toBeNull()
  })

  it('JSON legível nunca lança', () => {
    const circular: Record<string, unknown> = {}
    circular['eu'] = circular
    expect(jsonLegivel({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(typeof jsonLegivel(circular)).toBe('string')
  })
})
