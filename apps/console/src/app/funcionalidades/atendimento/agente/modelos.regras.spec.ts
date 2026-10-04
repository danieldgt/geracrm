import { describe, it, expect } from 'vitest'
import { errosDoServidor } from './agente.regras.js'
import { erroDoSeletor, escolhaForaDaLista, opcaoPadraoDoServidor, podeEscolher } from './modelos.regras.js'

describe('Primeira opção: padrão do servidor', () => {
  it('dado provedor padrão com chave, então "Padrão do servidor (Nome)" disponível', () => {
    const o = opcaoPadraoDoServidor({ provedorPadrao: 'groq', faltaPadrao: [] })
    expect(o.rotulo).toBe('Padrão do servidor (Groq)')
    expect(o.disponivel).toBe(true)
  })

  it('dado faltaPadrao, então vira aviso COM O NOME da variável e fica indisponível', () => {
    // ⚠️ Genérico manda abrir chamado; o nome manda resolver.
    const o = opcaoPadraoDoServidor({ provedorPadrao: null, faltaPadrao: ['GROQ_API_KEY'] })
    expect(o.disponivel).toBe(false)
    expect(o.rotulo).toContain('indisponível')
    expect(o.explicacao).toContain('GROQ_API_KEY')
  })

  it('dado provedorPadrao nulo sem lista de falta, então ainda assim indisponível (sem quebrar)', () => {
    const o = opcaoPadraoDoServidor({ provedorPadrao: null, faltaPadrao: [] })
    expect(o.disponivel).toBe(false)
    expect(o.explicacao).not.toContain('Falta configurar')
  })
})

describe('Escolha salva que saiu da lista', () => {
  const lista = [{ codigo: 'groq-llama' }, { codigo: 'claude-sonnet' }]

  it('dado código salvo presente na lista, então nada a avisar', () => {
    expect(escolhaForaDaLista('groq-llama', lista)).toBeNull()
  })

  it('dado código salvo que o staff restringiu depois, então devolve o código para o card de aviso', () => {
    expect(escolhaForaDaLista('openrouter-caro', lista)).toBe('openrouter-caro')
  })

  it('dado "padrão do servidor" (vazio), então nunca é fora da lista', () => {
    expect(escolhaForaDaLista('', lista)).toBeNull()
    expect(escolhaForaDaLista('   ', lista)).toBeNull()
  })
})

describe('Erro do seletor: o 422 da API cai NO SELETOR, não num banner', () => {
  it('dado agente.modelo_nao_permitido com campos [modelo], então a mensagem aparece em "modelo"', () => {
    const r = errosDoServidor({
      erro: 'agente.modelo_nao_permitido', campos: ['modelo'],
      mensagem: 'Este modelo não está liberado para a sua conta. Escolha um da lista.',
    })
    expect(r.geral).toBeNull()
    expect(erroDoSeletor(r.campos)).toBe('Este modelo não está liberado para a sua conta. Escolha um da lista.')
  })

  it('dado agente.modelo_indisponivel, então o motivo (com a variável) vem no seletor', () => {
    const r = errosDoServidor({
      erro: 'agente.modelo_indisponivel', campos: ['modelo'],
      mensagem: 'Llama 3.3 está sem chave no servidor (falta GROQ_API_KEY no servidor). Escolha outro.',
    })
    expect(erroDoSeletor(r.campos)).toContain('GROQ_API_KEY')
  })

  it('dado erro de outro campo, então o seletor fica limpo', () => {
    const r = errosDoServidor({ erro: 'agente.invalido', campos: ['maxTurnos'], mensagem: 'Fora da faixa.' })
    expect(erroDoSeletor(r.campos)).toBeNull()
  })
})

describe('Card desabilitado quando o servidor não tem a chave', () => {
  it('indisponível não pode ser escolhido; disponível pode', () => {
    expect(podeEscolher({ disponivel: false })).toBe(false)
    expect(podeEscolher({ disponivel: true })).toBe(true)
  })
})
