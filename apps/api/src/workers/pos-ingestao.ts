import type { Sql } from '../db/index.js'
import { decifrar } from '../contexts/integracao/cofre.js'
import { responderAutomaticamente } from '../contexts/atendimento/resposta-automatica.js'
import { resolverMidiaMeta } from '../contexts/atendimento/midia/resolver-midia-meta.js'
import { copiarMidiaEntrante } from '../contexts/atendimento/midia/copiar-entrante.js'
import { midiaHabilitada } from '../contexts/atendimento/midia/armazenamento.js'
import { PREFIXO_MIDIA_META } from '../contexts/atendimento/canais/meta-oficial.js'
import type { MidiaExterna } from '../contexts/atendimento/ingestao-mensagem.js'

/**
 * WORKER DE PÓS-INGESTÃO DO WEBHOOK (raia P11, docs/plano-port-playbook-am.md).
 *
 * Agendado em `server.ts` (dono: P0), com batimento a cada passada. Drena
 * `tarefa_pos_ingestao` — o que o webhook fazia antes do 200 e era REDE:
 *
 *   'automatica' → `responderAutomaticamente` (ausência; o turno do agente já
 *                  foi agendado pela ingestão e corre no worker do agente)
 *   'midia'      → Meta: `meta:media:<id>` → Graph API → nosso bucket;
 *                  não-oficial: URL do provedor → nosso bucket
 *
 * ⚠️ Retry com backoff e teto por tipo; esgotou → `falhou` com o detalhe (a
 *    mensagem do cliente já está salva — degradar aqui é manter a URL/
 *    placeholder, como antes). Uma tarefa quebrada nunca para as outras.
 * ⚠️ Vários processos: a reivindicação é `FOR UPDATE SKIP LOCKED` + ARRENDAMENTO
 *    (empurra `executar_em`): se o processo morrer no meio, a tarefa volta
 *    sozinha depois do arrendamento. A idempotência de verdade está embaixo —
 *    a ausência conta as próprias respostas (uma a cada 6h por conversa) e a
 *    mídia só troca o placeholder que ainda estiver lá.
 * ⚠️ Rede nunca dentro de transação: a passada lê/grava como DONO em comandos
 *    curtos e chama os passos (que abrem a própria transação sob o tenant).
 *
 * Também mantém o ROTEAMENTO POR WABA (0101): copia `wabaId`/`telefone` da
 * credencial cifrada para as colunas em claro que o webhook de qualidade e de
 * template usa para achar o canal.
 */
export const INTERVALO_POS_INGESTAO_MS = 2_000
const LOTE = 20
const ARRENDAMENTO_MS = 5 * 60_000
/** Atraso antes da tentativa N+1 (índice = tentativas já feitas − 1). */
export const ATRASOS_POS_INGESTAO_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]
export const MAX_TENTATIVAS_POS_INGESTAO: Readonly<Record<TipoTarefa, number>> = { automatica: 3, midia: 5 }
/** De quanto em quanto tempo REVALIDA o roteamento de todos os canais Meta (credencial pode ter mudado). */
const REVALIDAR_ROTEAMENTO_MS = 10 * 60_000

export type TipoTarefa = 'automatica' | 'midia'

export interface RelatorioPosIngestao {
  readonly processadas: number
  readonly feitas: number
  readonly reagendadas: number
  readonly falharam: number
  readonly descartadas: number
  readonly roteamentoMeta: number
}

/**
 * Dependências injetáveis (todas OPCIONAIS — `server.ts` passa `{}`): os passos
 * de rede são trocados por espiões nos testes.
 */
export interface DepsPosIngestao {
  readonly responder?: typeof responderAutomaticamente | undefined
  readonly resolverMeta?: ((tenantId: string, canalId: string, m: MidiaExterna) => Promise<boolean>) | undefined
  readonly copiar?: ((tenantId: string, m: MidiaExterna) => Promise<boolean>) | undefined
  readonly midiaHabilitada?: (() => boolean) | undefined
  /** Restringe a passada a UM tenant (testes contra banco compartilhado). */
  readonly somenteTenant?: string | undefined
}

interface TarefaVencida {
  readonly tenant_id: string
  readonly id: string
  readonly tipo: TipoTarefa
  readonly conversa_id: string
  readonly canal_id: string
  readonly mensagem_id: string
  readonly mensagem_criado_em: Date
  readonly dados: { tipo?: 'imagem' | 'audio'; url?: string; mime?: string | null }
  readonly tentativas: number
}

type Desfecho = { ok: true; detalhe: string } | { ok: false; detalhe: string; definitivo?: boolean }

let ultimaRevalidacao = 0

export async function processarPosIngestao(dono: Sql, deps: DepsPosIngestao = {}, agora: Date = new Date()): Promise<RelatorioPosIngestao> {
  let feitas = 0, reagendadas = 0, falharam = 0, descartadas = 0
  const lote = await dono<TarefaVencida[]>`
    UPDATE tarefa_pos_ingestao t
       SET executar_em = ${new Date(agora.getTime() + ARRENDAMENTO_MS)}, tentativas = t.tentativas + 1
     WHERE (t.tenant_id, t.id) IN (
       SELECT tenant_id, id FROM tarefa_pos_ingestao
        WHERE estado = 'pendente' AND executar_em <= ${agora}
          ${deps.somenteTenant ? dono`AND tenant_id = ${deps.somenteTenant}` : dono``}
        ORDER BY executar_em
        LIMIT ${LOTE}
          FOR UPDATE SKIP LOCKED)
    RETURNING t.tenant_id, t.id, t.tipo, t.conversa_id, t.canal_id, t.mensagem_id, t.mensagem_criado_em, t.dados, t.tentativas`

  for (const t of lote) {
    let d: Desfecho
    try {
      d = await executar(t, deps, agora)
    } catch (erro) {
      d = { ok: false, detalhe: `erro: ${erro instanceof Error ? erro.message : String(erro)}` }
    }
    const detalhe = d.detalhe.slice(0, 500)
    if (d.ok) {
      feitas += 1
      await dono`UPDATE tarefa_pos_ingestao SET estado = 'feita', detalhe = ${detalhe}, concluido_em = ${agora}
                  WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
    } else if (d.definitivo) {
      descartadas += 1
      await dono`UPDATE tarefa_pos_ingestao SET estado = 'descartada', detalhe = ${detalhe}, concluido_em = ${agora}
                  WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
    } else if (t.tentativas >= MAX_TENTATIVAS_POS_INGESTAO[t.tipo]) {
      falharam += 1
      await dono`UPDATE tarefa_pos_ingestao SET estado = 'falhou', detalhe = ${detalhe}, concluido_em = ${agora}
                  WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
    } else {
      reagendadas += 1
      const atraso = ATRASOS_POS_INGESTAO_MS[Math.min(t.tentativas - 1, ATRASOS_POS_INGESTAO_MS.length - 1)]!
      await dono`UPDATE tarefa_pos_ingestao SET executar_em = ${new Date(agora.getTime() + atraso)}, detalhe = ${detalhe}
                  WHERE tenant_id = ${t.tenant_id} AND id = ${t.id}`
    }
  }

  const roteamentoMeta = await sincronizarRoteamentoMeta(dono, agora, deps.somenteTenant)
  return { processadas: lote.length, feitas, reagendadas, falharam, descartadas, roteamentoMeta }
}

async function executar(t: TarefaVencida, deps: DepsPosIngestao, agora: Date): Promise<Desfecho> {
  if (t.tipo === 'automatica') {
    const r = await (deps.responder ?? responderAutomaticamente)(t.tenant_id, t.conversa_id, t.canal_id, agora)
    const detalhe = `ausencia=${r.ausencia}; agente=${r.agenteMotivo ?? '-'}; equipe=${r.disponibilidade}`
    // ⚠️ `envio_recusado` inclui falha de transporte: tenta de novo. Repetir é
    //    seguro — a ausência conta as próprias respostas (uma a cada 6h).
    return r.ausencia === 'envio_recusado' ? { ok: false, detalhe } : { ok: true, detalhe }
  }

  // Mídia.
  if (!(deps.midiaHabilitada ?? midiaHabilitada)()) {
    return { ok: false, definitivo: true, detalhe: 'bucket de mídia não configurado — mantém a referência do provedor' }
  }
  const url = t.dados.url
  if (!url || (t.dados.tipo !== 'imagem' && t.dados.tipo !== 'audio')) {
    return { ok: false, definitivo: true, detalhe: 'tarefa de mídia sem url/tipo' }
  }
  const m: MidiaExterna = {
    mensagemId: t.mensagem_id, mensagemCriadoEm: t.mensagem_criado_em, tipo: t.dados.tipo, url, mime: t.dados.mime ?? null,
  }
  const ok = url.startsWith(PREFIXO_MIDIA_META)
    ? await (deps.resolverMeta ?? resolverMidiaMeta)(t.tenant_id, t.canal_id, m)
    : await (deps.copiar ?? copiarMidiaEntrante)(t.tenant_id, m)
  return ok ? { ok: true, detalhe: 'mídia no nosso bucket' } : { ok: false, detalhe: 'download/cópia falhou' }
}

/**
 * Copia `wabaId` e `telefone` da credencial (cifrada) para as colunas de
 * roteamento em claro. Toda passada cuida dos canais NOVOS (coluna NULL); a
 * cada 10 min revalida todos (a credencial pode ter sido trocada na tela).
 * Credencial ilegível não derruba a passada — fica para a próxima.
 */
export async function sincronizarRoteamentoMeta(dono: Sql, agora: Date, somenteTenant?: string): Promise<number> {
  const todos = agora.getTime() - ultimaRevalidacao >= REVALIDAR_ROTEAMENTO_MS
  if (todos) ultimaRevalidacao = agora.getTime()
  const canais = await dono<{ tenant_id: string; id: string; cred: Uint8Array; waba: string | null; tel: string | null }[]>`
    SELECT tenant_id, id, credenciais_cifradas AS cred, meta_waba_id AS waba, meta_telefone AS tel
      FROM canal_conectado
     WHERE provedor = 'meta_oficial' AND credenciais_cifradas IS NOT NULL AND arquivado_em IS NULL
       ${todos ? dono`` : dono`AND meta_waba_id IS NULL`}
       ${somenteTenant ? dono`AND tenant_id = ${somenteTenant}` : dono``}
     LIMIT 200`
  let mudou = 0
  for (const c of canais) {
    let cred: Record<string, unknown>
    try { cred = decifrar(Buffer.from(c.cred)) as Record<string, unknown> } catch { continue }
    const waba = typeof cred['wabaId'] === 'string' ? cred['wabaId'].trim() : ''
    const tel = typeof cred['telefone'] === 'string' ? cred['telefone'].replace(/\D/g, '') : ''
    if (!waba || (waba === c.waba && (tel || null) === c.tel)) continue
    await dono`UPDATE canal_conectado SET meta_waba_id = ${waba}, meta_telefone = ${tel || null}
                WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
    mudou += 1
  }
  return mudou
}
