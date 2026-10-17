import {
  CODIGO_NAO_ENVIE, ETAPA_REGRAS_QUALIDADE, NumerosVistos, avaliarRegrasQualidade, extrairNumerosDeNegocio, lerComplianceExtra,
  perguntasJaRespondiveis, type MarcaGuardrail, type ViolacaoQualidade,
} from '@geracrm/shared'
import { fontesDoTurno } from './numeros-ampliados.js'
import { abrirAlertaViolacaoCritica } from '../qualidade/alerta.js'
import { marca, type ContextoPipeline, type EntradaPosResposta, type EtapaPosResposta } from './tipos.js'

/**
 * REGRAS DE QUALIDADE ANTES DO ENVIO (ADR-031 §1 e §3, raia P12).
 *
 * Última etapa depois do modelo: roda as regras determinísticas de
 * `avaliarRegrasQualidade` (shared) sobre o que VAI SAIR — depois de números,
 * filtro e pergunta repetida —, em 100% dos turnos e em todo modo. Mede o que
 * ESCAPOU: o que as etapas anteriores corrigiram fica nas marcas delas.
 *
 * Cada violação vira uma marca `regras-qualidade` com a gravidade da regra
 * ('registrado'); o worker (`workers/qualidade.ts`) transforma as marcas do
 * turno em `agente_avaliacao` tipo 'regras'.
 *
 * Violação CRÍTICA (pausa POR CONVERSA, nunca do modo inteiro):
 *   - autônomo e simulação → `bloquear` com `qualidade_violacao_critica` SEM
 *     mensagem substituta: nada sai e a conversa vai ao humano (a simulação
 *     mostra no playground o que aconteceria de verdade);
 *   - sombra, assistido e copiloto → a sugestão segue, marcada
 *     `nao_envie` (CRITICA 'bloqueado'): a tela do vendedor mostra "não envie
 *     assim". O humano decide; nada sai sozinho nesses modos mesmo.
 *   - sempre (fora da simulação/copiloto) → alerta `agente_violacao_critica`
 *     (um aberto por tenant; sem conteúdo da conversa) + log estruturado.
 *
 * ⚠️ Nunca lança para controlar fluxo; o alerta é melhor-esforço (falha vira
 *    log, o turno continua com a pausa).
 */

const ETAPA = ETAPA_REGRAS_QUALIDADE

/** Resumo do handoff: as regras, nunca o texto (o resumo vai para a fila do humano). */
function resumoDaPausa(criticas: readonly ViolacaoQualidade[]): string {
  const ids = [...new Set(criticas.map((v) => v.detalhe ? `${v.regra}/${v.detalhe}` : v.regra))].join(', ')
  return `Resposta do agente barrada pela qualidade (violação crítica: ${ids}). Nada foi enviado; continue o atendimento.`.slice(0, 600)
}

/** O limite do número (`agente_config.max_caracteres`), lido de forma tolerante. */
function maxCaracteresDe(cfgExtra: Readonly<Record<string, unknown>>): number | undefined {
  const v = cfgExtra['max_caracteres']
  return typeof v === 'number' && v > 0 ? v : undefined
}

export async function violacoesDoTurno(ctx: ContextoPipeline, entrada: EntradaPosResposta): Promise<ViolacaoQualidade[]> {
  const compliance = lerComplianceExtra(ctx.cfgExtra['compliance'])
  // Barato: só vai ao banco pelas fontes de número quando há número de negócio.
  const temNumero = entrada.mensagens.some((m) => extrairNumerosDeNegocio(m).length > 0)
  let fontes = null
  if (temNumero) {
    const f = await fontesDoTurno(ctx)
    for (const n of entrada.numerosVistos) f.gerais.add(n)
    if (entrada.numerosVistos instanceof NumerosVistos) for (const p of entrada.numerosVistos.percentuais) f.percentuais.add(p)
    fontes = f
  }
  // Leitura tolerante dos campos da P0c (u/j): presentes depois do merge, ausentes antes.
  const extra = entrada as EntradaPosResposta & { readonly saldoBaixoVisto?: boolean; readonly mensagensFixas?: readonly string[] }
  return avaliarRegrasQualidade({
    mensagens: entrada.mensagens,
    // Texto fixo do sistema (abertura da P4) não é resposta do agente: não é avaliado.
    isentas: extra.mensagensFixas,
    // O MESMO critério do filtro P2 (P0c): saldo BAIXO de ferramenta no turno (0 < saldo ≤ 10) torna
    // "poucas unidades" verdade — escassez deixa de ser urgência falsa.
    estoqueComFonte: extra.saldoBaixoVisto === true,
    extras: compliance.frasesProibidas,
    perguntasAnteriores: perguntasJaRespondiveis(ctx.historico),
    fontes,
    maxCaracteres: maxCaracteresDe(ctx.cfgExtra),
  })
}

export const etapaRegrasQualidade: EtapaPosResposta = {
  nome: ETAPA,
  async executar(ctx, entrada) {
    if (entrada.mensagens.length === 0) return { mensagens: entrada.mensagens, guardrails: [] }
    const violacoes = await violacoesDoTurno(ctx, entrada)
    const guardrails: MarcaGuardrail[] = violacoes.map((v) => marca(ETAPA, v.regra, v.gravidade, 'registrado', v.trecho))
    const criticas = violacoes.filter((v) => v.gravidade === 'CRITICA')
    if (criticas.length === 0) return { mensagens: entrada.mensagens, guardrails }

    const pausa = ctx.modo === 'autonomo' || ctx.modo === 'simulacao'
    if (ctx.modo !== 'simulacao' && ctx.modo !== 'copiloto') {
      await abrirAlertaViolacaoCritica({
        tenantId: ctx.tenantId, conversaId: ctx.conversaId, canalId: ctx.canalId, modo: ctx.modo,
        regras: criticas.map((v) => v.detalhe ?? v.regra), pausou: pausa,
      })
    }
    if (pausa) {
      guardrails.push(marca(ETAPA, 'qualidade_violacao_critica', 'CRITICA', 'handoff'))
      return {
        mensagens: [], guardrails,
        bloquear: { motivo: 'qualidade_violacao_critica', resumo: resumoDaPausa(criticas), mensagensSubstitutas: [] },
      }
    }
    guardrails.push(marca(ETAPA, CODIGO_NAO_ENVIE, 'CRITICA', 'bloqueado'))
    return { mensagens: entrada.mensagens, guardrails }
  },
}
