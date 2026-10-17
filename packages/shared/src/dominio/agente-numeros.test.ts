import { describe, it, expect } from 'vitest'
import {
  extrairNumerosDeNegocio, numeroBr, numeroPorExtenso, numerosDeSaida, numerosDoTexto, numerosSemFonte,
  percentuaisDeSaida, percentuaisDoTexto, NumerosVistos,
} from './agente-numeros.js'

const tipos = (t: string) => extrairNumerosDeNegocio(t).map((n) => `${n.tipo}:${n.valor}${n.bloqueante ? '!' : ''}`)

describe('numeroBr e por extenso', () => {
  it('lê o formato pt-BR', () => {
    expect(numeroBr('1.234,5')).toBe(1234.5)
    expect(numeroBr('1.234')).toBe(1234)
    expect(numeroBr('1,5')).toBe(1.5)
    expect(numeroBr('12')).toBe(12)
  })
  it('lê por extenso', () => {
    expect(numeroPorExtenso('dez')).toBe(10)
    expect(numeroPorExtenso('vinte e cinco')).toBe(25)
    expect(numeroPorExtenso('banana')).toBeNaN()
  })
})

describe('extrairNumerosDeNegocio — cada tipo', () => {
  it('percentual: "10%", "10 %", "12,5%", "dez por cento" — sempre bloqueante', () => {
    expect(tipos('Te dou 10% de desconto')).toEqual(['percentual:10!'])
    expect(tipos('fica com 10 % off')).toEqual(['percentual:10!'])
    expect(tipos('juros de 12,5% ao mês')).toEqual(['percentual:12.5!'])
    expect(tipos('consigo dez por cento')).toEqual(['percentual:10!'])
    expect(tipos('15 por cento à vista')).toEqual(['percentual:15!'])
  })
  it('quantidade afirmada como estoque é bloqueante; com unidade solta é ALTA', () => {
    expect(tipos('Temos 12 unidades da verde.')).toEqual(['quantidade:12!'])
    expect(tipos('temos 1.200 peças em estoque')).toEqual(['quantidade:1200!'])
    expect(tipos('só tenho 5 pares')).toEqual(['quantidade:5!'])
    expect(tipos('são 30 disponíveis')).toEqual(['quantidade:30!'])
    expect(tipos('o saldo de 40 já está separado')).toEqual(['quantidade:40!'])
    expect(tipos('Temos 8.')).toEqual(['quantidade:8!'])
    expect(tipos('posso separar 10 unidades')).toEqual(['quantidade:10'])
    expect(tipos('pedido mínimo de 6 peças')).toEqual(['quantidade:6'])
  })
  it('prazo em dias: com compromisso (entrega, envio, boleto) é bloqueante; intervalo rende os dois', () => {
    expect(tipos('A entrega é em 3 dias úteis')).toEqual(['prazo_dias:3!'])
    expect(tipos('chega em 3 a 5 dias úteis')).toEqual(['prazo_dias:3!', 'prazo_dias:5!'])
    expect(tipos('boleto para 30 dias')).toEqual(['prazo_dias:30!'])
    expect(tipos('enviamos em dois dias')).toEqual(['prazo_dias:2!'])
    expect(tipos('a proposta vale por 2 dias')).toEqual(['prazo_dias:2'])
    expect(extrairNumerosDeNegocio('entrega em 2 semanas')[0]).toMatchObject({ valor: 2, unidade: 'semana', bloqueante: true })
  })
  it('prazo em horas: "48 horas", "em 24h", "72h"', () => {
    expect(tipos('despachamos em 48 horas')).toEqual(['prazo_horas:48!'])
    expect(tipos('o envio sai em até 24h')).toEqual(['prazo_horas:24!'])
    expect(tipos('posto em 72h')).toEqual(['prazo_horas:72!'])
  })
})

describe('extrairNumerosDeNegocio — o que NÃO é número de negócio', () => {
  const vazio = (t: string) => expect(extrairNumerosDeNegocio(t), t).toEqual([])
  it('hora', () => {
    vazio('A loja abre às 9 e fecha às 18h')
    vazio('posso te ligar 14h30?')
    vazio('atendemos das 8 às 18 horas')
    vazio('o motoboy passa até 18h')
    vazio('combinado para 14:30')
  })
  it('data', () => {
    vazio('o boleto vence 12/10')
    vazio('entregue em 12/10/2026')
    vazio('chega dia 15')
    vazio('até 15 de outubro')
  })
  it('telefone, CNPJ, CPF, CEP', () => {
    vazio('me liga no (85) 99999-0001')
    vazio('whats 5585999990001')
    vazio('CNPJ 12.345.678/0001-90')
    vazio('CPF 123.456.789-09')
    vazio('CEP 60000-000 para entrega')
  })
  it('nº do pedido, nota e SKU/referência', () => {
    vazio('seu pedido 1234 foi registrado')
    vazio('pedido nº 4321 confirmado')
    vazio('protocolo #98765')
    vazio('a referência CAM-001 é a verde')
    vazio('o SKU AB123 está ok')
    vazio('ref. 4455 tamanho G')
  })
  it('dinheiro fica com o guardrail de R$; contagens sem unidade não contam', () => {
    vazio('fica R$ 49,90 cada')
    vazio('são 100 reais')
    vazio('temos 2 cores e 3 modelos')
    vazio('um dia desses te mando')
  })
  it('mistura: só o número de negócio sai', () => {
    expect(tipos('Pedido 1234: entrega em 3 dias úteis no CEP 60000-000, às 14h')).toEqual(['prazo_dias:3!'])
  })
})

describe('fontes', () => {
  it('numerosDoTexto lê dígitos e extenso (sem "um")', () => {
    expect([...numerosDoTexto('Entrega em três dias úteis; 10% no PIX; pedido mínimo 1.200')]).toEqual(expect.arrayContaining([3, 10, 1200]))
    expect(numerosDoTexto('um dia').has(1)).toBe(false)
  })
  it('numerosDeSaida pula centavos, ids, seq e datas ISO', () => {
    const s = numerosDeSaida({
      skuId: 'b2e20000-9999-4000-8000-000000000001', precoCentavos: 4990, saldo: 12, seq: 7,
      expiraEm: '2026-10-17T12:00:00.000Z', descricao: 'caixa com 24 unidades',
    })
    expect([...s].sort((a, b) => a - b)).toEqual([12, 24])
  })
  it('com fonte não acusa; sem fonte acusa', () => {
    expect(numerosSemFonte('Temos 12 unidades', { gerais: [12] })).toEqual([])
    expect(numerosSemFonte('Temos 13 unidades', { gerais: [12] }).map((n) => n.valor)).toEqual([13])
    expect(numerosSemFonte('10% de desconto', { gerais: [], percentuais: [10] })).toEqual([])
    expect(numerosSemFonte('10% de desconto', { gerais: [] })).toHaveLength(1)
  })
  it('o cliente abona só número NÃO bloqueante; percentual nunca', () => {
    const doCliente = numerosDoTexto('vocês dão 10%? quero 50 peças; vocês tem 500 unidades? entrega em 2 dias?')
    expect(numerosSemFonte('Separo 50 peças para você', { gerais: [], doCliente })).toEqual([])
    expect(numerosSemFonte('Sim, 10% de desconto', { gerais: [], doCliente }).map((n) => n.tipo)).toEqual(['percentual'])
    expect(numerosSemFonte('Sim, temos 500 unidades em estoque e entregamos em 2 dias', { gerais: [], doCliente }).map((n) => n.valor))
      .toEqual([500, 2])
  })
})

describe('Revisão adversarial (P7) — cada achado vira caso', () => {
  it('[ALTA 1] máscara de hora e de nº de pedido não engolem percentual nem estoque', () => {
    const pct = (t: string, v: number) => expect(extrairNumerosDeNegocio(t).filter((n) => n.tipo === 'percentual').map((n) => n.valor), t).toEqual([v])
    pct('Levando 10 caixas 15% de desconto', 15)
    pct('Todas as 30 caixas 20% off', 20)
    pct('Neste ano 10% de desconto', 10)
    pct('Para notas 5% de desconto', 5)
    pct('Pedido 7% de desconto', 7)
    pct('O plano 5% off', 5)
    expect(tipos('Temos as 10 unidades em estoque')).toEqual(['quantidade:10!'])
    expect(tipos('separo as 50 peças')).toEqual(['quantidade:50'])
    expect(tipos('Levando 10 caixas 15% de desconto')).toEqual(['percentual:15!', 'quantidade:10'])
  })
  it('[ALTA 2] fonte de percentual é tipada: referência, R$ e fração não abonam %', () => {
    const vistos = new NumerosVistos()
    const saida = { itens: [{ referencia: 'CAM-010', produto: 'Camiseta CAM-010', skus: [{ atributos: { tamanho: '10' }, precoCentavos: 9980, saldo: 3 }] }],
      detalhe: 'faltam R$ 99.80', taxa: 0.1, descontoPercentual: 7 }
    numerosDeSaida(saida, vistos); percentuaisDeSaida(saida, vistos.percentuais)
    expect([...vistos.percentuais]).toEqual([7])
    expect(vistos.has(80)).toBe(false)
    for (const t of ['10% de desconto', '80% off', '10 por cento']) {
      expect(numerosSemFonte(t, { gerais: vistos, percentuais: vistos.percentuais }), t).toHaveLength(1)
    }
    expect(numerosSemFonte('7% de desconto', { gerais: vistos, percentuais: vistos.percentuais })).toEqual([])
    expect([...percentuaisDoTexto('Pedido mínimo de 6 peças; PIX tem 5% de desconto; CAM-010')]).toEqual([5])
  })
  it('[MÉDIA 4] "tem/há" sozinhos não afirmam estoque', () => {
    expect(tipos('Seu pedido tem 3 itens')).toEqual(['quantidade:3'])
    expect(tipos('O pacote tem 1,5 kg')).toEqual(['quantidade:1.5'])
    expect(tipos('Restam 3 unidades')).toEqual(['quantidade:3!'])
  })
  it('[MÉDIA 5] prazos em lista e com receber/sair', () => {
    expect(tipos('30/60/90 dias no boleto')).toEqual(['prazo_dias:30!', 'prazo_dias:60!', 'prazo_dias:90!'])
    expect(tipos('Pagamento em 30, 60 e 90 dias')).toEqual(['prazo_dias:30!', 'prazo_dias:60!', 'prazo_dias:90!'])
    expect(tipos('Em 2 dias você recebe')).toEqual(['prazo_dias:2!'])
    expect(tipos('Você recebe em 2 dias')).toEqual(['prazo_dias:2!'])
    expect(tipos('Em 3 dias úteis o pedido sai')).toEqual(['prazo_dias:3!'])
  })
  it('[BAIXA 6] quantidade por extenso, "pct" e "metade do preço"', () => {
    expect(tipos('temos vinte unidades')).toEqual(['quantidade:20!'])
    expect(tipos('temos mil unidades em estoque')).toEqual(['quantidade:1000!'])
    expect(tipos('vendo em 12 pct')).toEqual(['quantidade:12'])
    expect(tipos('faço pela metade do preço')).toEqual(['percentual:50!'])
  })
})
