import { describe, it, expect } from 'vitest'
import { avisoDeTemplates, corpoAgendaAgente, efeitoDaChave, mostraTemplates, mudouAgenda } from './agenda-agente.regras.js'

const base = { reunioes: false, templateLembreteId: null, templateReagendarId: null }

describe('Chave "O agente pode marcar reuniões"', () => {
  it('desligada: diz que o botão da conversa continua valendo', () => {
    expect(efeitoDaChave(false, 'autonomo')).toMatch(/^Desligada: .*"Agendar reunião" da conversa continua valendo/)
  })
  it('ligada: o efeito depende do modo do número', () => {
    expect(efeitoDaChave(true, 'autonomo')).toMatch(/marca quando o cliente escolhe/)
    expect(efeitoDaChave(true, 'assistido')).toMatch(/quem marca é a pessoa/)
    expect(efeitoDaChave(true, 'sombra')).toMatch(/sem efeito/)
    expect(efeitoDaChave(true, 'desligado')).toMatch(/sem efeito/)
  })
})

describe('Templates dos avisos', () => {
  it('só no oficial; avisa o que falta e o efeito no no-show', () => {
    expect(mostraTemplates('whatsapp_oficial')).toBe(true)
    expect(mostraTemplates('whatsapp_nao_oficial')).toBe(false)
    expect(avisoDeTemplates('whatsapp_nao_oficial', base)).toBeNull()
    expect(avisoDeTemplates('whatsapp_oficial', base)).toBe(
      'Sem template de lembrete e de convite para remarcar, esse aviso não sai quando a última mensagem do cliente tiver mais de 24 h (regra da Meta) — e o no-show vai direto para uma pessoa.')
    expect(avisoDeTemplates('whatsapp_oficial', { templateLembreteId: null, templateReagendarId: 't2' })).toMatch(/^Sem template de lembrete, .*Meta\)\.$/)
    expect(avisoDeTemplates('whatsapp_oficial', { templateLembreteId: 't1', templateReagendarId: 't2' })).toBeNull()
  })
})

describe('Salvar', () => {
  it('detecta mudança e manda o corpo exato (vazio vira null)', () => {
    expect(mudouAgenda(base, base)).toBe(false)
    expect(mudouAgenda(base, { ...base, reunioes: true })).toBe(true)
    expect(corpoAgendaAgente({ reunioes: true, templateLembreteId: '', templateReagendarId: 't2' } as never))
      .toEqual({ reunioes: true, templateLembreteId: null, templateReagendarId: 't2' })
  })
})
