import { describe, it, expect } from 'vitest'
import type { RespostaHorariosLivres, VendedorParaReuniao } from '@geracrm/shared'
import {
  corpoReuniao, estadoDosHorarios, limitesDoDia, mensagemDaFalha, opcoesVendedores, recarregaHorarios, rotuloVendedor,
  textoDeSucesso, vendedorInicial, type FormReuniao,
} from './agendar-reuniao.regras.js'

const dono: VendedorParaReuniao = { usuarioId: 'u1', nome: 'Ana Lima', responsavelDoContato: true }
const outro: VendedorParaReuniao = { usuarioId: 'u2', nome: 'Bruno', responsavelDoContato: false }
const resp = (extra: Partial<RespostaHorariosLivres> = {}): RespostaHorariosLivres => ({
  usuarioId: 'u1', dia: '2030-03-12', duracaoMin: 30, origemExpediente: 'numero', fechado: false,
  horarios: [{ inicio: '2030-03-12T12:00:00.000Z', fim: '2030-03-12T12:30:00.000Z' }], ...extra,
})
const form = (extra: Partial<FormReuniao> = {}): FormReuniao => ({
  usuarioId: 'u1', inicio: '2030-03-12T12:00:00.000Z', duracao: '30', modalidade: 'online', link: '', ...extra,
})

describe('Vendedores do botão "Agendar reunião"', () => {
  it('o responsável do cliente aparece marcado e vem escolhido de início', () => {
    expect(rotuloVendedor(dono)).toBe('Ana Lima (responsável)')
    expect(rotuloVendedor(outro)).toBe('Bruno')
    expect(opcoesVendedores([dono, outro])).toEqual([{ valor: 'u1', rotulo: 'Ana Lima (responsável)' }, { valor: 'u2', rotulo: 'Bruno' }])
    expect(vendedorInicial([dono, outro])).toBe('u1')
    expect(vendedorInicial([])).toBe('')
  })
})

describe('Estados do bloco de horários', () => {
  it('ocioso, carregando, erro, dia fechado, sem vaga e pronto', () => {
    expect(estadoDosHorarios({ carregando: false, erro: false, resposta: null })).toBe('ocioso')
    expect(estadoDosHorarios({ carregando: true, erro: false, resposta: resp() })).toBe('carregando')
    expect(estadoDosHorarios({ carregando: false, erro: true, resposta: null })).toBe('erro')
    expect(estadoDosHorarios({ carregando: false, erro: false, resposta: resp({ fechado: true, horarios: [] }) })).toBe('fechado')
    expect(estadoDosHorarios({ carregando: false, erro: false, resposta: resp({ horarios: [] }) })).toBe('vazio')
    expect(estadoDosHorarios({ carregando: false, erro: false, resposta: resp() })).toBe('pronto')
  })

  it('o dia vai de hoje até 60 dias à frente', () => {
    expect(limitesDoDia(new Date(2030, 0, 31))).toEqual({ min: '2030-01-31', max: '2030-04-01' })
  })
})

describe('Corpo do agendamento', () => {
  it('monta o corpo com a duração em número e sem link vazio', () => {
    expect(corpoReuniao('cv1', form())).toEqual({
      ok: true, corpo: { conversaId: 'cv1', usuarioId: 'u1', inicio: '2030-03-12T12:00:00.000Z', duracaoMin: 30, modalidade: 'online' },
    })
    expect(corpoReuniao('cv1', form({ link: ' https://meet.x/abc ' }))).toMatchObject({ ok: true, corpo: { link: 'https://meet.x/abc' } })
  })

  it('erro por campo antes do clique: pessoa, horário e link', () => {
    expect(corpoReuniao('cv1', form({ usuarioId: '', inicio: null, link: 'javascript:x' }))).toEqual({
      ok: false, erros: { usuarioId: 'Escolha com quem é a reunião.', inicio: 'Escolha um horário livre.', link: 'O link precisa começar com http:// ou https://.' },
    })
  })
})

describe('Falhas e sucesso', () => {
  it('⚠️ 409: horário ocupado no meio — nomeia e manda recarregar a grade', () => {
    expect(mensagemDaFalha(409, 'agenda.horario_ocupado')).toBe('Esse horário acabou de ser ocupado. Escolha outro horário.')
    expect(recarregaHorarios(409, 'agenda.horario_ocupado')).toBe(true)
    expect(recarregaHorarios(422, 'agenda.horario_passado')).toBe(true)
    expect(recarregaHorarios(403, 'agenda.responsavel_proibido')).toBe(false)
  })

  it('403, 404, módulo desligado e sem rede têm frase própria', () => {
    expect(mensagemDaFalha(403, 'agenda.responsavel_proibido')).toMatch(/não pode marcar com essa pessoa/)
    expect(mensagemDaFalha(404, 'modulo.desligado')).toBe('A Agenda foi desligada para a sua empresa.')
    expect(mensagemDaFalha(404, 'conversa.nao_encontrada')).toMatch(/não está mais disponível/)
    expect(mensagemDaFalha(0, null)).toMatch(/Sem conexão/)
    expect(mensagemDaFalha(500, null)).toBe('Não foi possível marcar a reunião. Tente de novo.')
  })

  it('o sucesso diz quando, com quem e se o responsável mudou', () => {
    const inicio = new Date(2030, 2, 12, 15, 0).toISOString()
    expect(textoDeSucesso({ inicio, vendedor: outro, responsavelAlterado: true }))
      .toBe('Reunião marcada para 12/03 às 15:00 com Bruno. Bruno passou a ser o responsável pelo cliente.')
    expect(textoDeSucesso({ inicio, vendedor: dono, responsavelAlterado: false })).toBe('Reunião marcada para 12/03 às 15:00 com Ana Lima.')
  })
})
