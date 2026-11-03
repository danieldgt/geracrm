import type { Sql } from '../../db/index.js'

/**
 * Feed do contato (A3): linha do tempo unificada, mais novo primeiro.
 *
 * ⚠️ NUNCA conteúdo de mensagem do WhatsApp. Só fatos de gestão: observação interna, mudança de
 * etapa/qualificação, tarefa, pedido, handoff, etiqueta, arquivo. O texto do item é montado aqui,
 * a partir de colunas escolhidas uma a uma — não de `mensagem.conteudo` nem de `motivo_saida` do
 * agente (que carrega resumo da conversa).
 *
 * ⚠️ UNION ALL com LIMIT POR RAMO: cada ramo lê no máximo `limite + 1` linhas pelo índice do
 * contato (ou pelo índice `auditoria_por_entidade`, filtrando entidade/entidade_id e, havendo
 * cursor, `criado_em <= cursor` para podar partições futuras). Nada varre a auditoria inteira.
 *
 * Cursor = (em, id) com `em` em PRECISÃO DE MICROSSEGUNDOS (texto do banco, não Date do JS —
 * truncar a milissegundos repetiria ou pularia linhas com o mesmo instante). `id` é prefixado pelo
 * ramo (`comentario:<uuid>`), único no feed e comparável como texto (collation "C").
 */

export const TIPOS_FEED = [
  'comentario', 'funil', 'qualificacao', 'tarefa_criada', 'tarefa_concluida', 'pedido_criado',
  'pedido_efetivado', 'handoff', 'etiquetas', 'arquivo',
] as const
export type TipoFeed = (typeof TIPOS_FEED)[number]

export interface ItemFeed {
  readonly id: string
  readonly tipo: TipoFeed
  readonly em: string
  readonly autor: { id: string; nome: string } | null
  readonly texto: string
  readonly ref?: { tipo: string; id: string }
}

interface LinhaFeed {
  id: string; tipo: TipoFeed; em: Date; em_txt: string
  autor_id: string | null; autor_nome: string | null
  ref_tipo: string | null; ref_id: string | null
  a: string | null; b: string | null; c: string | null
}

const FORMATO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

export function lerCursorFeed(bruto: string | undefined): { em: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  const [em, id] = Buffer.from(bruto, 'base64url').toString('utf8').split('§')
  if (!em || !id || Number.isNaN(Date.parse(em)) || !/^[a-z_]+:[a-z0-9-]+$/i.test(id)) return 'invalido'
  return { em, id }
}
export const escreverCursorFeed = (em: string, id: string): string => Buffer.from(`${em}§${id}`).toString('base64url')

type Fragmento = ReturnType<Sql>

/** Monta o texto de exibição de uma linha (regra pura, testada pela rota). */
export function textoDoItem(l: Pick<LinhaFeed, 'tipo' | 'a' | 'b' | 'c'>): string {
  switch (l.tipo) {
    case 'comentario': return l.a ?? ''
    case 'funil':
      if (l.b === 'ganha') return 'Oportunidade ganha'
      if (l.b === 'perdida') return `Oportunidade perdida${l.c ? `: ${l.c}` : ''}`
      return `Oportunidade movida para a etapa ${l.a ?? '—'}`
    case 'qualificacao':
      return l.a === 'qualificado' ? 'Contato qualificado' : l.a === 'descartado' ? 'Contato descartado' : 'Contato voltou para novo'
    case 'tarefa_criada': return `Tarefa criada: ${l.a ?? ''}`
    case 'tarefa_concluida': return `Tarefa concluída: ${l.a ?? ''}${l.b ? `. Resultado: ${l.b}` : ''}`
    case 'pedido_criado': return `Pedido criado${l.a ? ` (${l.a})` : ''}`
    case 'pedido_efetivado': return `Pedido efetivado${l.a ? ` no ERP (nº ${l.a})` : ''}`
    case 'handoff':
      switch (l.a) {
        case 'atendimento.assumido': return 'Conversa assumida por um atendente'
        case 'atendimento.reatribuido': return `Conversa reatribuída${l.b ? ` para ${l.b}` : ''}`
        case 'conversa.devolvida_ao_agente': return l.b === 'agente' ? 'Conversa devolvida ao agente' : 'Conversa devolvida à fila'
        default: return 'O agente entregou a conversa a um atendente'
      }
    case 'etiquetas': return l.a ?? 'Etiquetas alteradas'
    case 'arquivo': return l.a === 'contato.arquivo_removido' ? `Arquivo removido: ${l.b ?? ''}` : `Arquivo anexado: ${l.b ?? ''}`
  }
}

export async function lerFeedDoContato(
  tx: Sql, contatoId: string, opcoes: { cursor: { em: string; id: string } | null; limite: number },
): Promise<{ itens: ItemFeed[]; proximoCursor: string | null }> {
  const { cursor, limite } = opcoes
  const n = limite + 1
  // Filtro de cursor por ramo: (em, id) < (cursor.em, cursor.id).
  const cur = (colEm: Fragmento, colId: Fragmento) =>
    cursor === null ? tx`true`
      : tx`(${colEm}, (${colId}) COLLATE "C") < (${cursor.em}::timestamptz, ${cursor.id}::text COLLATE "C")`
  const ate = (col: Fragmento) => cursor === null ? tx`true` : tx`${col} <= ${cursor.em}::timestamptz`

  const linhas = await tx<LinhaFeed[]>`
    SELECT feed.*, to_char(feed.em AT TIME ZONE 'UTC', ${FORMATO_UTC}) AS em_txt FROM (
      (SELECT 'comentario:' || c.id AS id, 'comentario' AS tipo, c.criado_em AS em, c.autor_id, u.nome AS autor_nome,
              NULL::text AS ref_tipo, NULL::text AS ref_id, c.texto AS a, NULL::text AS b, NULL::text AS c
         FROM comentario c LEFT JOIN usuario u ON u.tenant_id = c.tenant_id AND u.id = c.autor_id
        WHERE c.tenant_id = tenant_atual() AND c.contato_id = ${contatoId}
          AND ${cur(tx`c.criado_em`, tx`'comentario:' || c.id`)}
        ORDER BY c.criado_em DESC, c.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'funil:' || h.id, 'funil', h.entrou_em, h.ator_id, u.nome, 'oportunidade', o.id::text,
              e.nome, NULL, NULL
         FROM oportunidade o
         JOIN oportunidade_etapa_historico h ON h.tenant_id = o.tenant_id AND h.oportunidade_id = o.id
         LEFT JOIN funil_etapa e ON e.tenant_id = h.tenant_id AND e.id = h.etapa_id
         LEFT JOIN usuario u ON u.tenant_id = h.tenant_id AND u.id = h.ator_id
        WHERE o.tenant_id = tenant_atual() AND o.contato_id = ${contatoId}
          AND ${cur(tx`h.entrou_em`, tx`'funil:' || h.id`)}
        ORDER BY h.entrou_em DESC, h.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'funil:fecho-' || o.id, 'funil', o.fechada_em, NULL, NULL, 'oportunidade', o.id::text,
              NULL, o.estado, m.nome
         FROM oportunidade o
         LEFT JOIN motivo_perda m ON m.tenant_id = o.tenant_id AND m.codigo = o.motivo_perda_codigo
        WHERE o.tenant_id = tenant_atual() AND o.contato_id = ${contatoId}
          AND o.estado IN ('ganha', 'perdida') AND o.fechada_em IS NOT NULL
          AND ${cur(tx`o.fechada_em`, tx`'funil:fecho-' || o.id`)}
        ORDER BY o.fechada_em DESC, o.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'tarefa_criada:' || t.id, 'tarefa_criada', t.criado_em, t.criado_por, u.nome, 'tarefa', t.id::text,
              t.titulo, NULL, NULL
         FROM tarefa t LEFT JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.criado_por
        WHERE t.tenant_id = tenant_atual() AND t.contato_id = ${contatoId}
          AND ${cur(tx`t.criado_em`, tx`'tarefa_criada:' || t.id`)}
        ORDER BY t.criado_em DESC, t.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'tarefa_concluida:' || t.id, 'tarefa_concluida', t.concluida_em, t.concluida_por, u.nome, 'tarefa', t.id::text,
              t.titulo, t.resultado, NULL
         FROM tarefa t LEFT JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.concluida_por
        WHERE t.tenant_id = tenant_atual() AND t.contato_id = ${contatoId}
          AND t.estado = 'concluida' AND t.concluida_em IS NOT NULL
          AND ${cur(tx`t.concluida_em`, tx`'tarefa_concluida:' || t.id`)}
        ORDER BY t.concluida_em DESC, t.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'pedido_criado:' || p.id, 'pedido_criado', p.criado_em, p.vendedor_id, u.nome, 'pedido', p.id::text,
              p.nome, NULL, NULL
         FROM pedido p LEFT JOIN usuario u ON u.tenant_id = p.tenant_id AND u.id = p.vendedor_id
        WHERE p.tenant_id = tenant_atual() AND p.contato_id = ${contatoId}
          AND ${cur(tx`p.criado_em`, tx`'pedido_criado:' || p.id`)}
        ORDER BY p.criado_em DESC, p.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'pedido_efetivado:' || p.id, 'pedido_efetivado', p.efetivado_em, NULL, NULL, 'pedido', p.id::text,
              p.numero_externo, NULL, NULL
         FROM pedido p
        WHERE p.tenant_id = tenant_atual() AND p.contato_id = ${contatoId} AND p.efetivado_em IS NOT NULL
          AND ${cur(tx`p.efetivado_em`, tx`'pedido_efetivado:' || p.id`)}
        ORDER BY p.efetivado_em DESC, p.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'handoff:' || a.id, 'handoff', a.criado_em, a.ator_id, u.nome, 'conversa', a.entidade_id,
              a.acao, coalesce(pu.nome, a.dados->>'destino'), NULL
         FROM auditoria a
         LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
         LEFT JOIN usuario pu ON pu.tenant_id = a.tenant_id AND pu.id::text = a.dados->>'para'
        WHERE a.tenant_id = tenant_atual() AND a.entidade = 'conversa'
          AND a.entidade_id IN (SELECT cv.id::text FROM conversa cv WHERE cv.tenant_id = tenant_atual() AND cv.contato_id = ${contatoId})
          AND a.acao IN ('atendimento.assumido', 'atendimento.reatribuido', 'conversa.devolvida_ao_agente', 'agente.handoff')
          AND ${ate(tx`a.criado_em`)} AND ${cur(tx`a.criado_em`, tx`'handoff:' || a.id`)}
        ORDER BY a.criado_em DESC, a.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'handoff:sessao-' || s.id, 'handoff', s.encerrada_em, NULL, NULL, 'conversa', s.conversa_id::text,
              'agente.handoff', NULL, NULL
         FROM agente_sessao s
         JOIN conversa cv ON cv.tenant_id = s.tenant_id AND cv.id = s.conversa_id
        WHERE s.tenant_id = tenant_atual() AND cv.contato_id = ${contatoId}
          AND s.estado = 'entregue' AND s.encerrada_em IS NOT NULL
          AND ${cur(tx`s.encerrada_em`, tx`'handoff:sessao-' || s.id`)}
        ORDER BY s.encerrada_em DESC, s.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'qualificacao:' || a.id, 'qualificacao', a.criado_em, a.ator_id, u.nome, 'contato', a.entidade_id,
              COALESCE(a.dados->>'para', a.dados->>'estado'), NULL, NULL
         FROM auditoria a LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
        WHERE a.tenant_id = tenant_atual() AND a.entidade = 'contato' AND a.entidade_id = ${contatoId}
          -- qualificarContato (G5) audits as contato.qualificacao_alterada {de, para}; older rows used contato.qualificado {estado}
          AND a.acao IN ('contato.qualificacao_alterada', 'contato.qualificado')
          AND ${ate(tx`a.criado_em`)} AND ${cur(tx`a.criado_em`, tx`'qualificacao:' || a.id`)}
        ORDER BY a.criado_em DESC, a.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'etiquetas:' || a.id, 'etiquetas', a.criado_em, a.ator_id, u.nome, 'contato', a.entidade_id,
              a.dados->>'resumo', NULL, NULL
         FROM auditoria a LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
        WHERE a.tenant_id = tenant_atual() AND a.entidade = 'contato' AND a.entidade_id = ${contatoId}
          AND a.acao = 'contato.etiquetas_alteradas'
          AND ${ate(tx`a.criado_em`)} AND ${cur(tx`a.criado_em`, tx`'etiquetas:' || a.id`)}
        ORDER BY a.criado_em DESC, a.id DESC LIMIT ${n})
      UNION ALL
      (SELECT 'arquivo:' || a.id, 'arquivo', a.criado_em, a.ator_id, u.nome, 'contato', a.entidade_id,
              a.acao, a.dados->>'nome', NULL
         FROM auditoria a LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
        WHERE a.tenant_id = tenant_atual() AND a.entidade = 'contato' AND a.entidade_id = ${contatoId}
          AND a.acao IN ('contato.arquivo_enviado', 'contato.arquivo_removido')
          AND ${ate(tx`a.criado_em`)} AND ${cur(tx`a.criado_em`, tx`'arquivo:' || a.id`)}
        ORDER BY a.criado_em DESC, a.id DESC LIMIT ${n})
    ) feed
    ORDER BY em DESC, id COLLATE "C" DESC
    LIMIT ${n}`

  const temMais = linhas.length > limite
  const pagina = temMais ? linhas.slice(0, limite) : linhas
  const ultimo = pagina[pagina.length - 1]
  return {
    itens: pagina.map((l) => ({
      id: l.id,
      tipo: l.tipo,
      em: l.em.toISOString(),
      autor: l.autor_id && l.autor_nome ? { id: l.autor_id, nome: l.autor_nome } : null,
      texto: textoDoItem(l),
      ...(l.ref_tipo && l.ref_id ? { ref: { tipo: l.ref_tipo, id: l.ref_id } } : {}),
    })),
    proximoCursor: temMais && ultimo ? escreverCursorFeed(ultimo.em_txt, ultimo.id) : null,
  }
}
