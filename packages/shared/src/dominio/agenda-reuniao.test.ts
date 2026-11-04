import { describe, it, expect } from 'vitest'
import {
  agendaNoTurno, candidatosDoDia, decidirAvisoReuniao, desfechoPendente, efeitoDaAgenda, faixaDeReuniao,
  interpretarEscolhaDeHorario, lembreteDevido, linhaDaOpcao, quandoRelativo, textoLembreteReuniao, textoReagendamento,
  verificarReuniaoNaResposta,
} from './agenda-reuniao.js'

const H = 3_600_000

describe('Grade de horários da reunião', () => {
  it('dado número sem expediente, então vale o padrão comercial (seg–sex 09–18, fim de semana fechado)', () => {
    expect(faixaDeReuniao(null, 1)).toEqual({ de: '09:00', ate: '18:00' })
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

  it('⚠️ recorte 08–20: número 24h não oferta madrugada; faixa só de madrugada não tem reunião', () => {
    expect(faixaDeReuniao({ seg: { de: '00:00', ate: '23:59' } }, 1)).toEqual({ de: '08:00', ate: '20:00' })
    expect(faixaDeReuniao({ seg: { de: '22:00', ate: '02:00' } }, 1)).toBeNull()
    expect(faixaDeReuniao({ seg: { de: '06:00', ate: '09:00' } }, 1)).toEqual({ de: '08:00', ate: '09:00' })
  })

  it('candidatos de meia em meia hora cabendo a duração inteira', () => {
    expect(candidatosDoDia({ de: '09:00', ate: '11:00' }, 30).map((c) => c.de)).toEqual(['09:00', '09:30', '10:00', '10:30'])
    expect(candidatosDoDia({ de: '09:00', ate: '11:00' }, 60).map((c) => `${c.de}-${c.ate}`)).toEqual(['09:00-10:00', '09:30-10:30', '10:00-11:00'])
    expect(candidatosDoDia({ de: '09:00', ate: '09:20' }, 30)).toEqual([])
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
    expect(agendaNoTurno({ moduloAtivo: true, chaveLigada: true, modoDoNumero: null })).toBe(false)
  })

  it('efeito real só no modo efetivo autônomo; o resto é seco', () => {
    expect(efeitoDaAgenda('autonomo')).toBe('real')
    for (const m of ['sombra', 'assistido', 'simulacao', 'copiloto', 'desligado'] as const) expect(efeitoDaAgenda(m)).toBe('seco')
  })
})

describe('O que o cliente escolheu (leitura conservadora)', () => {
  const tres = [{ n: 1, hora: '09:00' }, { n: 2, hora: '14:00' }, { n: 3, hora: '16:00' }]

  it('pelo número da opção ou pelo ordinal como frase inteira', () => {
    expect(interpretarEscolhaDeHorario('2', tres)).toEqual({ tipo: 'escolheu', n: 2 })
    expect(interpretarEscolhaDeHorario('Opção 3', tres)).toEqual({ tipo: 'escolheu', n: 3 })
    expect(interpretarEscolhaDeHorario('a segunda', tres)).toEqual({ tipo: 'escolheu', n: 2 })
    expect(interpretarEscolhaDeHorario('a segunda opção', tres)).toEqual({ tipo: 'escolheu', n: 2 })
  })

  it('⚠️ ordinal que não é opção: dia da semana, "primeiro preciso…"', () => {
    expect(interpretarEscolhaDeHorario('segunda-feira fica melhor', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('primeiro preciso ver com meu sócio', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('na segunda semana', tres)).toEqual({ tipo: 'indefinido' })
  })

  it('⚠️ havendo hora, a hora decide', () => {
    expect(interpretarEscolhaDeHorario('pode ser segunda às 16h', tres)).toEqual({ tipo: 'escolheu', n: 3 })
    expect(interpretarEscolhaDeHorario('marca as 14 então', tres)).toEqual({ tipo: 'escolheu', n: 2 })
    expect(interpretarEscolhaDeHorario('marca as 10 então', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('16:00 fica ótimo', tres)).toEqual({ tipo: 'escolheu', n: 3 })
  })

  it('⚠️ número e hora que discordam → indefinido', () => {
    expect(interpretarEscolhaDeHorario('opção 1 às 16h', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('opção 3 às 16h', tres)).toEqual({ tipo: 'escolheu', n: 3 })
  })

  it('⚠️ negação nunca confirma', () => {
    expect(interpretarEscolhaDeHorario('não posso às 14h', tres)).toEqual({ tipo: 'recusou' })
    expect(interpretarEscolhaDeHorario('nenhum desses', tres)).toEqual({ tipo: 'recusou' })
    expect(interpretarEscolhaDeHorario('tem outro horário?', tres)).toEqual({ tipo: 'recusou' })
  })

  it('⚠️ "sim" com várias opções é ambíguo; com uma, confirma; "prefiro amanhã" não escolhe', () => {
    expect(interpretarEscolhaDeHorario('sim', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('Sim, pode marcar', [{ n: 1, hora: '10:00' }])).toEqual({ tipo: 'escolheu', n: 1 })
    expect(interpretarEscolhaDeHorario('prefiro amanhã', tres)).toEqual({ tipo: 'indefinido' })
  })

  it('hora não ofertada, opção inexistente ou conversa solta → indefinido', () => {
    expect(interpretarEscolhaDeHorario('às 11h', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('5', tres)).toEqual({ tipo: 'indefinido' })
    expect(interpretarEscolhaDeHorario('qual o preço da camiseta?', tres)).toEqual({ tipo: 'indefinido' })
  })
})

describe('Guarda da resposta (etapa do pipeline)', () => {
  const quandos = [{ data: '2030-03-13', hora: '15:00', diaIso: 3 }, { data: '2030-03-14', hora: '10:00', diaIso: 4 }]
  const linhas = [linhaDaOpcao({ n: 1, quando: 'qua, 13/03 às 15:00', com: 'Vera' }), linhaDaOpcao({ n: 2, quando: 'qui, 14/03 às 10:00', com: 'Vera' })]
  const base = { quandos, agendado: false, usouFerramenta: true, linhasOfertadas: linhas }

  it('a oferta montada pelo código passa', () => {
    expect(verificarReuniaoNaResposta([`Tenho estes horários:\n${linhas.join('\n')}`, 'Qual prefere?'], base)).toEqual([])
  })

  it('⚠️ hora, data ou dia inventados são barrados', () => {
    const v = verificarReuniaoNaResposta([`${linhas.join('\n')}`, 'Ou quinta às 16h, ou sexta 15/03?'], base)
    expect(v.map((x) => x.codigo).sort()).toEqual(['data_sem_fonte', 'dia_sem_fonte', 'horario_sem_fonte'])
  })

  it('⚠️ oferta sem as linhas do código (o cliente leria outra coisa) é barrada', () => {
    expect(verificarReuniaoNaResposta(['Posso quarta às 15:00 ou quinta às 10:00.'], base).map((x) => x.codigo)).toEqual(['opcao_fora_do_texto', 'opcao_fora_do_texto'])
  })

  it('⚠️ "reunião marcada" só com o evento criado no turno', () => {
    const p = { quandos: [quandos[0]!], agendado: false, usouFerramenta: false, linhasOfertadas: [] }
    expect(verificarReuniaoNaResposta(['Pronto, sua reunião está marcada para quarta às 15:00!'], p).map((x) => x.codigo)).toEqual(['marcacao_sem_evento'])
    expect(verificarReuniaoNaResposta(['Pronto, sua reunião está marcada para quarta às 15:00!'], { ...p, agendado: true })).toEqual([])
    expect(verificarReuniaoNaResposta(['Seu pedido foi confirmado.'], p)).toEqual([])
  })

  it('sem horário de reunião no turno, qualquer hora citada é barrada', () => {
    const p = { quandos: [], agendado: false, usouFerramenta: false, linhasOfertadas: [] }
    expect(verificarReuniaoNaResposta(['Um vendedor te chama amanhã às 9h.'], p).map((x) => x.codigo)).toEqual(['horario_sem_fonte'])
    expect(verificarReuniaoNaResposta(['Temos camisetas em 3 cores.'], p)).toEqual([])
  })
})

describe('Lembretes ao cliente', () => {
  const inicio = new Date('2030-03-10T15:00:00Z')
  const criadoCedo = new Date('2030-03-01T12:00:00Z')
  const ev = (criadoEm = criadoCedo, status = 'agendado') => ({ inicio, criadoEm, status })
  const ponto = new Date(inicio.getTime() - 24 * H)
  const util = { pontoH24: ponto, agoraUtil: true }

  it('H-24 a partir do ponto até 2h antes; H-2 nas 2h finais; nada antes nem depois', () => {
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 25 * H), util)).toBeNull()
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 24 * H), util)).toBe('h24')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 3 * H), util)).toBe('h24')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 2 * H), util)).toBe('h2')
    expect(lembreteDevido(ev(), inicio, util)).toBeNull()
  })

  it('⚠️ fora do período útil, nada agora; H-24 adiantado vale a partir do ponto útil anterior', () => {
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 3 * H), { ...util, agoraUtil: false })).toBeNull()
    const adiantado = new Date(inicio.getTime() - 60 * H)
    expect(lembreteDevido(ev(), adiantado, { pontoH24: adiantado, agoraUtil: true })).toBe('h24')
    expect(lembreteDevido(ev(), new Date(inicio.getTime() - 5 * H), { pontoH24: null, agoraUtil: true })).toBeNull()
  })

  it('marcado depois do ponto do lembrete não recebe aquele lembrete', () => {
    const criado = new Date(inicio.getTime() - 10 * H)
    expect(lembreteDevido(ev(criado), new Date(inicio.getTime() - 9 * H), util)).toBeNull()
    expect(lembreteDevido(ev(criado), new Date(inicio.getTime() - H), util)).toBe('h2')
  })

  it('fora de "agendado" não há lembrete', () => {
    for (const s of ['realizado', 'cancelado', 'nao_compareceu']) expect(lembreteDevido(ev(criadoCedo, s), new Date(inicio.getTime() - H), util)).toBeNull()
  })
})

describe('Desfecho pendente (não é no-show)', () => {
  const fim = new Date('2030-03-10T16:00:00Z')
  it('agendado depois do fim + 2h pede desfecho ao vendedor; marcado ou cancelado não', () => {
    expect(desfechoPendente({ fim, status: 'agendado' }, new Date(fim.getTime() + H))).toBe(false)
    expect(desfechoPendente({ fim, status: 'agendado' }, new Date(fim.getTime() + 2 * H))).toBe(true)
    for (const s of ['realizado', 'nao_compareceu', 'cancelado']) expect(desfechoPendente({ fim, status: s }, new Date(fim.getTime() + 9 * H))).toBe(false)
  })
})

describe('Por onde o aviso sai', () => {
  const tpl = { id: 't1', aprovado: true, compativel: true }
  it('oficial: texto com a janela aberta; fora dela, só o template aprovado', () => {
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: true, template: null, aquecimentoRestante: Infinity })).toEqual({ acao: 'texto' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: false, template: tpl, aquecimentoRestante: Infinity })).toEqual({ acao: 'template', templateId: 't1' })
    expect(decidirAvisoReuniao({ tipoCanal: 'whatsapp_oficial', janelaAberta: false, template: null, aquecimentoRestante: Infinity })).toEqual({ acao: 'recusar', motivo: 'sem_template' })
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
  it('"hoje/amanhã" pela data local; senão a data', () => {
    expect(quandoRelativo('2030-03-10', '2030-03-10')).toBe('hoje')
    expect(quandoRelativo('2030-03-11', '2030-03-10')).toBe('amanhã (11/03)')
    expect(quandoRelativo('2030-03-01', '2030-02-28')).toBe('amanhã (01/03)')
    expect(quandoRelativo('2030-03-13', '2030-03-10')).toBe('no dia 13/03')
  })
  it('lembrete com primeiro nome, dia e hora; sem nome não quebra', () => {
    expect(textoLembreteReuniao({ contato: 'Maria Souza', dia: '2030-03-11', hoje: '2030-03-10', hora: '12:00', responsavel: 'Ana Lima' }))
      .toBe('Olá, Maria! Passando para lembrar da nossa reunião amanhã (11/03) às 12:00 com Ana. Se precisar remarcar, é só responder por aqui.')
    expect(textoLembreteReuniao({ contato: null, dia: '2030-03-10', hoje: '2030-03-10', hora: '12:00', responsavel: null })).toMatch(/^Olá! .*hoje às 12:00\./)
    expect(textoReagendamento({ contato: 'João', dia: '2030-03-10', hora: '12:00' })).toMatch(/^Olá, João! Sentimos sua falta na reunião de 10\/03 às 12:00\./)
  })
})
