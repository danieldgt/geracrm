/**
 * AS REGRAS DE ENTRADA DO AGENTE — quando o robô pode abrir a boca.
 *
 * ⚠️ Isto era um punhado de CONSTANTES espalhadas pelo código da API
 * (`FALAS_DE_CONTEXTO`, `HORAS_DESDE_A_AUSENCIA`, `MAX_CARACTERES`,
 * `MINUTOS_DE_PRESENCA`) e por decisões embutidas no portão. Cada uma foi
 * calibrada para um cenário só: agente de madrugada, cobrindo o vácuo. Mudar
 * qualquer uma exigia deploy, e o dono da loja — que é quem convive com o
 * resultado — não tinha como opinar.
 *
 * ⚠️ **Os padrões são exatamente o comportamento de hoje.** Isto é uma abertura
 * de controle, não uma mudança de produto: quem não mexer em nada continua com o
 * agente que já tinha.
 *
 * ⚠️ Mora em `shared` porque a API valida e a tela oferece os MESMOS limites. Um
 * `min`/`max` duplicado entre input e endpoint é o clássico que aceita na tela e
 * recusa no servidor — ou, pior, o contrário.
 */

export interface RegrasDoAgente {
  /**
   * ⚠️ O robô só entra quando NÃO há quem atenda (fora do expediente, todos
   * ausentes, ninguém logado). Desligar isto faz o agente responder mesmo com a
   * equipe na mesa — é o que abre caminho para entregar uma conversa a ele de
   * propósito, e é a regra de maior consequência da tela.
   */
  readonly soQuandoNinguemDisponivel: boolean
  /**
   * ⚠️ O gatilho de §4.3.1: só conversa com quem escreveu DE NOVO depois da
   * resposta de ausência. É o filtro que separa o lead interessado de quem
   * mandou "oi" e dormiu — e é ele que segura o custo de IA.
   */
  readonly exigirAusenciaAntes: boolean
  /** Por quanto tempo a ausência enviada continua valendo como gatilho. */
  readonly horasDesdeAusencia: number
  /**
   * ⚠️ Depois de encerrar numa conversa, o agente volta se o cliente escrever de
   * novo? O padrão é NÃO: um robô que ressuscita depois de dizer que ia chamar
   * alguém destrói a confiança na entrega ao humano. Ligar isto é útil em
   * conversa de teste e em loja que usa o agente como triagem permanente.
   */
  readonly reabrirAposEncerrada: boolean
  /**
   * Por quantos minutos a atividade de um atendente na conversa cala o robô.
   *
   * ⚠️ Baixar isto faz o agente falar mais cedo depois de uma pessoa. A régua da
   * resposta de ausência NÃO muda junto — ela continua na de fábrica.
   */
  readonly minutosPresenca: number
  /** Teto de idas e vindas antes de entregar ao humano. */
  readonly maxTurnos: number
  /** ⚠️ Mensagem de WhatsApp: parágrafo longo não é lido. */
  readonly maxCaracteres: number
  /** Quantas falas da conversa vão como histórico para o modelo. */
  readonly falasDeContexto: number
}

/** ⚠️ Idênticos ao comportamento anterior à tela. Não são chute. */
export const REGRAS_AGENTE_PADRAO: RegrasDoAgente = {
  soQuandoNinguemDisponivel: true,
  exigirAusenciaAntes: true,
  horasDesdeAusencia: 12,
  reabrirAposEncerrada: false,
  minutosPresenca: 60,
  maxTurnos: 6,
  maxCaracteres: 320,
  falasDeContexto: 10,
}

/**
 * ⚠️ Faixas com razão, não números redondos: `falasDeContexto` alto multiplica o
 * custo de todo turno (o histórico vai inteiro em cada chamada) e
 * `maxCaracteres` alto produz parágrafo que ninguém lê no celular.
 */
export const FAIXAS_REGRAS_AGENTE = {
  horasDesdeAusencia: { min: 1, max: 72 },
  minutosPresenca: { min: 5, max: 480 },
  maxTurnos: { min: 1, max: 20 },
  maxCaracteres: { min: 80, max: 1000 },
  falasDeContexto: { min: 2, max: 40 },
} as const

export type CampoNumericoDeRegra = keyof typeof FAIXAS_REGRAS_AGENTE

/** Rótulos da tela e das mensagens de erro — uma escrita só para os dois. */
export const ROTULO_REGRA: Record<CampoNumericoDeRegra, string> = {
  horasDesdeAusencia: 'Validade da ausência como gatilho (horas)',
  minutosPresenca: 'Silêncio após um atendente responder (minutos)',
  maxTurnos: 'Máximo de idas e vindas',
  maxCaracteres: 'Tamanho máximo da resposta (caracteres)',
  falasDeContexto: 'Falas da conversa enviadas ao modelo',
}

export interface ErroDeRegra {
  readonly campo: CampoNumericoDeRegra
  readonly mensagem: string
}

/**
 * Valida o que veio da tela e devolve as regras completas.
 *
 * ⚠️ **Retorno tipificado, não exceção** (PED-08): a tela precisa do campo e da
 * frase, e o CHECK do banco é a rede de segurança — não a mensagem.
 *
 * ⚠️ Campo ausente cai no PADRÃO em vez de falhar. A tela manda o formulário
 * inteiro, mas o endpoint também é chamado por script e por teste, e recusar um
 * PUT parcial só produziria erro em quem não quis mudar aquela regra.
 */
export function validarRegrasAgente(
  bruto: Partial<Record<keyof RegrasDoAgente, unknown>>,
): { readonly ok: true; readonly regras: RegrasDoAgente } | { readonly ok: false; readonly erros: readonly ErroDeRegra[] } {
  const erros: ErroDeRegra[] = []

  const numero = (campo: CampoNumericoDeRegra): number => {
    const v = bruto[campo]
    if (v === undefined || v === null || v === '') return REGRAS_AGENTE_PADRAO[campo]
    const n = typeof v === 'number' ? v : Number(v)
    const { min, max } = FAIXAS_REGRAS_AGENTE[campo]
    if (!Number.isInteger(n) || n < min || n > max) {
      erros.push({ campo, mensagem: `${ROTULO_REGRA[campo]}: informe um número inteiro entre ${min} e ${max}.` })
      return REGRAS_AGENTE_PADRAO[campo]
    }
    return n
  }

  // ⚠️ Só `true` liga e só `false` desliga; qualquer outra coisa é o padrão. Um
  //    `Boolean(v)` transformaria a string "false" em ligado — e a regra que
  //    mais importa aqui é justamente uma que fica LIGADA por padrão.
  const booleano = (campo: 'soQuandoNinguemDisponivel' | 'exigirAusenciaAntes' | 'reabrirAposEncerrada'): boolean => {
    const v = bruto[campo]
    return v === true || v === false ? v : REGRAS_AGENTE_PADRAO[campo]
  }

  const regras: RegrasDoAgente = {
    soQuandoNinguemDisponivel: booleano('soQuandoNinguemDisponivel'),
    exigirAusenciaAntes: booleano('exigirAusenciaAntes'),
    reabrirAposEncerrada: booleano('reabrirAposEncerrada'),
    horasDesdeAusencia: numero('horasDesdeAusencia'),
    minutosPresenca: numero('minutosPresenca'),
    maxTurnos: numero('maxTurnos'),
    maxCaracteres: numero('maxCaracteres'),
    falasDeContexto: numero('falasDeContexto'),
  }

  return erros.length > 0 ? { ok: false, erros } : { ok: true, regras }
}

/**
 * O que dizer na tela sobre o risco de uma configuração — em português de gente.
 *
 * ⚠️ Existe porque duas destas regras mudam QUEM fala com o cliente, e a tela
 * não pode deixar isso implícito num checkbox. Aviso não é decoração: sem ele o
 * dono liga a opção, o robô responde por cima da equipe no dia seguinte, e
 * ninguém liga uma coisa à outra.
 */
export function avisosDasRegras(r: RegrasDoAgente): readonly string[] {
  const avisos: string[] = []
  if (!r.soQuandoNinguemDisponivel) {
    avisos.push('O agente vai responder mesmo com a equipe disponível, em horário comercial.')
  }
  if (!r.exigirAusenciaAntes) {
    avisos.push('Ele entra já na primeira mensagem, sem esperar o cliente insistir — o custo por conversa sobe.')
  }
  if (r.reabrirAposEncerrada) {
    avisos.push('Depois de entregar uma conversa ao humano, ele volta a falar se o cliente escrever de novo.')
  }
  if (r.minutosPresenca < REGRAS_AGENTE_PADRAO.minutosPresenca) {
    avisos.push(`Ele volta a falar ${r.minutosPresenca} min depois de um atendente responder.`)
  }
  return avisos
}
