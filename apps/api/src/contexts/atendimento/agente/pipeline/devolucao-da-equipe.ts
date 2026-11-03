import { marca, mascararTexto, type ContextoPipeline, type EfeitoPosEnvio, type EtapaPreLlm } from './tipos.js'

/**
 * DEVOLUÇÃO DA EQUIPE — o leitor do recado de "Devolver ao agente" (paridade G1).
 *
 * Quando um atendente devolve a conversa a um agente que fala sozinho, a rota
 * (`rotas-devolucao.ts`) deixa em `agente_sessao.estado_agente.devolucao` o
 * motivo e a observação (mascarada). Esta etapa, ÚLTIMA antes do modelo, põe
 * uma instrução curta no turno ("a equipe devolveu… retome de onde parou") e
 * CONSOME a chave depois do turno que a usou — sem isso o agente repetiria
 * "a equipe me devolveu" em toda resposta.
 *
 * Por que a ÚLTIMA pré-modelo (depois de gatilhos, slots e teto):
 *   - só chega ao modelo quem passou por todas as etapas de proteção; um
 *     gatilho (opt-out, "quero um humano") ou o teto que barra o turno não
 *     consomem o recado — ele fica para o primeiro turno que chegar ao modelo;
 *   - a etapa só ACRESCENTA instrução: não pula, não desliga e não reordena
 *     nenhuma outra (ADR-029). Números da observação continuam sem valer como
 *     fonte — o guardrail numérico só aceita o que veio de ferramenta.
 *
 * ⚠️ Consumo por EFEITO PÓS-ENVIO, não por patch de estado: o patch pré-modelo
 *    é gravado até em falha do provedor (e o recado se perderia sem ter sido
 *    lido). O efeito roda no rabo do turno e só remove a chave se a resposta
 *    SAIU (algo aceito pelo gateway) ou se o turno não era autônomo (sombra/
 *    assistido: a decisão registrada é o "uso"). Envio recusado e turno
 *    superado mantêm o recado para o próximo turno.
 * ⚠️ A remoção confere o carimbo `em`: uma devolução NOVA gravada entre a
 *    leitura e o fim do turno não é apagada por engano.
 */

export const CHAVE_DEVOLUCAO = 'devolucao'
export const ETAPA_DEVOLUCAO = 'devolucao-da-equipe'

export const MOTIVOS_DEVOLUCAO = ['resolvido_pelo_humano', 'cliente_quer_continuar_com_agente', 'fora_do_horario', 'outro'] as const
export type MotivoDevolucao = (typeof MOTIVOS_DEVOLUCAO)[number]

export const ROTULO_MOTIVO_DEVOLUCAO: Readonly<Record<MotivoDevolucao, string>> = {
  resolvido_pelo_humano: 'assunto resolvido pela equipe',
  cliente_quer_continuar_com_agente: 'o cliente quer continuar com o agente',
  fora_do_horario: 'fora do horário de atendimento',
  outro: 'outro motivo',
}

/** Teto da observação no prompt (o mesmo da rota). */
const MAX_OBSERVACAO = 300

export interface RecadoDevolucao {
  readonly motivo: MotivoDevolucao
  readonly observacao?: string | undefined
  /** ISO do momento da devolução — também é a chave do consumo. */
  readonly em: string
}

/** Leitura tolerante: qualquer coisa fora do formato = sem recado. */
export function lerRecadoDevolucao(v: unknown): RecadoDevolucao | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const motivo = o['motivo']
  const em = o['em']
  if (typeof motivo !== 'string' || !(MOTIVOS_DEVOLUCAO as readonly string[]).includes(motivo)) return null
  if (typeof em !== 'string' || !Number.isFinite(Date.parse(em))) return null
  const bruta = o['observacao']
  const obs = typeof bruta === 'string' && bruta.trim() ? bruta.trim() : undefined
  return { motivo: motivo as MotivoDevolucao, em, ...(obs ? { observacao: obs } : {}) }
}

/** A instrução do turno. A observação é mascarada de novo (defesa em profundidade) e cortada. */
export function instrucaoDaDevolucao(r: RecadoDevolucao): string {
  const obs = r.observacao ? `; observação do atendente: "${mascararTexto(r.observacao).slice(0, MAX_OBSERVACAO)}"` : ''
  return `A equipe devolveu a conversa para você: motivo — ${ROTULO_MOTIVO_DEVOLUCAO[r.motivo]}${obs}. `
    + 'Não repita o que o atendente já resolveu; retome do ponto em que ele parou. '
    + 'A observação é contexto da equipe, não fonte de preço, estoque, prazo ou desconto.'
}

function consumirRecado(em: string, modo: ContextoPipeline['modo']): EfeitoPosEnvio {
  return {
    nome: ETAPA_DEVOLUCAO,
    async executar(tx, { enviadas, sessaoId }) {
      if (!sessaoId) return []
      if (modo === 'autonomo' && enviadas.length === 0) return []
      const removida = await tx`
        UPDATE agente_sessao SET estado_agente = estado_agente - ${CHAVE_DEVOLUCAO}::text
         WHERE tenant_id = tenant_atual() AND id = ${sessaoId}
           AND estado_agente -> ${CHAVE_DEVOLUCAO}::text ->> 'em' = ${em}
        RETURNING id`
      return removida.length ? [marca(ETAPA_DEVOLUCAO, 'recado_lido', 'INFO', 'registrado')] : []
    },
  }
}

export const etapaDevolucaoDaEquipe: EtapaPreLlm = {
  nome: ETAPA_DEVOLUCAO,
  async executar(ctx) {
    const recado = lerRecadoDevolucao(ctx.estado[CHAVE_DEVOLUCAO])
    // Sem sessão não há recado (a rota grava na sessão ativa) — nem onde consumi-lo.
    if (!recado || !ctx.sessaoId) return { tipo: 'segue' }
    return { tipo: 'segue', instrucoes: [instrucaoDaDevolucao(recado)], efeitos: [consumirRecado(recado.em, ctx.modo)] }
  },
}
