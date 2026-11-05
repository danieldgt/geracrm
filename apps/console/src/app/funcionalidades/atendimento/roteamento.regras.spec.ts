import { describe, it, expect } from 'vitest'
import type { RegraRoteamento, SimulacaoRoteamento } from '@geracrm/shared'
import {
  FORM_REGRA_VAZIO, descreverSimulacao, formDaRegra, mapearErroRoteamento, montarPayloadRegra, rotuloNumero, rotuloValor,
  validarFormRegra,
} from './roteamento.regras.js'

const FILIAL = '0190a000-0000-4000-8000-0000000000f1'
const ORIGEM = '0190a000-0000-4000-8000-0000000000a1'
const CANAL = '0190a000-0000-4000-8000-0000000000c1'

const regra = (extra: Partial<RegraRoteamento> = {}): RegraRoteamento => ({
  id: 'r1', tipo: 'ddd', valor: '85', valorRotulo: null, filialId: FILIAL, filialNome: 'Norte', filialAtiva: true,
  canalId: null, canalNome: null, prioridade: 100, ativa: true, atualizadoEm: '2026-11-03T12:00:00Z', ...extra,
})

describe('rótulos da tabela', () => {
  it('valor: DDD, nome da origem, travessão no padrão', () => {
    expect(rotuloValor(regra())).toBe('85')
    expect(rotuloValor(regra({ tipo: 'origem', valor: ORIGEM, valorRotulo: 'Feira' }))).toBe('Feira')
    expect(rotuloValor(regra({ tipo: 'padrao', valor: null }))).toBe('—')
  })
  it('número: "Todos os números" quando a regra é geral', () => {
    expect(rotuloNumero(regra())).toBe('Todos os números')
    expect(rotuloNumero(regra({ canalId: CANAL, canalNome: 'Loja 1' }))).toBe('Loja 1')
  })
})

describe('formulário da regra', () => {
  it('valida antes de enviar com a régua do shared', () => {
    expect(validarFormRegra(FORM_REGRA_VAZIO)).toEqual({ valor: 'Informe o DDD com 2 dígitos.', filialId: 'Escolha a filial.' })
    expect(validarFormRegra({ ...FORM_REGRA_VAZIO, ddd: '20', filialId: FILIAL })).toEqual({ valor: 'O DDD 20 não existe.' })
    expect(validarFormRegra({ ...FORM_REGRA_VAZIO, tipo: 'origem', filialId: FILIAL })).toEqual({ valor: 'Escolha a origem.' })
    expect(validarFormRegra({ ...FORM_REGRA_VAZIO, tipo: 'padrao', filialId: FILIAL, prioridade: '-1' })).toEqual({ prioridade: 'Prioridade de 0 a 9999.' })
    expect(validarFormRegra({ ...FORM_REGRA_VAZIO, ddd: '85', filialId: FILIAL })).toEqual({})
  })
  it('monta o corpo: só o valor do tipo escolhido, número vazio = todos', () => {
    expect(montarPayloadRegra({ ...FORM_REGRA_VAZIO, tipo: 'ddd', ddd: '(85)', origemId: ORIGEM, filialId: FILIAL }))
      .toEqual({ tipo: 'ddd', valor: '85', filialId: FILIAL, canalId: null, prioridade: 100, ativa: true })
    expect(montarPayloadRegra({ ...FORM_REGRA_VAZIO, tipo: 'padrao', ddd: '85', filialId: FILIAL, canalId: CANAL, prioridade: '7', ativa: false }))
      .toEqual({ tipo: 'padrao', valor: null, filialId: FILIAL, canalId: CANAL, prioridade: 7, ativa: false })
  })
  it('edição: a regra gravada volta para o formulário e o corpo é o mesmo', () => {
    const r = regra({ tipo: 'origem', valor: ORIGEM, valorRotulo: 'Feira', canalId: CANAL, prioridade: 3 })
    const f = formDaRegra(r)
    expect(f).toMatchObject({ tipo: 'origem', origemId: ORIGEM, ddd: '', canalId: CANAL, prioridade: '3' })
    expect(montarPayloadRegra(f)).toEqual({ tipo: 'origem', valor: ORIGEM, filialId: FILIAL, canalId: CANAL, prioridade: 3, ativa: true })
  })
})

describe('erros da API', () => {
  it('código → campo, com a mensagem da API quando vem', () => {
    expect(mapearErroRoteamento('roteamento.regra_duplicada')).toMatchObject({ campo: 'valor' })
    expect(mapearErroRoteamento('roteamento.numero_obrigatorio')).toMatchObject({ campo: 'canalId' })
    expect(mapearErroRoteamento('roteamento.valor_indisponivel')).toMatchObject({ campo: 'valor' })
    expect(mapearErroRoteamento('roteamento.filial_inativa', 'Esta filial está desativada.')).toEqual({ campo: 'filialId', mensagem: 'Esta filial está desativada.' })
    expect(mapearErroRoteamento('roteamento.regra_nao_encontrada')?.campo).toBeNull()
    expect(mapearErroRoteamento('outro.codigo')).toBeNull()
    expect(mapearErroRoteamento(null)).toBeNull()
  })
})

describe('simulador', () => {
  const base: SimulacaoRoteamento = {
    ddd: '85', filial: { id: FILIAL, nome: 'Norte' }, motivo: 'ddd', regraId: 'r1',
    vendedor: { id: 'u1', nome: 'Ana' }, elegiveis: 3, rodizioNaEntrada: true, foraDoEscopo: false,
  }
  it('explica a filial com o motivo e o vendedor da vez', () => {
    expect(descreverSimulacao(base)).toEqual({
      filial: 'Norte — regra por DDD (85)', vendedor: 'Ana (a vez de 3 vendedores no rodízio)', aviso: null,
    })
  })
  it('avisa quando o rodízio na entrada está desligado no número', () => {
    expect(descreverSimulacao({ ...base, rodizioNaEntrada: false }).aviso).toMatch(/DESLIGADO/)
    expect(descreverSimulacao({ ...base, rodizioNaEntrada: null }).aviso).toBeNull()
  })
  it('filial de fora do escopo: só "outra filial", sem nome nem vendedor', () => {
    expect(descreverSimulacao({ ...base, filial: null, vendedor: null, regraId: null, elegiveis: 0, foraDoEscopo: true }))
      .toMatchObject({ filial: 'Outra filial (fora do seu acesso) — regra por DDD (85)', vendedor: 'Definido pela outra filial' })
  })
  it('sem filial e sem vendedor', () => {
    expect(descreverSimulacao({ ...base, filial: null, motivo: 'nenhuma', vendedor: null, elegiveis: 0 }))
      .toMatchObject({ filial: 'Nenhuma filial — nenhuma regra casou', vendedor: '—' })
    expect(descreverSimulacao({ ...base, vendedor: null, elegiveis: 0 }).vendedor).toBe('Ninguém disponível nesta filial para este número')
  })
})
