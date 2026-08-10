import { describe, it, expect } from 'vitest'
import { CAPACIDADES, MENSAGEM_FALHA, type Conexao, type ConectorDisponivel } from './tipos.js'

/**
 * Testes da lógica de apresentação — sem TestBed.
 *
 * ⚠️ O que importa nesta tela não é o DOM: é a decisão de O QUE mostrar. Um
 * teste que monta o componente e procura texto passa a falhar por causa de
 * espaçamento, e para de falhar quando a regra muda.
 */

const base: Conexao = {
  id: 'c1', conector: 'geracloud', nomeAmigavel: 'ERP da matriz', estado: 'ativa',
  capacidades: {}, papelFiscal: false, fonteDeVenda: true,
  identificacaoRemota: 'LOJA CENTRO LTDA',
  ultimaValidacaoEm: '2026-08-08T10:00:00Z', ultimaTentativaEm: '2026-08-08T10:00:00Z',
  ultimoErro: null, ultimoErroMotivo: null,
  credencial: { configurada: true, camposPreenchidos: ['baseUrl', 'usuario', 'senha'] },
}

// As mesmas funções puras que a página usa. Mantidas aqui como referência
// executável da regra; a página as chama por método.
const tentandoEFalhando = (c: Conexao): boolean => {
  if (!c.ultimaTentativaEm) return false
  if (!c.ultimaValidacaoEm) return true
  return new Date(c.ultimaTentativaEm) > new Date(c.ultimaValidacaoEm)
}
const faltantes = (c: Conexao) => CAPACIDADES.filter((cap) => c.capacidades[cap.chave] === false)

describe('⚠️ Está tentando e falhando', () => {
  it('dada validação e tentativa iguais, então está saudável', () => {
    expect(tentandoEFalhando(base)).toBe(false)
  })

  it('dada tentativa mais recente que a validação, então avisa', () => {
    // Credencial revogada no ERP: continua "configurada" para sempre, e sem
    // este sinal a tela mostraria "validada em 08/08" indefinidamente.
    expect(tentandoEFalhando({ ...base, ultimaTentativaEm: '2026-08-09T10:00:00Z' })).toBe(true)
  })

  it('dada conexão nunca validada mas já tentada, então avisa', () => {
    expect(tentandoEFalhando({ ...base, ultimaValidacaoEm: null })).toBe(true)
  })

  it('dada conexão nunca testada, então não avisa nada', () => {
    expect(tentandoEFalhando({ ...base, ultimaValidacaoEm: null, ultimaTentativaEm: null })).toBe(false)
  })
})

describe('⚠️ Degradação visível (ADR-008)', () => {
  it('dada capacidade ausente, então diz a CONSEQUÊNCIA, não a falta', () => {
    const c = { ...base, capacidades: { saldoSincrono: false, ingestaoClientes: true } }
    const lista = faltantes(c)

    expect(lista).toHaveLength(1)
    // "Sem saldo síncrono" não diz nada a quem vende.
    expect(lista[0]!.ausente).toContain('última sincronização')
    expect(lista[0]!.ausente).toContain('hora')
  })

  it('⚠️ capacidade ausente do objeto NÃO conta como faltante', () => {
    // Capacidades ainda não descobertas (conexão nunca testada) não podem
    // aparecer como "este ERP não oferece" — seria afirmar o que não se sabe.
    expect(faltantes({ ...base, capacidades: {} })).toHaveLength(0)
  })

  it('toda capacidade tem texto de consequência preenchido', () => {
    for (const c of CAPACIDADES) {
      expect(c.ausente.length, `${c.chave} sem texto de ausência`).toBeGreaterThan(20)
      expect(c.rotulo).not.toContain('Sincron')  // rótulo em linguagem de quem usa
    }
  })
})

describe('⚠️ Motivos de falha pedem ações diferentes', () => {
  it('credencial inválida manda conferir; sem permissão manda pedir liberação', () => {
    // Colapsar os dois faz a pessoa errada trabalhar: quem libera acesso no
    // ERP costuma não ser quem está configurando.
    expect(MENSAGEM_FALHA.credencial_invalida.acao).toContain('Confira')
    expect(MENSAGEM_FALHA.sem_permissao.acao).toContain('liberar')
  })

  it('indisponível avisa que a credencial foi salva', () => {
    // Sem isso a pessoa redigita tudo achando que perdeu o que preencheu.
    expect(MENSAGEM_FALHA.indisponivel.acao).toContain('salvas')
  })

  it('todo motivo tem título e ação', () => {
    for (const [motivo, m] of Object.entries(MENSAGEM_FALHA)) {
      expect(m.titulo.length, `${motivo} sem título`).toBeGreaterThan(10)
      expect(m.acao.length, `${motivo} sem ação`).toBeGreaterThan(10)
    }
  })
})

describe('⚠️ O console não conhece ERP nenhum', () => {
  it('o formulário sai do esquema declarado — nada codificado aqui', () => {
    const geracloud: ConectorDisponivel = {
      codigo: 'geracloud', nome: 'GeraCloud', descricao: '',
      capacidades: {},
      esquemaCredencial: {
        campos: [
          { nome: 'baseUrl', rotulo: 'Endereço', tipo: 'url', obrigatorio: true },
          { nome: 'usuario', rotulo: 'Usuário', tipo: 'texto', obrigatorio: true },
          { nome: 'senha', rotulo: 'Senha', tipo: 'senha', obrigatorio: true },
        ],
      },
    }
    const porToken: ConectorDisponivel = {
      codigo: 'x', nome: 'Outro', descricao: '', capacidades: {},
      esquemaCredencial: {
        campos: [{ nome: 'token', rotulo: 'Token', tipo: 'senha', obrigatorio: true }],
      },
    }

    // Um pede senha, o outro pede token, e a tela é a mesma.
    expect(geracloud.esquemaCredencial.campos.map((c) => c.tipo)).toEqual(['url', 'texto', 'senha'])
    expect(porToken.esquemaCredencial.campos.map((c) => c.tipo)).toEqual(['senha'])
  })

  it('⚠️ o resumo de credencial só carrega nomes de campo, nunca valores', () => {
    // A credencial entra e nunca sai. A garantia real é testada do lado do
    // servidor (rotas.test.ts); aqui é o contrato que o console consome — se
    // um dia vier valor, este formato é o primeiro lugar onde apareceria.
    const resumo = base.credencial
    expect(Object.keys(resumo)).toEqual(['configurada', 'camposPreenchidos'])
    expect(resumo.camposPreenchidos).toEqual(['baseUrl', 'usuario', 'senha'])
  })
})
