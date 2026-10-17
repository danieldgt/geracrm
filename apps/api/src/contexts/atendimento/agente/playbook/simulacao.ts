import { randomUUID } from 'node:crypto'
import {
  personaDoPlaybook, slotsDoPlaybook,
  type AcoesPlaybook, type ConteudoPlaybook, type PlaybookVigente,
} from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'
import type { DepsTurno } from '../vendedor.js'
import { aplicarPlaybookAoSistema } from '../instrucao-vendedor.js'
import { PIPELINE_PADRAO, type ContextoPipeline, type EtapaPosResposta, type EtapaPreLlm, type PipelineDoTurno } from '../pipeline/index.js'

/**
 * SANDBOX DO PLAYBOOK (P17; ADR-033 regra 5) — o playground existente em MODO
 * SECO rodando um playbook que NÃO está publicado (o rascunho).
 *
 * O turno real lê o playbook do espelho em `agente_config`; aqui o mesmo turno
 * (`conduzirTurnoVendedor` com `simulacao: true`) recebe o rascunho por três
 * costuras que já existem, sem tocar no vendedor:
 *   - as ETAPAS do pipeline enxergam `cfgExtra.playbook`/`qualificacao` e a
 *     persona do rascunho (`DepsTurno.pipeline`);
 *   - o LLM recebe o `<persona>`/`<objetivo>`/`<playbook>` do rascunho no bloco do tenant
 *     (`DepsTurno.llm`, envolvendo o modelo do número);
 *   - as LIGAÇÕES levam as ações do rascunho (o menu de ferramentas muda).
 * Ferramentas de escrita já são secas em simulação: pedido em carrinho de
 * ensaio, proposta sem envio, memória sem gravar, transferência sem fila.
 */

export function espelhoDoConteudo(conteudo: ConteudoPlaybook, meta: { versaoId: string; numero: number | null; escopo: 'numero' | 'tenant' }): PlaybookVigente {
  return { versaoId: meta.versaoId, numero: meta.numero ?? 0, escopo: meta.escopo, publicadaEm: '', conteudo }
}

function comPlaybook(ctx: ContextoPipeline, espelho: PlaybookVigente): ContextoPipeline {
  return {
    ...ctx,
    persona: personaDoPlaybook(espelho.conteudo),
    cfgExtra: { ...ctx.cfgExtra, playbook: espelho, qualificacao: slotsDoPlaybook(espelho.conteudo) },
  }
}

const pre = (e: EtapaPreLlm, esp: PlaybookVigente): EtapaPreLlm => ({ nome: e.nome, executar: (ctx) => e.executar(comPlaybook(ctx, esp)) })
const pos = (e: EtapaPosResposta, esp: PlaybookVigente): EtapaPosResposta => ({ nome: e.nome, executar: (ctx, en) => e.executar(comPlaybook(ctx, esp), en) })

/** As etapas do pipeline padrão vendo o playbook dado (o modo efetivo não roda em simulação). */
export function pipelineComPlaybook(espelho: PlaybookVigente, base: PipelineDoTurno = PIPELINE_PADRAO): Partial<PipelineDoTurno> {
  return {
    gatilhos: pre(base.gatilhos, espelho),
    slots: pre(base.slots, espelho),
    teto: { nome: base.teto.nome, antes: (ctx) => base.teto.antes(comPlaybook(ctx, espelho)), depois: (ctx, t) => base.teto.depois(comPlaybook(ctx, espelho), t) },
    numeros: pos(base.numeros, espelho),
    filtro: pos(base.filtro, espelho),
    pergunta: pos(base.pergunta, espelho),
    qualidade: pos(base.qualidade, espelho),
    falha: { nome: base.falha.nome, decidir: (ctx, e) => base.falha.decidir(comPlaybook(ctx, espelho), e) },
  }
}

/** O modelo do número com a persona, o objetivo e o playbook do rascunho no bloco do tenant. */
export function llmComPlaybook(llm: PortaLlmFerramentas, conteudo: ConteudoPlaybook, objetivo: 'vender' | 'qualificar'): PortaLlmFerramentas {
  const persona = personaDoPlaybook(conteudo)
  const slots = slotsDoPlaybook(conteudo)
  return {
    nome: llm.nome,
    capacidades: llm.capacidades,
    rodar: (p) => llm.rodar({ ...p, sistema: aplicarPlaybookAoSistema(p.sistema, { persona, objetivo, slots, playbook: conteudo }) }),
  }
}

/** Ligações do número com as ações do playbook dado (ou as do espelho, quando `acoes` é null). */
export function ligacoesDoSandbox(base: DepsTurno['ligacoes'], canalId: string, acoes: AcoesPlaybook | null): DepsTurno['ligacoes'] {
  return async (cfg) => {
    const l = await base({ ...cfg, canalId })
    return acoes ? { ...l, acoes } : l
  }
}

// ── uma simulação por vez ───────────────────────────────────────────────────

/** Duração do lease: maior que o prazo máximo de um turno (60 s) com folga. */
export const DURACAO_TRAVA_SIMULACAO_MS = 120_000

/**
 * Uma simulação por TENANT de cada vez (custo de LLM e o contato de simulação
 * compartilhado). Lease em banco — vale entre instâncias e expira sozinho se o
 * processo cair. Devolve o token, ou null quando há outra em andamento.
 */
export async function adquirirTravaSimulacao(tenantId: string, agora = new Date()): Promise<string | null> {
  const token = randomUUID()
  const ate = new Date(agora.getTime() + DURACAO_TRAVA_SIMULACAO_MS)
  const [l] = await comTenantServico(tenantId, (tx) => tx<{ token: string }[]>`
    INSERT INTO agente_simulacao_trava (tenant_id, token, ate) VALUES (tenant_atual(), ${token}, ${ate})
    ON CONFLICT (tenant_id) DO UPDATE SET token = EXCLUDED.token, ate = EXCLUDED.ate
     WHERE agente_simulacao_trava.ate < ${agora}
    RETURNING token`)
  return l?.token === token ? token : null
}

export async function liberarTravaSimulacao(tenantId: string, token: string): Promise<void> {
  await comTenantServico(tenantId, (tx) => tx`DELETE FROM agente_simulacao_trava WHERE tenant_id = tenant_atual() AND token = ${token}`)
}
