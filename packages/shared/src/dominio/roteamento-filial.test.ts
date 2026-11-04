import { describe, it, expect } from 'vitest'
import {
  DDDS_BRASIL, corpoRegraRoteamento, corpoRegraRoteamentoParcial, dddDoTelefone, proximoDoRodizio, resolverFilial,
  validarValorDaRegra, type FatosDaFilial, type RegraAplicavel,
} from './roteamento-filial.js'

const ORIGEM = '0190a000-0000-4000-8000-000000000001'
const CANAL = '0190a000-0000-4000-8000-0000000000c1'
const OUTRO = '0190a000-0000-4000-8000-0000000000c2'

let seq = 0
const regra = (extra: Partial<RegraAplicavel>): RegraAplicavel => ({
  id: `r${String(++seq).padStart(3, '0')}`, canalId: null, tipo: 'padrao', valor: null, filialId: 'F?', prioridade: 100,
  ativa: true, filialAtiva: true, ...extra,
})
const fatos = (extra: Partial<FatosDaFilial> = {}): FatosDaFilial => ({
  filialDoContato: null, origemId: null, ddd: null, canalId: CANAL, filialDoNumero: null, ...extra,
})

describe('dddDoTelefone', () => {
  it.each([
    ['+5585999990000', '85'], ['5511987654321', '11'], ['(21) 98765-4321', '21'], ['85 3222-1000', '85'],
  ])('%s → %s', (t, ddd) => expect(dddDoTelefone(t)).toBe(ddd))
  it.each([[null], [''], ['123'], ['+5520999990000'], ['+44 20 7946 0958']])('%s → null', (t) => expect(dddDoTelefone(t)).toBeNull())
  it('a lista tem os 67 DDDs do plano nacional', () => expect(DDDS_BRASIL).toHaveLength(67))
})

describe('validarValorDaRegra', () => {
  it('DDD com 2 dígitos e existente', () => {
    expect(validarValorDaRegra('ddd', ' 85 ')).toEqual({ ok: true, valor: '85' })
    expect(validarValorDaRegra('ddd', '8')).toMatchObject({ ok: false })
    expect(validarValorDaRegra('ddd', '20')).toEqual({ ok: false, mensagem: 'O DDD 20 não existe.' })
    expect(validarValorDaRegra('ddd', null)).toMatchObject({ ok: false })
  })
  it('origem é uuid (normalizado para minúsculas)', () => {
    expect(validarValorDaRegra('origem', ORIGEM.toUpperCase())).toEqual({ ok: true, valor: ORIGEM })
    expect(validarValorDaRegra('origem', 'Feira')).toMatchObject({ ok: false })
  })
  it('padrão não tem valor', () => {
    expect(validarValorDaRegra('padrao', null)).toEqual({ ok: true, valor: null })
    expect(validarValorDaRegra('padrao', '   ')).toEqual({ ok: true, valor: null })
    expect(validarValorDaRegra('padrao', '85')).toMatchObject({ ok: false })
  })
})

describe('corpoRegraRoteamento', () => {
  it('aplica os padrões (todos os números, prioridade 100, ativa)', () => {
    const r = corpoRegraRoteamento.parse({ tipo: 'padrao', filialId: ORIGEM.toUpperCase() })
    expect(r).toEqual({ tipo: 'padrao', filialId: ORIGEM, canalId: null, valor: null, prioridade: 100, ativa: true })
  })
  it('recusa campo desconhecido e prioridade fora da faixa', () => {
    expect(corpoRegraRoteamento.safeParse({ tipo: 'ddd', valor: '85', filialId: ORIGEM, tenantId: 'x' }).success).toBe(false)
    expect(corpoRegraRoteamento.safeParse({ tipo: 'ddd', valor: '85', filialId: ORIGEM, prioridade: 10_000 }).success).toBe(false)
  })
  it('o parcial aceita só o que mudou', () => {
    expect(corpoRegraRoteamentoParcial.parse({ ativa: false })).toEqual({ ativa: false })
  })
})

describe('resolverFilial — precedência fixa', () => {
  const regras = [
    regra({ tipo: 'origem', valor: ORIGEM, filialId: 'F-origem' }),
    regra({ tipo: 'ddd', valor: '85', filialId: 'F-ddd' }),
    regra({ tipo: 'padrao', canalId: CANAL, filialId: 'F-padrao-numero' }),
    regra({ tipo: 'padrao', filialId: 'F-padrao-geral' }),
  ]

  it('1. a filial gravada no contato vence tudo', () => {
    expect(resolverFilial(regras, fatos({ filialDoContato: 'F-contato', origemId: ORIGEM, ddd: '85' })))
      .toEqual({ filialId: 'F-contato', motivo: 'contato', regraId: null })
  })
  it('2. origem antes do DDD', () => {
    expect(resolverFilial(regras, fatos({ origemId: ORIGEM, ddd: '85' }))).toMatchObject({ filialId: 'F-origem', motivo: 'origem' })
  })
  it('3. DDD quando a origem não casa', () => {
    expect(resolverFilial(regras, fatos({ origemId: '0190a000-0000-4000-8000-0000000000ff', ddd: '85' })))
      .toMatchObject({ filialId: 'F-ddd', motivo: 'ddd' })
  })
  it('4. padrão do número quando nem origem nem DDD casam', () => {
    expect(resolverFilial(regras, fatos({ ddd: '11' }))).toMatchObject({ filialId: 'F-padrao-numero', motivo: 'padrao_numero' })
  })
  it('5. filial do número antes do padrão geral', () => {
    expect(resolverFilial(regras, fatos({ canalId: OUTRO, filialDoNumero: 'F-numero' })))
      .toEqual({ filialId: 'F-numero', motivo: 'filial_numero', regraId: null })
  })
  it('6. padrão geral em outro número sem filial', () => {
    expect(resolverFilial(regras, fatos({ canalId: OUTRO }))).toMatchObject({ filialId: 'F-padrao-geral', motivo: 'padrao_geral' })
  })
  it('7. nenhuma', () => {
    expect(resolverFilial([], fatos({ ddd: '85' }))).toEqual({ filialId: null, motivo: 'nenhuma', regraId: null })
  })
  it('sem número, só as regras gerais valem (a padrão do número não)', () => {
    expect(resolverFilial(regras, fatos({ canalId: null }))).toMatchObject({ filialId: 'F-padrao-geral', motivo: 'padrao_geral' })
  })

  it('a regra do número vence a geral no mesmo nível, mesmo com prioridade pior', () => {
    const r = [
      regra({ tipo: 'ddd', valor: '85', filialId: 'F-geral', prioridade: 1 }),
      regra({ tipo: 'ddd', valor: '85', canalId: CANAL, filialId: 'F-do-numero', prioridade: 500 }),
    ]
    expect(resolverFilial(r, fatos({ ddd: '85' }))).toMatchObject({ filialId: 'F-do-numero' })
    // Em outro número, a regra específica não vale: fica a geral.
    expect(resolverFilial(r, fatos({ ddd: '85', canalId: OUTRO }))).toMatchObject({ filialId: 'F-geral' })
  })
  it('no mesmo alcance, a menor prioridade vence', () => {
    const r = [regra({ tipo: 'padrao', canalId: CANAL, filialId: 'F-b', prioridade: 20 }), regra({ tipo: 'padrao', canalId: CANAL, filialId: 'F-a', prioridade: 10 })]
    expect(resolverFilial(r, fatos())).toMatchObject({ filialId: 'F-a' })
  })
  it('regra inativa ou para filial desativada é ignorada (cai no próximo nível)', () => {
    const r = [
      regra({ tipo: 'origem', valor: ORIGEM, filialId: 'F-x', ativa: false }),
      regra({ tipo: 'ddd', valor: '85', filialId: 'F-y', filialAtiva: false }),
      regra({ tipo: 'padrao', filialId: 'F-geral' }),
    ]
    expect(resolverFilial(r, fatos({ origemId: ORIGEM, ddd: '85' }))).toMatchObject({ filialId: 'F-geral', motivo: 'padrao_geral' })
  })
  it('origem compara sem caixa', () => {
    expect(resolverFilial(regras, fatos({ origemId: ORIGEM.toUpperCase() }))).toMatchObject({ motivo: 'origem' })
  })
})

describe('proximoDoRodizio', () => {
  it.each([
    [['b', 'a', 'c'], null, 'a'],
    [['b', 'a', 'c'], 'a', 'b'],
    [['a', 'b', 'c'], 'c', 'a'],
    [['a', 'c'], 'b', 'c'],      // o último saiu: segue a ordem por id
    [['a', 'a', 'b'], 'a', 'b'], // repetido não conta duas vezes
  ] as const)('%j depois de %s → %s', (ids, ultimo, esperado) => expect(proximoDoRodizio(ids, ultimo)).toBe(esperado))
  it('vazio → null', () => expect(proximoDoRodizio([], 'a')).toBeNull())
  it('justo: N escolhas em N elegíveis passam por todos uma vez', () => {
    const ids = ['u3', 'u1', 'u2', 'u4']
    let ultimo: string | null = null
    const escolhidos: string[] = []
    for (let i = 0; i < 8; i++) { ultimo = proximoDoRodizio(ids, ultimo); escolhidos.push(ultimo!) }
    expect(escolhidos).toEqual(['u1', 'u2', 'u3', 'u4', 'u1', 'u2', 'u3', 'u4'])
  })
})
