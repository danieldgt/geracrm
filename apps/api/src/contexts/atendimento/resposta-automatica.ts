import { comTenantServico } from '../../db/index.js'
import { responderAusencia } from './ausencia.js'
import { motivoDisponibilidade, quemAtende } from './disponibilidade.js'

/**
 * O QUE O PRODUTO RESPONDE SOZINHO a uma mensagem entrante — e em que ordem.
 *
 * ⚠️ Mora aqui porque há DOIS caminhos de entrada: o webhook do não-oficial
 * (PlugZapi) e o da Meta. Duas cópias desta ordem divergiriam, e o sintoma seria
 * o cliente de um canal recebendo duas automáticas seguidas e o do outro
 * recebendo nenhuma — com ninguém entendendo por quê.
 *
 * ⚠️ **Pós-commit e best-effort.** A mensagem do cliente JÁ está salva quando
 * isto roda. Nada aqui pode derrubar o 2xx do webhook: falhar por causa de uma
 * cortesia faria o provedor reenviar a mensagem do cliente em loop, e com
 * entrega sequencial isso trava a fila de TODOS os clientes.
 *
 * ⚠️ **Quem atende é lido UMA vez, aqui, e desce para os dois passos.** A
 * ausência e o agente respondem à mesma pergunta ("tem alguém para atender este
 * número?"); duas leituras no mesmo evento podem discordar — basta um batimento
 * de presença cair entre elas — e a discordância é invisível: a ausência sai
 * dizendo que não tem ninguém e o agente cala com `tem_quem_atenda`.
 */

export interface ResumoAutomatico {
  readonly ausencia: string
  readonly agenteFalou: boolean
  readonly agenteEncerrouPor: string | null
  /**
   * ⚠️ POR QUE o agente não falou — o motivo tipificado do portão, não um
   * booleano. Existe porque "o robô ficou quieto" era indistinguível de "o robô
   * está quebrado" para quem opera: a decisão é calculada a cada mensagem, com
   * seis motivos possíveis, e todos eles eram DESCARTADOS aqui. Sem isto, a
   * única forma de responder "por que ele não respondeu ao meu cliente?" é
   * reconstruir o estado da equipe e da conversa naquele minuto — que já passou.
   */
  readonly agenteMotivo: string | null
  /**
   * ⚠️ A falha do fornecedor de IA por extenso, quando houve uma. `agenteMotivo`
   * diz `modelo_falhou`; este campo diz QUAL falha — "estourou o teto de tokens
   * antes de responder", "sem crédito no OpenRouter", "corpo vazio". Sem ele, a
   * linha de log registra que a IA falhou e nada mais, e o próximo passo vira
   * adivinhação sobre chave, modelo e cota ao mesmo tempo.
   */
  readonly agenteDetalhe: string | null
  /**
   * ⚠️ O estado da EQUIPE em português, na mesma linha de log. `agenteMotivo`
   * diz que a decisão foi "tem quem atenda"; este campo diz quem era — "2 de 5
   * disponíveis" ou "todos os 3 logados estão marcados como ausentes". Sem ele,
   * a pergunta seguinte ("mas não tinha ninguém!") continua sem resposta, e a
   * contagem de cinco minutos atrás não dá para refazer depois.
   */
  readonly disponibilidade: string
}

export async function responderAutomaticamente(
  tenantId: string, conversaId: string, canalId: string, agora: Date = new Date(),
): Promise<ResumoAutomatico> {
  const { equipe, agente } = await comTenantServico(tenantId, async (tx) => {
    const [cfg] = await tx<{ modo: string; exigir_ausencia_antes: boolean }[]>`
      SELECT modo, exigir_ausencia_antes FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
    return { equipe: await quemAtende(tx, canalId, agora), agente: cfg ?? null }
  })
  const disponibilidade = motivoDisponibilidade(equipe)

  // ⚠️ Vendedor AUTÔNOMO que não espera a ausência responde ele mesmo: mandar
  //    "não há ninguém disponível" e, 3 s depois, o robô puxando conversa é a
  //    contradição que o §4.3.1 do escopo existe para evitar — só que invertida.
  const agenteResponde = agente?.modo === 'autonomo' && !agente.exigir_ausencia_antes
  const ausencia = agenteResponde ? 'agente_responde' : await responderAusencia(tenantId, conversaId, canalId, agora, equipe)

  // ⚠️ O TURNO do agente não roda mais aqui (ADR-024): foi agendado na
  //    transação da ingestão e corre no worker, fora do caminho do 2xx. Este
  //    resumo diz só o que saiu agora e por que o agente foi (ou não) agendado.
  return {
    ausencia,
    agenteFalou: false,
    agenteEncerrouPor: null,
    agenteMotivo: !agente || agente.modo === 'desligado' ? 'agente_desligado' : 'agendado_no_worker',
    agenteDetalhe: agente ? `modo ${agente.modo}` : null,
    disponibilidade,
  }
}
