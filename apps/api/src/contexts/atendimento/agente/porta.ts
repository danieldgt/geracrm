/**
 * A porta de MODELO DE LINGUAGEM — o que o nosso domínio precisa de um LLM,
 * definido por NÓS, nunca pela API do fornecedor (ADR-008, mesma filosofia dos
 * conectores de ERP, da porta de canal e da porta de plataforma de mídia).
 *
 * ⚠️ **O modelo PROPÕE; o domínio decide.** Nada aqui devolve uma ação: devolve
 * um texto para dizer, uma proposta de próximo passo e campos extraídos que
 * ainda vão passar por validação. Regra de negócio não mora no prompt (skill
 * `geracrm-ia`) — e um contrato que devolvesse "qualifiquei" ou "criei o
 * pedido" seria exatamente isso: regra escondida numa resposta de rede.
 *
 * Trocar de fornecedor é escrever outra implementação desta porta.
 */

/**
 * Capacidades declaradas. O produto DEGRADA conforme isto, e a degradação é
 * visível — nunca falha silenciosa.
 */
export interface CapacidadesLlm {
  /**
   * ⚠️ Devolve JSON no formato pedido de forma confiável. Sem isso, a extração
   * vira parsing de texto livre — que funciona na demonstração e falha na
   * primeira conversa em que o cliente escreve de um jeito diferente.
   */
  readonly saidaEstruturada: boolean
  /** Aceita instrução de sistema separada da conversa. */
  readonly instrucaoDeSistema: boolean
}

/**
 * Falha do modelo como resultado TIPIFICADO, nunca exceção — cada motivo pede
 * uma ação diferente de quem opera (regra da casa, PED-08).
 */
export type MotivoFalhaLlm =
  /** Chave ausente, inválida ou revogada. Ação: reconfigurar. */
  | 'credencial_invalida'
  /**
   * ⚠️ Estouro de cota do fornecedor. Ação: RECUAR e mandar para a fila humana.
   * Insistir no limite atrasa todos os tenants que dividem a mesma chave.
   */
  | 'limite_de_taxa'
  /** Fornecedor fora do ar. Ação: fila humana, e tentar de novo depois. */
  | 'indisponivel'
  /**
   * ⚠️ O modelo recusou responder (política de conteúdo). Ação: fila humana com
   * o motivo. NÃO é erro nosso e não adianta repetir — mas o cliente está
   * esperando, então alguém precisa saber.
   */
  | 'conteudo_recusado'
  /** Respondeu algo que não reconhecemos: JSON quebrado, campo faltando. */
  | 'resposta_inesperada'
  /** Nosso limite de custo por tenant estourou. Ação: degradar para humano. */
  | 'limite_de_custo'

export type ResultadoLlm<T> =
  | { readonly ok: true; readonly dados: T; readonly custo: CustoDoTurno }
  | { readonly ok: false; readonly motivo: MotivoFalhaLlm; readonly detalhe?: string | undefined }

/** ⚠️ Medido por turno para dar preço ao plano e detectar abuso (skill `geracrm-ia`). */
export interface CustoDoTurno {
  readonly tokensEntrada: number
  readonly tokensSaida: number
  readonly modelo: string
}

/** Uma fala da conversa, do ponto de vista de quem lê o histórico. */
export interface Fala {
  readonly de: 'cliente' | 'nos'
  readonly texto: string
}

/**
 * O que JÁ SABEMOS sobre quem está do outro lado.
 *
 * ⚠️ Existe porque três dos seis sinais de qualificação (§4.1 do escopo) já
 * estão no nosso banco. O agente que pergunta o CNPJ de quem já é cliente soa
 * como formulário, não como atendimento — e é o jeito mais rápido de a pessoa
 * desistir. Carrega o que sabe antes de abrir a boca, e só pergunta o buraco.
 *
 * ⚠️ Só entra aqui o que ajuda a conversar. Endereço completo e CNPJ inteiro não
 * melhoram a resposta e sairiam do nosso perímetro à toa.
 */
export interface ContextoDoLead {
  readonly nome: string | null
  readonly jaEhCliente: boolean
  readonly comprasNoUltimoAno: number
  readonly ultimaCompraEm: string | null
  readonly cidade: string | null
  /** ⚠️ Só se JÁ temos — nunca para o modelo "confirmar" um que ele inventou. */
  readonly temCnpj: boolean
}

/** O turno pedido ao modelo. */
export interface PedidoDeTurno {
  readonly historico: readonly Fala[]
  readonly lead: ContextoDoLead
  /** O lado curado da base híbrida: prazo, pagamento, entrega, troca. */
  readonly politicas: string
  /** ⚠️ Mensagem de WhatsApp. Parágrafo longo não é lido; o limite é do domínio. */
  readonly maxCaracteres: number
}

/**
 * O que o modelo PROPÕE. Nada aqui é decisão — tudo passa pelo domínio.
 */
export interface PropostaDeTurno {
  /** O texto a dizer. Ainda passa pelo gateway único de envio. */
  readonly texto: string
  /**
   * Próximo passo sugerido. ⚠️ `entregar` é sugestão de handoff, não handoff:
   * quem encerra a sessão é o domínio, registrando o motivo.
   */
  readonly proximoPasso: 'continuar' | 'entregar' | 'desistir'
  /** Por que sugeriu entregar ou desistir. Vai para `agente_sessao.motivo_saida`. */
  readonly motivo: string
  /**
   * ⚠️ Campos que o modelo ACHA que leu na conversa. **Nada disto é confiável.**
   * CNPJ passa por dígito verificador, cidade por catálogo, volume por faixa —
   * o modelo alucina campo bem formatado e errado com facilidade.
   */
  readonly extraidoBruto: Readonly<Record<string, string | number | boolean | null>>
}

export interface PortaLlm {
  readonly nome: string
  readonly capacidades: CapacidadesLlm
  conversar(pedido: PedidoDeTurno): Promise<ResultadoLlm<PropostaDeTurno>>
}

/**
 * Objeto nulo para fornecedor sem adaptador — mesmo padrão de
 * `PlataformaNaoImplementada`.
 *
 * ⚠️ Devolve falha NOMEADA em vez de lançar: o agente que encontra um provedor
 * inexistente manda a conversa para a fila humana, como faria com o fornecedor
 * fora do ar. Lançar aqui derrubaria a ingestão da mensagem, que já está salva.
 */
export class LlmNaoImplementado implements PortaLlm {
  readonly capacidades: CapacidadesLlm = { saidaEstruturada: false, instrucaoDeSistema: false }
  constructor(readonly nome: string) {}
  async conversar(): Promise<ResultadoLlm<PropostaDeTurno>> {
    return { ok: false, motivo: 'credencial_invalida', detalhe: `Sem adaptador para ${this.nome}.` }
  }
}
