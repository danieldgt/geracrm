/**
 * O PORTÃO DO AGENTE SDR (AQ-19, fatia 1) — quem decide se o robô abre a boca.
 *
 * ⚠️ Esta é a única parte do produto que fala com o cliente final em nome da
 * marca sem ninguém revisando. Por isso a decisão de FALAR mora aqui, pura e
 * testada, separada de qualquer modelo de linguagem: o que o agente diz é
 * incerto por natureza; SE ele diz não pode ser.
 *
 * ⚠️ O gatilho tem DUAS condições, e as duas nasceram de decisões de produto:
 * (1) não há ninguém disponível para atender este número (27/ago, ver
 * `disponibilidade.ts`) e (2) a resposta de ausência já saiu. A segunda é de
 * 2026-08-26 (§4.3.1 do escopo), e a razão é boa: a ausência é honesta e barata
 * ("voltamos às 9h"), e quem escreve de novo DEPOIS dela mostrou interesse — que
 * é exatamente o lead que vale o custo de uma conversa com IA. De quebra, o
 * desenho degrada sozinho: agente desligado ou provedor fora do ar deixa o
 * comportamento de hoje, que já funciona.
 *
 * Sem essa ordem, o cliente recebe duas automáticas seguidas e a primeira
 * ("voltamos amanhã") contradiz a segunda, que puxa conversa.
 *
 * ⚠️ As duas condições só passaram a fazer a MESMA pergunta em 2026-09-01. Antes
 * disso a (1) era "ninguém disponível" e a (2), por dentro, ainda era "fora do
 * expediente" — a ausência só saía com a loja fechada. Em horário comercial com
 * a equipe toda offline, o gatilho nunca vinha e o agente esperava para sempre,
 * registrando `sem_ausencia_antes`, um motivo que aponta para o lugar errado.
 */

/** Tudo que a decisão precisa. Coletado por quem chama; aqui não há consulta. */
export interface ContextoPortao {
  /** `agente_config.ativo` — o botão de desligar, lido a cada mensagem. */
  readonly agenteAtivo: boolean
  /**
   * ⚠️ NÃO é mais "fora do expediente". É "não há ninguém para atender ESTE
   * número": todos ausentes, ninguém logado, ou a loja fechada. Decisão do dono
   * do produto (27/ago) — a regra antiga deixava o cliente no vácuo quando o
   * consultor entrava em reunião às 14h, porque tecnicamente era horário
   * comercial. Ver `disponibilidade.ts`.
   */
  readonly ninguemDisponivel: boolean
  /** A ausência já saiu nesta conversa? É o gatilho. */
  readonly ausenciaJaEnviada: boolean
  /** Mesma régua de presença da resposta de ausência (atividade recente). */
  readonly atendentePresente: boolean
  /** Sessão em curso, se houver. `null` = a próxima fala inicia uma. */
  readonly sessaoAtiva: { readonly turnos: number } | null
  /**
   * A última sessão ENCERRADA nesta conversa (entregue ou desistiu), se houver.
   *
   * ⚠️ Deixou de ser um booleano em 01/09, e a razão está no que o booleano
   * escondia: ele dizia "já houve", nunca "quando" — e por isso a trava não
   * tinha como expirar. Aqui entram os dois fatos que decidem se ela ainda faz
   * sentido; o julgamento é do portão, não da consulta.
   */
  readonly sessaoEncerrada: SessaoEncerrada | null
  readonly maxTurnos: number
  /**
   * ⚠️ AS TRÊS REGRAS CONFIGURÁVEIS (0078). Eram decisões fixas aqui dentro;
   * agora vêm de `agente_config`, com os padrões iguais ao que estava escrito.
   *
   * ⚠️ Elas ligam e desligam GUARDAS, nunca o desligamento do agente — `ativo`
   * continua vencendo tudo. Uma configuração que pudesse fazer um agente
   * desligado falar não seria configuração, seria um buraco.
   */
  readonly regras: RegrasDePortao
}

/** O que se sabe sobre a última vez que o agente saiu desta conversa. */
export interface SessaoEncerrada {
  /** Horas decorridas desde o encerramento — calculadas no banco, com o mesmo `agora`. */
  readonly horasDesde: number
  /**
   * ⚠️ Um atendimento HUMANO foi encerrado depois daquela sessão. Vale como
   * "assunto fechado": o robô entregou, uma pessoa atendeu e concluiu. O que
   * vier agora é conversa nova, não a continuação do handoff — e é por isso que
   * este fato dispensa o prazo.
   */
  readonly humanoAtendeuDepois: boolean
}

/** O subconjunto de `RegrasDoAgente` que a decisão de ENTRAR consulta. */
export interface RegrasDePortao {
  /** `false` = o robô fala mesmo com a equipe disponível. */
  readonly soQuandoNinguemDisponivel: boolean
  /** `false` = entra já na primeira mensagem, sem esperar o cliente insistir. */
  readonly exigirAusenciaAntes: boolean
  /** `true` = volta a falar numa conversa em que já encerrou, sem esperar nada. */
  readonly reabrirAposEncerrada: boolean
  /** Com `reabrirAposEncerrada` desligado, por quantas horas a trava vale. */
  readonly horasParaReabrir: number
}

/**
 * A trava de "já conversei aqui" ainda vale?
 *
 * ⚠️ Ela protege UMA coisa: o cliente que acabou de ouvir "vou chamar alguém"
 * não pode receber o robô de volta em seguida. Isso tem prazo de validade, e
 * confundir a proteção com o prazo foi o defeito: sem expirar, a conversa ficava
 * sem agente para sempre — inclusive dias depois, com outro assunto e ninguém na
 * mesa (medido em produção em 01/09, seis mensagens seguidas sem resposta).
 */
function travaAindaVale(s: SessaoEncerrada, horasParaReabrir: number): boolean {
  // O ciclo já foi fechado por gente: o que vier agora é assunto novo.
  if (s.humanoAtendeuDepois) return false
  return s.horasDesde < horasParaReabrir
}

export type MotivoNaoEntra =
  | 'agente_desligado'
  | 'tem_quem_atenda'
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

  // ⚠️ Havendo alguém disponível, quem atende é GENTE. O agente cobre o vácuo,
  //    não substitui o time. DESLIGÁVEL (0078): quem quer o robô atendendo junto
  //    com a equipe desliga isto na tela — e assume o que vem junto.
  if (c.regras.soQuandoNinguemDisponivel && !c.ninguemDisponivel) return NAO('tem_quem_atenda')

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
  //    sozinho ENQUANTO a trava valer. Reabrir na hora daria ao cliente um robô
  //    que ressuscita depois de ter dito que ia chamar alguém — a forma mais
  //    rápida de perder a confiança na entrega ao humano. Mas a trava expira
  //    (0079), porque "não agora" e "nunca mais" não são a mesma decisão.
  //    DESLIGÁVEL por inteiro (0078) para triagem permanente e para conversa de
  //    teste, que sem isso trava no primeiro encerramento.
  if (!c.regras.reabrirAposEncerrada && c.sessaoEncerrada
      && travaAindaVale(c.sessaoEncerrada, c.regras.horasParaReabrir)) {
    return NAO('sessao_ja_encerrada')
  }

  // ⚠️ O GATILHO. Só entra depois de a ausência ter falado — e a ausência sai
  //    quando NÃO HÁ QUEM ATENDA (`ausencia.ts`), não mais só fora do
  //    expediente. Enquanto foram duas réguas diferentes, isto era um beco sem
  //    saída: em horário comercial sem ninguém na mesa, nunca virava verdade.
  //    DESLIGÁVEL (0078): sem ele o agente responde já na primeira mensagem —
  //    mais alcance, mais custo, e sem o filtro que separa quem tem interesse
  //    de quem mandou "oi" e sumiu.
  if (c.regras.exigirAusenciaAntes && !c.ausenciaJaEnviada) return NAO('sem_ausencia_antes')

  return { entra: true, sessao: 'nova' }
}
