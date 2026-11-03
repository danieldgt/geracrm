import { describe, it, expect } from 'vitest'
import {
  gatilhoCasa, lerEstadoObjecoes, naoRevertidasSeguidas, objecoesQueCasam, percentualRevertida, proximoCodigoObjecao, segueReferencia,
  type ObjecaoPlaybook,
} from './agente-objecoes.js'
import {
  conteudoPlaybook, diffPorSecao, errosDaRespostaObjecao, lerPlaybookVigente, objecoesAtivas, playbookPadrao, validarPlaybook,
  type ConteudoPlaybook,
} from './agente-playbook.js'
import { avaliarRegrasQualidade, objecaoForaDoCatalogo } from './agente-qualidade.js'

const caro: ObjecaoPlaybook = {
  codigo: 'OBJ-01', ativo: true, objecao: 'Achou caro',
  gatilhos: ['caro', 'muito caro', 'tá puxado'],
  resposta: 'Entendo a preocupação com o investimento. Posso mostrar opções do catálogo que cabem melhor no orçamento da loja?',
}
const pensar: ObjecaoPlaybook = {
  codigo: 'OBJ-02', ativo: true, objecao: 'Vai pensar',
  gatilhos: ['vou pensar', 'depois eu vejo'],
  resposta: 'Claro, sem pressa. Quer que eu deixe o resumo pronto para você decidir com calma?',
}

const comObjecoes = (objecoes: ObjecaoPlaybook[]): ConteudoPlaybook => ({ ...playbookPadrao(), objecoes })

describe('Objeções do playbook — validação da seção (G2)', () => {
  it('dado objeções válidas, então o playbook passa', () => {
    const r = validarPlaybook(comObjecoes([caro, pensar]))
    expect(r.ok).toBe(true)
  })

  it('dado versão publicada ANTES da G2 (sem objeções nem a ação), então continua válida com padrões', () => {
    const antigo = structuredClone(playbookPadrao()) as unknown as Record<string, any>
    delete antigo['objecoes']
    delete antigo['acoes'].objecoes
    const r = conteudoPlaybook.safeParse(antigo)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.objecoes).toEqual([])
      expect(r.data.acoes.objecoes).toBe(true)
    }
    expect(lerPlaybookVigente({ versaoId: 'v', numero: 1, conteudo: antigo })?.conteudo.objecoes).toEqual([])
  })

  it.each([
    ['preço literal', 'Entendo. Esse item sai por R$ 39,90 no atacado, vale a pena.', /preço/],
    ['valor sem R$', 'Entendo. O pacote fica 39,90 a unidade, é o melhor da praça.', /preço|número/],
    ['percentual', 'Consigo verificar, mas o reajuste foi de 5% para todos.', /percentual/],
    ['por cento por extenso', 'Consigo verificar, mas o reajuste foi de cinco por cento para todos.', /percentual/],
    ['prazo literal', 'Fica tranquilo: a separação leva 2 dias úteis depois do pagamento.', /número|prazo/],
    ['prazo por extenso', 'Fica tranquilo: a separação leva dois dias úteis depois do pagamento.', /número|prazo/],
    ['vezes por extenso', 'Entendo. Dá para pagar em doze vezes no cartão, pode ficar tranquilo.', /número|prazo/],
    ['parcelas por extenso', 'Entendo. Dá para dividir em três parcelas, pode ficar tranquilo.', /número|prazo/],
    ['anos por extenso', 'Entendo. A garantia dura dez anos, pode ficar tranquilo.', /número|prazo/],
    ['semanas por extenso', 'Entendo. A reposição chega em duas semanas, pode ficar tranquilo.', /número|prazo/],
    ['minutos por extenso', 'Entendo. A confirmação sai em cinco minutos, pode ficar tranquilo.', /número|prazo/],
    ['ordinal de parcela', 'Entendo. A primeira parcela só vence depois, pode ficar tranquilo.', /número|prazo/],
    ['metade', 'Entendo. Dá para pagar metade do valor na entrada, pode ficar tranquilo.', /número|prazo/],
    ['meio por cento', 'Entendo. O ajuste foi de meio por cento, pode ficar tranquilo.', /percentual|número|prazo/],
    ['promessa de entrega', 'Pode confiar, entregamos amanhã sem falta na sua loja.', /prazo/],
  ])('dado resposta com %s, então a publicação recusa e explica no item', (_n, resposta, explica) => {
    const r = validarPlaybook(comObjecoes([{ ...caro, resposta }]))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const e = r.erros.find((x) => x.campo === 'objecoes[0].resposta')
      expect(e, JSON.stringify(r.erros)).toBeDefined()
      expect(e!.mensagem).toMatch(explica)
    }
  })

  it('dado a soma das objeções ATIVAS acima de 20.000 caracteres, então a publicação recusa no campo objecoes; inativas não contam', () => {
    const resposta = 'Entendo a sua preocupação e posso ajudar com as opções do catálogo. '.repeat(17).slice(0, 1190).trim()
    const grande = (i: number): ObjecaoPlaybook => ({
      codigo: `OBJ-${String(i + 1).padStart(2, '0')}`, ativo: true, objecao: `Objeção número ${i}`.padEnd(190, 'x'),
      gatilhos: Array.from({ length: 10 }, (_, j) => `gatilho${'a'.repeat(30)}${i}-${j}`), resposta,
    })
    const muitas = Array.from({ length: 13 }, (_, i) => grande(i))
    const r = validarPlaybook(comObjecoes(muitas))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros.find((x) => x.campo === 'objecoes')?.mensagem).toMatch(/20000|20\.000/)
    const inativas = muitas.map((o, i) => (i >= 5 ? { ...o, ativo: false } : o))
    const r2 = validarPlaybook(comObjecoes(inativas))
    if (!r2.ok) expect(r2.erros.find((x) => x.campo === 'objecoes')).toBeUndefined()
  })

  it('dado resposta que FALA de prazo e desconto sem número nem promessa, então passa', () => {
    expect(errosDaRespostaObjecao('Entendo! O prazo de entrega eu confiro no sistema para você, e condição especial de volume é com o vendedor.')).toBeNull()
  })

  it('dado resposta que nega ser IA, então recusa', () => {
    expect(errosDaRespostaObjecao('Pode ficar tranquilo, aqui é atendimento humano de verdade.')).toMatch(/IA/)
  })

  it('dado código repetido, gatilho repetido no item e gatilho em duas objeções ativas, então cada erro vai ao seu campo', () => {
    const r = validarPlaybook(comObjecoes([
      { ...caro, gatilhos: ['caro', 'Caro!'] },
      { ...pensar, codigo: 'OBJ-01', gatilhos: ['vou pensar', 'caro'] },
    ]))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const campos = r.erros.map((e) => e.campo)
      expect(campos).toContain('objecoes[0].gatilhos[1]')
      expect(campos).toContain('objecoes[1].codigo')
      expect(campos).toContain('objecoes[1].gatilhos[1]')
    }
  })

  it('dado gatilho igual numa objeção INATIVA, então não conflita', () => {
    const r = validarPlaybook(comObjecoes([caro, { ...pensar, ativo: false, gatilhos: ['caro'] }]))
    expect(r.ok).toBe(true)
  })

  it.each([
    ['código fora do formato', { ...caro, codigo: 'OBJ-1' }, 'objecoes[0].codigo'],
    ['objeção longa demais', { ...caro, objecao: 'x'.repeat(201) }, 'objecoes[0].objecao'],
    ['gatilho longo demais', { ...caro, gatilhos: ['x'.repeat(61)] }, 'objecoes[0].gatilhos[0]'],
    ['gatilhos demais', { ...caro, gatilhos: Array.from({ length: 11 }, (_v, i) => `gatilho ${String.fromCharCode(97 + i)}`) }, 'objecoes[0].gatilhos'],
    ['resposta longa demais', { ...caro, resposta: 'Entendo a sua preocupação. '.repeat(50) }, 'objecoes[0].resposta'],
  ])('dado %s, então o schema recusa com o campo', (_n, o, campo) => {
    const r = validarPlaybook(comObjecoes([o as ObjecaoPlaybook]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros.map((e) => e.campo)).toContain(campo)
  })

  it('dado mais de 60 objeções, então recusa', () => {
    const muitas = Array.from({ length: 61 }, (_v, i) => ({ ...caro, codigo: `OBJ-${String(i + 1).padStart(2, '0')}`, gatilhos: [] }))
    const r = validarPlaybook(comObjecoes(muitas))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros[0]!.campo).toBe('objecoes')
  })

  it('dado chave fora do contrato na objeção, então recusa (schema estrito)', () => {
    const r = validarPlaybook(comObjecoes([{ ...caro, desligaHandoff: true } as unknown as ObjecaoPlaybook]))
    expect(r.ok).toBe(false)
  })

  it('objecoesAtivas: só as ativas, na ordem', () => {
    expect(objecoesAtivas(comObjecoes([caro, { ...pensar, ativo: false }])).map((o) => o.codigo)).toEqual(['OBJ-01'])
    expect(objecoesAtivas(null)).toEqual([])
  })

  it('diff: objeção nova, alterada e reordenada aparecem na seção Objeções', () => {
    const antes = comObjecoes([caro, pensar])
    const novo = diffPorSecao(antes, comObjecoes([caro, { ...pensar, resposta: `${pensar.resposta} Fico à disposição.` }]))
      .find((s) => s.secao === 'objecoes')!
    expect(novo.mudou).toBe(true)
    expect(novo.mudancas[0]!.campo).toBe('OBJ-02')
    const ordem = diffPorSecao(antes, comObjecoes([pensar, caro])).find((s) => s.secao === 'objecoes')!
    expect(ordem.mudancas[0]!.campo).toBe('Ordem')
  })
})

describe('Objeções — puras', () => {
  it('próximo código: maior + 1, com dois dígitos; null depois de OBJ-99', () => {
    expect(proximoCodigoObjecao([])).toBe('OBJ-01')
    expect(proximoCodigoObjecao([{ codigo: 'OBJ-01' }, { codigo: 'OBJ-07' }])).toBe('OBJ-08')
    expect(proximoCodigoObjecao([{ codigo: 'OBJ-99' }])).toBeNull()
  })

  it('gatilho casa palavra inteira, sem acento e sem caixa', () => {
    expect(gatilhoCasa('Achei MUITO caro!', 'muito caro')).toBe(true)
    expect(gatilhoCasa('ta puxado esse preço', 'tá puxado')).toBe(true)
    expect(gatilhoCasa('vou de carona', 'caro')).toBe(false)
  })

  it('objecoesQueCasam ignora inativas', () => {
    expect(objecoesQueCasam('achei caro, vou pensar', [caro, { ...pensar, ativo: false }]).map((o) => o.codigo)).toEqual(['OBJ-01'])
  })

  it('segueReferencia: resposta parecida com a referência sim; resposta sem relação não', () => {
    expect(segueReferencia(['Entendo a preocupação com o investimento! Posso mostrar opções do catálogo que cabem no orçamento?'], caro.resposta)).toBe(true)
    expect(segueReferencia(['Beleza, qual tamanho você quer?'], caro.resposta)).toBe(false)
  })

  it('não revertidas seguidas: conta do fim; uma revertida zera', () => {
    const l = (rs: boolean[]) => rs.map((revertida, i) => ({ codigo: 'OBJ-01', revertida, turno: i + 1 }))
    expect(naoRevertidasSeguidas(l([false, false, false]))).toBe(3)
    expect(naoRevertidasSeguidas(l([false, false, true, false]))).toBe(1)
    expect(naoRevertidasSeguidas(l([]))).toBe(0)
  })

  it('estado: leitura tolerante descarta item fora do formato', () => {
    expect(lerEstadoObjecoes([{ codigo: 'OBJ-01', revertida: false, turno: 2 }, { codigo: 1 }, 'x', null])).toEqual([{ codigo: 'OBJ-01', revertida: false, turno: 2 }])
    expect(lerEstadoObjecoes({})).toEqual([])
  })

  it('percentual revertida: inteiro 0–100, null sem registro', () => {
    expect(percentualRevertida(3, 1)).toBe(33)
    expect(percentualRevertida(0, 0)).toBeNull()
    expect(percentualRevertida(2, 5)).toBe(100)
  })
})

describe('Qualidade — objeção respondida fora do catálogo (G2, MEDIA)', () => {
  const base = { ativas: [caro, pensar], textoDoCliente: 'achei muito caro', registradas: 0 }

  it('dado gatilho casado, nenhum registro e resposta fora da referência, então MEDIA com o código', () => {
    const v = objecaoForaDoCatalogo(['Ok! Qual cor você prefere?'], base)
    expect(v).toMatchObject({ regra: 'objecao_fora_do_catalogo', gravidade: 'MEDIA', detalhe: 'OBJ-01' })
    const todas = avaliarRegrasQualidade({ mensagens: ['Ok! Qual cor você prefere?'], objecoes: base })
    expect(todas.map((x) => x.regra)).toContain('objecao_fora_do_catalogo')
  })

  it('dado registrar_objecao no turno, então não viola', () => {
    expect(objecaoForaDoCatalogo(['Ok! Qual cor você prefere?'], { ...base, registradas: 1 })).toBeNull()
  })

  it('dado resposta que segue a referência, então não viola', () => {
    expect(objecaoForaDoCatalogo(['Entendo a preocupação com o investimento. Posso mostrar opções do catálogo que cabem no orçamento?'], base)).toBeNull()
  })

  it('dado cliente sem gatilho, ou sem objeções informadas, então não roda', () => {
    expect(objecaoForaDoCatalogo(['Qual cor?'], { ...base, textoDoCliente: 'quero camiseta verde' })).toBeNull()
    expect(avaliarRegrasQualidade({ mensagens: ['Ok! Qual cor você prefere?'] }).map((x) => x.regra)).not.toContain('objecao_fora_do_catalogo')
  })
})
