import {
  MAX_TRECHO_GUARDRAIL,
  type AcaoGuardrail, type GravidadeGuardrail, type MarcaGuardrail, type ModoAgente, type ModoDoTurno,
  type MotivoHandoff, type PersonaResolvida,
} from '@geracrm/shared'
import type { Sql } from '../../../../db/index.js'
import type { Fala } from '../porta.js'
import type { EstadoAgente } from '../estado-agente.js'

/**
 * CONTRATOS DO PIPELINE DO TURNO (plano-port-playbook-am, raia P0; ADR-029).
 *
 * O turno do vendedor é uma sequência FIXA de etapas determinísticas em volta
 * do modelo. A ordem é código, não configuração:
 *
 *   modoEfetivo → [portão] → gatilhos → slots → teto(pré) → LLM →
 *   [guardrail R$] → números → filtro → pergunta → qualidade → envio → teto(pós)
 *
 * Os colchetes são etapas que já existiam em `vendedor.ts` e continuam lá. As
 * demais são pontos de extensão com dono (uma raia por arquivo em `pipeline/`).
 * A tela só ACRESCENTA restrição; nenhuma etapa é desligável pela interface.
 *
 * ⚠️ Etapa nunca lança para controlar fluxo: devolve uma decisão tipada. Se
 *    lançar, é bug — o worker devolve a tarefa à fila com backoff.
 */

export type { MarcaGuardrail, GravidadeGuardrail, AcaoGuardrail, EstadoAgente }

/** Uma mensagem entrante coberta por este turno (as da tarefa). */
export interface EntranteDoTurno {
  readonly id: string
  readonly tipo: string
  /** Texto como o modelo veria (`[áudio] …`, `[imagem] …`). */
  readonly texto: string
  /** Áudio ainda sem transcrição, com tentativas sobrando. */
  readonly transcricaoPendente: boolean
  /** Áudio cuja transcrição desistiu (teto de tentativas ou formato). */
  readonly transcricaoFalhou: boolean
}

/** O que toda etapa recebe. Imutável: etapa devolve, não altera. */
export interface ContextoPipeline {
  readonly tenantId: string
  readonly conversaId: string
  readonly canalId: string
  readonly contatoId: string
  /** Sessão ATIVA do agente nesta conversa; null quando o turno abrirá uma. */
  readonly sessaoId: string | null
  readonly modo: ModoDoTurno
  readonly agora: Date
  /**
   * A linha inteira de `agente_config` (`to_jsonb(ac.*)`): cada raia lê daqui
   * as SUAS colunas novas, com leitura tolerante (ausente → padrão).
   */
  readonly cfgExtra: Readonly<Record<string, unknown>>
  readonly persona: PersonaResolvida
  /** `agente_sessao.estado_agente` — uma chave por raia. `{}` sem sessão. */
  readonly estado: EstadoAgente
  /** Últimas falas (cliente e nós), em ordem cronológica. */
  readonly historico: readonly Fala[]
  readonly entrantes: readonly EntranteDoTurno[]
  /** O agente ainda não falou nesta conversa (no histórico carregado). */
  readonly primeiraResposta: boolean
  readonly foraDoExpediente: boolean
}

/** Patch raso em `estado_agente`: `{ [chaveDaRaia]: valor }`. */
export type PatchEstado = Readonly<Record<string, unknown>>

// ── antes do modelo ─────────────────────────────────────────────────────────

export type DecisaoPreLlm =
  /** Segue para a próxima etapa; `instrucoes` vão para a instrução do turno (operador). */
  | {
    readonly tipo: 'segue'; readonly instrucoes?: readonly string[] | undefined; readonly estado?: PatchEstado | undefined; readonly guardrails?: readonly MarcaGuardrail[] | undefined
    /**
     * Texto fixo que o RABO COMUM envia ANTES da resposta deste turno (ex.: a
     * abertura que identifica a assistente). Passa pelo filtro de saída e pela
     * rede final de R$, e fica registrado na decisão. Só sai se o turno chegar
     * ao envio (falha do modelo ou handoff sem modelo descartam o prefixo).
     */
    readonly prefixo?: readonly string[] | undefined
    readonly efeitos?: readonly EfeitoPosEnvio[] | undefined
  }
  /** Responde com texto fixo, SEM chamar o modelo (abertura, "sou uma assistente"…). */
  | { readonly tipo: 'resposta_fixa'; readonly mensagens: readonly string[]; readonly handoff?: { readonly motivo: MotivoHandoff; readonly resumo: string } | undefined; readonly estado?: PatchEstado | undefined; readonly guardrails?: readonly MarcaGuardrail[] | undefined; readonly efeitos?: readonly EfeitoPosEnvio[] | undefined }
  /** Entrega ao humano sem modelo; `avisoCliente` só sai em autônomo. */
  | { readonly tipo: 'handoff'; readonly motivo: MotivoHandoff; readonly resumo: string; readonly avisoCliente: string | null; readonly guardrails?: readonly MarcaGuardrail[] | undefined }
  /** Não responde (áudio ainda transcrevendo, opt-out já registrado…). */
  | { readonly tipo: 'silencio'; readonly motivo: string }

/** Uma mensagem que o rabo do turno efetivamente entregou ao gateway com sucesso. */
export interface EnvioDoTurno { readonly texto: string; readonly mensagemId: string }

/**
 * EFEITO PÓS-ENVIO de uma etapa pré-modelo (ex.: registrar o opt-out DEPOIS da
 * confirmação; registrar o aviso de privacidade SÓ se a abertura saiu).
 *
 * Roda dentro da transação de persistência do rabo comum, DEPOIS da tentativa
 * de envio, em TODA saída do rabo — enviado, envio recusado, turno superado,
 * sombra/assistido (nada enviado). Nunca em simulação/copiloto. As marcas que
 * devolve entram na decisão do turno. `enviadas` só tem o que o gateway aceitou.
 */
export interface EfeitoPosEnvio {
  readonly nome: string
  executar(tx: Sql, r: { readonly enviadas: readonly EnvioDoTurno[]; readonly sessaoId: string | null }): Promise<readonly MarcaGuardrail[]>
}

export interface EtapaPreLlm {
  readonly nome: string
  executar(ctx: ContextoPipeline): Promise<DecisaoPreLlm>
}

/** Modo efetivo: o mais restritivo entre tenant, número e recorte (P14). */
export interface EntradaModoEfetivo {
  readonly tenantId: string
  readonly canalId: string
  readonly contatoId: string
  /** `agente_config.modo` do número. */
  readonly modoDoNumero: ModoAgente
  readonly cfgExtra: Readonly<Record<string, unknown>>
  readonly agora: Date
}
export interface DecisaoModoEfetivo {
  readonly modo: ModoAgente
  /** Por que ficou mais restritivo que o do número (auditoria); null = igual. */
  readonly motivo: string | null
}
export interface EtapaModoEfetivo {
  readonly nome: string
  decidir(entrada: EntradaModoEfetivo): Promise<DecisaoModoEfetivo>
}

// ── depois do modelo ────────────────────────────────────────────────────────

export interface EntradaPosResposta {
  readonly mensagens: readonly string[]
  readonly handoff: { readonly motivo: string; readonly resumo: string } | null
  /** Centavos que vieram de ferramenta neste turno (guardrail R$). */
  readonly centavosVistos: ReadonlySet<number>
  /** Números de negócio (%, quantidade, prazo) que vieram de fonte (P7). */
  readonly numerosVistos: ReadonlySet<number>
  readonly falasAnterioresDoAgente: readonly string[]
}

export interface ResultadoPosResposta {
  readonly mensagens: readonly string[]
  readonly guardrails: readonly MarcaGuardrail[]
  /**
   * Barra a resposta: a cadeia para, a resposta vira `mensagensSubstitutas`
   * (ou nada) e o turno entrega ao humano com este motivo.
   */
  readonly bloquear?: { readonly motivo: MotivoHandoff; readonly resumo: string; readonly mensagensSubstitutas?: readonly string[] | undefined } | undefined
  readonly estado?: PatchEstado | undefined
}

export interface EtapaPosResposta {
  readonly nome: string
  executar(ctx: ContextoPipeline, entrada: EntradaPosResposta): Promise<ResultadoPosResposta>
}

// ── teto por conversa (P6) ──────────────────────────────────────────────────

export type DecisaoPosTurno =
  | { readonly tipo: 'segue' }
  /** Responde (já respondeu) e transfere EM SILÊNCIO — sem aviso ao cliente. */
  | { readonly tipo: 'handoff'; readonly motivo: MotivoHandoff; readonly resumo: string }

export interface EtapaTetoConversa {
  readonly nome: string
  /** Pré-LLM: sessão que já passou do teto nem chama o modelo. */
  antes(ctx: ContextoPipeline): Promise<DecisaoPreLlm>
  /**
   * Pós-envio e ANTES da persistência: a decisão gravada já sai com o handoff.
   * ⚠️ `custoCentavos` é o custo DESTE turno; o `custo_centavos` da sessão
   *    ainda NÃO o inclui — some os dois.
   */
  depois(ctx: ContextoPipeline, turno: { readonly custoCentavos: number }): Promise<DecisaoPosTurno>
}

// ── falha do provedor (P5) ──────────────────────────────────────────────────

export const CLASSES_FALHA = ['fatal', 'transitoria', 'requisicao', 'formato'] as const
export type ClasseFalha = (typeof CLASSES_FALHA)[number]

export interface EntradaFalha {
  /** `MotivoFalhaLlm` do laço, ou 'formato' quando a saída não passou no schema. */
  readonly motivo: string
  readonly detalhe: string
  readonly executouFerramentas: boolean
  readonly estado: EstadoAgente
  /**
   * Quantas vezes ESTA tarefa já foi pega pelo worker (1 na primeira). A fila
   * desiste em `MAX_TENTATIVAS` (fila.ts): `aviso_e_reagendar` na última
   * tentativa não reagenda — o worker conclui a tarefa.
   */
  readonly tentativas: number
}

export interface DecisaoFalha {
  readonly acao: 'handoff' | 'aviso_e_reagendar' | 'registrar'
  readonly classe: ClasseFalha
  /** Texto ao cliente — só sai em autônomo. null = nenhum aviso. */
  readonly avisoCliente: string | null
  readonly reagendarEmMs?: number | undefined
  /** Patch em `estado_agente` (ex.: contagem de falhas), gravado depois de garantir a sessão. */
  readonly estado?: PatchEstado | undefined
}

export interface PoliticaFalha {
  readonly nome: string
  decidir(ctx: ContextoPipeline, entrada: EntradaFalha): Promise<DecisaoFalha>
}

// ── o pipeline montado ──────────────────────────────────────────────────────

/** As etapas na ordem fixa. Testes trocam uma por uma etapa falsa via `DepsTurno.pipeline`. */
export interface PipelineDoTurno {
  readonly modoEfetivo: EtapaModoEfetivo
  readonly gatilhos: EtapaPreLlm
  readonly slots: EtapaPreLlm
  readonly teto: EtapaTetoConversa
  readonly numeros: EtapaPosResposta
  readonly filtro: EtapaPosResposta
  readonly pergunta: EtapaPosResposta
  readonly qualidade: EtapaPosResposta
  readonly falha: PoliticaFalha
}

// ── marcas ─────────────────────────────────────────────────────────────────

/** Mascara CPF/CNPJ/telefone num texto antes de gravar. */
export function mascararTexto(v: string): string {
  return v.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '***')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '***')
    .replace(/\b55\d{10,11}\b/g, '55***')
}

/** Cria uma marca com o trecho mascarado e cortado em 160 — o único jeito de criar uma. */
export function marca(
  etapa: string, codigo: string, gravidade: GravidadeGuardrail, acao: AcaoGuardrail, trecho?: string,
): MarcaGuardrail {
  return {
    etapa, codigo, gravidade, acao,
    ...(trecho ? { trecho: mascararTexto(trecho).slice(0, MAX_TRECHO_GUARDRAIL) } : {}),
  }
}
