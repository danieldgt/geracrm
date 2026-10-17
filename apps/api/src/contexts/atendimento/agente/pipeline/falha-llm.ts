import type { ClasseFalha, PoliticaFalha } from './tipos.js'

/**
 * POLÍTICA DE FALHA DO PROVEDOR — STUB da raia P5 (ADR-030).
 *
 * Contrato a preencher (P5): fatal → handoff com aviso sem prazo; transitória
 * 1ª → "tive uma instabilidade" + reagendar 30 s (uma vez, contada em
 * `estado.falha`); 2ª → handoff `modelo_indisponivel` com aviso; formato →
 * handoff; sombra/assistido só registram. Reserva de provedor em
 * `agente/llm-reserva.ts`, estado em `agente/llm-estado.ts`.
 *
 * ⚠️ Enquanto stub, reproduz EXATAMENTE o comportamento anterior ao pipeline:
 *    falha do laço → handoff mudo em autônomo, só registro nos outros modos;
 *    saída fora do formato → handoff (que só vira entrega real em autônomo);
 *    simulação e copiloto só registram.
 */
export const politicaFalhaLlm: PoliticaFalha = {
  nome: 'falha-llm',
  async decidir(ctx, entrada) {
    const classe = classeDaFalha(entrada.motivo)
    if (ctx.modo === 'simulacao' || ctx.modo === 'copiloto') return { acao: 'registrar', classe, avisoCliente: null }
    if (classe === 'formato') return { acao: 'handoff', classe, avisoCliente: null }
    return { acao: ctx.modo === 'autonomo' ? 'handoff' : 'registrar', classe, avisoCliente: null }
  },
}

/** Classificação provisória do `MotivoFalhaLlm` — a P5 refina (401/402/403/429/529). */
export function classeDaFalha(motivo: string): ClasseFalha {
  switch (motivo) {
    case 'formato':
    case 'resposta_inesperada':
      return 'formato'
    case 'limite_de_taxa':
    case 'indisponivel':
      return 'transitoria'
    case 'conteudo_recusado':
      return 'requisicao'
    default:
      return 'fatal'
  }
}
