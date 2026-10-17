import { describe, it, expect } from 'vitest'
import {
  erroDoRecorte, fraseOrigem, fraseReserva, pedidoAoTirarRecorte, pedidoDeConfirmacao, recorteParaFormulario, recorteParaSalvar,
  type ReservaLlm,
} from './modo.regras.js'

const efetivo = (o: Partial<Parameters<typeof fraseOrigem>[0]> = {}) => ({
  modo: 'autonomo' as const, origem: 'numero' as const, motivo: null, foraDoRecorte: [], dependeDoContato: false,
  momento: { diaIso: 1, hora: '10:00' }, ...o,
})

describe('selo do modo efetivo — de onde veio a restrição', () => {
  it('número', () => {
    expect(fraseOrigem(efetivo(), 'autonomo')).toBe('Vale o modo deste número.')
    expect(fraseOrigem(efetivo({ dependeDoContato: true }), 'autonomo')).toContain('segmento do cliente decide')
  })
  it('tenant nomeia o teto da conta e os dois modos', () => {
    const f = fraseOrigem(efetivo({ modo: 'desligado', origem: 'tenant', motivo: 'teto_do_tenant' }), 'autonomo')
    expect(f).toContain('teto da conta')
    expect(f).toContain('autônomo')
    expect(f).toContain('desligado')
  })
  it('recorte nomeia a parte que ficou de fora', () => {
    const f = fraseOrigem(efetivo({ modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario', foraDoRecorte: ['horario'] }), 'autonomo')
    expect(f).toContain('fora do recorte (horário)')
    expect(f).toContain('cai para sombra')
  })
  it('recorte inválido manda revisar', () => {
    expect(fraseOrigem(efetivo({ modo: 'sombra', origem: 'recorte', motivo: 'recorte_invalido' }), 'autonomo')).toContain('inválido')
  })
})

describe('recorte como formulário', () => {
  it('sem recorte: desligado, com horário comercial pronto para ligar', () => {
    const f = recorteParaFormulario(null)
    expect(f.ativo).toBe(false)
    expect(recorteParaSalvar(f)).toBeNull()
  })
  it('ida e volta preserva o recorte e manda só os dias abertos', () => {
    const r = { horario: { seg: { de: '08:00', ate: '18:00' } }, segmentosRfv: ['cliente-fiel' as const], foraDoRecorte: 'desligado' as const }
    const f = recorteParaFormulario(r)
    expect(f).toMatchObject({ ativo: true, usaHorario: true, segmentos: ['cliente-fiel'], foraDoRecorte: 'desligado' })
    expect(recorteParaSalvar(f)).toEqual(r)
  })
  it('só segmento: horário vai null', () => {
    const f = { ...recorteParaFormulario(null), ativo: true, usaHorario: false, segmentos: ['sem-historico' as const] }
    expect(recorteParaSalvar(f)).toEqual({ horario: null, segmentosRfv: ['sem-historico'], foraDoRecorte: 'sombra' })
  })
  it('erros: nada escolhido, nenhum dia, início = fim', () => {
    const base = { ...recorteParaFormulario(null), ativo: true }
    expect(erroDoRecorte({ ...base, usaHorario: false })).toContain('horário ou ao menos um segmento')
    expect(erroDoRecorte({ ...base, horario: { seg: null } })).toContain('ao menos um dia')
    expect(erroDoRecorte({ ...base, horario: { seg: { de: '08:00', ate: '08:00' } } })).toContain('iguais')
    expect(erroDoRecorte(base)).toBeNull()
    expect(erroDoRecorte({ ...base, ativo: false, usaHorario: false })).toBeNull()
  })
})

describe('confirmação digitada', () => {
  it('número: autônomo e desligado pedem; o mesmo modo e sombra não', () => {
    expect(pedidoDeConfirmacao('sombra', 'autonomo', 'numero')).toMatchObject({ digitar: 'autonomo', acao: 'Deixar autônomo' })
    expect(pedidoDeConfirmacao('autonomo', 'desligado', 'numero')).toMatchObject({ digitar: 'desligado' })
    expect(pedidoDeConfirmacao('autonomo', 'autonomo', 'numero')).toBeNull()
    expect(pedidoDeConfirmacao('autonomo', 'sombra', 'numero')).toBeNull()
    expect(pedidoDeConfirmacao(null, 'desligado', 'numero')).toBeNull()
  })
  it('conta: sem teto é autônomo — voltar a autônomo de autônomo não pede', () => {
    expect(pedidoDeConfirmacao(null, 'autonomo', 'conta')).toBeNull()
    expect(pedidoDeConfirmacao('autonomo', 'desligado', 'conta')?.mensagem).toContain('TODOS os números')
  })
})

describe('tirar o recorte de autônomo', () => {
  it('pede "autonomo" só quando continua autônomo, tinha recorte e vai sem', () => {
    expect(pedidoAoTirarRecorte('autonomo', 'autonomo', true, null)).toMatchObject({ digitar: 'autonomo' })
    expect(pedidoAoTirarRecorte('autonomo', 'autonomo', false, null)).toBeNull()
    expect(pedidoAoTirarRecorte('autonomo', 'sombra', true, null)).toBeNull()
    expect(pedidoAoTirarRecorte('autonomo', 'autonomo', true, { horario: null, segmentosRfv: ['cliente-fiel'], foraDoRecorte: 'sombra' })).toBeNull()
  })
})

describe('reserva de LLM na tela', () => {
  const base: ReservaLlm = { provedor: null, configurada: false, faltaParaReserva: [], situacao: 'principal', reservaAteEm: null, modelosBloqueados: 0 }
  it('sem reserva', () => { expect(fraseReserva(base)?.texto).toContain('Sem reserva') })
  it('falta configurar — nomeia a variável', () => {
    expect(fraseReserva({ ...base, provedor: 'groq', faltaParaReserva: ['GROQ_API_KEY'] })).toMatchObject({ tom: 'atencao', texto: expect.stringContaining('GROQ_API_KEY') })
  })
  it('pronta e em uso', () => {
    expect(fraseReserva({ ...base, provedor: 'groq', configurada: true })?.tom).toBe('sucesso')
    expect(fraseReserva({ ...base, situacao: 'reserva', reservaAteEm: '2026-10-17T15:30:00Z' }, new Date('2026-10-17T15:00:00Z'))?.texto).toContain('pela reserva até')
  })
  it('API anterior (sem o campo) não mostra nada', () => { expect(fraseReserva(undefined)).toBeNull() })
})
