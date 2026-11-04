import {
  MAX_TENTATIVAS_POS_VENDA, RETENTATIVA_POS_VENDA_MS, classificarRfv, espalhamentoDoPosVenda, validarAcaoAgenteEnvia,
  validarGatilhoPedidoEfetivado,
} from '@geracrm/shared'
import postgres from 'postgres'
import type { Sql } from '../../db/index.js'
import { enviarTextoNaConversa } from '../atendimento/envio-conversa.js'
import { capturarSegmentos } from './segmento-historico.js'

/**
 * Motor de automações — VARREDURA AGENDADA, ações INTERNAS (decisão de produto,
 * docs/automacoes.md). Roda como DONO (worker), sem tenant de sessão: o
 * isolamento vem do `tenant_id` explícito em cada query (como o dispatcher de
 * webhooks e o integrador). ⚠️ Por isso lê `mv_metricas_contato` CRU — a view
 * `metricas_contato` filtra por tenant_atual() e é para o papel da API.
 *
 * Cada regra age no mesmo contato UMA vez (dedup em automacao_execucao).
 *
 * ⚠️ **`enviar_mensagem` mudou a política** (docs/automacoes.md §2): até a 0065 o
 * motor só organizava trabalho humano. O que mudou não foi o risco — foi a
 * existência dos guardrails. O envio sai pelo GATEWAY ÚNICO, nunca por um
 * caminho próprio, e ainda respeita `contato.recebe_automacoes`, que é um
 * opt-out DIFERENTE da lista de bloqueio: é o cliente dizendo "pode me mandar
 * campanha, mas não robô".
 */

const CAP_POR_REGRA = 200 // teto por regra por passada — não explode em rajada

interface Automacao {
  id: string; nome: string; gatilho: string; gatilho_param: Record<string, unknown>
  acao: string; acao_param: Record<string, unknown>; criado_em: Date
}

/**
 * Até quantos dias DEPOIS do dia previsto o pós-venda ainda é agendado. Cobre o
 * worker parado e a conversa ocupada por outro pós-venda pendente (o índice
 * `agente_retorno_um_pendente` deixa um por conversa: o próximo espera a vez).
 * Passado isso, a mensagem já não é "pós-venda" — fica sem enviar.
 */
export const JANELA_POS_VENDA_DIAS = 7

/**
 * PÓS-VENDA POR PEDIDO (G3): gatilho `pedido_efetivado` + ação `agente_envia`.
 *
 * Diferente das outras regras, age POR PEDIDO (o mesmo cliente compra de novo e
 * recebe de novo), e não executa nada aqui: AGENDA uma ativa na fila do agente
 * (`agente_retorno`, motivo `pos_venda`), que o worker de retornos envia com a
 * política das ativas (expediente, limites, opt-out, suspensão, janela/template,
 * aquecimento, teto diário do não-oficial) e só no modo efetivo autônomo.
 *
 * ⚠️ Idempotência por pedido + roteiro: índice único `agente_retorno_pos_venda_em_curso`
 *    (pendente/enviado, 0141) + `ON CONFLICT DO NOTHING` — nunca duas na fila, nunca
 *    reenviar o que saiu. Encerrada SEM envio (cancelada/recusada: impedimento
 *    passageiro) pode ser reagendada (M1), até `MAX_TENTATIVAS_POS_VENDA`, com
 *    `RETENTATIVA_POS_VENDA_MS` entre elas, dentro de `JANELA_POS_VENDA_DIAS`.
 *    Conflito com outro pós-venda PENDENTE na mesma conversa também não insere —
 *    o pedido continua candidato e entra na próxima passada.
 * ⚠️ Não é retroativo: só pedidos efetivados DEPOIS de a regra existir.
 * ⚠️ Não agenda com atendimento humano aberto (a pessoa conduz) nem para telefone
 *    na lista de bloqueio; tenta de novo na próxima passada, dentro da janela.
 * ⚠️ Conversa-alvo (M4): só WhatsApp (oficial/não-oficial), número ativo e não
 *    arquivado, conversa não arquivada — preferindo a do pedido, depois a de um
 *    número onde o agente é autônomo, depois a mais recente. Sem conversa assim, não
 *    agenda (não inventa conversa fria).
 * ⚠️ Horário espalhado por contato (M3): `executar_em = agora + [0, 2 h)`, determinístico.
 */
async function agendarPosVenda(sql: Sql, tid: string, a: Automacao, agora: Date): Promise<number> {
  const g = validarGatilhoPedidoEfetivado(a.gatilho_param)
  const ac = validarAcaoAgenteEnvia(a.acao_param)
  if (!g.ok || !ac.ok) return 0
  const dias = g.dados.diasDepois
  const { roteiro, texto, templateId } = ac.dados
  const retentarAntesDe = new Date(agora.getTime() - RETENTATIVA_POS_VENDA_MS)
  const candidatos = await sql<{ pedido_id: string; contato_id: string; nome: string; conversa_id: string; canal_id: string }[]>`
    SELECT p.id AS pedido_id, p.contato_id, c.nome, cv.id AS conversa_id, cv.canal_id
      FROM pedido p
      JOIN contato c ON c.tenant_id = p.tenant_id AND c.id = p.contato_id
      JOIN LATERAL (
        SELECT x.id, x.canal_id FROM conversa x
          JOIN canal_conectado cc ON cc.tenant_id = x.tenant_id AND cc.id = x.canal_id
          LEFT JOIN agente_config ag ON ag.tenant_id = x.tenant_id AND ag.canal_id = x.canal_id
         WHERE x.tenant_id = p.tenant_id AND (x.id = p.conversa_id OR x.contato_id = p.contato_id)
           AND NOT x.arquivada
           AND cc.tipo IN ('whatsapp_oficial', 'whatsapp_nao_oficial')
           AND cc.arquivado_em IS NULL AND cc.estado IN ('conectado', 'degradado')
         ORDER BY (x.id = p.conversa_id) DESC NULLS LAST, (ag.modo = 'autonomo') DESC NULLS LAST,
                  x.ultima_mensagem_em DESC NULLS LAST
         LIMIT 1) cv ON true
     WHERE p.tenant_id = ${tid} AND p.estado = 'efetivado' AND p.efetivado_em IS NOT NULL
       AND p.efetivado_em >= ${a.criado_em}
       AND p.efetivado_em <= ${agora}::timestamptz - (${dias} || ' days')::interval
       AND p.efetivado_em >= ${agora}::timestamptz - (${dias + JANELA_POS_VENDA_DIAS} || ' days')::interval
       AND c.ativo AND c.recebe_automacoes
       -- Em curso, já enviada, ou encerrada sem envio há pouco: espera.
       AND NOT EXISTS (SELECT 1 FROM agente_retorno r
                        WHERE r.tenant_id = p.tenant_id AND r.pedido_id = p.id AND r.roteiro = ${roteiro}
                          AND (r.estado IN ('pendente', 'enviado') OR r.concluido_em > ${retentarAntesDe}))
       AND (SELECT count(*) FROM agente_retorno r
             WHERE r.tenant_id = p.tenant_id AND r.pedido_id = p.id AND r.roteiro = ${roteiro}) < ${MAX_TENTATIVAS_POS_VENDA}
       AND NOT EXISTS (SELECT 1 FROM atendimento at
                        WHERE at.tenant_id = p.tenant_id AND at.conversa_id = cv.id AND at.estado <> 'encerrado')
       AND NOT EXISTS (SELECT 1 FROM contato_telefone ct
                         JOIN lista_bloqueio lb ON lb.tenant_id = ct.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio
                        WHERE ct.tenant_id = p.tenant_id AND ct.contato_id = p.contato_id)
     ORDER BY p.efetivado_em
     LIMIT ${CAP_POR_REGRA}`
  let agendados = 0
  for (const cand of candidatos) {
    // ⚠️ O texto é resolvido AQUI (nome do contato) e viaja pronto, como no `enviar_mensagem`.
    const pronto = texto ? aplicarMarcadores(texto, cand.nome) : null
    const executarEm = new Date(agora.getTime() + espalhamentoDoPosVenda(`${cand.contato_id}:${cand.pedido_id}:${roteiro}`))
    const feito = await sql.begin(async (tx) => {
      const [linha] = await tx<{ id: string }[]>`
        INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, texto, criado_em,
                                    pedido_id, roteiro, template_id, automacao_id)
        VALUES (${tid}, gen_random_uuid(), ${cand.conversa_id}, ${cand.canal_id}, 'pos_venda', ${executarEm}, 'pendente', 1, ${pronto}, ${agora},
                ${cand.pedido_id}, ${roteiro}, ${templateId}, ${a.id})
        ON CONFLICT DO NOTHING
        RETURNING id`
      if (!linha) return false
      await tx`INSERT INTO automacao_execucao (tenant_id, automacao_id, contato_id)
               VALUES (${tid}, ${a.id}, ${cand.contato_id})
               ON CONFLICT (tenant_id, automacao_id, contato_id) DO UPDATE SET executado_em = now()`
      return true
    })
    if (feito) agendados += 1
  }
  return agendados
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
/**
 * Envio decidido dentro da transação e executado DEPOIS dela.
 *
 * ⚠️ Duas razões, e as duas são duras: (1) mandar mensagem é rede, e segurar uma
 * transação aberta durante uma chamada HTTP é como se esgota o pool; (2) se o
 * processo cair entre o commit e o envio, a mensagem não sai — melhor do que a
 * ordem inversa, em que ela sairia DUAS vezes. Entre perder e duplicar, o
 * produto perde.
 */
interface EnvioPendente { readonly contatoId: string; readonly texto: string }

/**
 * `{nome}` é o único marcador — e some quando o contato não tem nome.
 *
 * ⚠️ Some LIMPO: sem o espaço órfão nem a vírgula pendurada que denunciam o
 * modelo ("Oi , tudo bem?"). O cliente não precisa saber que havia um campo ali.
 */
export function aplicarMarcadores(modelo: string, nome: string | null): string {
  return modelo
    .replace(/\{nome\}/g, (nome ?? '').trim())
    .replace(/\s+([,.!?;:])/g, '$1')   // espaço órfão antes de pontuação
    .replace(/([,;:])\s*([,.!?;:])/g, '$2') // pontuação dupla que sobrou
    .replace(/\s{2,}/g, ' ')
    .trim()
}

async function aplicarAcao(
  sql: Sql, tid: string, a: Automacao, contatoId: string,
): Promise<EnvioPendente | null> {
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
    return null
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
    return null
  }

  if (a.acao === 'adicionar_lista') {
    const listaId = String(p['listaId'] ?? '')
    await sql`
      INSERT INTO lista_membro (tenant_id, lista_id, contato_id)
      VALUES (${tid}, ${listaId}, ${contatoId})
      ON CONFLICT (tenant_id, lista_id, contato_id) DO NOTHING`
    return null
  }

  if (a.acao === 'enviar_mensagem') {
    const modelo = String(p['texto'] ?? '').trim()
    if (!modelo) return null
    const [c] = await sql<{ nome: string }[]>`
      SELECT nome FROM contato WHERE tenant_id = ${tid} AND id = ${contatoId}`
    // ⚠️ O texto é resolvido AQUI, dentro da transação, e viaja pronto: se a
    //    automação for editada entre a decisão e o envio, sai o que foi decidido.
    return { contatoId, texto: aplicarMarcadores(modelo, c?.nome ?? null) }
  }

  return null
}

/**
 * Manda a mensagem da automação — pelo GATEWAY, como todo mundo.
 *
 * ⚠️ **Sem conversa aberta, NÃO inventa uma.** Abrir conversa para falar primeiro
 * é mensagem fria: no oficial exige template aprovado, no não-oficial é o
 * caminho mais curto para o banimento (ADR-021). Nesse caso — e em qualquer
 * recusa do gateway — a automação DEGRADA PARA TAREFA: o humano faz o que o robô
 * não pôde, e o motivo fica escrito na tarefa. Silêncio seria pior: a regra
 * pareceria ter funcionado.
 */
async function enviarDaAutomacao(
  sql: Sql, tid: string, a: Automacao, envio: EnvioPendente,
): Promise<'enviada' | 'virou_tarefa'> {
  const [conv] = await sql<{ id: string }[]>`
    SELECT id FROM conversa
     WHERE tenant_id = ${tid} AND contato_id = ${envio.contatoId}
     ORDER BY ultima_mensagem_em DESC NULLS LAST LIMIT 1`

  let motivo = 'o cliente não tem conversa aberta'
  if (conv) {
    // ⚠️ Sem cabeçalho de atendente: a mensagem é da EMPRESA, não de uma pessoa.
    //    Assinar com o nome de alguém que não escreveu seria mentir na assinatura.
    // Marcador 'automacao': o inbox e as métricas da P13 não contam isto como resposta humana.
    const r = await enviarTextoNaConversa(tid, conv.id, envio.texto, null, new Date(), { marcador: 'automacao' })
    if (r.ok) return 'enviada'
    motivo = `o envio foi recusado (${r.motivo})`
  }

  await sql`
    INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, criado_por)
    VALUES (${tid}, gen_random_uuid(), ${envio.contatoId},
            (SELECT usuario_id FROM carteira_atribuicao
              WHERE tenant_id = ${tid} AND contato_id = ${envio.contatoId} AND ate IS NULL LIMIT 1),
            ${`Falar com o cliente (${a.nome})`},
            ${`A automação "${a.nome}" não pôde enviar porque ${motivo}.\n\nMensagem que sairia:\n${envio.texto}`},
            date_trunc('day', now()) + interval '9 hours', NULL)`
  return 'virou_tarefa'
}

/** Roda TODAS as automações ativas de UM tenant. Devolve quantas ações executou. */
export async function executarNoTenant(sql: Sql, tid: string, agora: Date): Promise<number> {
  const regras = await sql<Automacao[]>`
    SELECT id, nome, gatilho, gatilho_param, acao, acao_param, criado_em
      FROM automacao WHERE tenant_id = ${tid} AND ativa`
  let total = 0
  for (const a of regras) {
    // Pós-venda (G3): por PEDIDO, agendando a ativa do agente — caminho próprio.
    if (a.gatilho === 'pedido_efetivado') {
      if (a.acao !== 'agente_envia') continue
      const n = await agendarPosVenda(sql, tid, a, agora)
      total += n
      if (n > 0) await sql`UPDATE automacao SET ultima_execucao_em = now() WHERE tenant_id = ${tid} AND id = ${a.id}`
      continue
    }
    if (a.acao === 'agente_envia') continue
    let ids = await candidatos(sql, tid, a)

    // ⚠️ `recebe_automacoes` é um opt-out DIFERENTE da lista de bloqueio: é o
    //    cliente dizendo "pode me mandar campanha, mas não robô". Filtrado aqui,
    //    ANTES do dedup — quem não recebe hoje continua elegível se mudar de
    //    ideia amanhã; filtrar depois queimaria a regra para ele para sempre.
    if (a.acao === 'enviar_mensagem' && ids.length > 0) {
      const podem = await sql<{ id: string }[]>`
        SELECT id FROM contato
         WHERE tenant_id = ${tid} AND id = ANY(${ids}::uuid[]) AND recebe_automacoes`
      const permitidos = new Set(podem.map((c) => c.id))
      ids = ids.filter((id) => permitidos.has(id))
    }

    const pendentes: EnvioPendente[] = []
    for (const contatoId of ids) {
      // Ação + dedup na MESMA transação: ou faz e registra, ou nenhum dos dois.
      await sql.begin(async (tx) => {
        const envio = await aplicarAcao(tx as unknown as Sql, tid, a, contatoId)
        if (envio) pendentes.push(envio)
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

    // ⚠️ Envio FORA da transação: é rede, e o commit já garantiu o dedup.
    for (const envio of pendentes) await enviarDaAutomacao(sql, tid, a, envio)

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
/**
 * Passada agendada (server.ts), na conexão dono compartilhada: varre as
 * automações E captura a trajetória de segmento RFV (só transições). Sequencial —
 * a conexão dono é max:1.
 */
export async function varrerAgendado(agora: Date): Promise<number> {
  const sql = conexaoDono() as unknown as Sql
  const auto = await varrerAutomacoes(sql, agora)
  const seg = await capturarSegmentos(sql)
  return auto + seg
}
export async function encerrarDonoAutomacao(): Promise<void> {
  if (dono) { await dono.end(); dono = undefined }
}
