import type { Sql } from '../../db/index.js'
import { auditar } from '../plataforma/auditoria.js'

/**
 * ANONIMIZAÇÃO LGPD DE CONTATOS (raia H2) — retenção e pedido do titular.
 *
 * QUANDO ANONIMIZA (regra do plano; a referência do AM só serviu para a regra):
 *
 *   (a) `retencao` — contato DESCARTADO (qualificado = false) há mais de
 *       `tenant.retencao_meses` SEM nenhuma interação desde o descarte (mensagem,
 *       pedido, tarefa aberta, oportunidade aberta) e SEM histórico de compra;
 *   (b) `opt_out`  — o próprio contato pediu para parar (consentimento
 *       `opt_out_mensagem`, ainda bloqueado) há mais de 15 dias;
 *   (c) `titular`  — pedido do titular pela rota: anonimiza já, sem prazo.
 *
 * ⚠️ CONTATO COM COMPRA (venda ou pedido efetivado) NUNCA é anonimizado pela retenção — é dado
 *    fiscal. No opt-out e no pedido do titular com `somenteCanais`, o contato com compra entra
 *    no modo `canais`: apaga só os CANAIS de contato (telefones, e-mail, identidades de
 *    WhatsApp/Instagram), o conteúdo das conversas e o que é texto livre; MANTÉM o vínculo
 *    fiscal mínimo (nome/razão social, documentos e endereços vindos do ERP, vendas e pedidos).
 *    Contato sem compra recebe o modo `completa`.
 *
 * O QUE FAZ (uma transação por contato, chamada sob tenant — RLS):
 *   - nome → "Contato anonimizado"; e-mail/razão/fantasia/observações → NULL (modo completa);
 *   - telefones, documentos manuais, endereço, nomes alternativos, identidades externas,
 *     memória do agente, etiquetas, comentários, pertencimento a listas → apagados;
 *   - conteúdo das mensagens das conversas → "[removido por LGPD]"; mídia anotada em
 *     `lgpd_midia_pendente` (o objeto do bucket é apagado FORA da transação);
 *   - a chave de bloqueio de cada telefone vai para `lista_bloqueio` com motivo 'lgpd' — nenhum
 *     envio, nenhuma reimportação do mesmo número (a mesma função de chave do opt-out);
 *   - mantém ids, contagens e agregados (RFV/MVs seguem coerentes); grava `anonimizado_em` e a
 *     auditoria `contato.anonimizado` SEM dado pessoal (ids, motivo, modo e contagens).
 *
 * ⚠️ Idempotente: contato já anonimizado → `jaAnonimizado`, nada é refeito nem re-auditado.
 * ⚠️ Nada de dado pessoal em log/auditoria: a auditoria leva só `{ motivo, modo, ... }`.
 */
export const TEXTO_REMOVIDO_LGPD = '[removido por LGPD]'
export const NOME_ANONIMIZADO = 'Contato anonimizado'
export const DIAS_OPT_OUT_PARA_ANONIMIZAR = 15

export type MotivoAnonimizacao = 'retencao' | 'opt_out' | 'titular'
export type ModoAnonimizacao = 'completa' | 'canais'

export type ResultadoAnonimizacao =
  | { readonly ok: true; readonly jaAnonimizado: boolean; readonly modo: ModoAnonimizacao }
  | { readonly ok: false; readonly erro: 'contato_nao_encontrado' | 'contato_com_compra' }

export interface OpcoesAnonimizacao {
  readonly motivo: MotivoAnonimizacao
  readonly agora: Date
  readonly atorId?: string | null | undefined
  /** Apaga só canais e conversas, mantendo o vínculo fiscal. Implícito para contato com compra no opt-out. */
  readonly somenteCanais?: boolean | undefined
}

/** Contato com venda ou pedido efetivado — dado fiscal. Sob tenant. */
export async function contatoTemCompra(tx: Sql, contatoId: string): Promise<boolean> {
  const [l] = await tx<{ tem: boolean }[]>`
    SELECT (c.qtd_vendas > 0 OR c.ultima_venda_em IS NOT NULL
            OR EXISTS (SELECT 1 FROM venda v WHERE v.tenant_id = c.tenant_id AND v.contato_id = c.id)
            OR EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id AND p.estado = 'efetivado')
           ) AS tem
      FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}`
  return l?.tem ?? false
}

export async function anonimizarContato(tx: Sql, contatoId: string, o: OpcoesAnonimizacao): Promise<ResultadoAnonimizacao> {
  const [c] = await tx<{ anonimizado_em: Date | null; anonimizacao_modo: ModoAnonimizacao | null }[]>`
    SELECT anonimizado_em, anonimizacao_modo FROM contato
     WHERE tenant_id = tenant_atual() AND id = ${contatoId} FOR UPDATE`
  if (!c) return { ok: false, erro: 'contato_nao_encontrado' }
  if (c.anonimizado_em) return { ok: true, jaAnonimizado: true, modo: c.anonimizacao_modo ?? 'completa' }

  const temCompra = await contatoTemCompra(tx, contatoId)
  // Dado fiscal: a retenção nunca chega aqui com compra; se chegar, recusa em vez de apagar.
  if (temCompra && o.motivo === 'retencao') return { ok: false, erro: 'contato_com_compra' }
  // Pedido do titular com compra: só com o consentimento explícito de manter o vínculo fiscal.
  if (temCompra && o.motivo === 'titular' && !o.somenteCanais) return { ok: false, erro: 'contato_com_compra' }
  const modo: ModoAnonimizacao = temCompra || o.somenteCanais ? 'canais' : 'completa'
  const completa = modo === 'completa'

  // 1. Bloqueio PRIMEIRO: com ele gravado, o gateway recusa qualquer envio e a reimportação do número.
  //    ⚠️ Sobe um opt_out/manual existente para 'lgpd' — este não sai pela tela de Bloqueios.
  await tx`
    INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem, bloqueado_em)
    SELECT DISTINCT tenant_atual(), ct.chave_bloqueio, 'lgpd', ${'lgpd:' + o.motivo}, ${o.agora}::timestamptz
      FROM contato_telefone ct
     WHERE ct.tenant_id = tenant_atual() AND ct.contato_id = ${contatoId} AND ct.chave_bloqueio IS NOT NULL
    ON CONFLICT (tenant_id, chave_bloqueio) DO UPDATE SET motivo = 'lgpd', origem = EXCLUDED.origem`
  await tx`
    INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
    SELECT tenant_atual(), ${contatoId}, t, false, 'solicitacao', ${o.agora}::timestamptz
      FROM unnest(ARRAY['campanhas', 'automacoes', 'whatsapp']) AS t
    ON CONFLICT DO NOTHING`

  // 2. Mídia: anota o que estava no conteúdo (o objeto sai do bucket fora da transação).
  const midias = await tx<{ referencia: string }[]>`
    INSERT INTO lgpd_midia_pendente (tenant_id, id, contato_id, referencia, criado_em)
    SELECT tenant_atual(), gen_random_uuid(), ${contatoId}, r.referencia, ${o.agora}::timestamptz
      FROM (SELECT DISTINCT kv.value AS referencia
              FROM mensagem m
              JOIN conversa cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversa_id
             CROSS JOIN LATERAL jsonb_each_text(m.conteudo) AS kv
             WHERE m.tenant_id = tenant_atual() AND cv.contato_id = ${contatoId}
               AND kv.key IN ('imagem', 'audio', 'video', 'documento', 'sticker', 'url', 'midia', 'arquivo')
               AND kv.value <> '') r
    ON CONFLICT (tenant_id, contato_id, referencia) DO NOTHING
    RETURNING referencia`

  // 3. Conteúdo das conversas (ids, tipo, direção, status e datas ficam: contagens e métricas seguem certas).
  const mensagens = await tx`
    UPDATE mensagem m
       SET conteudo = jsonb_build_object('texto', ${TEXTO_REMOVIDO_LGPD}::text, 'removido_lgpd', true)
                      || CASE m.tipo WHEN 'imagem' THEN '{"imagem": ""}'::jsonb
                                     WHEN 'audio'  THEN '{"audio": ""}'::jsonb ELSE '{}'::jsonb END
     WHERE m.tenant_id = tenant_atual()
       AND m.conversa_id IN (SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId})
       AND NOT (m.conteudo ? 'removido_lgpd')`
  await tx`UPDATE conversa SET arquivada = true
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND NOT arquivada`
  await limparAgenteENotificacao(tx, contatoId)

  // 4. Texto livre ligado ao contato.
  await tx`DELETE FROM comentario WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM cliente_memoria WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_etiqueta WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM lista_membro WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM conflito_identidade WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_campo_origem WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE nps_resposta SET comentario = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND comentario IS NOT NULL`
  await tx`UPDATE tarefa SET titulo = ${TEXTO_REMOVIDO_LGPD}, descricao = NULL,
                  estado = CASE WHEN estado = 'aberta' THEN 'cancelada' ELSE estado END
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE oportunidade SET titulo = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND titulo IS NOT NULL`
  await tx`UPDATE pedido SET observacao = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND observacao IS NOT NULL`
  await tx`UPDATE midia_lp_submissao SET nome = ${NOME_ANONIMIZADO}, telefone = '', email = NULL, mensagem = NULL
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE midia_lead_origem SET click_id = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND click_id IS NOT NULL`
  // Pessoas de contato ligadas SÓ a este contato (a pessoa compartilhada com outro contato fica).
  const minhas = await tx<{ pessoa_id: string }[]>`
    DELETE FROM pessoa_contato WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} RETURNING pessoa_id`
  if (minhas.length > 0) {
    await tx`
      DELETE FROM pessoa p
       WHERE p.tenant_id = tenant_atual() AND p.id IN ${tx(minhas.map((m) => m.pessoa_id))}
         AND NOT EXISTS (SELECT 1 FROM pessoa_contato pc WHERE pc.tenant_id = p.tenant_id AND pc.pessoa_id = p.id)`
  }

  // 5. Canais e identificadores. O que veio do ERP só sai no modo completa (vínculo fiscal).
  await tx`DELETE FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_nome WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_identidade_externa
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}
              AND (${completa} OR sistema NOT LIKE 'erp:%')`
  await tx`DELETE FROM contato_documento
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND (${completa} OR fonte NOT LIKE 'erp%')`
  await tx`DELETE FROM contato_endereco
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND (${completa} OR fonte NOT LIKE 'erp%')`

  // 6. O próprio contato. Agregados (qtd/total/datas de venda, ids) não são tocados.
  await tx`
    UPDATE contato
       SET nome = CASE WHEN ${completa} THEN ${NOME_ANONIMIZADO} ELSE nome END,
           razao_social = CASE WHEN ${completa} THEN NULL ELSE razao_social END,
           nome_fantasia = CASE WHEN ${completa} THEN NULL ELSE nome_fantasia END,
           email = NULL, observacoes = NULL, valor_estimado_centavos = NULL,
           recebe_campanhas = false, recebe_automacoes = false,
           ativo = CASE WHEN ${completa} THEN false ELSE ativo END,
           anonimizado_em = ${o.agora}::timestamptz, anonimizacao_modo = ${modo}
     WHERE tenant_id = tenant_atual() AND id = ${contatoId}`

  await auditar(tx, {
    atorId: o.atorId ?? null, acao: 'contato.anonimizado', entidade: 'contato', entidadeId: contatoId,
    dados: { motivo: o.motivo, modo, mensagens: mensagens.count, midias: midias.length },
  })
  return { ok: true, jaAnonimizado: false, modo }
}

/** Resumos/respostas do agente e títulos de notificação carregam trechos da conversa. */
async function limparAgenteENotificacao(tx: Sql, contatoId: string): Promise<void> {
  const conversas = tx`SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE agente_sessao SET resumo = NULL, extraido = '{}'::jsonb, slots = '{}'::jsonb
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_decisao SET resposta = NULL, ferramentas = '[]'::jsonb, erro = NULL
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_retorno SET texto = NULL, detalhe = NULL
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_avaliacao SET justificativas = NULL
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE notificacao SET titulo = ${TEXTO_REMOVIDO_LGPD}
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
}

export interface CandidatoAnonimizacao {
  readonly id: string
  readonly motivo: Exclude<MotivoAnonimizacao, 'titular'>
}

/**
 * Candidatos DESTE tenant (sob tenant), no máximo `limite`: primeiro a retenção (os mais antigos),
 * depois o opt-out. Só lê colunas baratas e índices; nunca varre a base inteira.
 */
export async function candidatosDeAnonimizacao(
  tx: Sql, p: { agora: Date; limite: number },
): Promise<CandidatoAnonimizacao[]> {
  const [t] = await tx<{ retencao_meses: number }[]>`SELECT retencao_meses FROM tenant WHERE id = tenant_atual()`
  const meses = t?.retencao_meses ?? 12
  const corte = new Date(p.agora)
  corte.setUTCMonth(corte.getUTCMonth() - meses)
  const corteOptOut = new Date(p.agora.getTime() - DIAS_OPT_OUT_PARA_ANONIMIZAR * 86_400_000)

  const retencao = await tx<{ id: string }[]>`
    SELECT c.id
      FROM contato c
     WHERE c.tenant_id = tenant_atual() AND c.anonimizado_em IS NULL
       AND c.qualificado = false AND c.qualificado_em <= ${corte}::timestamptz
       AND c.qtd_vendas = 0 AND c.ultima_venda_em IS NULL
       AND (c.ultimo_toque_em IS NULL OR c.ultimo_toque_em <= c.qualificado_em)
       AND NOT EXISTS (SELECT 1 FROM conversa cv WHERE cv.tenant_id = c.tenant_id AND cv.contato_id = c.id
                          AND cv.ultima_mensagem_em > c.qualificado_em)
       AND NOT EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id
                          AND (p.estado = 'efetivado' OR p.criado_em > c.qualificado_em OR p.atualizado_em > c.qualificado_em))
       AND NOT EXISTS (SELECT 1 FROM tarefa tf WHERE tf.tenant_id = c.tenant_id AND tf.contato_id = c.id
                          AND (tf.estado = 'aberta' OR tf.criado_em > c.qualificado_em))
       AND NOT EXISTS (SELECT 1 FROM oportunidade o WHERE o.tenant_id = c.tenant_id AND o.contato_id = c.id
                          AND (o.estado = 'aberta' OR o.criado_em > c.qualificado_em))
       AND NOT EXISTS (SELECT 1 FROM venda v WHERE v.tenant_id = c.tenant_id AND v.contato_id = c.id)
     ORDER BY c.qualificado_em, c.id
     LIMIT ${p.limite}`
  const achados: CandidatoAnonimizacao[] = retencao.map((r) => ({ id: r.id, motivo: 'retencao' }))
  if (achados.length >= p.limite) return achados

  // Opt-out pedido pelo contato: recusa de WhatsApp vinda de `opt_out_mensagem`, sem reversão
  // posterior, há mais de 15 dias — e ainda valendo (a lista de bloqueio é a fonte da verdade).
  const optOut = await tx<{ id: string }[]>`
    SELECT DISTINCT c.id
      FROM consentimento_contato cc
      JOIN contato c ON c.tenant_id = cc.tenant_id AND c.id = cc.contato_id
     WHERE cc.tenant_id = tenant_atual() AND cc.tipo = 'whatsapp'
       AND NOT cc.concedido AND cc.origem = 'opt_out_mensagem'
       AND cc.registrado_em <= ${corteOptOut}::timestamptz
       AND c.anonimizado_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM consentimento_contato cc2
                        WHERE cc2.tenant_id = cc.tenant_id AND cc2.contato_id = cc.contato_id
                          AND cc2.tipo = 'whatsapp' AND cc2.concedido AND cc2.registrado_em > cc.registrado_em)
       AND (   EXISTS (SELECT 1 FROM contato_telefone ct
                         JOIN lista_bloqueio lb ON lb.tenant_id = ct.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio
                        WHERE ct.tenant_id = c.tenant_id AND ct.contato_id = c.id)
            OR NOT EXISTS (SELECT 1 FROM contato_telefone ct
                            WHERE ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.chave_bloqueio IS NOT NULL))
     ORDER BY c.id
     LIMIT ${p.limite - achados.length}`
  for (const r of optOut) achados.push({ id: r.id, motivo: 'opt_out' })
  return achados
}

export interface RelatorioLgpd {
  readonly de: string
  readonly ate: string
  readonly total: number
  readonly porMotivo: Readonly<Record<MotivoAnonimizacao, number>>
  readonly porModo: Readonly<Record<ModoAnonimizacao, number>>
  readonly midiasPendentes: number
}

/**
 * Quantos contatos foram anonimizados no período, por motivo e modo — lido da AUDITORIA
 * (`contato.anonimizado`), que só carrega ids/motivo/modo. Nenhum dado pessoal. Sob tenant.
 */
export async function relatorioAnonimizacao(tx: Sql, p: { de: Date; ate: Date }): Promise<RelatorioLgpd> {
  const linhas = await tx<{ motivo: string; modo: string; n: number }[]>`
    SELECT dados->>'motivo' AS motivo, dados->>'modo' AS modo, count(*)::int AS n
      FROM auditoria
     WHERE tenant_id = tenant_atual() AND acao = 'contato.anonimizado'
       AND criado_em >= ${p.de}::timestamptz AND criado_em < ${p.ate}::timestamptz
     GROUP BY 1, 2`
  const porMotivo: Record<MotivoAnonimizacao, number> = { retencao: 0, opt_out: 0, titular: 0 }
  const porModo: Record<ModoAnonimizacao, number> = { completa: 0, canais: 0 }
  for (const l of linhas) {
    if (l.motivo in porMotivo) porMotivo[l.motivo as MotivoAnonimizacao] += l.n
    if (l.modo in porModo) porModo[l.modo as ModoAnonimizacao] += l.n
  }
  const [m] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM lgpd_midia_pendente WHERE tenant_id = tenant_atual() AND removido_em IS NULL`
  return {
    de: p.de.toISOString(), ate: p.ate.toISOString(),
    total: porModo.completa + porModo.canais, porMotivo, porModo, midiasPendentes: m?.n ?? 0,
  }
}
