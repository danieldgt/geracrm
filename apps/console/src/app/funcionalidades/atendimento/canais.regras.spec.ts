import { describe, it, expect } from 'vitest'
import {
  abrirAvancado, avisoDeRemocao, idadeVerificacao, mudancasDaEdicao, verificacaoAtrasada,
} from './canais.regras.js'

/**
 * ⚠️ O que importa aqui não é o DOM: é a decisão de QUANDO a área da equipe
 * aparece. Um teste que monta o componente e procura `<details>` falha por
 * espaçamento e para de falhar quando a regra muda.
 */
const CAMPOS = ['instancia', 'token', 'clientToken']

describe('Área da equipe (credencial do fornecedor)', () => {
  it('dado formulário limpo, então fica fechada — o cliente não tem esses dados', () => {
    expect(abrirAvancado({}, CAMPOS, false)).toBe(false)
  })

  it('dado clique no resumo, então abre', () => {
    expect(abrirAvancado({}, CAMPOS, true)).toBe(true)
  })

  it('⚠️ dado erro num campo de credencial, então abre SOZINHA', () => {
    // Sem isto, o servidor responde "confira os campos destacados" e não há
    // campo destacado na tela: o erro fica dentro de um bloco fechado.
    expect(abrirAvancado({ token: 'Obrigatório' }, CAMPOS, false)).toBe(true)
  })

  it('dado erro em campo de FORA da credencial, então continua fechada', () => {
    // Nome do número é do fluxo do cliente — não tem por que escancarar a
    // credencial do fornecedor por causa dele.
    expect(abrirAvancado({ nomeAmigavel: 'Obrigatório' }, CAMPOS, false)).toBe(false)
  })

  it('dado provedor sem campos declarados, então nunca abre sozinha', () => {
    expect(abrirAvancado({ token: 'Obrigatório' }, [], false)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O CARIMBO DA VERIFICAÇÃO (0069)
// ─────────────────────────────────────────────────────────────────────────────
const AGORA = new Date('2026-08-25T20:00:00Z')
const atras = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString()

describe('⚠️ Ausência de notícia NÃO é notícia boa', () => {
  /**
   * O caso encontrado em produção (25/ago): `estado = 'conectado'` escrito no
   * cadastro em 09/ago e nunca confirmado por ninguém. Se a tela traduzisse
   * "sem carimbo" para "verificado agora", ela estaria afirmando uma observação
   * que não houve — que é o incidente de 24/ago de volta.
   */
  it('sem carimbo, diz NUNCA verificado — e não "agora"', () => {
    expect(idadeVerificacao(null, AGORA)).toBe('nunca verificado')
    expect(idadeVerificacao(undefined, AGORA)).toBe('nunca verificado')
  })

  it('sem carimbo conta como atrasado — o estado não tem lastro', () => {
    expect(verificacaoAtrasada(null, AGORA)).toBe(true)
  })

  it('data ilegível também não vira saúde', () => {
    expect(idadeVerificacao('nao-e-data', AGORA)).toBe('nunca verificado')
    expect(verificacaoAtrasada('nao-e-data', AGORA)).toBe(true)
  })
})

describe('Idade da verificação', () => {
  it('menos de um minuto é "agora"', () => {
    expect(idadeVerificacao(atras(0.5), AGORA)).toBe('verificado agora')
  })

  it('minutos, horas e dias', () => {
    expect(idadeVerificacao(atras(3), AGORA)).toBe('verificado há 3 min')
    expect(idadeVerificacao(atras(59), AGORA)).toBe('verificado há 59 min')
    expect(idadeVerificacao(atras(60), AGORA)).toBe('verificado há 1 h')
    expect(idadeVerificacao(atras(60 * 25), AGORA)).toBe('verificado há 1 d')
  })

  /** ⚠️ Relógio adiantado no servidor não pode virar "há -3 min". */
  it('carimbo no futuro lê como agora, não como negativo', () => {
    expect(idadeVerificacao(atras(-5), AGORA)).toBe('verificado agora')
  })
})

describe('Quando o carimbo vira aviso', () => {
  /** O vigia passa de 5 em 5 min; 15 min são três passadas sem notícia. */
  it('recente não é atrasado', () => {
    expect(verificacaoAtrasada(atras(5), AGORA)).toBe(false)
    expect(verificacaoAtrasada(atras(14), AGORA)).toBe(false)
  })

  it('⚠️ três passadas sem notícia é atrasado — a vigilância parou', () => {
    expect(verificacaoAtrasada(atras(16), AGORA)).toBe(true)
    expect(verificacaoAtrasada(atras(180), AGORA)).toBe(true)
  })
})

describe('Editar número: só o que mudou viaja', () => {
  const VAZIA = { instancia: '', token: '', clientToken: '' }

  it('dado só o Client-Token preenchido, então envia SÓ ele — em branco é "mantém"', () => {
    // O caso real: Client-Token com a URL do endpoint colada. Quem vem
    // corrigir isso não tem o token da instância à mão.
    const r = mudancasDaEdicao('Wpp Drezz', 'Wpp Drezz', { ...VAZIA, clientToken: 'CLIENT-CERTO' })

    expect(r).toEqual({ credencial: { clientToken: 'CLIENT-CERTO' } })
  })

  it('dado nome inalterado e credencial vazia, então não envia nada', () => {
    // ⚠️ Abrir o modal e fechar não pode virar alteração na auditoria.
    expect(mudancasDaEdicao('Wpp Drezz', 'Wpp Drezz', VAZIA)).toEqual({})
  })

  it('dado nome novo, então envia o nome sem tocar na credencial', () => {
    expect(mudancasDaEdicao('  Wpp da loja  ', 'Wpp Drezz', VAZIA)).toEqual({ nomeAmigavel: 'Wpp da loja' })
  })

  it('dado campo só com espaços, então não conta como preenchido', () => {
    expect(mudancasDaEdicao('Wpp', 'Wpp', { ...VAZIA, token: '   ' })).toEqual({})
  })
})

describe('Desfecho da remoção', () => {
  it('dado canal sem histórico, então diz removido', () => {
    expect(avisoDeRemocao('Wpp teste', 'removido', 0)).toBe('Wpp teste foi removido.')
  })

  it('dado canal com histórico, então diz ARQUIVADO e quantas conversas ficaram', () => {
    // ⚠️ São promessas diferentes, e a pessoa não tem como conferir qual valeu.
    expect(avisoDeRemocao('Wpp Drezz', 'arquivado', 12))
      .toBe('Wpp Drezz foi arquivado e saiu da frota. 12 conversas preservadas no histórico.')
  })

  it('dada uma conversa só, então o plural não escorrega', () => {
    expect(avisoDeRemocao('Wpp', 'arquivado', 1)).toContain('1 conversa preservada')
  })
})
