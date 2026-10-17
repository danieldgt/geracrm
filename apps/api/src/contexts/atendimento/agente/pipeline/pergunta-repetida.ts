import {
  ehSlot, evitarPerguntaRepetidaNasMensagens, lerPlaybookVigente, slotsDoPlaybook, lerEstadoPerguntas, perguntasDe, slotDaPergunta, temPerguntaRepetida,
  type EstadoPerguntas, type UltimaPergunta,
} from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { carregarContextoDoLead } from '../contexto-lead.js'
import type { Fala } from '../porta.js'
import { slotsDosEntrantes } from './slots-do-cliente.js'
import { marca, mascararTexto, type ContextoPipeline, type EtapaPosResposta, type MarcaGuardrail } from './tipos.js'

/**
 * TRAVA DE PERGUNTA REPETIDA — raia P3 (playbook AM §3.8, peça 3; §12 #3).
 *
 * Depois do modelo e antes do envio: pergunta igual (normalizada, Jaccard ≥ 0,7) à do turno
 * anterior do agente NÃO sai de novo. A repetida é removida e o resto fica; se a resposta ficar
 * sem pergunta, entra a do próximo slot aberto do canal (fora a que acabou de ser feita) ou uma
 * neutra. Cada remoção vira marca MEDIA `pergunta_repetida` 'substituido'.
 *
 * "Turno anterior" = as falas nossas entre os dois últimos blocos do cliente no histórico. Sem
 * elas (janela curta, histórico apagado), vale `estado.perguntas.ultima` — é o que sobrevive.
 *
 * Também grava `estado_agente.perguntas`: os slots que o cliente trouxe neste turno e a última
 * pergunta ENVIADA. ⚠️ `ultima` só muda em autônomo: em sombra/assistido nada foi enviado pelo
 * agente, e uma pergunta que o cliente nunca viu não pode travar a próxima sugestão.
 */

export interface DepsPerguntaRepetida {
  /**
   * Slots já conhecidos fora do estado desta raia: os que o modelo declarou na sessão
   * (`agente_sessao.slots`) e o cadastro (cidade, CNPJ). Só é chamado quando há repetição — o
   * caminho comum não paga a consulta. Falha → [] (a trava degrada para a pergunta neutra).
   */
  readonly slotsConhecidos?: ((ctx: ContextoPipeline) => Promise<readonly string[]>) | undefined
}

/** As falas nossas do último turno: entre o último bloco do cliente e o anterior. */
export function falasDoUltimoTurnoDoAgente(historico: readonly Fala[]): string[] {
  let i = historico.length - 1
  while (i >= 0 && historico[i]!.de === 'cliente') i--
  const nossas: string[] = []
  while (i >= 0 && historico[i]!.de === 'nos') nossas.unshift(historico[i--]!.texto)
  return nossas
}

async function slotsConhecidosDoBanco(ctx: ContextoPipeline): Promise<readonly string[]> {
  return comTenantServico(ctx.tenantId, async (tx) => {
    const r: string[] = []
    if (ctx.sessaoId) {
      const [s] = await tx<{ slots: Record<string, unknown> | null }[]>`
        SELECT slots FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${ctx.sessaoId}`
      for (const [k, v] of Object.entries(s?.slots ?? {})) if (ehSlot(k) && typeof v === 'string' && v.trim()) r.push(k)
    }
    const lead = await carregarContextoDoLead(tx, ctx.conversaId)
    if (lead?.cidade) r.push('cidade')
    if (lead?.temCnpj) r.push('cnpj')
    return r
  })
}

/** Ordem do roteiro: a do playbook publicado (P17) ou, sem ele, `agente_config.qualificacao`. */
function slotsDoCanal(cfgExtra: Readonly<Record<string, unknown>>): string[] {
  const playbook = lerPlaybookVigente(cfgExtra['playbook'])
  if (playbook) return slotsDoPlaybook(playbook.conteudo)
  const q = cfgExtra['qualificacao']
  return Array.isArray(q) ? q.filter(ehSlot) : []
}

export function criarEtapaPerguntaRepetida(deps: DepsPerguntaRepetida = {}): EtapaPosResposta {
  const conhecidos = deps.slotsConhecidos ?? slotsConhecidosDoBanco
  return {
    nome: 'pergunta-repetida',
    async executar(ctx, entrada) {
      const est = lerEstadoPerguntas(ctx.estado['perguntas'])
      const respondidos = { ...est.respondidos, ...slotsDosEntrantes(ctx) }

      const doHistorico = falasDoUltimoTurnoDoAgente(ctx.historico)
      const anteriores = doHistorico.length ? doHistorico : est.ultima ? [est.ultima.texto] : []

      let mensagens = entrada.mensagens
      const guardrails: MarcaGuardrail[] = []
      if (temPerguntaRepetida(mensagens, anteriores)) {
        const extras = await conhecidos(ctx).catch(() => [] as readonly string[])
        const r = evitarPerguntaRepetidaNasMensagens(mensagens, {
          perguntasAnteriores: anteriores,
          slotsRespondidos: [...Object.keys(respondidos), ...extras],
          slotsDoCanal: slotsDoCanal(ctx.cfgExtra),
          proximoPasso: !entrada.handoff,
        })
        mensagens = r.mensagens
        for (const p of r.removidas) guardrails.push(marca('pergunta-repetida', 'pergunta_repetida', 'MEDIA', 'substituido', p))
      }

      // ⚠️ `ultima` é calculada AQUI, antes de `qualidade` e da rede final de R$ em `vendedor.ts`:
      //    se uma etapa posterior barrar ou trocar o texto, o estado guarda uma pergunta que não
      //    saiu. Efeito limitado — `ultima` só vale quando o histórico não tem o turno anterior, e
      //    nesse caso o histórico real (com o texto que saiu) manda. Rever na P12 / P0c, quando a
      //    gravação do estado puder olhar as mensagens finais.
      let ultima: UltimaPergunta | null = est.ultima
      if (ctx.modo === 'autonomo') {
        const p = mensagens.flatMap((m) => perguntasDe(m)).at(-1)
        ultima = p ? { texto: mascararTexto(p).slice(0, 300), slot: slotDaPergunta(p), em: ctx.agora.toISOString() } : null
      }
      const perguntas: EstadoPerguntas = { ultima, respondidos }
      return { mensagens, guardrails, estado: { perguntas } }
    },
  }
}

export const etapaPerguntaRepetida: EtapaPosResposta = criarEtapaPerguntaRepetida()
