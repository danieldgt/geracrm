import { describe, it, expect } from 'vitest'
import {
  REGRAS_AGENTE_PADRAO, FAIXAS_REGRAS_AGENTE, validarRegrasAgente, avisosDasRegras,
} from './agente-regras.js'

/**
 * ⚠️ Os padrões NÃO são preferência: são o comportamento que o agente tinha
 * antes de a tela existir. Um teste que os prende impede que alguém "melhore" um
 * default e mude, num deploy, o robô de todos os clientes que nunca pediram nada.
 *
 * ⚠️ `horasParaReabrir` é a ÚNICA exceção, e ela mudou o produto de propósito em
 * 01/09: antes a trava de "já conversei nesta conversa" não expirava nunca, e o
 * agente ficava permanentemente mudo ali. Mudar este número de novo continua
 * exigindo a mesma conversa que exigiu esta linha.
 */
describe('Os padrões são o comportamento anterior à tela', () => {
  it('mantém os números que estavam no código', () => {
    expect(REGRAS_AGENTE_PADRAO).toEqual({
      soQuandoNinguemDisponivel: true,
      exigirAusenciaAntes: true,
      horasDesdeAusencia: 12,
      reabrirAposEncerrada: false,
      horasParaReabrir: 24,
      minutosPresenca: 60,
      maxTurnos: 6,
      maxCaracteres: 320,
      falasDeContexto: 10,
    })
  })
})

/**
 * ⚠️ A trava perpétua era o defeito: "não reabrir agora" e "nunca mais" viraram
 * a mesma coisa, e o dono só descobria escrevendo para o próprio número.
 */
describe('Silêncio depois de encerrar tem prazo', () => {
  it('o padrão é um dia, não para sempre', () => {
    expect(REGRAS_AGENTE_PADRAO.horasParaReabrir).toBe(24)
  })

  it('aceita de uma hora a trinta dias', () => {
    expect(FAIXAS_REGRAS_AGENTE.horasParaReabrir).toEqual({ min: 1, max: 720 })
    expect(validarRegrasAgente({ horasParaReabrir: 720 }).ok).toBe(true)
    expect(validarRegrasAgente({ horasParaReabrir: 0 }).ok).toBe(false)
    expect(validarRegrasAgente({ horasParaReabrir: 721 }).ok).toBe(false)
  })

  /** Uma semana de silêncio é uma escolha legítima — mas a tela precisa dizê-la. */
  it('prazo longo vira aviso na tela, em dias', () => {
    const avisos = avisosDasRegras({ ...REGRAS_AGENTE_PADRAO, horasParaReabrir: 168 })
    expect(avisos.some((a) => a.includes('7 dias'))).toBe(true)
  })

  it('com reabertura ligada, o prazo não avisa nada — ele nem se aplica', () => {
    const avisos = avisosDasRegras({
      ...REGRAS_AGENTE_PADRAO, reabrirAposEncerrada: true, horasParaReabrir: 720,
    })
    expect(avisos.some((a) => a.includes('dias sem falar'))).toBe(false)
  })
})

describe('Validação das regras', () => {
  it('corpo vazio devolve os padrões, sem erro', () => {
    const r = validarRegrasAgente({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.regras).toEqual(REGRAS_AGENTE_PADRAO)
  })

  it('aceita valores dentro da faixa', () => {
    const r = validarRegrasAgente({ maxTurnos: 12, horasDesdeAusencia: 24, minutosPresenca: 15 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.regras.maxTurnos).toBe(12)
  })

  /** ⚠️ A frase é a que a tela mostra — precisa dizer a faixa, não "inválido". */
  it('recusa fora da faixa com a ação corretiva na mensagem', () => {
    const r = validarRegrasAgente({ maxTurnos: 99 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.erros[0]!.campo).toBe('maxTurnos')
      expect(r.erros[0]!.mensagem).toContain(String(FAIXAS_REGRAS_AGENTE.maxTurnos.max))
    }
  })

  it('recusa número quebrado', () => {
    expect(validarRegrasAgente({ falasDeContexto: 3.5 }).ok).toBe(false)
  })

  it('acumula os erros em vez de parar no primeiro', () => {
    const r = validarRegrasAgente({ maxTurnos: 0, maxCaracteres: 5, minutosPresenca: 9999 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros).toHaveLength(3)
  })

  /**
   * ⚠️ O caso que justifica não usar `Boolean(v)`: a regra mais perigosa da tela
   * fica LIGADA por padrão, e a string "false" de um formulário mal serializado
   * a desligaria em silêncio — soltando o robô em horário comercial.
   */
  it('booleano só aceita true/false de verdade; o resto cai no padrão', () => {
    const r = validarRegrasAgente({ soQuandoNinguemDisponivel: 'false' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.regras.soQuandoNinguemDisponivel).toBe(true)
  })

  it('false explícito desliga', () => {
    const r = validarRegrasAgente({ soQuandoNinguemDisponivel: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.regras.soQuandoNinguemDisponivel).toBe(false)
  })
})

describe('⚠️ Avisos: o que muda com esta configuração', () => {
  it('configuração padrão não assusta ninguém', () => {
    expect(avisosDasRegras(REGRAS_AGENTE_PADRAO)).toEqual([])
  })

  it('avisa quando o robô passa a falar com a equipe na mesa', () => {
    const avisos = avisosDasRegras({ ...REGRAS_AGENTE_PADRAO, soQuandoNinguemDisponivel: false })
    expect(avisos.join(' ')).toContain('equipe disponível')
  })

  it('avisa quando ele volta a falar em conversa encerrada', () => {
    const avisos = avisosDasRegras({ ...REGRAS_AGENTE_PADRAO, reabrirAposEncerrada: true })
    expect(avisos).toHaveLength(1)
  })

  it('avisa quando a régua de silêncio fica menor que a de fábrica', () => {
    const avisos = avisosDasRegras({ ...REGRAS_AGENTE_PADRAO, minutosPresenca: 10 })
    expect(avisos.join(' ')).toContain('10 min')
  })
})
