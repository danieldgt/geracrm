import { describe, it, expect } from 'vitest'
import { normalizarTelefone, ehMovel } from './telefone.js'

describe('Normalização de telefone', () => {
  // ⚠️ O caso que motiva a função existir: três grafias, uma chave.
  it('dadas as três grafias do mesmo número, então todas colidem na mesma chave', () => {
    const grafias = ['+55 81 99861-7049', '5581998617049', '81998617049', '(81) 99861-7049']
    const chaves = new Set(grafias.map((g) => normalizarTelefone(g)?.chaveBloqueio))
    expect(chaves.size).toBe(1)
    expect([...chaves][0]).toBe('5581998617049')
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
