import { describe, it, expect } from 'vitest'
import { normalizarTelefone, ehMovel, formatarTelefoneBR, mascararTelefone, mascararIdentificador } from './telefone.js'

describe('Normalização de telefone', () => {
  // ⚠️ O caso que motiva a função existir: três grafias, uma chave.
  it('dadas as três grafias do mesmo número, então todas colidem na mesma chave', () => {
    const grafias = ['+55 81 99861-7049', '5581998617049', '81998617049', '(81) 99861-7049']
    const chaves = new Set(grafias.map((g) => normalizarTelefone(g)?.chaveBloqueio))
    expect(chaves.size).toBe(1)
    // ⚠️ 55 + DDD + ÚLTIMOS 8 dígitos — 12 caracteres, não o E.164 completo.
    // É o truncamento que faz o número colidir com e sem o nono dígito (INV-50).
    expect([...chaves][0]).toBe('558198617049')
    // E o E.164, esse sim, preserva o número inteiro para poder enviar.
    expect(normalizarTelefone('81998617049')?.e164).toBe('+5581998617049')
  })

  it('dado número sem o nono dígito, então a chave de bloqueio bate com a versão com nono dígito', () => {
    // O mesmo lojista aparece das duas formas entre ERP e WhatsApp; o opt-out
    // precisa valer para as duas (INV-50).
    const antigo = normalizarTelefone('8198617049')
    const novo = normalizarTelefone('81998617049')
    expect(antigo?.chaveBloqueio).toBe(novo?.chaveBloqueio)
  })

  it('dado número com prefixo internacional digitado, então normaliza', () => {
    expect(normalizarTelefone('005581998617049')?.e164).toBe('+5581998617049')
  })

  it('dado fixo de 8 dígitos, então preserva sem inventar nono dígito', () => {
    const fixo = normalizarTelefone('8132345678')
    expect(fixo?.e164).toBe('+558132345678')
    expect(ehMovel(fixo!)).toBe(false)
  })

  it('dado DDD inexistente, então recusa em vez de corrigir', () => {
    // ⚠️ "Consertar" silenciosamente manda a mensagem do cliente para um estranho.
    expect(normalizarTelefone('20999999999')).toBeNull()
    expect(normalizarTelefone('00999999999')).toBeNull()
  })

  it('dado comprimento impossível, então recusa', () => {
    expect(normalizarTelefone('123')).toBeNull()
    expect(normalizarTelefone('5581998617049999')).toBeNull()
  })

  it('dado lixo de digitação, então limpa o que dá e recusa o que não dá', () => {
    expect(normalizarTelefone('  +55 (81) 9.9861-7049  ')?.e164).toBe('+5581998617049')
    expect(normalizarTelefone('não é telefone')).toBeNull()
  })
})

describe('formatarTelefoneBR', () => {
  it('formata celular e fixo para leitura', () => {
    expect(formatarTelefoneBR('5585998617049')).toBe('+55 (85) 99861-7049')
    expect(formatarTelefoneBR('558532224444')).toBe('+55 (85) 3222-4444')
  })

  it('⚠️ devolve INTACTO o que não é número brasileiro — não inventa formato', () => {
    expect(formatarTelefoneBR('12025550123')).toBe('12025550123')
    expect(formatarTelefoneBR('')).toBe('')
    expect(formatarTelefoneBR('55')).toBe('55')
  })

  it('aceita entrada já pontuada sem duplicar a pontuação', () => {
    expect(formatarTelefoneBR('+55 85 99861-7049')).toBe('+55 (85) 99861-7049')
  })
})

describe('Telefone mascarado (tela de números, P10)', () => {
  it('mantém país, DDD e os 4 últimos — o resto não sai do servidor', () => {
    expect(mascararTelefone('+5585998617049')).toBe('+55 (85) •••••-7049')
    expect(mascararTelefone('558532224444')).toBe('+55 (85) •••••-4444')
  })

  it('número estrangeiro mantém só o prefixo e o fim', () => {
    expect(mascararTelefone('+12025550123')).toBe('+12 •••••-0123')
  })

  it('já mascarado no formato canônico volta igual — mascarar duas vezes é inofensivo', () => {
    expect(mascararTelefone('+55 (85) •••••-7049')).toBe('+55 (85) •••••-7049')
    expect(mascararTelefone('+12 •••••-0123')).toBe('+12 •••••-0123')
    expect(mascararTelefone(mascararTelefone('+5585998617049'))).toBe('+55 (85) •••••-7049')
  })

  it('⚠️ símbolo de máscara fora do formato canônico NÃO libera o número', () => {
    expect(mascararTelefone('+5585998617049*')).toBe('+55 (85) •••••-7049')
    expect(mascararTelefone('•5585998617049')).toBe('+55 (85) •••••-7049')
    expect(mascararTelefone('+55 85 9****-7049')).not.toContain('9****')
  })

  it('⚠️ formato curto/desconhecido é mascarado INTEIRO, nunca ecoado', () => {
    expect(mascararTelefone('1234567')).toBe('••••')
    expect(mascararTelefone('abc')).toBe('••••')
  })

  it('ausente é null — a tela decide o traço, não a regra', () => {
    expect(mascararTelefone(null)).toBeNull()
    expect(mascararTelefone(undefined)).toBeNull()
    expect(mascararTelefone('')).toBeNull()
  })

  it('identificador do fornecedor mostra só os 4 finais; curto some inteiro', () => {
    expect(mascararIdentificador('106540352242922')).toBe('••••2922')
    expect(mascararIdentificador('12345')).toBe('••••')
    expect(mascararIdentificador(null)).toBeNull()
  })
})
