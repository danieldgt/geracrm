import { describe, it, expect } from 'vitest'
import {
  detectarOptOut, detectarPedidoHumano, detectarReclamacao, detectarPerguntaRobo, gatilhoExtra,
  detectarGatilhoDeEntrada, textoAbertura, textoRobo, textoOptOut, textoHandoffGatilho, contemAvisoPrivacidade,
  textoAvisoPrivacidade, FRASE_REGISTRO_CONVERSA,
} from './agente-gatilhos.js'

describe('detectarOptOut', () => {
  it.each(['pare', 'PARE!', 'Sair', 'stop', 'chega.', 'não quero mais receber mensagens', 'Para de me mandar mensagem',
    'parem de me enviar isso', 'me tira dessa lista', 'quero me descadastrar', 'nao desejo receber'])(
    'dado "%s", então é opt-out', (t) => expect(detectarOptOut(t)).toBe('opt_out'))

  it('dado pedido de apagar os dados, então é exclusão LGPD', () => {
    expect(detectarOptOut('apaguem os meus dados, não quero mais receber')).toBe('lgpd_exclusao')
  })

  it.each(['cancelar pedido', 'quero cancelar o pedido', 'cancelar', 'pode parar o pedido', 'desisti da compra',
    'para quando chega?', 'chega amanhã?', 'para mim está bom', 'quero parar de comprar fiado? não, só perguntando',
    'quero 2 caixas para revenda'])(
    'dado "%s", então NÃO é opt-out', (t) => expect(detectarOptOut(t)).toBeNull())
})

describe('pedido de humano e reclamação', () => {
  it.each(['quero falar com um atendente', 'posso conversar com o vendedor?', 'me liga', 'prefiro um humano', 'me passa pro gerente'])(
    'dado "%s", então pede humano', (t) => expect(detectarPedidoHumano(t)).toBe(true))
  it.each(['vou no Procon', 'vou te processar', 'vou abrir reclamação no Reclame Aqui', 'meu advogado vai ligar', 'isso é caso jurídico'])(
    'dado "%s", então é reclamação', (t) => expect(detectarReclamacao(t)).toBe(true))
  it('frase comum de compra não aciona nenhum dos dois', () => {
    expect(detectarPedidoHumano('quero 10 camisetas G')).toBe(false)
    expect(detectarReclamacao('quero 10 camisetas G')).toBe(false)
  })
})

describe('detectarPerguntaRobo', () => {
  it.each(['é robô?', 'Você é um bot?', 'to falando com uma máquina', 'vc é ia', 'você é pessoa de verdade?', 'isso é inteligência artificial?'])(
    'dado "%s", então pergunta se é robô', (t) => expect(detectarPerguntaRobo(t)).toBe(true))
  it.each(['quero 3 camisetas', 'robótica é legal', 'qual o prazo?'])(
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
  it('opt-out vence tudo; reclamação vence pedido de humano; humano vence "é robô?"', () => {
    expect(detectarGatilhoDeEntrada('pare')).toBe('opt_out')
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
