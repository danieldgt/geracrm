import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_VAZIO, LIMITES_COMPLIANCE, TEXTO_RETOMADA, TEXTO_SEGURO,
  ajustarMensagemHandoff, aplicarLimitesMensagem, complianceExtra, complianceExtraCompleto, filtrarSaida, lerComplianceExtra,
  regexLiteral, semDuplicatas, termoNegado,
} from './agente-filtro.js'

const intacto = (t: string) => ({ texto: t, alterado: false, ocorrencias: [], esvaziado: false })
const ids = (t: string, extras?: string[]) => filtrarSaida(t, { extras }).ocorrencias.map((o) => o.id)

describe('filtro de saída — negação explícita não é promessa', () => {
  it.each([
    'Não garantimos entrega amanhã, mas o pedido sai hoje pela transportadora. Quer que eu feche?',
    'O prazo não é garantido; depende da transportadora. Posso consultar para você?',
    'Nunca garantimos estoque sem conferir no sistema. Quer que eu confira agora?',
    'Ninguém consegue garantir prazo de entrega nessa época. Posso ver a previsão da transportadora?',
    'É uma previsão, sem garantia de prazo. Faz sentido?',
    'Infelizmente não posso dar desconto por aqui. Quer que eu chame o vendedor?',
    'Não consigo baixar o preço, essa é a tabela do seu perfil. Posso ajudar com outra coisa?',
    'A gente não tem o melhor preço do mercado em tudo, mas a tabela de atacado é boa. Quer ver?',
    'Não temos frete grátis para a sua região. Quer o valor do frete?',
    'Não trabalhamos com consignação. Posso te mostrar as formas de pagamento?',
  ])('mantém: %s', (t) => {
    expect(filtrarSaida(t, { extras: ['consignação'] })).toEqual(intacto(t))
  })
})

describe('filtro de saída — promessas afirmativas saem', () => {
  it.each([
    ['Garantimos entrega amanhã. Posso fechar?', 'garantia_sem_fonte'],
    ['A gente garante o prazo de 3 dias. Bora?', 'garantia_sem_fonte'],
    ['Posso garantir o estoque para você. Fechamos?', 'garantia_sem_fonte'],
    ['Não se preocupe que garantimos a entrega. Fechamos?', 'garantia_sem_fonte'],
    ['Não se preocupe, a entrega é garantida. Fechamos?', 'garantido'],
    ['Não tem como não ser garantido o prazo. Fechamos?', 'garantido'],
    ['Seu crédito está garantido. Fechamos?', 'garantido'],
    ['Com garantia de entrega no sábado! Fechamos?', 'garantia_de'],
    ['Chega amanhã sem falta. Fechamos?', 'entrega_sem_falta'],
    ['Com certeza chega até sexta. Fechamos?', 'entrega_sem_falta'],
    ['Sempre temos estoque desse item. Fechamos?', 'estoque_infinito'],
    ['Aqui nunca falta estoque. Fechamos?', 'estoque_infinito'],
    ['O preço fica congelado até o fim do ano. Fechamos?', 'preco_congelado'],
    ['Temos o melhor preço do mercado. Fechamos?', 'melhor_preco_do_mercado'],
    ['Somos os mais baratos da região. Fechamos?', 'melhor_preco_do_mercado'],
    ['Cobrimos qualquer oferta. Fechamos?', 'melhor_preco_do_mercado'],
    ['Ninguém faz mais barato que a gente. Fechamos?', 'ninguem_mais_barato'],
    ['Posso te dar um desconto se fechar hoje. Fechamos?', 'oferece_desconto'],
    ['Consigo um descontinho para você. Fechamos?', 'oferece_desconto'],
    ['Não dou desconto, mas consigo melhorar o preço. Fechamos?', 'baixa_preco'],
    ['Faço por menos se levar duas caixas. Fechamos?', 'baixa_preco'],
    ['São as últimas unidades! Fechamos?', 'escassez_sem_fonte'],
    ['Essa condição é só hoje. Fechamos?', 'urgencia_falsa'],
    ['Aproveita agora antes que acabe. Fechamos?', 'urgencia_falsa'],
    ['Não sou um robô, sou a Lia. Fechamos?', 'nega_ser_ia'],
    ['Você está falando com uma pessoa de verdade. Fechamos?', 'finge_ser_humano'],
  ])('remove: %s', (t, id) => {
    const r = filtrarSaida(t)
    expect(r.alterado).toBe(true)
    expect(r.ocorrencias.map((o) => o.id)).toContain(id)
    expect(r.ocorrencias.find((o) => o.id === id)).toMatchObject({ gravidade: 'CRITICA', acao: 'removido' })
    expect(r.texto).toMatch(/^(Fechamos\?|Posso fechar\?|Bora\?)$/)
    expect(r.texto).not.toMatch(/garant|desconto|certeza|sem falta|barat|melhor pre|congelad|robô|pessoa de verdade|unidades|só hoje/i)
  })

  it.each([
    'Garantimos que chega amanhã. Fechamos?',
    'Te garanto que chega sexta. Fechamos?',
    'Garantimos que não vai faltar estoque. Fechamos?',
    'Asseguramos a entrega amanhã. Fechamos?',
    'Prometemos entrega amanhã. Fechamos?',
    'Prometo que chega amanhã. Fechamos?',
    'Eu garanto o seu pedido na sexta. Fechamos?',
  ])('promessa com "que", te/lhe, assegurar ou prometer também sai: %s', (t) => {
    const r = filtrarSaida(t)
    expect(r.texto).toBe('Fechamos?')
    expect(r.ocorrencias.map((o) => o.id)).toEqual(['garantia_sem_fonte'])
  })

  it('compromisso de encaminhar, fato registrado e restrição honesta NÃO são promessa', () => {
    for (const t of [
      'Prometo verificar o prazo com a transportadora.',
      'Garanto que o pedido foi registrado.',
      'Asseguramos que o pedido é conferido antes do envio.',
      'Prometo te retornar sobre o pedido.',
      'Prometo que hoje confiro o estoque.',
      'Prometo que amanhã cedo eu verifico.',
      'Garanto que amanhã te retorno.',
      'Garanto que hoje mesmo o vendedor te chama.',
      'Garantimos o atendimento de segunda a sexta.',
    ]) expect(filtrarSaida(t)).toEqual(intacto(t))
  })

  it.each([
    'Te garanto: chega amanhã.',
    'Garanto, chega amanhã.',
    'A gente só garante entrega amanhã.',
    'Só garantimos entrega amanhã se fechar até as 14h.',
    'Hoje só prometemos entrega para sexta.',
    'Só garantimos o prazo depois do faturamento.',
    'Só a gente garante entrega amanhã.',
    'Garanto que verifico e chega sexta.',
    'Garanto que amanhã o vendedor confirma e chega sexta.',
    'Garantimos, com toda a certeza, a entrega amanhã.',
    'Garantimos (pode confiar) a entrega amanhã.',
    'Garanto que o seu pedido de 10 caixas chega na sexta.',
    'Garantimos que o produto que você pediu ontem vai chegar amanhã.',
  ])('restrição, pontuação ou encaminhamento seguido de promessa não abonam: %s', (t) => {
    expect(ids(t)).toEqual(['garantia_sem_fonte'])
  })

  it('garantia do PRODUTO não é promessa de entrega', () => {
    for (const t of [
      'O produto tem garantia de fábrica de 12 meses. Quer ver o manual?',
      'A garantia do fabricante cobre defeito de fabricação. Posso ajudar com mais algo?',
      'Não prometemos entrega amanhã; o prazo é o da transportadora. Fechamos?',
    ]) expect(filtrarSaida(t)).toEqual(intacto(t))
  })

  it('escassez só passa com estoque de fonte no turno', () => {
    const t = 'Restam poucas unidades em estoque segundo o sistema.'
    expect(ids(t)).toEqual(['escassez_sem_fonte'])
    expect(filtrarSaida(t, { estoqueComFonte: true })).toEqual(intacto(t))
    // urgência de tempo continua vetada mesmo com estoque de fonte
    expect(filtrarSaida('Essa condição é só hoje.', { estoqueComFonte: true }).ocorrencias.map((o) => o.id)).toEqual(['urgencia_falsa'])
  })

  it('a negação olha só a oração do termo', () => {
    const f = 'Não, a entrega é garantida'
    expect(termoNegado(f, f.indexOf('garantida'))).toBe(false)
    const g = 'não damos garantia de prazo'
    expect(termoNegado(g, g.indexOf('garantia'))).toBe(true)
    const h = 'sem garantia de prazo'
    expect(termoNegado(h, h.indexOf('garantia'))).toBe(true)
    const i = 'sem nenhuma dúvida garantimos'
    expect(termoNegado(i, i.indexOf('garantimos'))).toBe(false) // dupla negação = afirmação
    const j = 'não se preocupe que garantimos'
    expect(termoNegado(j, j.indexOf('garantimos'))).toBe(false) // conectivo no meio
    const k = 'não é nem um pouco garantido'
    expect(termoNegado(k, k.indexOf('garantido'))).toBe(false) // mais de 2 palavras entre
  })

  it('encaminhar ao vendedor não é oferecer desconto', () => {
    for (const t of [
      'Posso verificar se há desconto para volume com o vendedor. Quer?',
      'Posso pedir ao vendedor uma condição especial para esse volume. Quer?',
      'Vou consultar se existe desconto para o seu perfil. Tudo bem?',
    ]) expect(filtrarSaida(t)).toEqual(intacto(t))
  })

  it('dentro do texto, só a frase proibida sai; o resto fica e a capitalização é refeita', () => {
    const r = filtrarSaida('Temos o item no catálogo. Garantimos entrega amanhã. qual a quantidade?')
    expect(r.texto).toBe('Temos o item no catálogo. Qual a quantidade?')
    expect(r.ocorrencias).toEqual([{ id: 'garantia_sem_fonte', gravidade: 'CRITICA', acao: 'removido', trecho: 'Garantimos entrega amanhã.' }])
  })

  it('tudo removido → texto seguro e esvaziado', () => {
    const r = filtrarSaida('Garantimos entrega amanhã!')
    expect(r).toMatchObject({ texto: TEXTO_SEGURO, alterado: true, esvaziado: true })
  })
})

describe('filtro de saída — consentimento, hesitação e notas', () => {
  it('pedido de consentimento sai (ALTA) com a confirmação solta que sobra', () => {
    const r = filtrarSaida('Anotei o pedido. Posso guardar seus dados no sistema? Tudo bem pra você? Qual a quantidade?')
    expect(r.texto).toBe('Anotei o pedido. Qual a quantidade?')
    expect(r.ocorrencias).toEqual([expect.objectContaining({ id: 'pede_consentimento', gravidade: 'ALTA', acao: 'removido' })])
  })

  it('pedir permissão para atender sai', () => {
    expect(ids('Oi! Você autoriza que eu te atenda por aqui? Qual produto procura?')).toEqual(['pede_consentimento'])
  })

  it('coletar dado de cadastro B2B NÃO é pedido de consentimento', () => {
    for (const t of [
      'Para fechar o pedido, posso anotar seu CNPJ?',
      'Vou cadastrar seu CNPJ e já te mando a proposta.',
      'Vou salvar seu e-mail no cadastro.',
      'Posso cadastrar seu endereço de entrega?',
    ]) expect(filtrarSaida(t)).toEqual(intacto(t))
  })

  it.each([
    'Provavelmente chega amanhã.',
    'Acho que temos em estoque.',
    'Acredito que o preço é esse.',
    'Quem sabe sai ainda esta semana.',
  ])('hesitação + afirmação de negócio: a frase INTEIRA sai (ALTA) — %s', (t) => {
    const r = filtrarSaida(`${t} Quer que eu confira?`)
    expect(r.texto).toBe('Quer que eu confira?')
    expect(r.ocorrencias).toEqual([expect.objectContaining({ id: 'hesitacao_em_afirmacao', gravidade: 'ALTA', acao: 'removido' })])
  })

  it.each([
    ['Quem sabe você tem interesse no modelo novo?', 'Você tem interesse no modelo novo?'],
    ['Quem sabe o catálogo tem o que você procura?', 'O catálogo tem o que você procura?'],
    ['Acho que o vendedor consegue te ajudar com o prazo.', 'O vendedor consegue te ajudar com o prazo.'],
    ['Provavelmente o vendedor sabe te dizer o valor.', 'O vendedor sabe te dizer o valor.'],
  ])('pergunta ou encaminhamento: só a locução sai, a frase fica — %s', (t, esperado) => {
    const r = filtrarSaida(t)
    expect(r.texto).toBe(esperado)
    expect(r.ocorrencias.every((o) => o.gravidade === 'INFO' && o.acao === 'reescrito')).toBe(true)
  })

  it.each([
    'Acho que chega amanhã, ok?',
    'Provavelmente chega amanhã, tudo bem?',
    'Acho que temos estoque, quer fechar?',
    'Acho que chega amanhã e o vendedor confirma.',
    'Provavelmente sai hoje; a equipe confirma o horário.',
    'Acho que chega amanhã?',
  ])('hesitação + promessa em pergunta ou com quem encaminha: frase INTACTA, só registrada — %s', (t) => {
    expect(filtrarSaida(t)).toEqual({
      texto: t, alterado: false, esvaziado: false,
      ocorrencias: [{ id: 'hesitacao_em_afirmacao', gravidade: 'INFO', acao: 'registrado', trecho: t }],
    })
  })

  it('a transportadora como sujeito de promessa ainda é promessa', () => {
    expect(ids('Acho que a transportadora entrega amanhã.')).toEqual(['hesitacao_em_afirmacao'])
    expect(ids('Acredito que o prazo fica em 3 dias.')).toEqual(['hesitacao_em_afirmacao'])
    expect(ids('Acho que temos umas 10 caixas.')).toEqual(['hesitacao_em_afirmacao'])
  })

  it('hesitação sem afirmação de negócio: corta a locução; "talvez" não é cortado, só registrado', () => {
    const r = filtrarSaida('Eu acho que esse modelo combina com a sua loja.')
    expect(r.texto).toBe('Esse modelo combina com a sua loja.')
    expect(r.ocorrencias.map((o) => [o.id, o.gravidade, o.acao])).toEqual([['hesitacao_acho_que', 'INFO', 'reescrito']])

    const talvez = 'Talvez o modelo de 2 litros sirva.'
    expect(filtrarSaida(talvez)).toEqual({
      texto: talvez, alterado: false, esvaziado: false,
      ocorrencias: [{ id: 'hesitacao_talvez', gravidade: 'INFO', acao: 'registrado', trecho: 'Talvez' }],
    })
    expect(filtrarSaida('Talvez.')).toMatchObject({ texto: 'Talvez.', alterado: false, esvaziado: false })
  })

  it('"frete grátis" sem condição ganha a ressalva; com condição ou negado, não', () => {
    const r = filtrarSaida('O frete grátis vale para você. Fechamos?')
    expect(r.texto).toBe('O frete grátis (conforme a política de frete) vale para você. Fechamos?')
    expect(r.ocorrencias).toEqual([expect.objectContaining({ id: 'frete_gratis_sem_condicao', gravidade: 'MEDIA', acao: 'anexado' })])
    const c = 'Frete grátis para pedidos acima do mínimo da política. Fechamos?'
    expect(filtrarSaida(c)).toEqual(intacto(c))
  })

  it('a ressalva vale por frase: condição em outra frase não cobre o "frete grátis"', () => {
    const r = filtrarSaida('Tem pedido mínimo de R$ 300,00. O frete grátis é para você. Consulte o vendedor.')
    expect(r.texto).toBe('Tem pedido mínimo de R$ 300,00. O frete grátis (conforme a política de frete) é para você. Consulte o vendedor.')
  })
})

describe('filtro de saída — extras do número só acrescentam', () => {
  it('extra literal casa sem acento e sem caixa, com a mesma regra de negação', () => {
    expect(ids('Trabalhamos com CONSIGNACAO sim. Quer?', ['consignação'])).toEqual(['extra:consignacao'])
    const negado = 'Não trabalhamos com consignação. Quer?'
    expect(filtrarSaida(negado, { extras: ['consignação'] })).toEqual(intacto(negado))
  })

  it('extra não desliga a base: lista vazia ou estranha continua filtrando', () => {
    expect(ids('Garantimos entrega amanhã. Quer?', [])).toEqual(['garantia_sem_fonte'])
    expect(ids('Garantimos entrega amanhã. Quer?', ['', ' '])).toEqual(['garantia_sem_fonte'])
  })

  it('caractere de regex no extra é literal', () => {
    expect(regexLiteral('a.b*').test('axbbb')).toBe(false)
    expect(regexLiteral('a.b*').test('a.b*')).toBe(true)
    expect(ids('Pague 50% na entrega. Quer?', ['50%'])).toEqual(['extra:50%'])
  })
})

describe('limites de mensagem (estilo)', () => {
  it('máximo de perguntas mantém a última', () => {
    const r = aplicarLimitesMensagem('Qual a cor? Qual o tamanho? Quantas caixas?', { maxPerguntas: 1 })
    expect(r.texto).toBe('Quantas caixas?')
    expect(r.ocorrencias.map((o) => o.id)).toEqual(['max_perguntas'])
  })

  it('máximo de caracteres preserva a última pergunta', () => {
    const r = aplicarLimitesMensagem('Temos o item. Ele vem em caixa com 12. Quantas caixas?', { maxCaracteres: 30 })
    expect(r.texto.length).toBeLessThanOrEqual(30)
    expect(r.texto).toContain('Quantas caixas?')
  })

  it('pelo filtro, com limites', () => {
    const r = filtrarSaida('Qual a cor? Qual o tamanho?', { limites: { maxPerguntas: 1 } })
    expect(r).toMatchObject({ texto: 'Qual o tamanho?', alterado: true })
  })
})

describe('ajustarMensagemHandoff', () => {
  it('tira promessa de prazo e garante que alguém da equipe retoma', () => {
    const r = ajustarMensagemHandoff('Vou te passar para o vendedor. Ele te responde em 5 minutos.')
    expect(r.texto).toBe('Vou te passar para o vendedor.')
    expect(r.ocorrencias.map((o) => o.id)).toEqual(['promessa_prazo_handoff'])
  })

  it('sem quem retoma, anexa a retomada', () => {
    const r = ajustarMensagemHandoff('Já já te respondem!')
    expect(r.texto).toBe(TEXTO_RETOMADA)
    expect(r.ocorrencias.map((o) => o.id)).toEqual(['promessa_prazo_handoff', 'retomada_handoff'])
  })

  it('semNumeros tira frase com número de negócio', () => {
    const r = ajustarMensagemHandoff('Sai por R$ 10,00 a caixa. A equipe confirma com você.', { semNumeros: true })
    expect(r.texto).toBe('A equipe confirma com você.')
  })

  it('mensagem boa passa sem alteração; retomada pode ser desligada', () => {
    expect(ajustarMensagemHandoff('Vou chamar um vendedor da equipe para te ajudar.')).toMatchObject({ alterado: false, ocorrencias: [] })
    expect(ajustarMensagemHandoff('Certo.', { anexarRetomada: false })).toMatchObject({ texto: 'Certo.', alterado: false })
  })
})

describe('ComplianceExtra', () => {
  it('valida limites: ≤50 itens, cada um ≤80 caracteres', () => {
    expect(complianceExtra.safeParse({ frasesProibidas: Array(LIMITES_COMPLIANCE.maxItens + 1).fill('xxx') }).success).toBe(false)
    expect(complianceExtra.safeParse({ frasesProibidas: ['x'.repeat(81)] }).success).toBe(false)
    expect(complianceExtra.parse({})).toEqual(COMPLIANCE_VAZIO)
    expect(complianceExtra.safeParse({ frasesProibidas: ['ab'] }).success).toBe(false) // mínimo de 3
    // PUT: os dois campos obrigatórios (corpo parcial não apaga o outro por default)
    expect(complianceExtraCompleto.safeParse({ frasesProibidas: [] }).success).toBe(false)
    expect(complianceExtraCompleto.safeParse({ frasesProibidas: [], gatilhosHandoff: [], x: 1 }).success).toBe(false)
    expect(complianceExtraCompleto.safeParse({ frasesProibidas: [], gatilhosHandoff: [] }).success).toBe(true)
  })

  it('leitura tolerante descarta item inválido e duplicado, nunca lança', () => {
    expect(lerComplianceExtra(null)).toEqual(COMPLIANCE_VAZIO)
    expect(lerComplianceExtra({ frasesProibidas: ['Consignação', 'consignacao', 3, 'x'.repeat(200), 'ab'], gatilhosHandoff: 'oi' }))
      .toEqual({ frasesProibidas: ['Consignação'], gatilhosHandoff: [] })
  })

  it('semDuplicatas compara sem acento e caixa', () => {
    expect(semDuplicatas([' Frete  Grátis ', 'frete gratis', 'Boleto'])).toEqual(['Frete Grátis', 'Boleto'])
  })
})
