import { randomUUID } from 'node:crypto'
import type { ModoDoTurno } from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { classeDaFalhaLlm } from '../porta.js'
import { MAX_TENTATIVAS } from '../fila.js'
import type { ClasseFalha, DecisaoFalha, EntradaFalha, EstadoAgente, PoliticaFalha } from './tipos.js'

/**
 * POLÍTICA DE FALHA DO PROVEDOR (ADR-030 §4–5, raia P5) — o que o turno faz
 * quando o modelo não entregou. A reserva de provedor (`llm-reserva.ts`) já
 * tentou o que dava ANTES de a falha chegar aqui.
 *
 *   modo            classe                     ação
 *   ─────────────── ────────────────────────── ─────────────────────────────────────────────
 *   simulação/cop.  qualquer                   registrar (a tela mostra o erro na hora)
 *   sombra/assist.  qualquer                   registrar — o robô não falava com o cliente
 *   autônomo        fatal                      handoff na hora, com aviso SEM prazo
 *   autônomo        transitória, 1ª            "tive uma instabilidade" + reagenda 30 s (UMA vez)
 *   autônomo        transitória, 2ª seguida    handoff `modelo_indisponivel` com aviso
 *   autônomo        transitória c/ ferramenta  handoff com aviso (refazer duplicaria efeito)
 *   autônomo        requisição / formato       handoff com aviso
 *
 * ⚠️ "Seguida" = a anterior foi há menos de `JANELA_SEGUIDA_MS` (contada em
 *    `estado_agente.falha`), OU esta tarefa já é uma repetição (`tentativas > 1`),
 *    OU é a última tentativa da fila — nela o worker não reagenda, e um aviso de
 *    "já te respondo" sem turno seguinte seria exatamente o silêncio proibido.
 * ⚠️ O resumo do handoff é determinístico: é o recado da falha (`recadoDaFalha`)
 *    montado pelo turno, nunca texto de modelo.
 * ⚠️ Nunca em silêncio: todo desfecho que não seja "tentar de novo" grava o
 *    alerta `agente_llm_indisponivel` do tenant (um aberto por vez; o texto é
 *    atualizado com a falha mais recente).
 */

export const AVISO_INSTABILIDADE = 'Tive uma instabilidade aqui do meu lado. Só um instante que já te respondo.'
/** ⚠️ Sem prazo: quem assume é uma pessoa, e "em 5 minutos" vira promessa quebrada fora do expediente. */
export const AVISO_TRANSFERENCIA = 'Vou passar sua conversa para alguém da nossa equipe, que continua o atendimento por aqui.'
export const REAGENDAR_INSTABILIDADE_MS = 30_000
/** Duas falhas transitórias dentro disto contam como seguidas. */
export const JANELA_SEGUIDA_MS = 10 * 60_000
export const TIPO_ALERTA_LLM = 'agente_llm_indisponivel'

/** O que esta raia guarda em `estado_agente.falha`. */
export interface EstadoFalha {
  readonly transitorias: number
  /** ISO da última falha transitória. */
  readonly ultimaEm: string
}

function lerEstadoFalha(estado: EstadoAgente): EstadoFalha | null {
  const f = estado['falha']
  if (!f || typeof f !== 'object') return null
  const { transitorias, ultimaEm } = f as Record<string, unknown>
  if (typeof transitorias !== 'number' || typeof ultimaEm !== 'string') return null
  return { transitorias, ultimaEm }
}

/** A decisão, PURA: sem banco, sem relógio próprio. É o que a tabela do topo descreve. */
export function decidirFalha(modo: ModoDoTurno, e: EntradaFalha, agora: Date): DecisaoFalha {
  const classe: ClasseFalha = classeDaFalhaLlm(e.motivo)
  if (modo !== 'autonomo') return { acao: 'registrar', classe, avisoCliente: null }
  if (classe !== 'transitoria') return { acao: 'handoff', classe, avisoCliente: AVISO_TRANSFERENCIA }

  const anterior = lerEstadoFalha(e.estado)
  const recente = !!anterior && agora.getTime() - Date.parse(anterior.ultimaEm) < JANELA_SEGUIDA_MS
  const transitorias = (recente ? anterior!.transitorias : 0) + 1
  const estado = { falha: { transitorias, ultimaEm: agora.toISOString() } satisfies EstadoFalha }
  const seguida = transitorias > 1 || e.tentativas > 1 || e.tentativas >= MAX_TENTATIVAS
  if (seguida || e.executouFerramentas) return { acao: 'handoff', classe, avisoCliente: AVISO_TRANSFERENCIA, estado }
  return { acao: 'aviso_e_reagendar', classe, avisoCliente: AVISO_INSTABILIDADE, reagendarEmMs: REAGENDAR_INSTABILIDADE_MS, estado }
}

/** Ação de quem opera, por classe — alerta sem ação ensina a ignorar (skill de observabilidade). */
const ACAO_DO_ALERTA: Record<ClasseFalha, string> = {
  fatal: 'Confira a chave e o crédito do fornecedor de IA (ou o acesso ao modelo); com IA_RESERVA_PROVEDOR configurada o agente desvia sozinho.',
  transitoria: 'O fornecedor de IA está instável. Se persistir, troque o modelo do número ou configure a reserva.',
  requisicao: 'O fornecedor recusou o pedido. Abra a decisão no painel do agente para ver o detalhe.',
  formato: 'O modelo respondeu fora do formato. Se repetir, troque o modelo do número.',
}

/**
 * Abre (ou atualiza) o alerta `agente_llm_indisponivel` do tenant. Um aberto
 * por vez (índice parcial de 0031): a falha seguinte só reescreve o texto com
 * a mais recente — e o evento `alerta.novo` sai apenas quando nasce um.
 * ⚠️ O texto não leva o detalhe do fornecedor nem amostra da resposta: só a
 *    classe, o motivo e o modo — a decisão no painel tem o resto.
 */
export async function registrarAlertaLlm(
  tenantId: string, p: { readonly classe: ClasseFalha; readonly motivo: string; readonly modo: ModoDoTurno; readonly agora: Date },
): Promise<void> {
  const quando = p.agora.toISOString().slice(0, 16).replace('T', ' ')
  const efeito = p.modo === 'autonomo' ? 'conversa entregue à fila humana' : `só registrado (modo ${p.modo})`
  const mensagem = `IA do agente falhou (${p.classe}: ${p.motivo}) — ${efeito}. Última falha: ${quando} UTC. ${ACAO_DO_ALERTA[p.classe]}`
  const severidade = p.modo === 'autonomo' ? 'critico' : 'aviso'
  await comTenantServico(tenantId, async (tx) => {
    const [l] = await tx<{ novo: boolean }[]>`
      INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem, criado_em)
      VALUES (tenant_atual(), ${randomUUID()}, ${TIPO_ALERTA_LLM}, ${severidade}, ${mensagem}, ${p.agora})
      ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL
      DO UPDATE SET mensagem = EXCLUDED.mensagem,
                    -- Sobe para crítico se agora há cliente afetado; nunca desce.
                    severidade = CASE WHEN EXCLUDED.severidade = 'critico' THEN 'critico' ELSE alerta.severidade END
      RETURNING (xmax = 0) AS novo`
    if (l?.novo) {
      await tx`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'alerta.novo', 'tenant', ${tenantId}, '{}'::jsonb)`
    }
  })
}

export const politicaFalhaLlm: PoliticaFalha = {
  nome: 'falha-llm',
  async decidir(ctx, entrada) {
    const decisao = decidirFalha(ctx.modo, entrada, ctx.agora)
    // Simulação e copiloto mostram o erro na tela de quem pediu; "tentar de novo" ainda não é falha final.
    const alertar = ctx.modo !== 'simulacao' && ctx.modo !== 'copiloto' && decisao.acao !== 'aviso_e_reagendar'
    if (alertar) {
      // ⚠️ Best-effort: o alerta não pode impedir o handoff — o cliente vem antes do painel.
      await registrarAlertaLlm(ctx.tenantId, { classe: decisao.classe, motivo: entrada.motivo, modo: ctx.modo, agora: ctx.agora })
        .catch((e: unknown) => {
          process.stderr.write(`${JSON.stringify({ nivel: 'warn', contexto: 'agente.llm', tenantId: ctx.tenantId, conversaId: ctx.conversaId, msg: 'alerta agente_llm_indisponivel não gravou', erro: e instanceof Error ? e.message : String(e) })}\n`)
        })
    }
    return decisao
  },
}

/** Classe de um motivo (atalho mantido para quem importava daqui). */
export function classeDaFalha(motivo: string): ClasseFalha {
  return classeDaFalhaLlm(motivo)
}
