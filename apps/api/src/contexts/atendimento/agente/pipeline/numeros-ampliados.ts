import {
  NumerosVistos, extrairNumerosDeNegocio, numerosDoTexto, numerosSemFonte, percentuaisDoTexto, type MarcaGuardrail, type NumeroDeNegocio,
} from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { marca, type ContextoPipeline, type EntradaPosResposta, type EtapaPosResposta } from './tipos.js'

/**
 * GUARDRAIL NUMÉRICO AMPLIADO (raia P7; ADR-029 §3, amplia o ADR-023).
 *
 * Roda logo depois do guardrail de R$ (que segue em `vendedor.ts`). Extrai de
 * cada mensagem os números de negócio — percentual, quantidade, prazo em dias e
 * em horas (`extrairNumerosDeNegocio`, shared) — e confere contra as FONTES do
 * turno, separadas por tipo:
 *   - ferramentas (`numerosVistos`: saldo, quantidade e nº de itens do pedido,
 *     trecho do conhecimento, validade da proposta; percentuais à parte em
 *     `NumerosVistos.percentuais`);
 *   - políticas da loja (`agente_config.politicas`, lidas de `cfgExtra` — é o
 *     texto que o modelo recebeu no prompt);
 *   - o que o VENDEDOR HUMANO já escreveu na conversa (mensagem saliente sem
 *     `conteudo.automatica` e fora de campanha). ⚠️ Fala do PRÓPRIO agente não é
 *     fonte: um número que ele inventou e passou como ALTA não se legitima ao
 *     ser repetido. Como `Fala` não distingue agente de humano, a etapa lê
 *     essas mensagens direto do banco (só leitura, sob RLS). ⚠️ Contam como
 *     fala de vendedor: (a) automação do CRM que não grava `automatica` (ex.:
 *     resposta rápida, mensagem enviada por regra sem marcador) e (b) sugestão do
 *     agente que o HUMANO enviou (assistido/copiloto) — ao enviar, o humano a
 *     assumiu. Ausência, retorno e o próprio agente gravam `automatica` e ficam
 *     fora;
 *   - o CLIENTE — só abona número NÃO bloqueante, e nunca percentual: "vocês
 *     têm 500? entregam em 2 dias?" não autoriza "temos 500 e entregamos em 2".
 * Percentual só confere com percentual de fonte (escrito com %/"por cento" ou
 * campo percentual) — "CAM-010" nunca abona "10%". A alçada NÃO é fonte: é
 * limite interno, não fato para o cliente.
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
/** Quantas falas do vendedor humano entram como fonte (as mais recentes). */
const FALAS_DO_VENDEDOR = 30

export interface FontesDoTurno {
  readonly gerais: Set<number>
  readonly percentuais: Set<number>
  readonly doCliente: Set<number>
}

/** Textos que o vendedor humano escreveu nesta conversa (mais recentes primeiro). */
async function falasDoVendedorHumano(ctx: ContextoPipeline): Promise<string[]> {
  const linhas = await comTenantServico(ctx.tenantId, (tx) => tx<{ texto: string | null }[]>`
    SELECT conteudo->>'texto' AS texto FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${ctx.conversaId}
       AND direcao = 'saliente' AND tipo = 'texto' AND campanha_id IS NULL
       AND NOT (conteudo ? 'automatica')
     ORDER BY criado_em DESC LIMIT ${FALAS_DO_VENDEDOR}`)
  return linhas.map((l) => l.texto ?? '').filter(Boolean)
}

/** As fontes de texto do turno, fora as ferramentas. */
export async function fontesDoTurno(ctx: ContextoPipeline): Promise<FontesDoTurno> {
  const gerais = new Set<number>()
  const percentuais = new Set<number>()
  const doCliente = new Set<number>()
  const textosFonte: string[] = await falasDoVendedorHumano(ctx)
  const politicas = ctx.cfgExtra['politicas']
  if (typeof politicas === 'string') textosFonte.push(politicas)
  for (const t of textosFonte) { numerosDoTexto(t, gerais); percentuaisDoTexto(t, percentuais) }
  for (const f of ctx.historico) if (f.de === 'cliente') numerosDoTexto(f.texto, doCliente)
  for (const e of ctx.entrantes) numerosDoTexto(e.texto, doCliente)
  return { gerais, percentuais, doCliente }
}

export const etapaNumerosAmpliados: EtapaPosResposta = {
  nome: ETAPA,
  async executar(ctx, entrada: EntradaPosResposta) {
    // Barato: sem número de negócio na resposta, nem consulta as fontes.
    if (!entrada.mensagens.some((m) => extrairNumerosDeNegocio(m).length > 0)) return { mensagens: entrada.mensagens, guardrails: [] }

    const { gerais, percentuais, doCliente } = await fontesDoTurno(ctx)
    for (const n of entrada.numerosVistos) gerais.add(n)
    // Memória do contato (P0c-a): peso de fala do cliente — nunca fonte geral nem de %.
    for (const n of entrada.numerosDoCliente ?? []) doCliente.add(n)
    if (entrada.numerosVistos instanceof NumerosVistos) for (const p of entrada.numerosVistos.percentuais) percentuais.add(p)
    const semFonte: NumeroDeNegocio[] = entrada.mensagens.flatMap((m) => [...numerosSemFonte(m, { gerais, percentuais, doCliente })])
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
