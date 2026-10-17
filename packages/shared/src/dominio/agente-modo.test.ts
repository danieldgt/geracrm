import { describe, it, expect } from 'vitest'
import {
  confirmacaoConfere, decidirModoEfetivo, dentroDoHorarioRecorte, exigeConfirmacao, maisRestritivo, recorteAgente,
  type EntradaDecisaoModo, type MomentoLocal, type SegmentoRecorte,
} from './agente-modo.js'
import type { ModoAgente } from './agente-vendedor.js'

const SEG_14H: MomentoLocal = { diaIso: 1, hora: '14:00' }
const SEG_20H: MomentoLocal = { diaIso: 1, hora: '20:00' }
const DOM_10H: MomentoLocal = { diaIso: 7, hora: '10:00' }
const COMERCIAL = { seg: { de: '08:00', ate: '18:00' }, ter: { de: '08:00', ate: '18:00' } }

describe('decidirModoEfetivo — o mais restritivo vence (ADR-028)', () => {
  type Linha = [
    descricao: string,
    tenant: ModoAgente | null, numero: ModoAgente, recorte: unknown, momento: MomentoLocal,
    segmento: SegmentoRecorte | undefined,
    esperado: { modo: ModoAgente; origem: 'numero' | 'tenant' | 'recorte'; motivo: string | null },
  ]
  const tabela: Linha[] = [
    ['sem teto e sem recorte: vale o número', null, 'autonomo', null, SEG_14H, 'cliente-fiel', { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['tenant desligado é kill switch geral', 'desligado', 'autonomo', null, SEG_14H, undefined, { modo: 'desligado', origem: 'tenant', motivo: 'teto_do_tenant' }],
    ['tenant em sombra rebaixa número autônomo', 'sombra', 'autonomo', null, SEG_14H, undefined, { modo: 'sombra', origem: 'tenant', motivo: 'teto_do_tenant' }],
    ['tenant NUNCA afrouxa o número', 'autonomo', 'sombra', null, SEG_14H, undefined, { modo: 'sombra', origem: 'numero', motivo: null }],
    ['número desligado vence tudo', 'autonomo', 'desligado', { horario: COMERCIAL }, SEG_14H, undefined, { modo: 'desligado', origem: 'numero', motivo: null }],
    ['dentro do horário: vale o número', null, 'autonomo', { horario: COMERCIAL }, SEG_14H, undefined, { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['fora do horário: cai para sombra (padrão)', null, 'autonomo', { horario: COMERCIAL }, SEG_20H, undefined, { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario' }],
    ['dia sem faixa conta como fora', null, 'autonomo', { horario: COMERCIAL }, DOM_10H, undefined, { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario' }],
    ['fora do recorte cai para o configurado', null, 'autonomo', { horario: COMERCIAL, foraDoRecorte: 'desligado' }, SEG_20H, undefined, { modo: 'desligado', origem: 'recorte', motivo: 'fora_do_recorte_horario' }],
    ['fora do recorte nunca SOBE o número', null, 'sombra', { horario: COMERCIAL, foraDoRecorte: 'assistido' }, SEG_20H, undefined, { modo: 'sombra', origem: 'numero', motivo: null }],
    ['segmento liberado: vale o número', null, 'autonomo', { segmentosRfv: ['cliente-fiel', 'nao-perder'] }, SEG_14H, 'nao-perder', { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['segmento fora: cai', null, 'autonomo', { segmentosRfv: ['cliente-fiel'] }, SEG_14H, 'hibernando', { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_segmento' }],
    ['lead sem compra fora quando só clientes', null, 'autonomo', { segmentosRfv: ['cliente-fiel'] }, SEG_14H, 'sem-historico', { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_segmento' }],
    ['lead sem compra dentro quando liberado', null, 'autonomo', { segmentosRfv: ['sem-historico'] }, SEG_14H, 'sem-historico', { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['segmento desconhecido (tela) não é avaliado', null, 'autonomo', { segmentosRfv: ['cliente-fiel'] }, SEG_14H, undefined, { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['horário e segmento fora juntos', null, 'autonomo', { horario: COMERCIAL, segmentosRfv: ['cliente-fiel'] }, SEG_20H, 'em-risco', { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario_segmento' }],
    ['tenant mais restritivo que o recorte', 'desligado', 'autonomo', { horario: COMERCIAL }, SEG_20H, undefined, { modo: 'desligado', origem: 'tenant', motivo: 'teto_do_tenant' }],
    ['recorte mais restritivo que o tenant', 'assistido', 'autonomo', { horario: COMERCIAL }, SEG_20H, undefined, { modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario' }],
    ['empate tenant × recorte credita o tenant', 'sombra', 'autonomo', { horario: COMERCIAL }, SEG_20H, undefined, { modo: 'sombra', origem: 'tenant', motivo: 'teto_do_tenant' }],
    ['recorte inválido erra para o restritivo', null, 'autonomo', { horario: 'seg-sex' }, SEG_14H, undefined, { modo: 'sombra', origem: 'recorte', motivo: 'recorte_invalido' }],
    ['recorte vazio não restringe', null, 'autonomo', {}, SEG_20H, 'hibernando', { modo: 'autonomo', origem: 'numero', motivo: null }],
    ['assistido no número com tenant autônomo', 'autonomo', 'assistido', null, SEG_14H, undefined, { modo: 'assistido', origem: 'numero', motivo: null }],
  ]

  it.each(tabela)('%s', (_d, tenant, numero, recorte, momento, segmento, esperado) => {
    const e: EntradaDecisaoModo = { modoTenant: tenant, modoNumero: numero, recorte, momento, segmento }
    expect(decidirModoEfetivo(e)).toMatchObject(esperado)
  })

  it('informa o que ficou fora do recorte mesmo quando não rebaixou', () => {
    const d = decidirModoEfetivo({ modoTenant: null, modoNumero: 'sombra', recorte: { horario: COMERCIAL }, momento: SEG_20H })
    expect(d).toMatchObject({ modo: 'sombra', origem: 'numero', foraDoRecorte: ['horario'] })
  })
})

describe('horário do recorte', () => {
  it('faixa que cruza a meia-noite', () => {
    const h = recorteAgente.parse({ horario: { seg: { de: '22:00', ate: '02:00' }, ter: { de: '22:00', ate: '02:00' } } }).horario
    expect(dentroDoHorarioRecorte(h, { diaIso: 1, hora: '23:30' })).toBe(true)
    expect(dentroDoHorarioRecorte(h, { diaIso: 1, hora: '01:59' })).toBe(true)
    expect(dentroDoHorarioRecorte(h, { diaIso: 1, hora: '02:00' })).toBe(false)
    expect(dentroDoHorarioRecorte(h, { diaIso: 1, hora: '12:00' })).toBe(false)
  })
  it('fim é exclusivo, início inclusivo', () => {
    const h = recorteAgente.parse({ horario: COMERCIAL }).horario
    expect(dentroDoHorarioRecorte(h, { diaIso: 2, hora: '08:00' })).toBe(true)
    expect(dentroDoHorarioRecorte(h, { diaIso: 2, hora: '18:00' })).toBe(false)
  })
  it('schema recusa horário sem nenhum dia, hora malformada e campo desconhecido', () => {
    expect(recorteAgente.safeParse({ horario: {} }).success).toBe(false)
    expect(recorteAgente.safeParse({ horario: { seg: { de: '8:00', ate: '18:00' } } }).success).toBe(false)
    expect(recorteAgente.safeParse({ horario: null, extra: 1 }).success).toBe(false)
    expect(recorteAgente.safeParse({ foraDoRecorte: 'autonomo' }).success).toBe(false)
  })
})

describe('confirmação digitada', () => {
  it('confere sem acento, sem caixa e sem espaço nas pontas', () => {
    expect(confirmacaoConfere('autonomo', 'autonomo')).toBe(true)
    expect(confirmacaoConfere('Autônomo', 'autonomo')).toBe(true)
    expect(confirmacaoConfere('  AUTÔNOMO ', 'autonomo')).toBe(true)
    expect(confirmacaoConfere('DESLIGADO', 'desligado')).toBe(true)
  })
  it('não confere com outro texto, vazio ou ausente', () => {
    expect(confirmacaoConfere('autonom', 'autonomo')).toBe(false)
    expect(confirmacaoConfere('sim', 'desligado')).toBe(false)
    expect(confirmacaoConfere('', 'autonomo')).toBe(false)
    expect(confirmacaoConfere(undefined, 'autonomo')).toBe(false)
  })
  it('só pede ao MUDAR para autônomo ou desligado', () => {
    expect(exigeConfirmacao('sombra', 'autonomo')).toBe(true)
    expect(exigeConfirmacao('autonomo', 'desligado')).toBe(true)
    expect(exigeConfirmacao('autonomo', 'autonomo')).toBe(false)
    expect(exigeConfirmacao('sombra', 'assistido')).toBe(false)
    // Número nunca configurado = desligado: salvar desligado de novo não pede.
    expect(exigeConfirmacao(null, 'desligado')).toBe(false)
    expect(exigeConfirmacao(null, 'autonomo')).toBe(true)
  })
  it('maisRestritivo', () => {
    expect(maisRestritivo('autonomo', 'sombra')).toBe('sombra')
    expect(maisRestritivo('desligado', 'assistido')).toBe('desligado')
  })
})
