import { describe, it, expect } from 'vitest'
import { REGRAS_AGENTE_PADRAO } from '@geracrm/shared'
import { portaoDoAgente, type ContextoPortao, type RegrasDePortao } from './portao.js'

/**
 * ⚠️ O que este teste protege é a decisão de FALAR, não o que é falado.
 *
 * O agente é a única parte do produto que conversa com o cliente final em nome
 * da marca sem revisão humana. O conteúdo é incerto por natureza — o gatilho
 * não pode ser. Cada recusa tem motivo nomeado, e cada motivo tem um teste.
 */
const BASE: ContextoPortao = {
  agenteAtivo: true,
  ninguemDisponivel: true,
  ausenciaJaEnviada: true,
  atendentePresente: false,
  sessaoAtiva: null,
  sessaoJaEncerrada: false,
  maxTurnos: 6,
  // ⚠️ Os padrões de fábrica, não valores inventados para o teste: é o que
  //    garante que estes casos descrevem o agente que está em produção.
  regras: REGRAS_AGENTE_PADRAO,
}
const com = (mudanca: Partial<ContextoPortao>): ContextoPortao => ({ ...BASE, ...mudanca })
/** Muda uma regra, mantendo as outras nos padrões. */
const comRegra = (r: Partial<RegrasDePortao>, ctx: Partial<ContextoPortao> = {}): ContextoPortao =>
  ({ ...BASE, ...ctx, regras: { ...REGRAS_AGENTE_PADRAO, ...r } })

describe('O caminho feliz', () => {
  it('fora do expediente, ausência já enviada, ninguém na mesa: abre sessão', () => {
    expect(portaoDoAgente(BASE)).toEqual({ entra: true, sessao: 'nova' })
  })

  it('sessão em curso continua', () => {
    expect(portaoDoAgente(com({ sessaoAtiva: { turnos: 2 } })))
      .toEqual({ entra: true, sessao: 'continua' })
  })
})

describe('⚠️ O gatilho: a ausência fala primeiro', () => {
  /**
   * Decisão de 2026-08-26. Sem ela, o cliente recebe duas automáticas seguidas
   * e a primeira ("voltamos amanhã às 9h") contradiz a segunda, que puxa
   * conversa. Quem escreve DEPOIS da ausência mostrou interesse — é o lead que
   * vale o custo de uma conversa com IA.
   */
  it('sem ausência antes, o agente NÃO entra', () => {
    expect(portaoDoAgente(com({ ausenciaJaEnviada: false })))
      .toEqual({ entra: false, motivo: 'sem_ausencia_antes' })
  })

  it('mas uma sessão JÁ EM CURSO não precisa da ausência de novo', () => {
    expect(portaoDoAgente(com({ ausenciaJaEnviada: false, sessaoAtiva: { turnos: 1 } })))
      .toEqual({ entra: true, sessao: 'continua' })
  })
})

describe('⚠️ Desligar vence tudo', () => {
  /**
   * O invariante 7 do escopo: o botão tem efeito na PRÓXIMA mensagem. Se
   * qualquer outra condição pudesse passar na frente, "desliguei e continuou
   * falando" seria um relato real — e é o pior relato possível sobre um agente.
   */
  it('agente desligado não fala, mesmo com tudo o mais a favor', () => {
    expect(portaoDoAgente(com({ agenteAtivo: false })))
      .toEqual({ entra: false, motivo: 'agente_desligado' })
  })

  it('desligado interrompe até sessão em curso', () => {
    expect(portaoDoAgente(com({ agenteAtivo: false, sessaoAtiva: { turnos: 1 } })))
      .toEqual({ entra: false, motivo: 'agente_desligado' })
  })
})

describe('Fronteiras da fatia 1', () => {
  /**
   * ⚠️ O agente cobre o VÁCUO, não substitui o time. Um consultor disponível —
   * logado, não-ausente, dentro do expediente — cala o agente na hora.
   */
  it('havendo quem atenda, o agente não fala', () => {
    expect(portaoDoAgente(com({ ninguemDisponivel: false })))
      .toEqual({ entra: false, motivo: 'tem_quem_atenda' })
  })

  /** ⚠️ Se tem gente ali, tem gente ali — inclusive de madrugada. */
  it('atendente presente cala o agente, mesmo com sessão em curso', () => {
    expect(portaoDoAgente(com({ atendentePresente: true })))
      .toEqual({ entra: false, motivo: 'atendente_presente' })
    expect(portaoDoAgente(com({ atendentePresente: true, sessaoAtiva: { turnos: 1 } })))
      .toEqual({ entra: false, motivo: 'atendente_presente' })
  })
})

describe('⚠️ O teto de turnos', () => {
  /**
   * Sem teto, um cliente confuso conversa com o robô por vinte mensagens e vai
   * embora achando que foi atendido. O teto é o que transforma "não consegui"
   * em "vou chamar alguém".
   */
  it('no teto, para', () => {
    expect(portaoDoAgente(com({ sessaoAtiva: { turnos: 6 } })))
      .toEqual({ entra: false, motivo: 'teto_de_turnos' })
  })

  it('um turno antes do teto ainda fala', () => {
    expect(portaoDoAgente(com({ sessaoAtiva: { turnos: 5 } })))
      .toEqual({ entra: true, sessao: 'continua' })
  })

  it('o teto é configurável por canal', () => {
    expect(portaoDoAgente(com({ sessaoAtiva: { turnos: 2 }, maxTurnos: 2 })))
      .toEqual({ entra: false, motivo: 'teto_de_turnos' })
  })
})

describe('⚠️ O agente não ressuscita', () => {
  /**
   * Depois de entregar ao humano ou desistir, ele não recomeça sozinho. Um robô
   * que volta a falar depois de dizer "vou chamar alguém" destrói a confiança na
   * própria entrega — e a entrega é o produto.
   */
  it('sessão já encerrada nesta conversa não abre outra', () => {
    expect(portaoDoAgente(com({ sessaoJaEncerrada: true })))
      .toEqual({ entra: false, motivo: 'sessao_ja_encerrada' })
  })

  it('nem mesmo com uma ausência nova antes', () => {
    expect(portaoDoAgente(com({ sessaoJaEncerrada: true, ausenciaJaEnviada: true })))
      .toEqual({ entra: false, motivo: 'sessao_ja_encerrada' })
  })
})


/**
 * ⚠️ AS REGRAS CONFIGURÁVEIS (0078) — o que a tela do agente passou a controlar.
 *
 * Cada caso prova as duas metades: que o padrão preserva o comportamento antigo
 * e que a chave realmente vira a decisão. Testar só a metade ligada deixaria
 * passar uma configuração que a tela oferece e o portão ignora — que é pior que
 * não ter a opção, porque o dono acha que mudou algo.
 */
describe('⚠️ Regra: só quando ninguém está disponível', () => {
  it('ligada (padrão), gente disponível cala o agente', () => {
    expect(portaoDoAgente(com({ ninguemDisponivel: false })))
      .toEqual({ entra: false, motivo: 'tem_quem_atenda' })
  })

  /** É a regra que abre caminho para entregar uma conversa ao robô de propósito. */
  it('desligada, o agente entra com a equipe na mesa', () => {
    expect(portaoDoAgente(comRegra({ soQuandoNinguemDisponivel: false }, { ninguemDisponivel: false })))
      .toEqual({ entra: true, sessao: 'nova' })
  })

  /**
   * ⚠️ Desligar esta regra NÃO libera falar por cima de um atendente ativo na
   * conversa: são duas guardas diferentes, e confundi-las faria o robô
   * interromper um atendimento humano em andamento.
   */
  it('desligada, ainda respeita o atendente presente na conversa', () => {
    expect(portaoDoAgente(comRegra(
      { soQuandoNinguemDisponivel: false },
      { ninguemDisponivel: false, atendentePresente: true },
    ))).toEqual({ entra: false, motivo: 'atendente_presente' })
  })
})

describe('⚠️ Regra: exigir a ausência antes', () => {
  it('ligada (padrão), sem ausência não entra', () => {
    expect(portaoDoAgente(com({ ausenciaJaEnviada: false })))
      .toEqual({ entra: false, motivo: 'sem_ausencia_antes' })
  })

  it('desligada, entra já na primeira mensagem', () => {
    expect(portaoDoAgente(comRegra({ exigirAusenciaAntes: false }, { ausenciaJaEnviada: false })))
      .toEqual({ entra: true, sessao: 'nova' })
  })
})

describe('⚠️ Regra: reabrir depois de encerrada', () => {
  it('desligada (padrão), não ressuscita na conversa', () => {
    expect(portaoDoAgente(com({ sessaoJaEncerrada: true })))
      .toEqual({ entra: false, motivo: 'sessao_ja_encerrada' })
  })

  /**
   * O caso medido em produção (28/ago): a conversa de teste travou aqui e o
   * agente ficou permanentemente mudo nela. Com a chave ligada, volta.
   */
  it('ligada, abre uma sessão NOVA na mesma conversa', () => {
    expect(portaoDoAgente(comRegra({ reabrirAposEncerrada: true }, { sessaoJaEncerrada: true })))
      .toEqual({ entra: true, sessao: 'nova' })
  })
})

describe('⚠️ Nenhuma regra vence o desligamento', () => {
  /**
   * O invariante 7 do escopo. Se qualquer combinação de configuração fizesse um
   * agente desligado falar, o botão de desligar deixaria de ser um botão de
   * desligar — e é o único controle que o dono da loja tem sobre o robô.
   */
  it('com tudo liberado e o agente desligado, continua desligado', () => {
    expect(portaoDoAgente(comRegra(
      { soQuandoNinguemDisponivel: false, exigirAusenciaAntes: false, reabrirAposEncerrada: true },
      { agenteAtivo: false, ninguemDisponivel: false, ausenciaJaEnviada: false, sessaoJaEncerrada: true },
    ))).toEqual({ entra: false, motivo: 'agente_desligado' })
  })

  /** O teto também não é vencido pelas chaves: sessão em curso respeita o limite. */
  it('com tudo liberado, o teto de turnos continua valendo', () => {
    expect(portaoDoAgente(comRegra(
      { soQuandoNinguemDisponivel: false, exigirAusenciaAntes: false, reabrirAposEncerrada: true },
      { sessaoAtiva: { turnos: 6 }, maxTurnos: 6 },
    ))).toEqual({ entra: false, motivo: 'teto_de_turnos' })
  })
})
