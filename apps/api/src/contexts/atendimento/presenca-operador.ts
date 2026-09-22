import type { FastifyRequest } from 'fastify'
import type { Sql } from '../../db/index.js'
import { subDoUsuario } from '../../plugins/tenant.js'

/**
 * QUEM SE MARCOU AUSENTE NÃO RESPONDE — a outra metade do botão "Estou ausente".
 *
 * ⚠️ O botão sempre disse ao ROBÔ o que fazer ("o agente pode assumir suas
 * conversas"), e nunca disse nada à PESSOA. Quem se marcava ausente continuava
 * com o campo de digitação aberto, e o resultado é a pior combinação possível:
 * o agente assume a conversa achando que não tem ninguém e o atendente responde
 * por cima — dois interlocutores no mesmo cliente, cada um sem saber do outro.
 *
 * ⚠️ **A trava mora no SERVIDOR, não só na tela.** Esconder o campo é conforto;
 * o que decide é aqui. Uma aba aberta desde antes de a pessoa se marcar ausente
 * continua com o botão de enviar na memória, e é exatamente a aba de quem
 * saiu da mesa.
 *
 * ⚠️ Só alcança o que uma PESSOA manda por vontade própria numa conversa. O
 * agente, a resposta de ausência e o disparo de campanha não têm autor
 * (`enviada_por_id IS NULL`) e seguem seu caminho — travá-los aqui silenciaria
 * o produto justamente quando ninguém está para atender, que é o contrário do
 * que a ausência existe para resolver.
 */

/**
 * Estou marcado como ausente?
 *
 * ⚠️ Casa por `cognito_sub`, como o resto da presença: é quem o token
 * identifica. Aceitar um id do corpo deixaria uma pessoa enviar pela outra.
 *
 * ⚠️ Linha inexistente é DISPONÍVEL, não ausente. Quem nunca abriu o menu não
 * tem linha em `usuario` com a coluna marcada — recusar o envio nesse caso
 * travaria o atendimento inteiro de um tenant novo por causa de um default.
 */
export async function operadorAusente(tx: Sql, req: FastifyRequest): Promise<boolean> {
  const sub = subDoUsuario(req)
  const [u] = await tx<{ ausente: boolean }[]>`
    SELECT ausente FROM usuario
     WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub}`
  return u?.ausente === true
}

/**
 * A recusa, com a AÇÃO CORRETIVA nomeada (PED-08).
 *
 * ⚠️ "Envio recusado" mandaria a pessoa procurar defeito no canal. O texto diz
 * o que houve, quem causou (ela mesma) e o caminho exato para desfazer.
 */
export const RECUSA_OPERADOR_AUSENTE = {
  erro: 'operador_ausente',
  mensagem: 'Você está marcado como ausente e só está acompanhando. '
    + 'Marque "Estou disponível" no menu do seu usuário para voltar a responder.',
} as const
