import { comTenantServico } from '../../db/index.js'
import { responderAusencia } from './ausencia.js'
import { motivoDisponibilidade, quemAtende } from './disponibilidade.js'
import { conduzirTurno } from './agente/turno.js'

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
  const equipe = await comTenantServico(tenantId, (tx) => quemAtende(tx, canalId, agora))
  const disponibilidade = motivoDisponibilidade(equipe)

  const ausencia = await responderAusencia(tenantId, conversaId, canalId, agora, equipe)

  // ⚠️ O AGENTE SDR entra DEPOIS da ausência, nunca junto. Se a ausência acabou
  //    de sair NESTA mensagem, o agente fica para a próxima: mandar as duas de
  //    uma vez faria a primeira ("voltamos às 9h") contradizer a segunda, que
  //    puxa conversa. Quem escreve de novo depois da ausência mostrou interesse
  //    — é esse o lead que vale o custo de uma conversa com IA (§4.3.1).
  if (ausencia === 'enviada') {
    return {
      ausencia, agenteFalou: false, agenteEncerrouPor: null,
      agenteMotivo: 'ausencia_recem_enviada', disponibilidade,
    }
  }

  const t = await conduzirTurno(tenantId, conversaId, canalId, agora, { equipe })
  return {
    ausencia,
    agenteFalou: t.falou,
    agenteEncerrouPor: t.falou ? t.encerrouPor : null,
    agenteMotivo: t.falou ? null : t.motivo,
    disponibilidade,
  }
}
