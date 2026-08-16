import { classificarRfv } from '@geracrm/shared'
import postgres from 'postgres'
import type { Sql } from '../../db/index.js'

/**
 * Motor de automações — VARREDURA AGENDADA, ações INTERNAS (decisão de produto,
 * docs/automacoes.md). Roda como DONO (worker), sem tenant de sessão: o
 * isolamento vem do `tenant_id` explícito em cada query (como o dispatcher de
 * webhooks e o integrador). ⚠️ Por isso lê `mv_metricas_contato` CRU — a view
 * `metricas_contato` filtra por tenant_atual() e é para o papel da API.
 *
 * Cada regra age no mesmo contato UMA vez (dedup em automacao_execucao).
 */

const CAP_POR_REGRA = 200 // teto por regra por passada — não explode em rajada

interface Automacao {
  id: string; nome: string; gatilho: string; gatilho_param: Record<string, unknown>
  acao: string; acao_param: Record<string, unknown>
}

/** contato_ids que casam o gatilho e ainda NÃO foram atendidos por esta regra. */
async function candidatos(sql: Sql, tid: string, a: Automacao): Promise<string[]> {
  const p = a.gatilho_param
  const naoAtendido = (col: string) =>
    sql`NOT EXISTS (SELECT 1 FROM automacao_execucao ae WHERE ae.tenant_id = ${tid} AND ae.automacao_id = ${a.id} AND ae.contato_id = ${sql(col)})`

  if (a.gatilho === 'dias_sem_comprar') {
    const dias = Number(p['dias'] ?? 60)
    const linhas = await sql<{ id: string }[]>`
      SELECT c.id FROM contato c
       WHERE c.tenant_id = ${tid} AND c.ativo AND c.qtd_vendas > 0 AND c.ultima_venda_em IS NOT NULL
         AND (now()::date - c.ultima_venda_em::date) > ${dias}
         AND ${naoAtendido('c.id')}
       LIMIT ${CAP_POR_REGRA}`
    return linhas.map((l) => l.id)
  }

  if (a.gatilho === 'lead_frio') {
    const dias = Number(p['dias'] ?? 30)
    const linhas = await sql<{ id: string }[]>`
      SELECT c.id FROM contato c
       WHERE c.tenant_id = ${tid} AND c.ativo AND c.qtd_vendas = 0
         AND (now()::date - c.criado_em::date) > ${dias}
         AND ${naoAtendido('c.id')}
       LIMIT ${CAP_POR_REGRA}`
    return linhas.map((l) => l.id)
  }

  if (a.gatilho === 'nps_detrator') {
    const notaMax = Number(p['notaMax'] ?? 6)
    const janela = Number(p['janelaDias'] ?? 30)
    const linhas = await sql<{ contato_id: string }[]>`
      SELECT DISTINCT n.contato_id FROM nps_resposta n
       WHERE n.tenant_id = ${tid} AND n.contato_id IS NOT NULL AND n.nota <= ${notaMax}
         AND n.respondido_em >= now() - (${janela} || ' days')::interval
         AND NOT EXISTS (SELECT 1 FROM automacao_execucao ae WHERE ae.tenant_id = ${tid} AND ae.automacao_id = ${a.id} AND ae.contato_id = n.contato_id)
       LIMIT ${CAP_POR_REGRA}`
    return linhas.map((l) => l.contato_id)
  }

  if (a.gatilho === 'rfv_segmento') {
    const segmento = String(p['segmento'] ?? '')
    // ⚠️ MV crua (worker), filtrada por tenant explícito. Classifica no JS com a
    // MESMA régua do resto (classificarRfv), depois filtra ao segmento-alvo.
    const linhas = await sql<{ contato_id: string; qtd_vendas: number; dias_sem_comprar: number | null; atraso: string | null }[]>`
      SELECT m.contato_id, m.qtd_vendas, m.dias_sem_comprar, m.atraso_relativo::text AS atraso
        FROM mv_metricas_contato m
       WHERE m.tenant_id = ${tid}
         AND NOT EXISTS (SELECT 1 FROM automacao_execucao ae WHERE ae.tenant_id = ${tid} AND ae.automacao_id = ${a.id} AND ae.contato_id = m.contato_id)
       LIMIT 3000`
    const ids: string[] = []
    for (const l of linhas) {
      const s = classificarRfv({
        qtdVendas: Number(l.qtd_vendas),
        diasSemComprar: l.dias_sem_comprar,
        atrasoRelativo: l.atraso === null ? null : Number(l.atraso),
      })
      if (s.codigo === segmento) ids.push(l.contato_id)
      if (ids.length >= CAP_POR_REGRA) break
    }
    return ids
  }

  if (a.gatilho === 'reposicao_ritmo') {
    // Régua de recompra (skill funil-de-vendas): oferecer reposição na JANELA DE
    // ANTECIPAÇÃO — quando o cliente chega a `fator`× a média entre compras DELE
    // (padrão 0,8), antes de virar atraso. Compara ao ritmo do próprio cliente
    // (atraso_relativo), nunca a uma régua única.
    // ⚠️ RECORRENTE: age de novo a cada ciclo. O dedup é ciente do ciclo —
    //    candidato só se NÃO agimos DESDE a última compra (executado_em vs
    //    ultima_venda_em); o registro é UPSERT (executado_em = now()).
    const fator = Number(p['fator'] ?? 0.8)
    const teto = Number(p['teto'] ?? 1.0)
    const linhas = await sql<{ contato_id: string }[]>`
      SELECT m.contato_id
        FROM mv_metricas_contato m
       WHERE m.tenant_id = ${tid}
         AND m.qtd_vendas >= 2                 -- precisa de ritmo (2+ compras)
         AND m.atraso_relativo IS NOT NULL
         AND m.atraso_relativo >= ${fator}
         AND m.atraso_relativo <  ${teto}
         AND NOT EXISTS (
           SELECT 1 FROM automacao_execucao ae
            WHERE ae.tenant_id = ${tid} AND ae.automacao_id = ${a.id}
              AND ae.contato_id = m.contato_id
              AND ae.executado_em >= m.ultima_venda_em)   -- já agimos NESTE ciclo
       LIMIT ${CAP_POR_REGRA}`
    return linhas.map((l) => l.contato_id)
  }

  return []
}

/** Executa a ação da regra para um contato. Reusa Tarefas/Sequências/Listas. */
async function aplicarAcao(sql: Sql, tid: string, a: Automacao, contatoId: string): Promise<void> {
  const p = a.acao_param

  if (a.acao === 'criar_tarefa') {
    const titulo = String(p['titulo'] ?? a.nome)
    const offset = Number(p['offsetDias'] ?? 0)
    const paraDono = p['paraDono'] !== false
    await sql`
      INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por)
      VALUES (${tid}, gen_random_uuid(), ${contatoId},
              ${paraDono
                ? sql`(SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${tid} AND contato_id = ${contatoId} AND ate IS NULL LIMIT 1)`
                : sql`NULL`},
              ${titulo}, ${'Criada pela automação: ' + a.nome},
              date_trunc('day', now()) + (${offset} || ' days')::interval + interval '9 hours', NULL)`
    return
  }

  if (a.acao === 'aplicar_sequencia') {
    const sequenciaId = String(p['sequenciaId'] ?? '')
    const passos = await sql<{ offset_dias: number; titulo: string; descricao: string | null }[]>`
      SELECT offset_dias, titulo, descricao FROM sequencia_passo
       WHERE tenant_id = ${tid} AND sequencia_id = ${sequenciaId} ORDER BY seq ASC`
    for (const passo of passos) {
      await sql`
        INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por)
        VALUES (${tid}, gen_random_uuid(), ${contatoId},
                (SELECT usuario_id FROM carteira_atribuicao WHERE tenant_id = ${tid} AND contato_id = ${contatoId} AND ate IS NULL LIMIT 1),
                ${passo.titulo}, ${passo.descricao},
                date_trunc('day', now()) + (${passo.offset_dias} || ' days')::interval + interval '9 hours', NULL)`
    }
    return
  }

  if (a.acao === 'adicionar_lista') {
    const listaId = String(p['listaId'] ?? '')
    await sql`
      INSERT INTO lista_membro (tenant_id, lista_id, contato_id)
      VALUES (${tid}, ${listaId}, ${contatoId})
      ON CONFLICT (tenant_id, lista_id, contato_id) DO NOTHING`
    return
  }
}

/** Roda TODAS as automações ativas de UM tenant. Devolve quantas ações executou. */
export async function executarNoTenant(sql: Sql, tid: string, agora: Date): Promise<number> {
  void agora
  const regras = await sql<Automacao[]>`
    SELECT id, nome, gatilho, gatilho_param, acao, acao_param
      FROM automacao WHERE tenant_id = ${tid} AND ativa`
  let total = 0
  for (const a of regras) {
    const ids = await candidatos(sql, tid, a)
    for (const contatoId of ids) {
      // Ação + dedup na MESMA transação: ou faz e registra, ou nenhum dos dois.
      await sql.begin(async (tx) => {
        await aplicarAcao(tx as unknown as Sql, tid, a, contatoId)
        // ⚠️ UPSERT do carimbo: gatilhos de uma vez (rfv/dias/lead/nps) nunca
        //    reincidem (o candidato usa NOT EXISTS de QUALQUER linha), então o
        //    UPDATE é inócuo para eles; a régua recorrente (reposicao_ritmo)
        //    depende de `executado_em` avançar para fechar o ciclo atual.
        await tx`INSERT INTO automacao_execucao (tenant_id, automacao_id, contato_id)
                 VALUES (${tid}, ${a.id}, ${contatoId})
                 ON CONFLICT (tenant_id, automacao_id, contato_id) DO UPDATE SET executado_em = now()`
      })
      total += 1
    }
    if (ids.length > 0) {
      await sql`UPDATE automacao SET ultima_execucao_em = now() WHERE tenant_id = ${tid} AND id = ${a.id}`
    }
  }
  return total
}

/**
 * Uma passada por TODOS os tenants com automação ativa. Guardada por advisory
 * lock — várias instâncias não varrem em dobro. Roda como DONO.
 */
export async function varrerAutomacoes(sql: Sql, agora: Date): Promise<number> {
  const [trava] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('automacao_varredura')) AS ok`
  if (!trava?.ok) return 0
  let total = 0
  try {
    const tenants = await sql<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM automacao WHERE ativa`
    for (const t of tenants) total += await executarNoTenant(sql, t.tenant_id, agora)
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('automacao_varredura'))`
  }
  return total
}

// --- Conexão DONO compartilhada (para o endpoint "rodar agora" e o agendador) ---
let dono: ReturnType<typeof postgres> | undefined
function conexaoDono(): ReturnType<typeof postgres> {
  if (!dono) {
    if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL ausente para o motor de automação')
    dono = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} })
  }
  return dono
}
/** "Rodar agora" para um tenant (endpoint). Isolamento pelo tid explícito. */
export function executarAutomacoesDoTenant(tid: string, agora: Date): Promise<number> {
  return executarNoTenant(conexaoDono() as unknown as Sql, tid, agora)
}
/** Passada agendada (server.ts), usando a conexão dono compartilhada. */
export function varrerAgendado(agora: Date): Promise<number> {
  return varrerAutomacoes(conexaoDono() as unknown as Sql, agora)
}
export async function encerrarDonoAutomacao(): Promise<void> {
  if (dono) { await dono.end(); dono = undefined }
}
