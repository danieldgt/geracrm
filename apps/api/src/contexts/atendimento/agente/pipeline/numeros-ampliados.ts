import { numerosDoTexto, numerosSemFonte, type MarcaGuardrail, type NumeroDeNegocio } from '@geracrm/shared'
import { marca, type ContextoPipeline, type EntradaPosResposta, type EtapaPosResposta } from './tipos.js'

/**
 * GUARDRAIL NUMÉRICO AMPLIADO (raia P7; ADR-029 §3, amplia o ADR-023).
 *
 * Roda logo depois do guardrail de R$ (que segue em `vendedor.ts`). Extrai de
 * cada mensagem os números de negócio — percentual, quantidade, prazo em dias e
 * em horas (`extrairNumerosDeNegocio`, shared) — e confere contra as FONTES do
 * turno:
 *   - ferramentas (`numerosVistos`: saldo, quantidade do pedido, trecho do
 *     conhecimento, validade da proposta);
 *   - políticas da loja (`agente_config.politicas`, lidas de `cfgExtra` — é o
 *     texto que o modelo recebeu no prompt);
 *   - o que NÓS já dissemos na conversa (agente ou vendedor humano);
 *   - o que o CLIENTE disse — só para quantidade e prazo. ⚠️ Percentual do
 *     cliente não é fonte: "vocês dão 10%?" não autoriza "sim, 10%".
 * A alçada NÃO é fonte: é limite interno, não fato para o cliente.
 *
 * Sem fonte:
 *   - bloqueante (todo %, "temos N unidades", "entrega em N dias") → a resposta
 *     não sai: vira um aviso fixo e o turno entrega ao humano por `incerteza`.
 *     Marca CRITICA `numero_sem_fonte` 'substituido'. Vale em todos os modos
 *     (em sombra/assistido o bloqueio fica registrado, nada é enviado mesmo).
 *   - demais ("posso separar 10 unidades") → marca ALTA 'registrado'; sai.
 *
 * ⚠️ Nunca "corrige" o número — trocar por outro também seria inventar.
 */
export const AVISO_NUMERO_BLOQUEADO = 'Vou confirmar essa informação certinha com a equipe e já te retorno.'

const ETAPA = 'numeros-ampliados'

/** As fontes de texto do turno, fora as ferramentas. */
export function fontesDoTurno(ctx: ContextoPipeline): { gerais: Set<number>; doCliente: Set<number> } {
  const gerais = new Set<number>()
  const politicas = ctx.cfgExtra['politicas']
  if (typeof politicas === 'string') numerosDoTexto(politicas, gerais)
  const doCliente = new Set<number>()
  for (const f of ctx.historico) numerosDoTexto(f.texto, f.de === 'cliente' ? doCliente : gerais)
  for (const e of ctx.entrantes) numerosDoTexto(e.texto, doCliente)
  return { gerais, doCliente }
}

export const etapaNumerosAmpliados: EtapaPosResposta = {
  nome: ETAPA,
  async executar(ctx, entrada: EntradaPosResposta) {
    const { gerais, doCliente } = fontesDoTurno(ctx)
    for (const n of entrada.numerosVistos) gerais.add(n)
    const semFonte: NumeroDeNegocio[] = entrada.mensagens.flatMap((m) => [...numerosSemFonte(m, { gerais, doCliente })])
    if (semFonte.length === 0) return { mensagens: entrada.mensagens, guardrails: [] }

    const bloqueantes = semFonte.filter((n) => n.bloqueante)
    if (bloqueantes.length > 0) {
      const guardrails: MarcaGuardrail[] = semFonte.map((n) =>
        marca(ETAPA, 'numero_sem_fonte', n.bloqueante ? 'CRITICA' : 'ALTA', n.bloqueante ? 'substituido' : 'registrado', n.trecho))
      const citados = [...new Set(bloqueantes.map((n) => `"${n.trecho}"`))].join(', ')
      return {
        mensagens: [AVISO_NUMERO_BLOQUEADO],
        guardrails,
        bloquear: {
          motivo: 'incerteza',
          resumo: `A IA citou ${citados} sem origem em ferramenta, política ou conhecimento; resposta bloqueada pelo guardrail numérico.`.slice(0, 600),
          mensagensSubstitutas: [AVISO_NUMERO_BLOQUEADO],
        },
      }
    }
    return {
      mensagens: entrada.mensagens,
      guardrails: semFonte.map((n) => marca(ETAPA, 'numero_sem_fonte', 'ALTA', 'registrado', n.trecho)),
    }
  },
}
