import { describe, expect, it } from 'vitest'
import {
  PERGUNTA_DO_SLOT, PERGUNTA_NEUTRA, PERGUNTAS_NEUTRAS, evitarPerguntaRepetida, evitarPerguntaRepetidaNasMensagens,
  extrairSlotsDoCliente, lerEstadoPerguntas, mesmaPergunta, normalizarPergunta, perguntasDe, proximoSlotAberto,
  slotDaPergunta, temPerguntaRepetida,
} from './agente-perguntas.js'
import { SLOTS_QUALIFICACAO } from './agente-vendedor.js'

/**
 * Caso real da AM portado ao B2B (playbook §3.8, §12 #3): o agente perguntou se a compra é para
 * revenda, o cliente respondeu OUTRA coisa (volume e prazo) e o agente repetiu a pergunta.
 */
const PERGUNTA_TIPO = 'Você vai revender ou é para uso próprio da empresa?'
const CNPJ_VALIDO = '11.222.333/0001-81'

describe('texto da pergunta', () => {
  it('normaliza sem acento, caixa e pontuação; separa as perguntas', () => {
    expect(normalizarPergunta('  É PARA   revenda?! ')).toBe('e para revenda')
    expect(perguntasDe('Anotado! Qual a cidade? E o prazo?')).toEqual(['Qual a cidade?', 'E o prazo?'])
    expect(perguntasDe('Sem pergunta aqui.')).toEqual([])
  })

  it('mesma pergunta: idêntica normalizada ou Jaccard ≥ 0,7; diferente não', () => {
    expect(mesmaPergunta(PERGUNTA_TIPO, 'voce vai revender ou e para uso proprio da empresa??')).toBe(true)
    expect(mesmaPergunta('Vai revender ou é uso próprio da empresa?', PERGUNTA_TIPO)).toBe(true)
    expect(mesmaPergunta('Qual a cidade da entrega?', PERGUNTA_TIPO)).toBe(false)
  })

  it('as perguntas canônicas dos slots não se confundem entre si e apontam para o próprio slot', () => {
    for (const a of SLOTS_QUALIFICACAO) {
      expect(slotDaPergunta(PERGUNTA_DO_SLOT[a])).toBe(a)
      for (const b of SLOTS_QUALIFICACAO) if (a !== b) expect(mesmaPergunta(PERGUNTA_DO_SLOT[a], PERGUNTA_DO_SLOT[b])).toBe(false)
    }
    for (const n of PERGUNTAS_NEUTRAS) expect(slotDaPergunta(n)).toBeNull()
    expect(slotDaPergunta(PERGUNTA_TIPO)).toBe('tipoCompra')
    expect(slotDaPergunta('Faz sentido pra você?')).toBeNull()
  })

  it('próximo slot aberto respeita a ordem do canal, os respondidos e os excluídos', () => {
    expect(proximoSlotAberto(['tipoCompra', 'volume', 'prazo', 'cidade'], ['volume', 'prazo'], ['tipoCompra'])).toBe('cidade')
    expect(proximoSlotAberto(['volume'], ['volume'])).toBeNull()
    expect(proximoSlotAberto(['inventado', 'cnpj'], [])).toBe('cnpj')
  })
})

describe('extrairSlotsDoCliente', () => {
  it('caso real B2B: volume e prazo trazidos sem responder a pergunta feita', () => {
    expect(extrairSlotsDoCliente('Preciso de 50 caixas até sexta')).toEqual({ volume: '50 caixas', prazo: 'até sexta' })
  })

  it('tipo de compra: revenda, uso próprio e a negação de revenda', () => {
    expect(extrairSlotsDoCliente('é pra revender na minha loja')).toEqual({ tipoCompra: 'revenda' })
    expect(extrairSlotsDoCliente('é para uso próprio')).toEqual({ tipoCompra: 'consumo_final' })
    expect(extrairSlotsDoCliente('não é pra revenda, é consumo interno')).toEqual({ tipoCompra: 'consumo_final' })
  })

  it('CNPJ com DV válido vira "informado" — os dígitos nunca saem', () => {
    const r = extrairSlotsDoCliente(`meu cnpj é ${CNPJ_VALIDO}`)
    expect(r).toEqual({ cnpj: 'informado' })
    expect(JSON.stringify(r)).not.toMatch(/\d/)
    expect(extrairSlotsDoCliente('cnpj 11.222.333/0001-82')).toEqual({})
    expect(extrairSlotsDoCliente('11222333000181')).toEqual({ cnpj: 'informado' })
  })

  it('orçamento vira "informado", sem o valor; quantidade não é orçamento', () => {
    expect(extrairSlotsDoCliente('tenho uns R$ 3.000 pra isso')).toEqual({ orcamento: 'informado' })
    expect(extrairSlotsDoCliente('meu orçamento é de 5 mil')).toEqual({ orcamento: 'informado' })
    expect(extrairSlotsDoCliente('quero investir em 20 fardos')).toEqual({ volume: '20 fardos' })
  })

  it('prazos em várias formas', () => {
    expect(extrairSlotsDoCliente('preciso pra amanhã').prazo).toBe('pra amanhã')
    expect(extrairSlotsDoCliente('é urgente').prazo).toBe('urgente')
    expect(extrairSlotsDoCliente('pode ser semana que vem').prazo).toBe('semana que vem')
    expect(extrairSlotsDoCliente('até o dia 20').prazo).toBe('até o dia 20')
    expect(extrairSlotsDoCliente('dentro de 10 dias').prazo).toBe('dentro de 10 dias')
    expect(extrairSlotsDoCliente('sem pressa').prazo).toBe('sem pressa')
  })

  it('não confunde passado, telefone nem conversa à toa', () => {
    expect(extrairSlotsDoCliente('da outra vez comprei 10 caixas')).toEqual({})
    expect(extrairSlotsDoCliente('meu número é 85999990000')).toEqual({})
    expect(extrairSlotsDoCliente('oi, tudo bem? sou a Carla')).toEqual({})
    expect(extrairSlotsDoCliente('')).toEqual({})
  })
})

describe('evitarPerguntaRepetida (trava antes do envio)', () => {
  const ctx = { perguntasAnteriores: [`Olá! ${PERGUNTA_TIPO}`], slotsRespondidos: ['volume', 'prazo'], slotsDoCanal: ['tipoCompra', 'volume', 'prazo', 'cidade'] }

  it('caso real: tira a repetida, mantém o resto e entra a pergunta do próximo slot aberto', () => {
    const r = evitarPerguntaRepetida(`Perfeito, 50 caixas até sexta, anotado! ${PERGUNTA_TIPO}`, ctx)
    expect(r.removidas).toEqual([PERGUNTA_TIPO])
    expect(r.substituta).toBe(PERGUNTA_DO_SLOT.cidade)
    expect(r.texto).toBe(`Perfeito, 50 caixas até sexta, anotado! ${PERGUNTA_DO_SLOT.cidade}`)
  })

  it('sem slot aberto: pergunta neutra; neutra repetida dá lugar à outra', () => {
    const semSlot = { ...ctx, slotsDoCanal: [] }
    expect(evitarPerguntaRepetida(PERGUNTA_TIPO, semSlot)).toEqual({ texto: PERGUNTA_NEUTRA, removidas: [PERGUNTA_TIPO], substituta: PERGUNTA_NEUTRA })
    const r = evitarPerguntaRepetida(`Ok. ${PERGUNTA_NEUTRA}`, { ...semSlot, perguntasAnteriores: [PERGUNTA_NEUTRA] })
    expect(r.texto).toBe(`Ok. ${PERGUNTAS_NEUTRAS[1]}`)
  })

  it('substituta igual à que acabou de sair não vale', () => {
    const r = evitarPerguntaRepetida(PERGUNTA_DO_SLOT.cidade, { perguntasAnteriores: [PERGUNTA_DO_SLOT.cidade], slotsRespondidos: [], slotsDoCanal: ['cidade'] })
    expect(r.substituta).toBe(PERGUNTA_NEUTRA)
  })

  it('outra pergunta nova fica, e nenhuma substituta entra', () => {
    const r = evitarPerguntaRepetida(`Anotado! ${PERGUNTA_TIPO}\nE qual a cidade?`, ctx)
    expect(r.texto).toBe('Anotado!\nE qual a cidade?')
    expect(r.substituta).toBeNull()
  })

  it('pergunta diferente passa intacta; sem turno anterior nada muda', () => {
    const txt = 'Que bom! Qual a cidade da entrega?'
    expect(evitarPerguntaRepetida(txt, ctx)).toEqual({ texto: txt, removidas: [], substituta: null })
    expect(evitarPerguntaRepetida(PERGUNTA_TIPO, { ...ctx, perguntasAnteriores: [] }).removidas).toEqual([])
  })

  it('em várias bolhas: bolha que esvazia sai, a substituta vai na última; proximoPasso=false não acrescenta', () => {
    const r = evitarPerguntaRepetidaNasMensagens(['Anotado!', PERGUNTA_TIPO], ctx)
    expect(r.mensagens).toEqual([`Anotado! ${PERGUNTA_DO_SLOT.cidade}`])
    const h = evitarPerguntaRepetidaNasMensagens(['Vou te passar para a equipe.', PERGUNTA_TIPO], { ...ctx, proximoPasso: false })
    expect(h).toEqual({ mensagens: ['Vou te passar para a equipe.'], removidas: [PERGUNTA_TIPO], substituta: null })
    expect(temPerguntaRepetida(['Anotado!', PERGUNTA_TIPO], ctx.perguntasAnteriores)).toBe(true)
    expect(temPerguntaRepetida(['Qual a cidade?'], ctx.perguntasAnteriores)).toBe(false)
  })
})

describe('lerEstadoPerguntas (leitura tolerante do jsonb)', () => {
  it('lixo vira vazio; chave inventada e valor não-texto saem', () => {
    expect(lerEstadoPerguntas(null)).toEqual({ ultima: null, respondidos: {} })
    expect(lerEstadoPerguntas([1])).toEqual({ ultima: null, respondidos: {} })
    expect(lerEstadoPerguntas({ ultima: { texto: 'a?', slot: 'x', em: 'e' }, respondidos: { volume: '5 cx', foo: 'b', prazo: 3 } }))
      .toEqual({ ultima: { texto: 'a?', slot: null, em: 'e' }, respondidos: { volume: '5 cx' } })
  })
})
