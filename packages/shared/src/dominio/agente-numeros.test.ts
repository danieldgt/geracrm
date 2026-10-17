import { describe, it, expect } from 'vitest'
import {
  extrairNumerosDeNegocio, numeroBr, numeroPorExtenso, numerosDeSaida, numerosDoTexto, numerosSemFonte,
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
    expect(numerosSemFonte('10% de desconto', { gerais: [10] })).toEqual([])
    expect(numerosSemFonte('10% de desconto', { gerais: [0.1] })).toEqual([])
    expect(numerosSemFonte('10% de desconto', { gerais: [] })).toHaveLength(1)
  })
  it('o cliente é fonte de quantidade e prazo, NUNCA de percentual', () => {
    const doCliente = numerosDoTexto('vocês dão 10%? quero 50 peças para daqui 5 dias')
    expect(numerosSemFonte('Separo 50 peças com entrega em 5 dias', { gerais: [], doCliente })).toEqual([])
    expect(numerosSemFonte('Sim, 10% de desconto', { gerais: [], doCliente }).map((n) => n.tipo)).toEqual(['percentual'])
  })
})
