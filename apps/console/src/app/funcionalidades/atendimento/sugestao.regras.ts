import type { ModoAgente, RespostaSugestao } from '@geracrm/shared'

/**
 * Regras PURAS do painel de sugestão do inbox (raia P13) — testadas em sugestao.regras.spec.ts.
 * O serviço faz HTTP; a página só apresenta.
 */

/** Estado do bloco "sugestão" — ramos explícitos (os cinco estados, skill geracrm-layout-ui). */
export type EstadoPainelSugestao = 'carregando' | 'erro' | 'sem_permissao' | 'pronto'

/** Rótulo do selo do modo do agente no número desta conversa. */
export function rotuloModo(modo: ModoAgente | null): string {
  switch (modo) {
    case 'autonomo': return 'Agente autônomo'
    case 'assistido': return 'Agente assistido'
    case 'sombra': return 'Agente em sombra'
    case 'desligado': return 'Agente desligado'
    default: return 'Agente não configurado'
  }
}

/** Dica curta do que o modo significa para quem está atendendo. */
export function dicaModo(modo: ModoAgente | null): string {
  switch (modo) {
    case 'autonomo': return 'O agente responde sozinho neste número.'
    case 'assistido': return 'O agente sugere; você envia, edita ou descarta.'
    case 'sombra': return 'O agente só observa; nada é sugerido sem você pedir.'
    case 'desligado': return 'O agente está desligado neste número.'
    default: return 'Configure o agente em Agente para pedir sugestões.'
  }
}

/** O que mostrar no lugar do botão "Sugerir resposta" quando ele não pode rodar. */
export function motivoSemCopiloto(r: Pick<RespostaSugestao, 'copilotoDisponivel' | 'motivoIndisponivel'>): string | null {
  if (r.copilotoDisponivel) return null
  if (r.motivoIndisponivel === 'agente.desligado') return 'Agente desligado — sugestão indisponível'
  return 'Agente não configurado neste número'
}

/** Erro tipado de POST …/sugestao/gerar → frase para a tela (nunca o texto cru do servidor sem código). */
export function mensagemErroGerar(status: number, corpo: { erro?: string; mensagem?: string } | null): string {
  switch (corpo?.erro) {
    case 'copiloto.indisponivel': return 'O assistente não respondeu a tempo. Tente de novo ou responda sem a sugestão.'
    case 'agente.desligado': return 'Agente desligado — sugestão indisponível.'
    case 'copiloto.em_andamento': return 'Já estou preparando uma sugestão para esta conversa.'
    case 'copiloto.sem_sugestao':
    case 'agente.sem_configuracao': return corpo.mensagem ?? 'Sem sugestão para esta conversa.'
    default:
      if (status === 0) return 'Sem conexão com o servidor. Tente de novo.'
      return 'Não foi possível pedir a sugestão. Tente de novo.'
  }
}

/** Tempo desde a sugestão ("agora", "há 3 min", "há 2 h") — o vendedor precisa saber se está velha. */
export function idadeDaSugestao(criadaEm: string, agora: Date = new Date()): string {
  const min = Math.floor((agora.getTime() - new Date(criadaEm).getTime()) / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  return `há ${Math.floor(min / 60)} h`
}
