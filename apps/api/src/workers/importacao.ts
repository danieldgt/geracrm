import { IMPORTACAO_LOTE, parseCsv, type ContagensImportacao, type DePara, type TipoImportacao } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../db/index.js'
import { executarPedaco, somar } from '../contexts/crm/importacao-execucao.js'
import type { OpcoesImportacao } from '../contexts/crm/importacao-dominio.js'

/**
 * WORKER DA IMPORTAÇÃO (raia H1) — executa, em lotes de 500 linhas, as importações que o gestor confirmou
 * (`estado = 'executando'`). Agendado em `server.ts` com guarda anti-sobreposição e batimento.
 *
 * ⚠️ RETOMA SE CAIR: a posição não está na memória, está em `importacao_item` — cada lote grava os itens na MESMA
 *    transação que grava o domínio, então a próxima passada recomeça depois da maior linha com desfecho. Linha
 *    reprocessada nunca duplica (a decisão é idempotente: contato/venda/tarefa já existentes viram `ignorado`).
 * ⚠️ ARRENDAMENTO: a passada reivindica a importação empurrando `arrendado_ate`; processo morto deixa o
 *    arrendamento vencer e outro pega. Cada lote renova. Vários processos nunca executam a mesma importação.
 * ⚠️ Transação curta: um lote por transação, sob o tenant (`comTenantServico`); nada de rede dentro dela.
 * ⚠️ Falha de lote (banco indisponível…) NÃO perde a importação: reagenda com atraso; 5 falhas seguidas → `falhou`
 *    com o código do erro (nunca a mensagem, que poderia citar a célula). Log sem dado pessoal.
 */
export const INTERVALO_IMPORTACAO_MS = 3_000
const ARRENDAMENTO_MS = 2 * 60_000
const ATRASO_APOS_FALHA_MS = 30_000
const MAX_FALHAS_SEGUIDAS = 5
/** Importações reivindicadas por passada (uma de cada vez por processo, em sequência). */
const POR_PASSADA = 3

export interface DepsImportacao {
  readonly somenteTenant?: string | undefined
  /** Só para teste: lote menor para exercitar a retomada. */
  readonly lote?: number | undefined
  /** Só para teste: roda depois de cada lote COMMITADO (lançar simula o processo caindo). */
  readonly depoisDoLote?: ((lotesFeitos: number) => Promise<void> | void) | undefined
}

export interface RelatorioImportacao {
  readonly processadas: number
  readonly concluidas: number
  readonly lotes: number
  readonly falhas: number
}

interface Reivindicada {
  tipo: TipoImportacao
  conteudo: string | null
  de_para: DePara
  opcoes: OpcoesImportacao
  contagens: ContagensImportacao
  criado_por: string | null
  arquivo_hash: string
  tentativas: number
}

export async function processarImportacoes(dono: Sql, deps: DepsImportacao = {}, agora: Date = new Date()): Promise<RelatorioImportacao> {
  const candidatas = await dono<{ tenant_id: string; id: string }[]>`
    SELECT tenant_id, id FROM importacao
     WHERE estado = 'executando' AND (arrendado_ate IS NULL OR arrendado_ate < ${agora})
       ${deps.somenteTenant ? dono`AND tenant_id = ${deps.somenteTenant}` : dono``}
     ORDER BY criado_em LIMIT ${POR_PASSADA}`
  let concluidas = 0, lotes = 0, falhas = 0
  for (const c of candidatas) {
    const r = await processarUma(c.tenant_id, c.id, deps, agora)
    lotes += r.lotes
    if (r.concluida) concluidas++
    if (r.falhou) falhas++
  }
  return { processadas: candidatas.length, concluidas, lotes, falhas }
}

async function processarUma(
  tenantId: string, id: string, deps: DepsImportacao, agora: Date,
): Promise<{ lotes: number; concluida: boolean; falhou: boolean }> {
  const lote = deps.lote ?? IMPORTACAO_LOTE
  const venceEm = () => new Date(agora.getTime() + ARRENDAMENTO_MS)
  // Reivindicação atômica: só um processo passa por aqui por vez.
  const imp = await comTenantServico(tenantId, async (tx) => {
    const [r] = await tx<Reivindicada[]>`
      UPDATE importacao SET arrendado_ate = ${venceEm()}
       WHERE tenant_id = tenant_atual() AND id = ${id} AND estado = 'executando'
         AND (arrendado_ate IS NULL OR arrendado_ate < ${agora})
      RETURNING tipo, conteudo, de_para, opcoes, contagens, criado_por, arquivo_hash, tentativas`
    return r ?? null
  })
  if (!imp) return { lotes: 0, concluida: false, falhou: false }
  if (imp.conteudo === null) {
    await encerrar(tenantId, id, 'falhou', 'sem_conteudo')
    return { lotes: 0, concluida: false, falhou: true }
  }

  const csv = parseCsv(imp.conteudo)
  let contagens = imp.contagens
  let feitos = 0
  let tentativas = imp.tentativas
  try {
    for (;;) {
      const resultado = await comTenantServico(tenantId, async (tx) => {
        const [estado] = await tx<{ estado: string; ultima: number }[]>`
          SELECT i.estado, (SELECT coalesce(max(linha), 0) FROM importacao_item
                             WHERE tenant_id = i.tenant_id AND importacao_id = i.id)::int AS ultima
            FROM importacao i WHERE i.tenant_id = tenant_atual() AND i.id = ${id} FOR UPDATE`
        if (!estado || estado.estado !== 'executando') return { fim: 'parada' as const }
        const pendentes = csv.linhas.filter((l) => l.numero > estado.ultima).slice(0, lote)
        if (pendentes.length === 0) return { fim: 'terminou' as const }
        const itens = await executarPedaco(tx, {
          tipo: imp.tipo, importacaoId: id, arquivoHash: imp.arquivo_hash, usuarioId: imp.criado_por,
          opcoes: imp.opcoes, dePara: imp.de_para, csv, agora,
        }, pendentes)
        let novas = contagens
        for (const i of itens) novas = somar(novas, i.resultado)
        // Absoluto, a partir do que ESTA passada sabe — o arrendamento garante que ninguém mais escreve.
        await tx`
          UPDATE importacao SET contagens = ${JSON.stringify(novas)}::text::jsonb, arrendado_ate = ${venceEm()},
                 atualizado_em = now(), tentativas = 0
           WHERE tenant_id = tenant_atual() AND id = ${id}`
        return { fim: null, contagens: novas }
      })
      if (resultado.fim === 'parada') return { lotes: feitos, concluida: false, falhou: false }
      if (resultado.fim === 'terminou') break
      contagens = resultado.contagens
      tentativas = 0
      feitos++
      await deps.depoisDoLote?.(feitos)
    }
  } catch (erro) {
    if (erro instanceof ErroDeTeste) throw erro
    tentativas++
    const codigo = (erro as { code?: string } | null)?.code ?? 'erro_no_lote'
    if (tentativas >= MAX_FALHAS_SEGUIDAS) {
      await encerrar(tenantId, id, 'falhou', String(codigo).slice(0, 60))
      return { lotes: feitos, concluida: false, falhou: true }
    }
    await comTenantServico(tenantId, (tx) => tx`
      UPDATE importacao SET tentativas = ${tentativas}, arrendado_ate = ${new Date(agora.getTime() + ATRASO_APOS_FALHA_MS)}
       WHERE tenant_id = tenant_atual() AND id = ${id} AND estado = 'executando'`)
    return { lotes: feitos, concluida: false, falhou: true }
  }

  await encerrar(tenantId, id, 'concluida', null)
  return { lotes: feitos, concluida: true, falhou: false }
}

/** Erro que o teste lança para simular o processo caindo: passa direto, sem contar como falha de lote. */
export class ErroDeTeste extends Error {}

/** Fecha a importação: zera o CSV guardado (dado pessoal não fica mais do que o necessário) e solta o arrendamento. */
async function encerrar(tenantId: string, id: string, estado: 'concluida' | 'falhou', erro: string | null): Promise<void> {
  await comTenantServico(tenantId, (tx) => tx`
    UPDATE importacao SET estado = ${estado}, conteudo = NULL, arrendado_ate = NULL, erro = ${erro},
           concluido_em = now(), atualizado_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${id} AND estado = 'executando'`)
}
