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
/** Cada canal Meta tem o roteamento (re)conferido na credencial no máximo a cada 10 min (rodízio). */
export const REVALIDAR_ROTEAMENTO_MS = 10 * 60_000
const LOTE_ROTEAMENTO = 50
/**
 * ⚠️ Ausência ATRASADA não sai: mais de 15 min depois de agendada (worker
 * parado, fila acumulada), "não há ninguém agora" já não descreve o momento —
 * e pode chegar depois de alguém ter respondido.
 */
export const VALIDADE_AUSENCIA_MS = 15 * 60_000
/** Retenção: concluídas há mais de 30 dias são purgadas, em lote, a cada 10 min. */
export const RETENCAO_POS_INGESTAO_MS = 30 * 24 * 60 * 60_000
const LOTE_PURGA = 500
const INTERVALO_PURGA_MS = 10 * 60_000

export type TipoTarefa = 'automatica' | 'midia'

export interface RelatorioPosIngestao {
  readonly processadas: number
  readonly feitas: number
  readonly reagendadas: number
  readonly falharam: number
  readonly descartadas: number
  readonly roteamentoMeta: number
  readonly purgadas: number
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
  readonly criado_em: Date
}

type Desfecho = { ok: true; detalhe: string } | { ok: false; detalhe: string; definitivo?: boolean }

let ultimaPurga = 0

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
    RETURNING t.tenant_id, t.id, t.tipo, t.conversa_id, t.canal_id, t.mensagem_id, t.mensagem_criado_em, t.dados, t.tentativas, t.criado_em`

  for (const t of lote) {
    let d: Desfecho
    try {
      d = await executar(dono, t, deps, agora)
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
  let purgadas = 0
  if (agora.getTime() - ultimaPurga >= INTERVALO_PURGA_MS) {
    ultimaPurga = agora.getTime()
    purgadas = await purgarPosIngestao(dono, agora, deps.somenteTenant)
  }
  return { processadas: lote.length, feitas, reagendadas, falharam, descartadas, roteamentoMeta, purgadas }
}

/**
 * Retenção: apaga as tarefas CONCLUÍDAS (feita/falhou/descartada) há mais de 30
 * dias, em lote (índice parcial `tarefa_pos_ingestao_concluidas`). Pendente
 * nunca é apagada. Devolve quantas saíram.
 */
export async function purgarPosIngestao(dono: Sql, agora: Date, somenteTenant?: string, lote = LOTE_PURGA): Promise<number> {
  const linhas = await dono<{ id: string }[]>`
    DELETE FROM tarefa_pos_ingestao t
     WHERE (t.tenant_id, t.id) IN (
       SELECT tenant_id, id FROM tarefa_pos_ingestao
        WHERE estado <> 'pendente' AND concluido_em < ${new Date(agora.getTime() - RETENCAO_POS_INGESTAO_MS)}
          ${somenteTenant ? dono`AND tenant_id = ${somenteTenant}` : dono``}
        LIMIT ${lote})
    RETURNING t.id`
  return linhas.length
}

async function executar(dono: Sql, t: TarefaVencida, deps: DepsPosIngestao, agora: Date): Promise<Desfecho> {
  if (t.tipo === 'automatica') {
    if (agora.getTime() - t.criado_em.getTime() > VALIDADE_AUSENCIA_MS) {
      return { ok: false, definitivo: true, detalhe: 'atrasada: mais de 15 min depois da mensagem — não responde fora de hora' }
    }
    // Alguém (pessoa, agente, outra automática) já falou depois desta mensagem?
    // A falha de envio não conta — é exatamente o que o retry vem consertar.
    const [depois] = await dono<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM mensagem m
                      WHERE m.tenant_id = ${t.tenant_id} AND m.conversa_id = ${t.conversa_id}
                        AND m.direcao = 'saliente' AND m.status IS DISTINCT FROM 'falhou'
                        AND m.criado_em > ${t.mensagem_criado_em}) AS ok`
    if (depois?.ok) return { ok: false, definitivo: true, detalhe: 'já houve resposta depois da mensagem do cliente' }

    const r = await (deps.responder ?? responderAutomaticamente)(t.tenant_id, t.conversa_id, t.canal_id, agora)
    const detalhe = `ausencia=${r.ausencia}; agente=${r.agenteMotivo ?? '-'}; equipe=${r.disponibilidade}`
    // ⚠️ Só a falha de TRANSPORTE tenta de novo. Recusa nossa (opt-out, canal
    //    arquivado, sem credencial) é final: repetir criaria uma bolha nova a
    //    cada passada para quem pediu para não receber.
    return r.ausencia === 'envio_falhou_transporte' ? { ok: false, detalhe } : { ok: true, detalhe }
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
 * roteamento em claro que o webhook de qualidade/template usa.
 *
 * ⚠️ RODÍZIO, não varredura: cada passada pega até 50 canais cuja última
 *    conferência (`meta_roteamento_em`) é nula ou tem mais de 10 min, os mais
 *    antigos primeiro, e carimba TODOS — inclusive os que falharam, com o erro
 *    em `meta_roteamento_erro`. Assim o mesmo conjunto não é decifrado a cada
 *    2 s, e uma credencial trocada na tela é vista em até 10 min.
 */
export async function sincronizarRoteamentoMeta(dono: Sql, agora: Date, somenteTenant?: string): Promise<number> {
  const canais = await dono<{ tenant_id: string; id: string; cred: Uint8Array; waba: string | null; tel: string | null }[]>`
    SELECT tenant_id, id, credenciais_cifradas AS cred, meta_waba_id AS waba, meta_telefone AS tel
      FROM canal_conectado
     WHERE provedor = 'meta_oficial' AND credenciais_cifradas IS NOT NULL AND arquivado_em IS NULL
       AND (meta_roteamento_em IS NULL OR meta_roteamento_em < ${new Date(agora.getTime() - REVALIDAR_ROTEAMENTO_MS)})
       ${somenteTenant ? dono`AND tenant_id = ${somenteTenant}` : dono``}
     ORDER BY meta_roteamento_em NULLS FIRST, tenant_id, id
     LIMIT ${LOTE_ROTEAMENTO}`
  let mudou = 0
  for (const c of canais) {
    let waba = '', tel = '', erro: string | null = null
    try {
      const cred = decifrar(Buffer.from(c.cred)) as Record<string, unknown>
      waba = typeof cred['wabaId'] === 'string' ? cred['wabaId'].trim() : ''
      tel = typeof cred['telefone'] === 'string' ? cred['telefone'].replace(/\D/g, '') : ''
      if (!waba) erro = 'credencial sem wabaId'
    } catch (e) {
      erro = `credencial ilegível: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)
    }
    const muda = !erro && (waba !== c.waba || (tel || null) !== c.tel)
    await dono`
      UPDATE canal_conectado
         SET meta_roteamento_em = ${agora}, meta_roteamento_erro = ${erro},
             meta_waba_id = CASE WHEN ${muda} THEN ${waba || null} ELSE meta_waba_id END,
             meta_telefone = CASE WHEN ${muda} THEN ${tel || null} ELSE meta_telefone END
       WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
    if (muda) mudou += 1
  }
  return mudou
}
