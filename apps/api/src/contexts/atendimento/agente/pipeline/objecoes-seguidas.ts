import {
  MAX_OBJECOES_NO_ESTADO, OBJECOES_SEGUIDAS_PARA_HANDOFF, lerEstadoObjecoes, lerPlaybookVigente, naoRevertidasSeguidas,
  type ObjecaoNoEstado,
} from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { textoDoHandoff } from './gatilhos-entrada.js'
import { marca, type ContextoPipeline, type EtapaPosResposta, type MarcaGuardrail } from './tipos.js'

/**
 * OBJEÇÕES SEGUIDAS — raia G2 (comportamento do agente da AM: "na 3ª objeção
 * seguida, uma pessoa assume").
 *
 * Depois do modelo, ÚLTIMA etapa pós-resposta (depois da qualidade). A
 * ferramenta `registrar_objecao` só registra; o registro do turno chega aqui por
 * `entrada.objecoesDoTurno`. A etapa:
 *
 *   1. acumula UMA objeção do turno em `estado_agente.objecoes` (código,
 *      revertida, turno da sessão) — lista com teto, as mais recentes ficam.
 *      Várias chamadas no mesmo turno contam uma (se houver uma revertida, ela
 *      prevalece): três chamadas num turno só NÃO são três objeções seguidas;
 *   2. conta as NÃO revertidas seguidas no fim da lista (uma revertida zera);
 *   3. na 3ª, troca a resposta pelo aviso de transferência (mensagem pronta do
 *      playbook ou o texto do código) e BLOQUEIA com o motivo
 *      `objecoes_seguidas` e um resumo com os códigos — o turno entrega ao
 *      humano (autônomo) ou encerra a sessão sem entrega (sombra/assistido).
 *
 * ⚠️ Não é desligável pela tela: a ação "Registrar objeções" do playbook tira a
 *    FERRAMENTA do menu (sem registro, a regra não tem o que contar) — a regra
 *    em si é código (ADR-029).
 * ⚠️ Só dispara no turno que registrou uma objeção NÃO revertida: estado antigo
 *    nunca transfere sozinho. Se o turno já vai para humano por outro motivo, só
 *    registra (o motivo anterior fica).
 * ⚠️ Copiloto (sugestão a pedido do vendedor humano) só marca: não há sessão do
 *    agente a entregar. Simulação transfere (mostra o que aconteceria), mas não
 *    tem sessão: conta só o que foi registrado no próprio turno.
 * ⚠️ Sem texto do cliente no estado nem no resumo: só códigos e o texto da
 *    objeção escrito pelo negócio.
 */

export const ETAPA_OBJECOES = 'objecoes-seguidas'

export interface DepsObjecoesSeguidas {
  /**
   * Turno da sessão que está acontecendo (1 = primeiro). Padrão: `agente_sessao.turnos + 1`
   * (o turno corrente ainda não foi somado); sem sessão, 1. Só é chamado quando o turno registrou objeção.
   */
  readonly turnoAtual?: ((ctx: ContextoPipeline) => Promise<number>) | undefined
}

async function turnoDoBanco(ctx: ContextoPipeline): Promise<number> {
  if (!ctx.sessaoId) return 1
  const [s] = await comTenantServico(ctx.tenantId, (tx) => tx<{ turnos: number }[]>`
    SELECT turnos FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${ctx.sessaoId}`)
  return (s?.turnos ?? 0) + 1
}

/** Resumo do handoff: códigos e o texto do negócio, nunca a fala do cliente. */
export function resumoObjecoesSeguidas(seguidas: readonly ObjecaoNoEstado[], textoDe: (codigo: string) => string | null): string {
  const lista = seguidas.map((o) => { const t = textoDe(o.codigo); return t ? `${o.codigo} (${t})` : o.codigo }).join(', ')
  return `O cliente levantou ${seguidas.length} objeções seguidas sem reverter: ${lista}. O agente parou de insistir; continue o atendimento a partir daqui.`.slice(0, 600)
}

export function criarEtapaObjecoesSeguidas(deps: DepsObjecoesSeguidas = {}): EtapaPosResposta {
  const turnoAtual = deps.turnoAtual ?? turnoDoBanco
  return {
    nome: ETAPA_OBJECOES,
    async executar(ctx, entrada) {
      const todas = entrada.objecoesDoTurno ?? []
      const doTurno = todas.length === 0 ? [] : [todas.find((o) => o.revertida) ?? todas[0]!]
      if (doTurno.length === 0) return { mensagens: entrada.mensagens, guardrails: [] }

      const turno = await turnoAtual(ctx).catch(() => 1)
      const anteriores = lerEstadoObjecoes(ctx.estado['objecoes'])
      const objecoes: ObjecaoNoEstado[] = [...anteriores, ...doTurno.map((o) => ({ codigo: o.codigo, revertida: o.revertida, turno }))]
        .slice(-MAX_OBJECOES_NO_ESTADO)
      const estado = { objecoes }
      const guardrails: MarcaGuardrail[] = doTurno.map((o) =>
        marca(ETAPA_OBJECOES, o.revertida ? 'objecao_revertida' : 'objecao_registrada', 'INFO', 'registrado', o.codigo))

      const seguidas = naoRevertidasSeguidas(objecoes)
      const disparou = doTurno.some((o) => !o.revertida) && seguidas >= OBJECOES_SEGUIDAS_PARA_HANDOFF
      if (!disparou || entrada.handoff || ctx.modo === 'copiloto') return { mensagens: entrada.mensagens, guardrails, estado }

      const playbook = lerPlaybookVigente(ctx.cfgExtra['playbook'])?.conteudo ?? null
      const textoDe = (codigo: string) => playbook?.objecoes.find((o) => o.codigo === codigo)?.objecao ?? null
      const resumo = resumoObjecoesSeguidas(objecoes.slice(-seguidas), textoDe)
      guardrails.push(marca(ETAPA_OBJECOES, 'objecoes_seguidas', 'ALTA', 'handoff', objecoes.slice(-seguidas).map((o) => o.codigo).join(', ')))
      const aviso = textoDoHandoff(ctx, playbook)
      return {
        mensagens: [aviso], guardrails, estado,
        bloquear: { motivo: 'objecoes_seguidas', resumo, mensagensSubstitutas: [aviso] },
      }
    },
  }
}

export const etapaObjecoesSeguidas: EtapaPosResposta = criarEtapaObjecoesSeguidas()
