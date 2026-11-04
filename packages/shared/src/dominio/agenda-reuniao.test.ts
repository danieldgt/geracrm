import { describe, it, expect } from 'vitest'
import {
  EXPEDIENTE_REUNIAO_PADRAO, agendaNoTurno, candidatosDoDia, decidirAvisoReuniao, efeitoDaAgenda, faixaDeReuniao,
  interpretarEscolhaDeHorario, lembreteDevido, noShowDevido, textoLembreteReuniao, textoReagendamento,
} from './agenda-reuniao.js'

const H = 3_600_000

describe('Grade de horários da reunião', () => {
  it('dado número sem expediente, então vale o padrão comercial (seg–sex 09–18, fim de semana fechado)', () => {
    expect(faixaDeReuniao(null, 1)).toEqual(EXPEDIENTE_REUNIAO_PADRAO['seg'])
    expect(faixaDeReuniao({}, 3)).toEqual({ de: '09:00', ate: '18:00' })
    expect(faixaDeReuniao(null, 6)).toBeNull()
    expect(faixaDeReuniao(null, 7)).toBeNull()
  })

  it('dado expediente do número, então ele manda; dia declarado fechado não tem reunião', () => {
    const h = { seg: { de: '08:00', ate: '12:00' }, ter: null }
    expect(faixaDeReuniao(h, 1)).toEqual({ de: '08:00', ate: '12:00' })
    expect(faixaDeReuniao(h, 2)).toBeNull()
    expect(faixaDeReuniao(h, 3)).toBeNull()
  })

  it('candidatos de meia em meia hora cabendo a duração inteira', () => {
    expect(candidatosDoDia({ de: '09:00', ate: '11:00' }, 30).map((c) => c.de)).toEqual(['09:00', '09:30', '10:00', '10:30'])
    expect(candidatosDoDia({ de: '09:00', ate: '11:00' }, 60).map((c) => `${c.de}-${c.ate}`)).toEqual(['09:00-10:00', '09:30-10:30', '10:00-11:00'])
    expect(candidatosDoDia({ de: '09:00', ate: '09:20' }, 30)).toEqual([])
  })

  it('faixa que vira a meia-noite fica só com a parte do próprio dia', () => {
    const c = candidatosDoDia({ de: '22:00', ate: '02:00' }, 60)
    expect(c[0]).toEqual({ de: '22:00', ate: '23:00' })
    expect(c.every((x) => x.ate <= '23:59')).toBe(true)
  })

  it('faixa inválida ou duração zero não gera nada', () => {
    expect(candidatosDoDia({ de: '9h', ate: '18:00' }, 30)).toEqual([])
    expect(candidatosDoDia({ de: '09:00', ate: '18:00' }, 0)).toEqual([])
  })
})

describe('A ferramenta do agente entra no turno?', () => {
  it('⚠️ só com módulo E chave do número E número assistido/autônomo', () => {
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: 'autonomo' })).toBe(true)
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: 'assistido' })).toBe(true)
    expect(agendaNoTurno({ moduloAtivo: false, chaveLigada: true, modoDoNumero: 'autonomo' })).toBe(false)
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: false, modoDoNumero: 'autonomo' })).toBe(false)
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: 'sombra' })).toBe(false)
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: 'desligado' })).toBe(false)
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: null })).toBe(false)
  })

  it('efeito real só no modo efetivo autônomo; o resto é seco', () => {
    expect(efeitoDaAgenda('autonomo')).toBe('real')
    for (const m of ['sombra', 'assistido', 'simulacao', 'copiloto', 'desligado'] as const) expect(efeitoDaAgenda(m)).toBe('seco')
  })
})

describe('O que o cliente escolheu', () => {
  const tres = [{ n: 1, hora: '09:00' }, { n: 2, hora: '14:00' }, { n: 3, hora: '16:30' }]

  it('pelo número da opção', () => {
    expect(interpretarEscolhaDeHorario('2', tres)).toEqual({ tipo: 'escolheu', n: 2 })
    expect(interpretarEscolhaDeHorario('Opção 3', tres)).toEqual({ tipo: 'escolheu', n: 3 })
    expect(interpretarEscolhaDeHorario('a primeira', tres)).toEqual({ tipo: 'escolheu', n: 1 })
  })

  it('pela hora', () => {
    expect(interpretarEscolhaDeHorario('pode ser às 14h', tres)).toEqual({ tipo: 'escolheu', n: 2 })
    expect(interpretarEscolhaDeHorario('16:30 fica ótimo', tres)).toEqual({ tipo: 'escolheu', n: 3 })
    expect(interpretarEscolhaDeHorario('16h30', tres)).toEqual({ tipo: 'escolheu', n: 3 })
    expect(interpretarEscolhaDeHorario('as 9', tres)).toEqual({ tipo: 'escolheu', n: 1 })
  })

  it('⚠️ negação nunca confirma', () => {
    expect(interpretarEscolhaDeHorario('não posso às 14h', tres)).toEqual({ tipo: 'recusou' })
    expect(interpretarEscolhaDeHorario('nenhum desses', tres)).toEqual({ tipo: 'recusou' })
    expect(interpretarEscolhaDeHorario('tem outro horário?', tres)).toEqual({ tipo: 'recusou' })
  })

  it('⚠️ "sim" com várias opções é ambíguo; com uma, confirma', () => {
    expect(interpretarEscolhaDeHorario('sim', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('Sim, pode marcar', [{ n: 1, hora: '10:00' }])).toEqual({ tipo: 'escolheu', n: 1 })
  })

  it('hora que não foi ofertada, opção inexistente ou conversa solta → indefinido', () => {
    expect(interpretarEscolhaDeHorario('às 11h', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('5', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('qual o preço da camiseta?', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('', tres)).toEqual({ tipo: 'indefinido' })
  })
})

describe('Lembretes ao cliente', () => {
  const inicio = new Date('2030-03-10T15:00:00Z')
  const criadoCedo = new Date('2030-03-01T12:00:00Z')
  const ev = (criadoEm = criadoCedo, status = 'agendado') => ({ inicio, criadoEm, status })

  it('H-24 entre 24h e 2h antes; H-2 nas 2h finais; nada antes nem depois', () => {
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 25 * H))).toBeNull()
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 24 * H))).toBe('h24')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 3 * H))).toBe('h24')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 2 * H))).toBe('h2')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 60_000))).toBe('h2')
    expect(lembreteDevido(ev(), inicio)).toBeNull()
  })

  it('marcado depois do ponto do lembrete não recebe aquele lembrete', () => {
    const criado = new Date(inicio.getTime() - 10 * H)
    expect(lembreteDevido(ev(criado), new Date(inicio.getTime() - 9 * H))).toBeNull()
    expect(lembreteDevido(ev(criado), new Date(inicio.getTime() - H))).toBe('h2')
    expect(lembreteDevido(ev(new Date(inicio.getTime() - H)), new Date(inicio.getTime() - 30 * 60_000))).toBeNull()
  })

  it('fora de "agendado" não há lembrete', () => {
    for (const s of ['realizado', 'cancelado', 'nao_compareceu']) {
      expect(lembreteDevido(ev(criadoCedo, s), new Date(inicio.getTime() - H))).toBeNull()
    }
  })
})

describe('No-show', () => {
  const fim = new Date('2030-03-10T16:00:00Z')
  it('agendado vira no-show só depois da tolerância; "não compareceu" vale na hora; realizado/cancelado nunca', () => {
    expect(noShowDevido({ fim, status: 'agendado' }, new Date(fim.getTime() + H))).toBe(false)
    expect(noShowDevido({ fim, status: 'agendado' }, new Date(fim.getTime() + 2 * H))).toBe(true)
    expect(noShowDevido({ fim, status: 'nao_compareceu' }, fim)).toBe(true)
    expect(noShowDevido({ fim, status: 'realizado' }, new Date(fim.getTime() + 9 * H))).toBe(false)
    expect(noShowDevido({ fim, status: 'cancelado' }, new Date(fim.getTime() + 9 * H))).toBe(false)
  })
})

describe('Por onde o aviso sai', () => {
  const tpl = { id: 't1', aprovado: true, compativel: true }
  it('oficial: texto com a janela aberta; fora dela, só o template aprovado', () => {
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: true, template: null, aquecimentoRestante: Infinity })).toEqual({ acao: 'texto' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: false, template: tpl, aquecimentoRestante: Infinity })).toEqual({ acao: 'template', templateId: 't1' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: false, template: null, aquecimentoRestante: Infinity })).toEqual({ acao: 'recusar', motivo: 'sem_template' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: false, template: { ...tpl, aprovado: false }, aquecimentoRestante: Infinity }))
      .toEqual({ acao: 'recusar', motivo: 'template_indisponivel' })
  })
  it('não-oficial: só texto, e só dentro da cota de aquecimento', () => {
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_nao_oficial', janelaAberta: false, template: tpl, aquecimentoRestante: 3 })).toEqual({ acao: 'texto' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_nao_oficial', janelaAberta: true, template: null, aquecimentoRestante: 0 }))
      .toEqual({ acao: 'recusar', motivo: 'aquecimento_esgotado' })
  })
  it('Instagram fora da janela não tem como avisar', () => {
    expect(decidirAvisoReuniao({ tipoCanal: 'instagram', janelaAberta: false, template: tpl, aquecimentoRestante: Infinity })).toEqual({ acao: 'recusar', motivo: 'janela_fechada' })
  })
})

describe('Textos', () => {
  it('lembrete com primeiro nome, data e hora; sem nome não quebra', () => {
    expect(textoLembreteReuniao({ tipo: 'h24', contato: 'Maria Souza', data: '10/03', hora: '12:00', responsavel: 'Ana Lima' }))
      .toBe('Olá, Maria! Passando para lembrar da nossa reunião amanhã (10/03) às 12:00 com Ana. Se precisar remarcar, é só responder por aqui.')
    expect(textoLembreteReuniao({ tipo: 'h2', contato: null, data: '10/03', hora: '12:00', responsavel: null })).toMatch(/^Olá! .*hoje às 12:00\./)
    expect(textoReagendamento({ contato: 'João', data: '10/03', hora: '12:00' })).toMatch(/^Olá, João! Sentimos sua falta na reunião de 10\/03 às 12:00\./)
  })
})
