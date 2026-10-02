import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

/**
 * O JUIZ das conversas douradas — LLM-as-judge com rubrica de VENDA, em pt-BR.
 *
 * ⚠️ Só roda sob `IA_E2E` (manual, custa dinheiro). O juiz NÃO substitui as
 * verificações determinísticas (ferramentas chamadas, números, desfecho):
 * ele avalia o que elas não enxergam — se a resposta vende bem. Modelo:
 * Opus 5.5 (o padrão da casa), effort médio, saída estruturada.
 */
export const notaDoJuiz = z.object({
  entendeuANecessidade: z.number().min(0).max(5),
  recomendouComBase: z.number().min(0).max(5).describe('Só citou produto/preço que veio de ferramenta'),
  conduziuParaOProximoPasso: z.number().min(0).max(5),
  tomAdequado: z.number().min(0).max(5),
  naoInventou: z.boolean(),
  problemas: z.array(z.string().max(200)).max(5),
  nota: z.number().min(0).max(10),
})
export type NotaDoJuiz = z.infer<typeof notaDoJuiz>

export interface TranscricaoParaJuiz {
  readonly cenario: string
  readonly politicas: string
  readonly falas: readonly { de: 'cliente' | 'agente'; texto: string }[]
  readonly ferramentas: readonly { nome: string; saida: unknown }[]
}

const RUBRICA = `Você é um gerente comercial experiente avaliando um vendedor de WhatsApp.
Avalie a ÚLTIMA resposta do agente no contexto da conversa, com a rubrica (0 a 5 cada):
- entendeuANecessidade: perguntou/entendeu antes de empurrar produto; não perguntou o que já sabia.
- recomendouComBase: todo produto, preço, estoque e prazo citado está nas saídas de ferramenta ou nas políticas. Qualquer número sem origem zera este critério e marca naoInventou=false.
- conduziuParaOProximoPasso: terminou com uma pergunta ou ação clara (quantidade, fechar, confirmar).
- tomAdequado: curto, humano, sem jargão, sem Markdown, sem pressão.
"nota" é a sua nota geral de 0 a 10. "problemas": o que um gerente corrigiria, em frases curtas.`

export async function julgar(t: TranscricaoParaJuiz, cliente = new Anthropic()): Promise<NotaDoJuiz> {
  const r = await cliente.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'medium', format: zodOutputFormat(notaDoJuiz) },
    system: RUBRICA,
    messages: [{
      role: 'user',
      content: [
        `<cenario>${t.cenario}</cenario>`,
        `<politicas_da_loja>${t.politicas}</politicas_da_loja>`,
        `<saidas_de_ferramenta>${JSON.stringify(t.ferramentas).slice(0, 6000)}</saidas_de_ferramenta>`,
        '<conversa>',
        ...t.falas.map((f) => `${f.de === 'cliente' ? 'CLIENTE' : 'AGENTE'}: ${f.texto}`),
        '</conversa>',
      ].join('\n'),
    }],
  })
  if (!r.parsed_output) throw new Error('juiz: resposta sem saída estruturada')
  return r.parsed_output
}
