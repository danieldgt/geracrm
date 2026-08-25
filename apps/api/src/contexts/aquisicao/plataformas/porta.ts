/**
 * A porta de PLATAFORMA DE MÍDIA — o que uma plataforma de anúncio faz, definido
 * pelo NOSSO domínio, nunca pela API do fornecedor (ADR-008, mesma filosofia dos
 * conectores de ERP e da porta de canal).
 *
 * Google Ads e Meta Marketing são dois ADAPTADORES desta porta. O resto da camada
 * (sincronizador, painel, analista, vigia) fala com a porta e não sabe se o custo
 * veio em micros ou em decimal — só o adaptador conhece o formato do fornecedor.
 *
 * ⚠️ Vive no contexto `aquisicao` da API (server-side): sai para a rede. As regras
 * puras — conversão de custo, código de origem — moram em `packages/shared`,
 * porque o console também precisa delas.
 */
import type { Plataforma } from '@geracrm/shared'

/**
 * Capacidades declaradas. O produto DEGRADA conforme isto e a degradação é
 * VISÍVEL na interface (ADR-008) — nunca falha silenciosa.
 *
 * ⚠️ É aqui que a consequência de AMK-012/015 fica registrada em código, não só
 * em documento: `cliqueParaConversa: false` no Google é exatamente o motivo de a
 * landing page com `wa.me` existir. Se um dia a Meta entrar, a capacidade vira
 * `true` e o `modo_entrada` ganha um terceiro valor — sem reescrever o resto.
 */
export interface CapacidadesPlataforma {
  /** Lê conta, campanha, conjunto e anúncio. Base de tudo. */
  readonly leituraEstrutura: boolean
  /** Lê impressão, clique e CUSTO por dia. */
  readonly leituraMetrica: boolean
  /** Sobe público a partir da nossa base (Customer Match / Custom Audience). */
  readonly publicoPersonalizado: boolean
  /** Recebe conversão com valor real da venda (offline / CAPI). */
  readonly conversaoOffline: boolean
  /**
   * ⚠️ Formato em que o LEAD inicia a conversa no WhatsApp (Click-to-WhatsApp).
   * Só a Meta tem. Sem ele, a janela de 24h não nasce aberta e a operação depende
   * da LP com `wa.me` (AQ-44) para se manter inbound (AMK-014).
   */
  readonly cliqueParaConversa: boolean
  /** Pausa e reativa (a escrita de MENOR risco — Fase 4, primeiro passo). */
  readonly escritaEstado: boolean
  /** Altera orçamento. ⚠️ A escrita de maior risco: mexe em dinheiro e reseta aprendizado. */
  readonly escritaOrcamento: boolean
}

/**
 * Falha de plataforma como resultado TIPIFICADO, nunca exceção — cada motivo
 * pede uma ação diferente de quem opera (regra da casa, PED-08).
 */
export type MotivoFalhaPlataforma =
  /** Token expirado ou revogado. Ação: reconectar a conta. */
  | 'credencial_invalida'
  /** Autenticou, mas não tem acesso a esta conta. Ação: revisar o vínculo de parceiro. */
  | 'sem_permissao'
  /**
   * ⚠️ Estouro de cota. Ação: RECUAR — nunca repetir na hora. Insistir no limite
   * derruba a sincronização de TODOS os clientes que compartilham o app.
   */
  | 'limite_de_taxa'
  /** Conta suspensa ou sem meio de pagamento (AMK-002). Ação: falar com o cliente. */
  | 'conta_indisponivel'
  /** Fornecedor fora do ar. Ação: esperar e tentar de novo. */
  | 'indisponivel'
  /** Resposta que não reconhecemos — a API mudou. Ação: olhar o log. */
  | 'resposta_inesperada'

export type ResultadoPlataforma<T> =
  | { readonly ok: true; readonly dados: T }
  | { readonly ok: false; readonly motivo: MotivoFalhaPlataforma; readonly detalhe?: string | undefined }

/**
 * ⚠️ Falha **permanente** — retentar não adianta, o problema é humano (credencial
 * revogada, acesso perdido, conta sem meio de pagamento). Quem despacha manda
 * direto para o dead-letter em vez de queimar oito tentativas contra uma parede.
 */
export function ehFalhaPermanente(motivo: MotivoFalhaPlataforma): boolean {
  return motivo === 'credencial_invalida'
      || motivo === 'sem_permissao'
      || motivo === 'conta_indisponivel'
}

/** Um nó da hierarquia, já traduzido do formato do fornecedor para o nosso. */
export interface NoVeiculacao {
  readonly idExterno: string
  readonly nome: string
  readonly estado: 'rascunho' | 'ativa' | 'pausada' | 'removida'
  /** `null` só no topo (conta). */
  readonly paiExternoId: string | null
}

/** A estrutura completa de uma conta, num só retorno. */
export interface EstruturaVeiculacao {
  readonly campanhas: readonly NoVeiculacao[]
  readonly conjuntos: readonly NoVeiculacao[]
  readonly anuncios: readonly NoVeiculacao[]
}

/**
 * Métrica de um anúncio num dia.
 *
 * ⚠️ **Custo já em CENTAVOS INTEIROS** — a conversão (micros no Google, decimal em
 * texto na Meta) acontece DENTRO do adaptador. Float e micros não atravessam a
 * porta; se atravessassem, cada consumidor arredondaria do seu jeito.
 *
 * ⚠️ Só métrica ADITIVA. Alcance e frequência deduplicam pessoas e não somam
 * entre anúncios — ficam de fora por desenho (ver a migration 0058).
 */
export interface MetricaDiaExterna {
  readonly anuncioExternoId: string
  /** `YYYY-MM-DD` no fuso da CONTA — ⚠️ não no nosso. */
  readonly dia: string
  readonly impressoes: number
  readonly cliques: number
  readonly custoCentavos: number
  /** ⚠️ O que a plataforma REIVINDICA. Não é a nossa verdade (o ERP é). */
  readonly conversoesPlataforma: number
}

export interface PeriodoConsulta {
  /** `YYYY-MM-DD`, inclusivo. */
  readonly de: string
  readonly ate: string
}

/**
 * Uma conversão pronta para devolver à plataforma.
 *
 * ⚠️ O `valorCentavos` é o que faz a plataforma parar de buscar lead barato e
 * começar a buscar cliente que compra. Devolver compra sem valor é o bug que
 * anula o produto inteiro (migration 0060 impede no banco).
 */
export interface ConversaoParaEnvio {
  /** ⚠️ Compartilhado com o pixel para a plataforma DEDUPLICAR. */
  readonly eventId: string
  readonly tipoEvento: 'lead' | 'lead_qualificado' | 'compra'
  readonly valorCentavos: number | null
  /** `gclid`/`wbraid`/`gbraid` (Google) ou `fbclid` (Meta), vindo da origem. */
  readonly clickId: string
  /**
   * ⚠️ QUAL parâmetro trouxe o clique. Não é metadado: `gclid`, `wbraid` e
   * `gbraid` vão em CAMPOS DIFERENTES da API de upload, e o valor é opaco — não
   * dá para deduzir o tipo olhando o texto. `null` = origem antiga, anterior ao
   * `0068`; quem envia decide o que fazer com isso (o Google assume `gclid`,
   * que é o caso dominante, e diz que assumiu).
   */
  readonly clickIdTipo: 'gclid' | 'wbraid' | 'gbraid' | 'fbclid' | null
  /**
   * ⚠️ A `conversionAction` da CONTA (cadastro do cliente na plataforma). O
   * despachante só chega aqui com ela preenchida — sem ela, descarta antes.
   */
  readonly acaoDeConversaoId: string | null
  /** Quando o fato aconteceu — a plataforma recusa fora da janela de importação. */
  readonly ocorridaEm: Date
}

/**
 * A porta. A Fase 0 implementa só LEITURA — escrita de campanha entra na Fase 4,
 * atrás dos guardrails e do dry-run (AMK-008).
 *
 * ⚠️ `enviarConversao` é escrita, mas de outra natureza: **não gasta verba nem
 * altera veiculação**. Ela devolve um fato que já aconteceu, e por isso não passa
 * pelos guardrails de orçamento — passa pelos de dedup e janela (0060).
 */
export interface PortaPlataformaMidia {
  readonly plataforma: Plataforma
  readonly capacidades: CapacidadesPlataforma

  /** Valida a credencial sem escrever nada. Usado no cadastro da conta. */
  testarConexao(): Promise<ResultadoPlataforma<{ nomeConta: string; moeda: string }>>

  lerEstrutura(contaExternaId: string): Promise<ResultadoPlataforma<EstruturaVeiculacao>>

  /**
   * ⚠️ Reler um período JÁ sincronizado é normal e esperado: as plataformas
   * reescrevem dias fechados enquanto a janela de atribuição assenta (até ~28
   * dias). Quem chama grava com UPSERT (migration 0058), nunca INSERT.
   */
  lerMetricas(
    contaExternaId: string,
    periodo: PeriodoConsulta,
  ): Promise<ResultadoPlataforma<readonly MetricaDiaExterna[]>>

  /**
   * Devolve uma conversão. ⚠️ Só é chamada quando `capacidades.conversaoOffline`
   * é verdadeira — plataforma sem a capacidade faz o despachante **descartar**
   * (decisão nossa, nomeada), em vez de tentar e falhar oito vezes.
   */
  enviarConversao(
    contaExternaId: string,
    conversao: ConversaoParaEnvio,
  ): Promise<ResultadoPlataforma<{ readonly idExterno: string | null }>>
}

/**
 * Adaptador de plataforma ainda não implementada.
 *
 * ⚠️ Existe para que "não temos isso" seja um resultado NOMEADO em vez de um
 * `undefined` viajando pelo sistema — mesmo padrão do `CanalNaoImplementado`.
 */
export class PlataformaNaoImplementada implements PortaPlataformaMidia {
  readonly capacidades: CapacidadesPlataforma = {
    leituraEstrutura: false,
    leituraMetrica: false,
    publicoPersonalizado: false,
    conversaoOffline: false,
    cliqueParaConversa: false,
    escritaEstado: false,
    escritaOrcamento: false,
  }

  constructor(readonly plataforma: Plataforma) {}

  private naoImplementada<T>(): ResultadoPlataforma<T> {
    return { ok: false, motivo: 'resposta_inesperada', detalhe: `plataforma ${this.plataforma} não implementada` }
  }

  async testarConexao(): Promise<ResultadoPlataforma<{ nomeConta: string; moeda: string }>> {
    return this.naoImplementada()
  }
  async lerEstrutura(): Promise<ResultadoPlataforma<EstruturaVeiculacao>> {
    return this.naoImplementada()
  }
  async lerMetricas(): Promise<ResultadoPlataforma<readonly MetricaDiaExterna[]>> {
    return this.naoImplementada()
  }
  async enviarConversao(): Promise<ResultadoPlataforma<{ idExterno: string | null }>> {
    return this.naoImplementada()
  }
}
