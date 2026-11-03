import type { Sql } from '../../db/index.js'
import { auditar } from '../plataforma/auditoria.js'

/**
 * ANONIMIZAÇÃO LGPD DE CONTATOS (raia H2) — retenção, opt-out e pedido do titular.
 *
 * QUANDO ANONIMIZA:
 *
 *   (a) `retencao` — contato DESCARTADO (qualificado = false) há mais de `tenant.retencao_meses`,
 *       SEM compra (ver `semCompra`) e SEM NENHUM sinal de vida depois do descarte: mensagem
 *       (entrante ou saliente humana), pedido criado, tarefa criada/aberta/concluída, oportunidade
 *       criada/aberta/fechada, comentário, arquivo ou evento de agenda;
 *   (b) `opt_out`  — o contato pediu para parar (`opt_out_mensagem`) há mais de 15 dias, é o
 *       registro de WhatsApp mais recente (desbloquear pela tela grava `concedido=true` e tira daqui),
 *       TODOS os telefones com chave seguem bloqueados com motivo `opt_out` e não houve mensagem
 *       entrante nem pedido depois;
 *   (c) `titular`  — pedido do titular pela rota: anonimiza já, sem prazo.
 *
 *   (a) e (b) só rodam no tenant com `tenant.lgpd_auto` LIGADO (desligado por padrão; o admin liga
 *   depois da prévia — `previaAnonimizacao` — e de confirmação explícita).
 *
 * ⚠️ COMPRA = venda, pedido em `confirmado|validando|enviando|aguardando_conferencia|efetivado|falhou|
 *    aguardando_confirmacao` (ou com `confirmado_em`/`efetivado_em`/`numero_externo`, em qualquer momento),
 *    oportunidade `ganha` OU identidade de ERP (`erp:%`): venda importada antes do cliente fica sem
 *    contato (`semContato`) e não tem como ser religada — então todo cliente que veio do ERP é tratado
 *    como possível comprador. Com compra: a retenção NUNCA anonimiza; opt-out e titular (com
 *    `somenteCanais`) caem no modo `canais` — apaga os CANAIS (telefones, e-mail, identidades de
 *    WhatsApp/Instagram), o conteúdo das conversas e o texto livre, e MANTÉM o vínculo fiscal mínimo
 *    (nome/razão social, documentos e endereços do ERP, a identidade do ERP, vendas e pedidos).
 *    A identidade do ERP que fica é o que impede a ingestão de recriar o contato (`ingestao-clientes`
 *    pula contato com `anonimizado_em`). Sem compra: modo `completa`.
 *
 * O QUE FAZ (uma transação por contato, sob tenant — RLS):
 *   - opt-out/titular: as chaves dos telefones ganham `lista_bloqueio.lgpd_em` (motivo original
 *     preservado; linha nova nasce `lgpd`). A RETENÇÃO NÃO BLOQUEIA: ninguém pediu nada;
 *   - nome → "Contato anonimizado"; e-mail/razão/fantasia/observações → NULL (modo completa);
 *   - telefones, documentos manuais, endereço, nomes, identidades externas (exceto ERP), memória do
 *     agente, etiquetas, comentários, listas → apagados; arquivos do contato (modo completa) → apagados;
 *   - conteúdo das mensagens → "[removido por LGPD]"; transcrições (`midia`) apagadas; trechos que o
 *     agente guardou (resumo, slots, estado, guardrails, retornos, revisão, proposta) apagados;
 *   - as CHAVES dos objetos do bucket vão para `lgpd_midia_pendente` (o worker de mídia apaga fora da
 *     transação, com backoff);
 *   - encerra atendimento aberto, sessão do agente e retornos pendentes; evento `contato.atualizado`
 *     (só ids) no outbox;
 *   - mantém ids, contagens e agregados; grava `anonimizado_em` e a auditoria `contato.anonimizado`
 *     SEM dado pessoal (ids, motivo, modo, contagens; protocolo/data do pedido do titular).
 *
 * ⚠️ Idempotente: contato já anonimizado → `jaAnonimizado`, nada é refeito nem re-auditado.
 */
export const TEXTO_REMOVIDO_LGPD = '[removido por LGPD]'
export const NOME_ANONIMIZADO = 'Contato anonimizado'
export const DIAS_OPT_OUT_PARA_ANONIMIZAR = 15
/** A prévia conta até aqui; acima disso diz "mais de". */
export const LIMITE_PREVIA = 10_000
/** Estados de pedido que significam compra (dado fiscal). */
export const ESTADOS_PEDIDO_COMPRA = [
  'confirmado', 'validando', 'enviando', 'aguardando_conferencia', 'efetivado', 'falhou', 'aguardando_confirmacao',
] as const
/** Pedido ainda em andamento: protege o contato no opt-out (modo canais) — o rascunho é trabalho do vendedor. */
const ESTADOS_PEDIDO_PENDENTE = ['rascunho', 'aguardando_confirmacao', 'falhou'] as const

/** Chaves do `mensagem.conteudo` que guardam objeto do bucket (o `texto` e a `legenda` são do cliente). */
export const CHAVES_DE_MIDIA = ['imagem', 'audio', 'video', 'documento', 'sticker', 'arquivo', 'midia'] as const

export type MotivoAnonimizacao = 'retencao' | 'opt_out' | 'titular'
export type ModoAnonimizacao = 'completa' | 'canais'

export type ResultadoAnonimizacao =
  | { readonly ok: true; readonly jaAnonimizado: boolean; readonly modo: ModoAnonimizacao; readonly midiasPendentes: number }
  | { readonly ok: false; readonly erro: 'contato_nao_encontrado' | 'contato_com_compra' | 'nao_elegivel' }

export interface OpcoesAnonimizacao {
  readonly motivo: MotivoAnonimizacao
  readonly agora: Date
  readonly atorId?: string | null | undefined
  readonly atorStaff?: boolean | undefined
  /** Apaga só canais e conversas, mantendo o vínculo fiscal. Implícito para contato com compra no opt-out. */
  readonly somenteCanais?: boolean | undefined
  /**
   * Caminho do worker: depois de travar o contato, reexecuta o predicado do motivo (`retencao`/`opt_out`)
   * nesta transação; se o contato não casa mais (o cliente voltou a falar, comprou…) recusa com
   * `nao_elegivel` sem apagar nada. O lote foi lido antes — o fato pode ter mudado desde então.
   */
  readonly reavaliarSeletor?: boolean | undefined
  /** Pedido do titular: protocolo e data da solicitação (vão para a auditoria). */
  readonly protocolo?: string | null | undefined
  readonly solicitadoEm?: Date | null | undefined
}

/** Fragmento: o contato `c` NÃO tem compra (nem identidade de ERP). */
function semCompra(tx: Sql) {
  return tx`(c.qtd_vendas = 0 AND c.ultima_venda_em IS NULL
    AND NOT EXISTS (SELECT 1 FROM venda v WHERE v.tenant_id = c.tenant_id AND v.contato_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id
                       AND (p.estado = ANY(${ESTADOS_PEDIDO_COMPRA as unknown as string[]}::text[])
                            OR p.confirmado_em IS NOT NULL OR p.efetivado_em IS NOT NULL OR p.numero_externo IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM oportunidade o WHERE o.tenant_id = c.tenant_id AND o.contato_id = c.id AND o.estado = 'ganha')
    AND NOT EXISTS (SELECT 1 FROM contato_identidade_externa ie
                     WHERE ie.tenant_id = c.tenant_id AND ie.contato_id = c.id AND ie.sistema LIKE 'erp:%'))`
}

/** Fragmento: o contato `c` tem oportunidade aberta ou pedido pendente (rascunho/aguardando/falhou). */
function comPendencia(tx: Sql) {
  return tx`(EXISTS (SELECT 1 FROM oportunidade o WHERE o.tenant_id = c.tenant_id AND o.contato_id = c.id AND o.estado = 'aberta')
    OR EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id
                  AND p.estado = ANY(${ESTADOS_PEDIDO_PENDENTE as unknown as string[]}::text[])))`
}

/** Contato com compra (ou vindo do ERP) — dado fiscal. Sob tenant. */
export async function contatoTemCompra(tx: Sql, contatoId: string): Promise<boolean> {
  const [l] = await tx<{ tem: boolean }[]>`
    SELECT NOT ${semCompra(tx)} AS tem FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}`
  return l?.tem ?? false
}

async function contatoTemPendencia(tx: Sql, contatoId: string): Promise<boolean> {
  const [l] = await tx<{ tem: boolean }[]>`
    SELECT ${comPendencia(tx)} AS tem FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}`
  return l?.tem ?? false
}

export async function anonimizarContato(tx: Sql, contatoId: string, o: OpcoesAnonimizacao): Promise<ResultadoAnonimizacao> {
  const [c] = await tx<{ anonimizado_em: Date | null; anonimizacao_modo: ModoAnonimizacao | null }[]>`
    SELECT anonimizado_em, anonimizacao_modo FROM contato
     WHERE tenant_id = tenant_atual() AND id = ${contatoId} FOR UPDATE`
  if (!c) return { ok: false, erro: 'contato_nao_encontrado' }
  if (c.anonimizado_em) {
    return { ok: true, jaAnonimizado: true, modo: c.anonimizacao_modo ?? 'completa', midiasPendentes: await midiasPendentesDoContato(tx, contatoId) }
  }

  if (o.reavaliarSeletor && o.motivo !== 'titular') {
    const filtro = { agora: o.agora }
    const [ainda] = o.motivo === 'retencao'
      ? await tx`SELECT 1 ${deRetencao(tx, filtro)} AND c.id = ${contatoId} LIMIT 1`
      : await tx`SELECT 1 ${deOptOut(tx, filtro)} AND c.id = ${contatoId} LIMIT 1`
    if (!ainda) return { ok: false, erro: 'nao_elegivel' }
  }

  const temCompra = await contatoTemCompra(tx, contatoId)
  // Dado fiscal: a retenção nunca chega aqui com compra; se chegar, recusa em vez de apagar.
  if (temCompra && o.motivo === 'retencao') return { ok: false, erro: 'contato_com_compra' }
  // Pedido do titular com compra: só com o consentimento explícito de manter o vínculo fiscal.
  if (temCompra && o.motivo === 'titular' && !o.somenteCanais) return { ok: false, erro: 'contato_com_compra' }
  // Opt-out com oportunidade aberta ou pedido pendente: só os canais (o trabalho do vendedor não some).
  const pendente = o.motivo === 'opt_out' && await contatoTemPendencia(tx, contatoId)
  const modo: ModoAnonimizacao = temCompra || o.somenteCanais || pendente ? 'canais' : 'completa'
  const completa = modo === 'completa'
  const agora = o.agora

  // 1. Bloqueio PRIMEIRO (só quem PEDIU: opt-out e titular — a retenção não bloqueia ninguém).
  //    ⚠️ O motivo existente (denuncia, invalido, opt_out…) fica; o LGPD é registrado à parte.
  if (o.motivo !== 'retencao') {
    await tx`
      INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem, bloqueado_em, lgpd_em)
      SELECT DISTINCT tenant_atual(), ct.chave_bloqueio, 'lgpd', ${'lgpd:' + o.motivo}, ${agora}::timestamptz, ${agora}::timestamptz
        FROM contato_telefone ct
       WHERE ct.tenant_id = tenant_atual() AND ct.contato_id = ${contatoId} AND ct.chave_bloqueio IS NOT NULL
      ON CONFLICT (tenant_id, chave_bloqueio) DO UPDATE SET lgpd_em = coalesce(lista_bloqueio.lgpd_em, EXCLUDED.lgpd_em)`
    await tx`
      INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
      SELECT tenant_atual(), ${contatoId}, t, false, 'solicitacao', ${agora}::timestamptz
        FROM unnest(ARRAY['campanhas', 'automacoes', 'whatsapp']) AS t
      ON CONFLICT DO NOTHING`
  }

  // 2. Objetos do bucket: anota SÓ a chave nossa (`tenant/{T}/…`); o worker de mídia apaga fora daqui.
  const conversas = tx`SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  const doConteudo = await tx`
    INSERT INTO lgpd_midia_pendente (tenant_id, id, contato_id, chave_objeto, origem, criado_em, proxima_tentativa_em)
    SELECT tenant_atual(), gen_random_uuid(), ${contatoId}, r.chave, 'mensagem', ${agora}::timestamptz, ${agora}::timestamptz
      FROM (SELECT DISTINCT kv.value AS chave
              FROM mensagem m
             -- SÓ as chaves de mídia: o texto e a legenda do cliente nunca vira chave de objeto a apagar
             CROSS JOIN LATERAL (SELECT m.conteudo ->> k AS value FROM unnest(${CHAVES_DE_MIDIA as unknown as string[]}::text[]) AS k) AS kv
             WHERE m.tenant_id = tenant_atual() AND m.conversa_id IN (${conversas})
               AND kv.value LIKE 'tenant/' || tenant_atual()::text || '/%') r
    ON CONFLICT (tenant_id, chave_objeto) DO NOTHING`
  const daMidia = await tx`
    INSERT INTO lgpd_midia_pendente (tenant_id, id, contato_id, chave_objeto, origem, criado_em, proxima_tentativa_em)
    SELECT DISTINCT ON (md.chave_objeto) tenant_atual(), gen_random_uuid(), ${contatoId}, md.chave_objeto, 'midia',
           ${agora}::timestamptz, ${agora}::timestamptz
      FROM midia md
      JOIN mensagem m ON m.tenant_id = md.tenant_id AND m.id = md.mensagem_id AND m.criado_em = md.mensagem_criado_em
     WHERE md.tenant_id = tenant_atual() AND m.conversa_id IN (${conversas})
       AND md.chave_objeto LIKE 'tenant/' || tenant_atual()::text || '/%'
    ON CONFLICT (tenant_id, chave_objeto) DO NOTHING`
  // A transcrição de áudio é o conteúdo da conversa em texto: a linha sai junto.
  await tx`
    DELETE FROM midia md
     USING mensagem m
     WHERE md.tenant_id = tenant_atual() AND m.tenant_id = md.tenant_id AND m.id = md.mensagem_id
       AND m.criado_em = md.mensagem_criado_em AND m.conversa_id IN (${conversas})`
  let arquivos = 0
  if (completa) {
    const a = await tx`
      INSERT INTO lgpd_midia_pendente (tenant_id, id, contato_id, chave_objeto, origem, criado_em, proxima_tentativa_em)
      SELECT tenant_atual(), gen_random_uuid(), ${contatoId}, ca.chave_bucket, 'arquivo', ${agora}::timestamptz, ${agora}::timestamptz
        FROM contato_arquivo ca
       WHERE ca.tenant_id = tenant_atual() AND ca.contato_id = ${contatoId}
      ON CONFLICT (tenant_id, chave_objeto) DO NOTHING`
    arquivos = a.count
    await tx`DELETE FROM contato_arquivo WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  }

  // 3. Conteúdo das conversas (ids, tipo, direção, status e datas ficam: contagens e métricas seguem certas).
  const mensagens = await tx`
    UPDATE mensagem m
       SET conteudo = jsonb_build_object('texto', ${TEXTO_REMOVIDO_LGPD}::text, 'removido_lgpd', true)
                      || CASE m.tipo WHEN 'imagem' THEN '{"imagem": ""}'::jsonb
                                     WHEN 'audio'  THEN '{"audio": ""}'::jsonb ELSE '{}'::jsonb END
     WHERE m.tenant_id = tenant_atual() AND m.conversa_id IN (${conversas})
       AND NOT (m.conteudo ? 'removido_lgpd')`
  await tx`UPDATE conversa SET arquivada = true
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND NOT arquivada`
  await encerrarAtendimento(tx, contatoId, agora)
  await limparAgenteENotificacao(tx, contatoId, agora)

  // 4. Texto livre ligado ao contato.
  await tx`DELETE FROM comentario WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM cliente_memoria WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_etiqueta WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM lista_membro WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM conflito_identidade WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`DELETE FROM contato_campo_origem WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE nps_resposta SET comentario = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND comentario IS NOT NULL`
  await tx`UPDATE tarefa SET titulo = ${TEXTO_REMOVIDO_LGPD}, descricao = NULL, resultado = NULL,
                  estado = CASE WHEN estado = 'aberta' THEN 'cancelada' ELSE estado END
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE oportunidade SET titulo = NULL, perda_descricao = NULL
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND (titulo IS NOT NULL OR perda_descricao IS NOT NULL)`
  await tx`UPDATE evento_agenda SET titulo = ${TEXTO_REMOVIDO_LGPD}, descricao = NULL, local = NULL, link = NULL
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  // Pedido: observação sempre; nome do pedido e motivo de cancelamento só no modo completa (que, por
  // construção, nunca tem pedido de compra).
  await tx`UPDATE pedido SET observacao = NULL,
                  nome = CASE WHEN ${completa} THEN NULL ELSE nome END,
                  -- (o CHECK exige motivo em pedido cancelado: troca o texto, não anula)
                  cancelado_motivo = CASE WHEN ${completa} AND cancelado_motivo IS NOT NULL THEN ${TEXTO_REMOVIDO_LGPD} ELSE cancelado_motivo END
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE pedido_proposta SET resumo = ${TEXTO_REMOVIDO_LGPD}
            WHERE tenant_id = tenant_atual()
              AND pedido_id IN (SELECT id FROM pedido WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId})`
  await tx`UPDATE midia_lp_submissao SET nome = ${NOME_ANONIMIZADO}, telefone = '', email = NULL, mensagem = NULL
            WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE midia_lead_origem SET click_id = NULL WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND click_id IS NOT NULL`
  // Pessoas de contato ligadas SÓ a este contato (a pessoa compartilhada com outro contato fica).
  const minhas = await tx<{ pessoa_id: string }[]>`
    DELETE FROM pessoa_contato WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} RETURNING pessoa_id`
  if (minhas.length > 0) {
    await tx`
      DELETE FROM pessoa p
       WHERE p.tenant_id = tenant_atual() AND p.id = ANY(${minhas.map((m) => m.pessoa_id)}::uuid[])
         AND NOT EXISTS (SELECT 1 FROM pessoa_contato pc WHERE pc.tenant_id = p.tenant_id AND pc.pessoa_id = p.id)`
  }

  // 5. Canais e identificadores. O que veio do ERP só sai no modo completa (vínculo fiscal) — e o
  //    modo completa nunca tem identidade de ERP (ela conta como compra).
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
           anonimizado_em = ${agora}::timestamptz, anonimizacao_modo = ${modo}
     WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
  await tx`DELETE FROM lgpd_falha WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`

  // 7. Tempo real: só o id (a tela relê por API, sob RLS).
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'contato.atualizado', 'contato', ${contatoId}, ${JSON.stringify({ contatoId })}::text::jsonb)`

  const midias = doConteudo.count + daMidia.count + arquivos
  await auditar(tx, {
    atorId: o.atorId ?? null, atorStaff: o.atorStaff ?? false,
    acao: 'contato.anonimizado', entidade: 'contato', entidadeId: contatoId,
    dados: {
      motivo: o.motivo, modo, mensagens: mensagens.count, midias,
      ...(o.protocolo ? { protocolo: o.protocolo } : {}),
      ...(o.solicitadoEm ? { solicitadoEm: o.solicitadoEm.toISOString().slice(0, 10) } : {}),
    },
  })
  return { ok: true, jaAnonimizado: false, modo, midiasPendentes: await midiasPendentesDoContato(tx, contatoId) }
}

async function midiasPendentesDoContato(tx: Sql, contatoId: string): Promise<number> {
  const [m] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lgpd_midia_pendente
     WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId} AND removido_em IS NULL`
  return m?.n ?? 0
}

/** Atendimento aberto do contato é encerrado: ninguém deve seguir atendendo quem foi esquecido. */
async function encerrarAtendimento(tx: Sql, contatoId: string, agora: Date): Promise<void> {
  const encerrados = await tx<{ id: string }[]>`
    UPDATE atendimento a
       SET estado = 'encerrado', encerrado_em = coalesce(a.encerrado_em, ${agora}::timestamptz), versao = a.versao + 1,
           reatribuicao_vence_em = NULL, aviso_espera_previsto_em = NULL, reatribuicao_liberada_em = NULL
     WHERE a.tenant_id = tenant_atual() AND a.estado <> 'encerrado'
       AND a.conversa_id IN (SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId})
    RETURNING a.id`
  if (encerrados.length > 0) {
    await tx`UPDATE atendimento_etapa_historico SET saiu_em = ${agora}::timestamptz
              WHERE tenant_id = tenant_atual() AND saiu_em IS NULL
                AND atendimento_id = ANY(${encerrados.map((e) => e.id)}::uuid[])`
  }
}

/** Resumos/respostas do agente, retornos, revisão e títulos de notificação carregam trechos da conversa. */
async function limparAgenteENotificacao(tx: Sql, contatoId: string, agora: Date): Promise<void> {
  const conversas = tx`SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}`
  await tx`UPDATE agente_sessao
              SET resumo = NULL, extraido = '{}'::jsonb, slots = '{}'::jsonb, descartados = '[]'::jsonb,
                  estado_agente = '{}'::jsonb,
                  estado = CASE WHEN estado = 'ativa' THEN 'encerrada' ELSE estado END,
                  encerrada_em = coalesce(encerrada_em, ${agora}::timestamptz),
                  motivo_saida = 'lgpd'
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_decisao
              SET resposta = NULL, ferramentas = '[]'::jsonb, erro = NULL,
                  guardrails = coalesce((SELECT jsonb_agg(CASE WHEN jsonb_typeof(g) = 'object' THEN g - 'trecho' ELSE g END)
                                           FROM jsonb_array_elements(guardrails) AS g), '[]'::jsonb)
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_retorno
              SET texto = NULL, detalhe = NULL,
                  estado = CASE WHEN estado = 'pendente' THEN 'cancelado' ELSE estado END,
                  concluido_em = CASE WHEN estado = 'pendente' THEN ${agora}::timestamptz ELSE concluido_em END
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_avaliacao SET justificativas = NULL
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
  await tx`UPDATE agente_revisao SET observacao = NULL
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas}) AND observacao IS NOT NULL`
  await tx`UPDATE notificacao SET titulo = ${TEXTO_REMOVIDO_LGPD}
            WHERE tenant_id = tenant_atual() AND conversa_id IN (${conversas})`
}

export interface CandidatoAnonimizacao {
  readonly id: string
  readonly motivo: Exclude<MotivoAnonimizacao, 'titular'>
}

interface FiltroCandidatos {
  readonly agora: Date
  /** Ids já tentados nesta passada (falharam): não voltam no mesmo ciclo. */
  readonly excluir?: readonly string[] | undefined
}

/**
 * FROM/WHERE da retenção (alias `c`, `f` = falha anterior). Prazo calculado NO SQL a partir do
 * relógio injetado (`agora - make_interval(months => retencao_meses)`), sem aritmética de mês em JS.
 */
function deRetencao(tx: Sql, p: FiltroCandidatos) {
  const excluir = [...(p.excluir ?? [])]
  return tx`
      FROM contato c
      JOIN tenant t ON t.id = c.tenant_id
      LEFT JOIN lgpd_falha f ON f.tenant_id = c.tenant_id AND f.contato_id = c.id
     WHERE c.tenant_id = tenant_atual() AND c.anonimizado_em IS NULL
       AND c.qualificado = false AND c.qualificado_em IS NOT NULL
       AND c.qualificado_em <= ${p.agora}::timestamptz - make_interval(months => t.retencao_meses)
       AND NOT (c.id = ANY(${excluir}::uuid[]))
       AND ${semCompra(tx)}
       AND NOT EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = c.tenant_id AND m.criado_em > c.qualificado_em
                          AND m.conversa_id IN (SELECT cv.id FROM conversa cv WHERE cv.tenant_id = c.tenant_id AND cv.contato_id = c.id)
                          AND (m.direcao = 'entrante' OR m.enviada_por_id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id
                          AND p.criado_em > c.qualificado_em)
       AND NOT EXISTS (SELECT 1 FROM tarefa tf WHERE tf.tenant_id = c.tenant_id AND tf.contato_id = c.id
                          AND tf.criado_por IS NOT NULL  -- tarefa de automação (sem pessoa) não é sinal de vida
                          AND (tf.estado = 'aberta' OR tf.criado_em > c.qualificado_em OR tf.concluida_em > c.qualificado_em))
       AND NOT EXISTS (SELECT 1 FROM oportunidade o WHERE o.tenant_id = c.tenant_id AND o.contato_id = c.id
                          AND (o.estado = 'aberta' OR o.criado_em > c.qualificado_em OR o.fechada_em > c.qualificado_em))
       AND NOT EXISTS (SELECT 1 FROM comentario cm WHERE cm.tenant_id = c.tenant_id AND cm.contato_id = c.id
                          AND cm.criado_em > c.qualificado_em)
       AND NOT EXISTS (SELECT 1 FROM contato_arquivo ca WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id
                          AND ca.criado_em > c.qualificado_em)
       AND NOT EXISTS (SELECT 1 FROM evento_agenda ev WHERE ev.tenant_id = c.tenant_id AND ev.contato_id = c.id
                          AND ev.status <> 'cancelado'
                          AND (ev.criado_em > c.qualificado_em OR ev.inicio > c.qualificado_em))`
}

/** FROM/WHERE do opt-out (alias `c`, `cc` = o registro de recusa, `f` = falha anterior). */
function deOptOut(tx: Sql, p: FiltroCandidatos) {
  const excluir = [...(p.excluir ?? [])]
  const corte = new Date(p.agora.getTime() - DIAS_OPT_OUT_PARA_ANONIMIZAR * 86_400_000)
  return tx`
      FROM consentimento_contato cc
      JOIN contato c ON c.tenant_id = cc.tenant_id AND c.id = cc.contato_id
      LEFT JOIN lgpd_falha f ON f.tenant_id = c.tenant_id AND f.contato_id = c.id
     WHERE cc.tenant_id = tenant_atual() AND cc.tipo = 'whatsapp'
       AND NOT cc.concedido AND cc.origem = 'opt_out_mensagem'
       AND cc.registrado_em <= ${corte}::timestamptz
       AND c.anonimizado_em IS NULL
       AND NOT (c.id = ANY(${excluir}::uuid[]))
       -- é o registro de WhatsApp mais recente: desbloqueio (concedido=true) ou qualquer mudança depois tira daqui
       AND NOT EXISTS (SELECT 1 FROM consentimento_contato cc2
                        WHERE cc2.tenant_id = cc.tenant_id AND cc2.contato_id = cc.contato_id
                          AND cc2.tipo = 'whatsapp' AND cc2.registrado_em > cc.registrado_em)
       -- ao menos um telefone com chave (sem telefone, "todos bloqueados" seria vacuidade)
       AND EXISTS (SELECT 1 FROM contato_telefone ct0
                    WHERE ct0.tenant_id = c.tenant_id AND ct0.contato_id = c.id AND ct0.chave_bloqueio IS NOT NULL)
       -- TODOS os telefones com chave seguem bloqueados POR OPT-OUT (desbloqueado, inválido, denúncia: fora)
       AND NOT EXISTS (SELECT 1 FROM contato_telefone ct
                         LEFT JOIN lista_bloqueio lb ON lb.tenant_id = ct.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio
                        WHERE ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.chave_bloqueio IS NOT NULL
                          AND (lb.chave_bloqueio IS NULL OR lb.motivo NOT IN ('opt_out', 'lgpd')))
       -- nada de vida depois do opt-out: o cliente voltou a falar ou comprou
       AND NOT EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = c.tenant_id AND m.direcao = 'entrante' AND m.criado_em > cc.registrado_em
                          AND m.conversa_id IN (SELECT cv.id FROM conversa cv WHERE cv.tenant_id = c.tenant_id AND cv.contato_id = c.id))
       AND NOT EXISTS (SELECT 1 FROM pedido p WHERE p.tenant_id = c.tenant_id AND p.contato_id = c.id
                          AND p.criado_em > cc.registrado_em)`
}

/**
 * Candidatos DESTE tenant (sob tenant), no máximo `limite`: primeiro a retenção (os mais antigos),
 * depois o opt-out. Contato que já falhou (`lgpd_falha`) vai para o FIM; `excluir` tira os que
 * falharam nesta passada. Só lê colunas baratas e índices; nunca varre a base inteira numa tacada.
 */
export async function candidatosDeAnonimizacao(
  tx: Sql, p: FiltroCandidatos & { limite: number },
): Promise<CandidatoAnonimizacao[]> {
  const retencao = await tx<{ id: string }[]>`
    SELECT c.id ${deRetencao(tx, p)}
     ORDER BY (f.contato_id IS NOT NULL), f.ultima_em NULLS FIRST, c.qualificado_em, c.id
     LIMIT ${p.limite}`
  const achados: CandidatoAnonimizacao[] = retencao.map((r) => ({ id: r.id, motivo: 'retencao' }))
  if (achados.length >= p.limite) return achados

  const vistos = new Set(achados.map((a) => a.id))
  const optOut = await tx<{ id: string }[]>`
    SELECT c.id, bool_or(f.contato_id IS NOT NULL) AS falhou, min(f.ultima_em) AS falhou_em ${deOptOut(tx, p)}
     GROUP BY c.id
     ORDER BY 2, 3 NULLS FIRST, c.id
     LIMIT ${p.limite - achados.length}`
  for (const r of optOut) if (!vistos.has(r.id)) achados.push({ id: r.id, motivo: 'opt_out' })
  return achados
}

export interface PreviaLgpd {
  readonly porMotivo: Readonly<Record<Exclude<MotivoAnonimizacao, 'titular'>, number>>
  readonly total: number
  /** Alguma contagem bateu no teto (`LIMITE_PREVIA`): "mais de". */
  readonly limitado: boolean
}

/** MODO RELATÓRIO: quantos a automática anonimizaria AGORA, por motivo. Não altera nada. Sob tenant. */
export async function previaAnonimizacao(tx: Sql, p: { agora: Date }): Promise<PreviaLgpd> {
  const [r] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT c.id ${deRetencao(tx, p)} LIMIT ${LIMITE_PREVIA + 1}) s`
  const [o] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT DISTINCT c.id ${deOptOut(tx, p)} LIMIT ${LIMITE_PREVIA + 1}) s`
  const retencao = Math.min(r?.n ?? 0, LIMITE_PREVIA)
  const optOut = Math.min(o?.n ?? 0, LIMITE_PREVIA)
  return {
    porMotivo: { retencao, opt_out: optOut },
    total: retencao + optOut,
    limitado: (r?.n ?? 0) > LIMITE_PREVIA || (o?.n ?? 0) > LIMITE_PREVIA,
  }
}

/** Registra a falha de um contato (só o código). Sob tenant, em transação própria. */
export async function registrarFalhaAnonimizacao(tx: Sql, contatoId: string, codigo: string, agora: Date): Promise<void> {
  await tx`
    INSERT INTO lgpd_falha (tenant_id, contato_id, codigo, tentativas, ultima_em)
    SELECT tenant_atual(), id, ${codigo.slice(0, 80)}, 1, ${agora}::timestamptz
      FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}
    ON CONFLICT (tenant_id, contato_id) DO UPDATE
       SET codigo = EXCLUDED.codigo, tentativas = lgpd_falha.tentativas + 1, ultima_em = EXCLUDED.ultima_em`
}

export interface RelatorioLgpd {
  readonly de: string
  readonly ate: string
  readonly total: number
  readonly porMotivo: Readonly<Record<MotivoAnonimizacao, number>>
  readonly porModo: Readonly<Record<ModoAnonimizacao, number>>
  readonly midiasPendentes: number
  readonly midiasRemovidas: number
  readonly falhas: number
}

/**
 * Quantos contatos foram anonimizados no período, por motivo e modo — lido da AUDITORIA
 * (`contato.anonimizado`), que só carrega ids/motivo/modo. Mídia: pendentes (todas) e removidas no
 * período. Nenhum dado pessoal. Sob tenant.
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
  const [m] = await tx<{ pendentes: number; removidas: number }[]>`
    SELECT count(*) FILTER (WHERE removido_em IS NULL)::int AS pendentes,
           count(*) FILTER (WHERE removido_em >= ${p.de}::timestamptz AND removido_em < ${p.ate}::timestamptz)::int AS removidas
      FROM lgpd_midia_pendente WHERE tenant_id = tenant_atual()`
  const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM lgpd_falha WHERE tenant_id = tenant_atual()`
  return {
    de: p.de.toISOString(), ate: p.ate.toISOString(),
    total: porModo.completa + porModo.canais, porMotivo, porModo,
    midiasPendentes: m?.pendentes ?? 0, midiasRemovidas: m?.removidas ?? 0, falhas: f?.n ?? 0,
  }
}
