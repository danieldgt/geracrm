import { describe, it, expect } from 'vitest'
import {
  detectarOptOut, detectarPedidoHumano, detectarReclamacao, detectarPerguntaRobo, gatilhoExtra,
  detectarGatilhoDeEntrada, textoAbertura, textoRobo, textoOptOut, textoHandoffGatilho, contemAvisoPrivacidade,
  textoAvisoPrivacidade, FRASE_REGISTRO_CONVERSA,
} from './agente-gatilhos.js'

/**
 * ⚠️ Falso opt-out é o erro mais caro: cada frase da revisão adversarial da P4
 *    virou um caso aqui. Na dúvida a regra devolve `possivel_opt_out` (pessoa),
 *    nunca `opt_out` (bloqueio).
 */
describe('detectarOptOut — o que é opt-out CLARO', () => {
  it.each(['pare', 'PARE!', 'Sair', 'stop', 'descadastrar', 'quero me descadastrar',
    'não quero mais receber mensagens', 'Para de me mandar mensagem', 'parem de me enviar isso', 'me tira dessa lista',
    'nao desejo receber', 'não quero mais receber', 'não quero mais receber essas promoções', 'pare de me mandar mensagem por favor',
    'não me mande mais nada', 'não quero mais que vocês me mandem mensagem',
    // (b) formas explícitas da re-revisão
    'não quero mais mensagem', 'não quero mais mensagens', 'não quero mais msg', 'não quero mais contato', 'nao quero mais mensagens de vocês',
    'chega de mensagem', 'chega de mensagens', 'chega de propaganda', 'chega de promoção', 'chega de oferta',
    'quero parar de receber mensagens', 'gostaria de parar de receber isso', 'parar de receber mensagens', 'não receber mais nada',
    'não me manda mais', 'não me chama mais', 'quero sair da lista', 'sair da sua lista',
    // (c) a palavra com fecho de cortesia
    'pare por favor', 'pare, obrigado'])(
    'dado "%s", então é opt-out', (t) => expect(detectarOptOut(t)).toBe('opt_out'))

  it('dado pedido de apagar os dados junto, então é exclusão LGPD', () => {
    expect(detectarOptOut('apaguem os meus dados, não quero mais receber')).toBe('lgpd_exclusao')
    expect(detectarOptOut('quero que apaguem meus dados pessoais')).toBe('lgpd_exclusao')
  })
})

describe('detectarOptOut — ambíguo vai para uma PESSOA (possivel_opt_out), nunca para o bloqueio', () => {
  it.each([
    // revisão 1: verbo de parar + mercadoria/pagamento — nunca bloqueia; e o modelo também não segue vendendo
    'não quero receber em caixa', 'não quero receber o pedido em caixa', 'não quero receber boleto, só pix',
    'nao quero mais receber a mercadoria com atraso', 'não desejo receber nota fiscal impressa',
    'não quero mais receber essa marca', 'pare de me mandar boleto errado', 'parem de me enviar produto vencido',
    'pare de mandar mensagem errada pro meu financeiro', 'não quero mais que você me mande o boleto por email',
    'não quero mais receber a entrega na loja 2',
    'apaga meus dados do cartão antigo', 'pode remover meus dados bancários antigos', 'descadastrar o meu cartão antigo',
    'me tira dessa lista de espera',
    // re-revisão (a): falsos negativos — opt-out com palavra de negócio no meio
    'não quero mais receber mensagens dessa loja', 'não quero mais receber promoção de produtos',
    'para de mandar mensagem por favor, não tenho interesse em produtos', 'descadastrar meu número do whatsapp da loja',
    // re-revisão (d): palavra solta
    'para', 'Para!', 'parar', 'chega', 'chega.', 'Chega!',
    // verbo de parar sem objeto de mensagem
    'não quero mais receber essas coisas', 'para de me mandar esses links', 'não quero receber ligação', 'não me chama mais de senhor',
  ])('dado "%s", então é possivel_opt_out', (t) => expect(detectarOptOut(t)).toBe('possivel_opt_out'))
})

describe('detectarOptOut — sem verbo de parar, não é opt-out', () => {
  it.each(['cancelar pedido', 'quero cancelar o pedido', 'cancelar', 'pode parar o pedido', 'desisti da compra',
    'para quando chega?', 'chega amanhã?', 'para mim está bom', 'quero 2 caixas para revenda', 'quero mais mensagens de promoção'])(
    'dado "%s", então é null', (t) => expect(detectarOptOut(t)).toBeNull())
})

describe('pedido de humano', () => {
  it.each(['quero falar com um atendente', 'posso conversar com o vendedor?', 'me liga', 'prefiro um humano',
    'me passa pro gerente', 'pode me ligar?', 'preciso falar com alguém', 'quero um atendente'])(
    'dado "%s", então pede humano', (t) => expect(detectarPedidoHumano(t)).toBe(true))
  it.each(['o técnico me liga depois', 'me liga amanhã quando chegar', 'vou conversar com o vendedor depois',
    'preciso falar com o gerente da minha loja antes', 'quero 10 camisetas G', 'o vendedor de vocês me ligou ontem'])(
    'dado "%s", então NÃO pede humano', (t) => expect(detectarPedidoHumano(t)).toBe(false))
})

describe('ameaça formal (reclamação)', () => {
  it.each(['vou no Procon', 'vou te processar', 'vou abrir reclamação no Reclame Aqui', 'vou processar vocês',
    'isso vai acabar num processo judicial', 'vou resolver na justiça', 'vou acionar meu advogado', 'vou processar a loja'])(
    'dado "%s", então é ameaça formal', (t) => expect(detectarReclamacao(t)).toBe(true))
  it.each(['pode processar o pedido', 'jurídico precisa da nota', 'meu advogado pediu nota', 'quero 10 camisetas G',
    'o pedido está em processamento?'])(
    'dado "%s", então NÃO é', (t) => expect(detectarReclamacao(t)).toBe(false))
})

describe('detectarPerguntaRobo', () => {
  it.each(['é robô?', 'Você é um bot?', 'to falando com uma máquina', 'vc é ia', 'você é pessoa de verdade?',
    'isso é inteligência artificial?', 'robô?', 'é robô mesmo?', 'aqui é bot?', 'será que é um robô'])(
    'dado "%s", então pergunta se é robô', (t) => expect(detectarPerguntaRobo(t)).toBe(true))
  it.each(['quero 3 camisetas', 'robótica é legal', 'qual o prazo?', 'a máquina de cartão quebrou?',
    'o robô de limpeza que comprei chegou?', 'a máquina de costura é bivolt?', 'tem bot de pedido?'])(
    'dado "%s", então não', (t) => expect(detectarPerguntaRobo(t)).toBe(false))
})

describe('gatilhoExtra', () => {
  it('casa literal sem acento/caixa e palavra inteira; lista vazia nunca casa', () => {
    expect(gatilhoExtra('Preciso da NOTA FISCAL', ['nota fiscal'])).toBe('nota fiscal')
    expect(gatilhoExtra('preciso da nota', ['nota fiscal'])).toBeNull()
    expect(gatilhoExtra('trocar', ['troca'])).toBeNull()
    expect(gatilhoExtra('qualquer', [])).toBeNull()
    expect(gatilhoExtra('qualquer', undefined)).toBeNull()
  })
})

describe('detectarGatilhoDeEntrada — precedência', () => {
  it('opt-out vence tudo; ambíguo é possivel_opt_out; ameaça vence humano; humano vence "é robô?"', () => {
    expect(detectarGatilhoDeEntrada('pare')).toBe('opt_out')
    expect(detectarGatilhoDeEntrada('não quero mais receber essas coisas')).toBe('possivel_opt_out')
    expect(detectarGatilhoDeEntrada('quero falar com um atendente, vou no procon')).toBe('reclamacao')
    expect(detectarGatilhoDeEntrada('é robô? quero falar com um atendente')).toBe('pedido_humano')
    expect(detectarGatilhoDeEntrada('é robô?')).toBe('pergunta_robo')
    expect(detectarGatilhoDeEntrada('preciso de boleto', ['boleto'])).toBe('extra')
    expect(detectarGatilhoDeEntrada('cancelar pedido')).toBeNull()
  })
})

describe('textos fixos', () => {
  const id = { assistenteNome: 'Lia', loja: 'Loja Teste' }
  it('abertura identifica a assistente virtual, a loja e exibe o aviso de privacidade', () => {
    const t = textoAbertura({ ...id, clienteNome: 'Ana Maria', privacidade: { url: 'https://loja.test/privacidade' } })
    expect(t).toMatch(/^Oi, Ana!/)
    expect(t).toContain('Sou Lia, assistente virtual da Loja Teste')
    expect(t).toContain('inteligência artificial')
    expect(t).toContain('https://loja.test/privacidade')
    expect(contemAvisoPrivacidade(t, { url: 'https://loja.test/privacidade' })).toBe(true)
  })
  it('abertura sem configuração usa a frase de registro, que conta como aviso', () => {
    const t = textoAbertura({ assistenteNome: 'Lia' })
    expect(t).toContain(FRASE_REGISTRO_CONVERSA)
    expect(t).toContain('da loja')
    expect(contemAvisoPrivacidade(t)).toBe(true)
  })
  it('aviso com texto padrão do tenant e link', () => {
    expect(textoAvisoPrivacidade({ textoPadrao: 'Tratamos seus dados conforme a LGPD.', url: 'https://x.test/p' }))
      .toBe('Tratamos seus dados conforme a LGPD. Aviso de privacidade: https://x.test/p')
    expect(contemAvisoPrivacidade('oi, tudo bem?', { url: 'https://x.test/p' })).toBe(false)
  })
  it('"é robô?" confirma que é IA e oferece uma pessoa — nunca nega', () => {
    const t = textoRobo(id)
    expect(t).toContain('inteligência artificial')
    expect(t).not.toMatch(/não sou (um |uma )?(robô|ia|bot)/i)
    expect(t).toMatch(/pessoa da equipe/)
  })
  it('confirmação de opt-out e aviso de transferência não prometem prazo', () => {
    for (const t of [textoOptOut({ clienteNome: 'Ana' }), textoOptOut({ exclusao: true }),
      textoHandoffGatilho({ foraDoExpediente: true }), textoHandoffGatilho({ foraDoExpediente: false })]) {
      expect(t).not.toMatch(/\b(em \d+|já já|em breve|ainda hoje|minutos?)\b/i)
    }
    expect(textoOptOut({ clienteNome: 'Ana Maria' })).toBe('Certo, Ana. Não vamos mais te enviar mensagens por aqui.')
  })
})
