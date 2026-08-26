/**
 * O PORTÃO DO AGENTE SDR (AQ-19, fatia 1) — quem decide se o robô abre a boca.
 *
 * ⚠️ Esta é a única parte do produto que fala com o cliente final em nome da
 * marca sem ninguém revisando. Por isso a decisão de FALAR mora aqui, pura e
 * testada, separada de qualquer modelo de linguagem: o que o agente diz é
 * incerto por natureza; SE ele diz não pode ser.
 *
 * ⚠️ O gatilho não é "chegou mensagem fora do expediente" — é "chegou mensagem
 * DEPOIS de a resposta de ausência já ter saído". Decisão de produto de
 * 2026-08-26 (§4.3.1 do escopo), e a razão é boa: a ausência é honesta e barata
 * ("voltamos às 9h"), e quem escreve de novo DEPOIS dela mostrou interesse — que
 * é exatamente o lead que vale o custo de uma conversa com IA. De quebra, o
 * desenho degrada sozinho: agente desligado ou provedor fora do ar deixa o
 * comportamento de hoje, que já funciona.
 *
 * Sem essa ordem, o cliente recebe duas automáticas seguidas e a primeira
 * ("voltamos amanhã") contradiz a segunda, que puxa conversa.
 */

/** Tudo que a decisão precisa. Coletado por quem chama; aqui não há consulta. */
export interface ContextoPortao {
  /** `agente_config.ativo` — o botão de desligar, lido a cada mensagem. */
  readonly agenteAtivo: boolean
  readonly foraDoExpediente: boolean
  /** A ausência já saiu nesta conversa? É o gatilho. */
  readonly ausenciaJaEnviada: boolean
  /** Mesma régua de presença da resposta de ausência (atividade recente). */
  readonly atendentePresente: boolean
  /** Sessão em curso, se houver. `null` = a próxima fala inicia uma. */
  readonly sessaoAtiva: { readonly turnos: number } | null
  /** Já houve sessão ENCERRADA nesta conversa (entregue ou desistiu). */
  readonly sessaoJaEncerrada: boolean
  readonly maxTurnos: number
}

export type MotivoNaoEntra =
  | 'agente_desligado'
  | 'dentro_do_expediente'
  | 'sem_ausencia_antes'
  | 'atendente_presente'
  | 'teto_de_turnos'
  | 'sessao_ja_encerrada'

export type DecisaoPortao =
  | { readonly entra: true; readonly sessao: 'nova' | 'continua' }
  | { readonly entra: false; readonly motivo: MotivoNaoEntra }

const NAO = (motivo: MotivoNaoEntra): DecisaoPortao => ({ entra: false, motivo })

/**
 * O agente deve responder a esta mensagem entrante?
 *
 * ⚠️ A ORDEM das checagens é a ordem do risco, e não é arbitrária: o
 * desligamento vem primeiro porque tem de vencer todo o resto, e a presença
 * humana vem antes do teto porque um atendente na mesa encerra o assunto
 * independentemente de quantos turnos já houve.
 *
 * ⚠️ Opt-out NÃO é checado aqui de propósito: ele mora no gateway único de
 * envio (INV-50), por onde o agente fala como todo mundo. Duplicar a checagem
 * criaria uma segunda verdade que envelhece — e a que envelhece é sempre a
 * cópia.
 */
export function portaoDoAgente(c: ContextoPortao): DecisaoPortao {
  // ⚠️ Primeiro de todos. Desligar tem de vencer qualquer outra condição.
  if (!c.agenteAtivo) return NAO('agente_desligado')

  // Fatia 1 é só fora do expediente: dentro dele, quem atende é gente.
  if (!c.foraDoExpediente) return NAO('dentro_do_expediente')

  // ⚠️ Alguém está na mesa AGORA (mesma régua da resposta de ausência): o robô
  //    não fala por cima de atendimento humano. Vale inclusive de madrugada —
  //    se tem gente ali, tem gente ali.
  if (c.atendentePresente) return NAO('atendente_presente')

  // Sessão em curso continua, respeitando o teto.
  if (c.sessaoAtiva) {
    return c.sessaoAtiva.turnos >= c.maxTurnos
      ? NAO('teto_de_turnos')
      : { entra: true, sessao: 'continua' }
  }

  // ⚠️ Já conversou e saiu nesta conversa (entregou ou desistiu): não recomeça
  //    sozinho. Reabrir daria ao cliente um robô que ressuscita depois de ter
  //    dito que ia chamar alguém — a forma mais rápida de perder a confiança na
  //    entrega ao humano.
  if (c.sessaoJaEncerrada) return NAO('sessao_ja_encerrada')

  // ⚠️ O GATILHO. Só entra depois de a ausência ter falado.
  if (!c.ausenciaJaEnviada) return NAO('sem_ausencia_antes')

  return { entra: true, sessao: 'nova' }
}
