/**
 * Tipos COMUNS às portas de modelo: a falha tipificada (e seu recado para a
 * tela), a fala do histórico e o contexto do lead. A porta com ferramentas
 * mora em `porta-llm.ts` (ADR-023).
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

/**
 * A falha do modelo em LINGUAGEM DE QUEM OPERA, para a tela e para o log.
 *
 * ⚠️ Existe porque `motivo_saida` é lido por gente: a tela do agente mostrava
 * "Saiu porque: modelo falhou: resposta_inesperada", que não diz nem o que houve
 * nem o que fazer. O nome interno do motivo é para o código; quem abre a tela
 * precisa da frase.
 *
 * ⚠️ **O `detalhe` é a parte que vale.** É ele que diz QUAL dos três modelos da
 * cadeia respondeu e o que veio — sem isso, "fora do formato" manda a pessoa
 * trocar modelo no escuro. Ele era montado pelos adaptadores e descartado aqui
 * no meio do caminho.
 */
const RECADO_DA_FALHA: Record<MotivoFalhaLlm, string> = {
  credencial_invalida: 'IA sem credencial válida',
  limite_de_taxa: 'IA no limite de uso do fornecedor',
  indisponivel: 'IA fora do ar',
  conteudo_recusado: 'a IA recusou responder',
  resposta_inesperada: 'a IA respondeu fora do formato',
  limite_de_custo: 'sem crédito para a IA',
}

export function recadoDaFalha(motivo: MotivoFalhaLlm, detalhe?: string | undefined): string {
  const base = RECADO_DA_FALHA[motivo] ?? `IA falhou (${motivo})`
  return detalhe ? `${base} — ${detalhe}` : base
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
