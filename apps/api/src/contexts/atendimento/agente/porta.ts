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
 *
 * ⚠️ Quem traduz HTTP/SDK para estes motivos é o ADAPTADOR (só ele conhece o
 *    formato do fornecedor). A tabela completa, com a classe de cada motivo,
 *    está em `CLASSE_DO_MOTIVO` abaixo e no teste `falha-llm.test.ts` (ADR-030).
 */
export type MotivoFalhaLlm =
  /** 401: chave ausente, inválida ou revogada. Ação: reconfigurar. */
  | 'credencial_invalida'
  /**
   * 403/404 num MODELO: a chave vale, mas este modelo não está liberado para
   * ela (ou não existe mais). ⚠️ Não é a credencial inteira: bloqueia o modelo
   * por 1 h e cai no `IA_MODELO` (ADR-030 §3 — o "Haiku bloqueado no Bedrock").
   */
  | 'acesso_negado'
  /**
   * 429: estouro de taxa do fornecedor. Ação: RECUAR. Insistir no limite atrasa
   * todos os tenants que dividem a mesma chave.
   */
  | 'limite_de_taxa'
  /** 408/5xx/529, rede, tempo esgotado: fornecedor fora ou sobrecarregado. */
  | 'indisponivel'
  /**
   * ⚠️ O modelo recusou responder (política de conteúdo). NÃO é erro nosso e não
   * adianta repetir — mas o cliente está esperando, então alguém precisa saber.
   */
  | 'conteudo_recusado'
  /**
   * 400/413/422: o fornecedor recusou o PEDIDO (erro nosso: esquema, tamanho,
   * parâmetro). Trocar de provedor não resolve — não conta para a reserva.
   */
  | 'requisicao_invalida'
  /** Respondeu algo que não reconhecemos: JSON quebrado, campo faltando, teto de tokens. */
  | 'resposta_inesperada'
  /** 402 / cota / sem crédito no fornecedor. Não se resolve sozinho. */
  | 'limite_de_custo'

/**
 * As quatro classes de falha (ADR-030 §1) — o que a política do turno e a
 * reserva de provedor fazem com cada uma.
 *
 * | classe       | o que é                                   | reserva conta? | turno em autônomo                       |
 * |--------------|-------------------------------------------|----------------|-----------------------------------------|
 * | fatal        | chave, crédito, modelo negado             | sim            | handoff na hora, com aviso sem prazo    |
 * | transitoria  | taxa, 5xx, rede, tempo                    | sim            | 1ª: aviso + reagenda 30 s; 2ª: handoff  |
 * | requisicao   | pedido recusado, conteúdo recusado        | não            | handoff com aviso                       |
 * | formato      | saída fora do esquema                     | não            | handoff com aviso                       |
 */
export type ClasseFalhaLlm = 'fatal' | 'transitoria' | 'requisicao' | 'formato'

const CLASSE_DO_MOTIVO: Record<MotivoFalhaLlm, ClasseFalhaLlm> = {
  credencial_invalida: 'fatal',
  acesso_negado: 'fatal',
  limite_de_custo: 'fatal',
  limite_de_taxa: 'transitoria',
  indisponivel: 'transitoria',
  conteudo_recusado: 'requisicao',
  requisicao_invalida: 'requisicao',
  resposta_inesperada: 'formato',
}

/**
 * Classe de um motivo. Aceita `string` porque o turno também classifica
 * `'formato'` (saída que não passou no esquema do domínio). ⚠️ Motivo
 * desconhecido é `fatal`: tratar o que não entendemos como passageiro faria o
 * agente insistir num erro que não sabe nomear.
 */
export function classeDaFalhaLlm(motivo: string): ClasseFalhaLlm {
  if (motivo === 'formato') return 'formato'
  return (CLASSE_DO_MOTIVO as Record<string, ClasseFalhaLlm>)[motivo] ?? 'fatal'
}

/**
 * Falha DO PROVEDOR (fatal ou transitória): é a que conta para ligar a
 * reserva. Erro de requisição e de formato não contam — outro fornecedor
 * receberia o mesmo pedido e falharia igual.
 */
export function ehFalhaDeProvedor(motivo: string): boolean {
  const c = classeDaFalhaLlm(motivo)
  return c === 'fatal' || c === 'transitoria'
}

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
  acesso_negado: 'IA sem acesso a este modelo',
  limite_de_taxa: 'IA no limite de uso do fornecedor',
  indisponivel: 'IA fora do ar',
  conteudo_recusado: 'a IA recusou responder',
  requisicao_invalida: 'o fornecedor de IA recusou o pedido',
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
