import { z } from 'zod'
import {
  EXCLUSOES_PADRAO, LIMITES_EXCLUSOES, ehCodigoSegmentoRfv, ehQualificacaoContato,
  type CodigoSegmentoRfv, type MotivoExclusao, type QualificacaoContato,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { condicaoContato, type Escopo } from '../plataforma/escopo.js'
import { FILTROS_VAZIOS, condicaoFiltros, contextoDosFiltros, diaReal } from './contatos-filtros.js'

/**
 * PÚBLICO DA CAMPANHA V2 (F1, #75): quem entra, quem fica de fora e por quê.
 *
 * ── A COMBINAÇÃO ──────────────────────────────────────────────────────────────
 *   **AND entre tipos, OR dentro do tipo.** `{ etiquetas: [A, B], origens: [X] }` =
 *   (tem A OU tem B) E veio de X. Tipo ausente/vazio não restringe; sem filtro
 *   nenhum = a base inteira. Segmento, qualificação, origem, etiqueta e período são
 *   os MESMOS filtros da lista de contatos (`contatos-filtros.ts`, A2), um valor de
 *   cada vez, unidos por OR — a régua é uma só nas duas telas.
 *     segmentos   código RFV (faixas de `faixasDoSegmento`, shared)
 *     listas      membro de alguma das listas
 *     etapas      o card ATUAL do contato (o aberto; sem aberto, o mais recente) está na etapa
 *     origens     contato.origem_id
 *     etiquetas   tem alguma das etiquetas
 *     qualificacao novo | qualificado | descartado
 *     semInteracaoDias  último toque/mensagem (ou o cadastro) há pelo menos N dias
 *     criadoDe/criadoAte  dia do cadastro, no fuso do tenant
 *
 * ── AS EXCLUSÕES (o primeiro motivo que casa vence; ordem de MOTIVOS_EXCLUSAO) ──
 *   foraDoEscopo   o contato não está no escopo de quem prevê/inicia (D3)
 *   anonimizado    LGPD (contato.anonimizado_em, H2) ou contato inativo — antes do opt-out:
 *                  o titular esquecido também está na lista de bloqueio
 *   optout         recebe_campanhas = false, ou QUALQUER telefone na lista_bloqueio
 *   semTelefone    sem telefone principal, ou marcado como "não é WhatsApp"
 *   conversaRecente  conversa com mensagem nos últimos N dias (padrão 7)
 *   campanhaRecente  recebeu outra campanha nos últimos N dias (padrão 30; v2 e legado)
 *   compraRecente    comprou nos últimos N dias (padrão 7)
 *   telefoneDuplicado  mesma chave de telefone (com/sem nono dígito) de outro contato
 *                      elegível: só o primeiro recebe
 *   As três janelas "recente" são configuráveis em `publico.exclusoes` (0 desliga).
 *   Opt-out, inativo e sem telefone NÃO são configuráveis: são proteção, não critério.
 *
 * ⚠️ O contato de simulação do playground nunca é público (mesma regra das listas).
 * ⚠️ Tudo é SQL: nada lê a base para filtrar em memória (60 mil contatos não cabem).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = z.string().regex(UUID)
const ids = z.array(uuid).max(50)

const esquemaPublico = z.object({
  segmentos: z.array(z.string().refine(ehCodigoSegmentoRfv)).max(20).optional(),
  listas: ids.optional(),
  etapas: ids.optional(),
  origens: ids.optional(),
  etiquetas: ids.optional(),
  qualificacao: z.array(z.string().refine(ehQualificacaoContato)).max(3).optional(),
  // nullish: o público gravado (normalizado) guarda null nos tipos não usados.
  semInteracaoDias: z.number().int().min(1).max(3650).nullish(),
  criadoDe: z.string().refine(diaReal).nullish(),
  criadoAte: z.string().refine(diaReal).nullish(),
  exclusoes: z.object({
    conversaRecenteDias: z.number().int().min(0).max(LIMITES_EXCLUSOES.conversaRecenteDias).optional(),
    campanhaRecenteDias: z.number().int().min(0).max(LIMITES_EXCLUSOES.campanhaRecenteDias).optional(),
    compraRecenteDias: z.number().int().min(0).max(LIMITES_EXCLUSOES.compraRecenteDias).optional(),
  }).strict().optional(),
}).strict()

/** Público validado e com os padrões aplicados — é o que vai para `campanha.publico`. */
export interface Publico {
  readonly segmentos: readonly CodigoSegmentoRfv[]
  readonly listas: readonly string[]
  readonly etapas: readonly string[]
  readonly origens: readonly string[]
  readonly etiquetas: readonly string[]
  readonly qualificacao: readonly QualificacaoContato[]
  readonly semInteracaoDias: number | null
  readonly criadoDe: string | null
  readonly criadoAte: string | null
  readonly exclusoes: { conversaRecenteDias: number; campanhaRecenteDias: number; compraRecenteDias: number }
}

const unicos = <T extends string>(v: readonly T[] | undefined): T[] => [...new Set((v ?? []).map((x) => x.toLowerCase() as T))]

/** Valida o público. Inválido → os campos (`publico.<campo>`) para o 422 apontar o campo. */
export function lerPublico(bruto: unknown): { ok: true; publico: Publico } | { ok: false; campos: string[] } {
  const p = esquemaPublico.safeParse(bruto ?? {})
  if (!p.success) {
    return { ok: false, campos: [...new Set(p.error.issues.map((i) => ['publico', ...i.path.map(String)].slice(0, 3).join('.')))] }
  }
  const d = p.data
  if (d.criadoDe && d.criadoAte && d.criadoDe > d.criadoAte) return { ok: false, campos: ['publico.criadoDe', 'publico.criadoAte'] }
  return {
    ok: true,
    publico: {
      segmentos: [...new Set(d.segmentos as CodigoSegmentoRfv[] | undefined ?? [])],
      listas: unicos(d.listas), etapas: unicos(d.etapas), origens: unicos(d.origens), etiquetas: unicos(d.etiquetas),
      qualificacao: [...new Set(d.qualificacao as QualificacaoContato[] | undefined ?? [])],
      semInteracaoDias: d.semInteracaoDias ?? null,
      criadoDe: d.criadoDe ?? null,
      criadoAte: d.criadoAte ?? null,
      exclusoes: {
        conversaRecenteDias: d.exclusoes?.conversaRecenteDias ?? EXCLUSOES_PADRAO.conversaRecenteDias,
        campanhaRecenteDias: d.exclusoes?.campanhaRecenteDias ?? EXCLUSOES_PADRAO.campanhaRecenteDias,
        compraRecenteDias: d.exclusoes?.compraRecenteDias ?? EXCLUSOES_PADRAO.compraRecenteDias,
      },
    },
  }
}

/** O público como guardado em `campanha.publico` (já validado na gravação). */
export function publicoGravado(bruto: unknown): Publico {
  const r = lerPublico(bruto)
  // ⚠️ Gravado é sempre válido (passou por lerPublico). Se um dia não for, o público
  //    vazio NÃO serve de recuo: seria a base inteira. Falhar é o caminho seguro.
  if (!r.ok) throw new Error(`campanha.publico inválido no banco: ${r.campos.join(', ')}`)
  return r.publico
}

type Fragmento = ReturnType<typeof condicaoFiltros>

const ou = (tx: Sql, partes: Fragmento[]): Fragmento =>
  partes.reduce((acc, p, i) => (i === 0 ? tx`(${p})` : tx`${acc} OR (${p})`), tx`true`)

interface Contexto { readonly fuso: string; readonly agenda: boolean }

/** Condição do público (AND entre tipos, OR dentro) sobre os aliases `c` e `m`. */
function condicaoPublico(tx: Sql, p: Publico, ctx: Contexto, agora: Date): Fragmento {
  const viaFiltro = (f: Partial<typeof FILTROS_VAZIOS>) => condicaoFiltros(tx, { ...FILTROS_VAZIOS, ...f }, ctx)
  const tipos: Fragmento[] = []
  if (p.segmentos.length) tipos.push(ou(tx, p.segmentos.map((s) => viaFiltro({ segmento: s }))))
  if (p.qualificacao.length) tipos.push(ou(tx, p.qualificacao.map((q) => viaFiltro({ qualificacao: q }))))
  if (p.origens.length) tipos.push(ou(tx, p.origens.map((o) => viaFiltro({ origemId: o }))))
  if (p.etiquetas.length) tipos.push(ou(tx, p.etiquetas.map((e) => viaFiltro({ etiquetaIds: [e] }))))
  if (p.criadoDe || p.criadoAte) tipos.push(viaFiltro({ criadoDe: p.criadoDe, criadoAte: p.criadoAte }))
  if (p.listas.length) {
    tipos.push(tx`EXISTS (SELECT 1 FROM lista_membro pl WHERE pl.tenant_id = c.tenant_id AND pl.contato_id = c.id
                            AND pl.lista_id = ANY(${[...p.listas]}::uuid[]))`)
  }
  if (p.etapas.length) {
    tipos.push(tx`EXISTS (SELECT 1 FROM (SELECT po.etapa_id FROM oportunidade po
                                          WHERE po.tenant_id = c.tenant_id AND po.contato_id = c.id
                                          ORDER BY (po.estado = 'aberta') DESC, po.criado_em DESC LIMIT 1) atual
                           WHERE atual.etapa_id = ANY(${[...p.etapas]}::uuid[]))`)
  }
  if (p.semInteracaoDias !== null) {
    tipos.push(tx`coalesce(greatest(c.ultimo_toque_em,
                                    (SELECT max(pcv.ultima_mensagem_em) FROM conversa pcv
                                      WHERE pcv.tenant_id = c.tenant_id AND pcv.contato_id = c.id)),
                           c.criado_em) < ${agora}::timestamptz - make_interval(days => ${p.semInteracaoDias})`)
  }
  return tipos.reduce((acc, t) => tx`${acc} AND ${t}`, tx`true`)
}

/**
 * O motivo de exclusão (ou NULL = elegível), sem o `telefoneDuplicado` (que depende
 * dos vizinhos e sai de uma janela). Precisa de `c`, `m` e `tp` (telefone principal).
 */
function motivoBase(tx: Sql, p: Publico, escopo: Escopo, agora: Date, campanhaId: string | null): Fragmento {
  const x = p.exclusoes
  const desde = (dias: number) => tx`${agora}::timestamptz - make_interval(days => ${dias})`
  const outraCampanha = campanhaId === null ? tx`true` : tx`rd.campanha_id <> ${campanhaId}::uuid`
  return tx`CASE
      WHEN NOT (${condicaoContato(tx, escopo, 'c')}) THEN 'foraDoEscopo'
      WHEN c.anonimizado_em IS NOT NULL OR NOT c.ativo THEN 'anonimizado'
      WHEN NOT c.recebe_campanhas OR EXISTS (
             SELECT 1 FROM contato_telefone ot
               JOIN lista_bloqueio lb ON lb.tenant_id = ot.tenant_id AND lb.chave_bloqueio = ot.chave_bloqueio
              WHERE ot.tenant_id = c.tenant_id AND ot.contato_id = c.id) THEN 'optout'
      WHEN tp.e164 IS NULL THEN 'semTelefone'
      ${x.conversaRecenteDias > 0 ? tx`
      WHEN EXISTS (SELECT 1 FROM conversa rcv WHERE rcv.tenant_id = c.tenant_id AND rcv.contato_id = c.id
                      AND rcv.ultima_mensagem_em >= ${desde(x.conversaRecenteDias)}) THEN 'conversaRecente'` : tx``}
      ${x.campanhaRecenteDias > 0 ? tx`
      WHEN EXISTS (SELECT 1 FROM campanha_destinatario rd WHERE rd.tenant_id = c.tenant_id AND rd.contato_id = c.id
                      AND rd.enviado_em >= ${desde(x.campanhaRecenteDias)} AND ${outraCampanha})
        OR EXISTS (SELECT 1 FROM campanha_envio re WHERE re.tenant_id = c.tenant_id AND re.contato_id = c.id
                      AND re.estado = 'enviado' AND re.enviado_em >= ${desde(x.campanhaRecenteDias)}) THEN 'campanhaRecente'` : tx``}
      ${x.compraRecenteDias > 0 ? tx`
      WHEN greatest(c.ultima_venda_em, m.ultima_venda_em) >= ${desde(x.compraRecenteDias)} THEN 'compraRecente'` : tx``}
      ELSE NULL END`
}

/** FROM comum: contato + métricas + telefone principal, já com o público aplicado. */
function baseDoPublico(tx: Sql, p: Publico, escopo: Escopo, ctx: Contexto, agora: Date, campanhaId: string | null, extra: Fragmento) {
  return tx`
    SELECT c.id, c.nome, tp.chave, ${motivoBase(tx, p, escopo, agora, campanhaId)} AS motivo
      FROM contato c
      LEFT JOIN metricas_contato m ON m.tenant_id = c.tenant_id AND m.contato_id = c.id
      LEFT JOIN LATERAL (SELECT ct.e164, ct.chave_bloqueio AS chave FROM contato_telefone ct
                          WHERE ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.principal
                            AND ct.whatsapp IS DISTINCT FROM false
                          LIMIT 1) tp ON true
     WHERE c.tenant_id = tenant_atual()
       AND coalesce(c.origem_carga, '') <> 'simulacao'
       AND ${condicaoPublico(tx, p, ctx, agora)}
       AND ${extra}`
}

async function contexto(tx: Sql, p: Publico): Promise<Contexto> {
  return contextoDosFiltros(tx, { ...FILTROS_VAZIOS, criadoDe: p.criadoDe, criadoAte: p.criadoAte })
}

export interface Previa {
  /** Todos os contatos que casam com o público (antes das exclusões). */
  readonly total: number
  readonly elegiveis: number
  readonly excluidos: Readonly<Record<MotivoExclusao, number>>
  /** Até 10 elegíveis: só nome e cidade (nada de telefone, documento ou valor). */
  readonly amostra: readonly { nome: string; cidade: string | null }[]
}

const EXCLUIDOS_ZERADOS: Record<MotivoExclusao, number> = {
  foraDoEscopo: 0, optout: 0, anonimizado: 0, semTelefone: 0,
  conversaRecente: 0, campanhaRecente: 0, compraRecente: 0, telefoneDuplicado: 0,
}

/** A prévia: contagem por motivo + amostra, numa consulta só. Sob tenant (RLS). */
export async function previaDoPublico(tx: Sql, p: Publico, escopo: Escopo, agora: Date): Promise<Previa> {
  const ctx = await contexto(tx, p)
  const [r] = await tx<{ por: Record<string, number> | null; amostra: { nome: string; cidade: string | null }[] | null }[]>`
    WITH base AS (${baseDoPublico(tx, p, escopo, ctx, agora, null, tx`true`)}),
    marcada AS (
      SELECT id, nome,
             CASE WHEN motivo IS NULL
                   AND row_number() OVER (PARTITION BY chave, (motivo IS NULL) ORDER BY id) > 1
                  THEN 'telefoneDuplicado' ELSE motivo END AS motivo
        FROM base),
    por AS (SELECT coalesce(motivo, 'elegivel') AS motivo, count(*)::int AS n FROM marcada GROUP BY 1)
    SELECT (SELECT json_object_agg(motivo, n) FROM por) AS por,
           (SELECT json_agg(json_build_object('nome', a.nome, 'cidade', a.cidade))
              FROM (SELECT mk.nome, ce.cidade FROM marcada mk
                      LEFT JOIN contato_endereco ce ON ce.tenant_id = tenant_atual() AND ce.contato_id = mk.id AND ce.principal
                     WHERE mk.motivo IS NULL ORDER BY mk.id LIMIT 10) a) AS amostra`
  const por = r?.por ?? {}
  const excluidos = { ...EXCLUIDOS_ZERADOS }
  for (const k of Object.keys(excluidos) as MotivoExclusao[]) excluidos[k] = Number(por[k] ?? 0)
  const elegiveis = Number(por['elegivel'] ?? 0)
  const total = elegiveis + Object.values(excluidos).reduce((a, b) => a + b, 0)
  return { total, elegiveis, excluidos, amostra: r?.amostra ?? [] }
}

/** Contatos por passada da materialização. Cada passada é UMA instrução. */
export const LOTE_MATERIALIZACAO = 2000

/**
 * Materializa UMA fatia do público em `campanha_destinatario`, a partir do contato
 * `depoisDe` (keyset por id). Elegível → `pendente`; excluído → `excluida` com o motivo.
 * Quem está fora do escopo NÃO entra (não é do universo de quem iniciou).
 *
 * ⚠️ Idempotente: `ON CONFLICT (tenant, campanha, contato) DO NOTHING` — repetir a mesma
 *    fatia, ou o iniciar inteiro depois de uma queda no meio, não duplica ninguém.
 * ⚠️ Telefone duplicado entre fatias: o segundo contato com a mesma chave de um
 *    pendente já gravado vira `excluida/telefoneDuplicado`.
 */
export async function materializarFatia(
  tx: Sql, p: { campanhaId: string; publico: Publico; escopo: Escopo; agora: Date; depoisDe: string | null; limite?: number },
): Promise<{ lidos: number; inseridos: number; ultimo: string | null }> {
  const ctx = await contexto(tx, p.publico)
  const limite = p.limite ?? LOTE_MATERIALIZACAO
  const aPartir = p.depoisDe === null ? tx`true` : tx`c.id > ${p.depoisDe}::uuid`
  const [r] = await tx<{ lidos: number; inseridos: number; ultimo: string | null }[]>`
    WITH fatia AS (
      ${baseDoPublico(tx, p.publico, p.escopo, ctx, p.agora, p.campanhaId, aPartir)}
      ORDER BY c.id LIMIT ${limite}),
    marcada AS (
      SELECT f.id, f.chave,
             CASE WHEN f.motivo IS NULL AND (
                    row_number() OVER (PARTITION BY f.chave, (f.motivo IS NULL) ORDER BY f.id) > 1
                    OR EXISTS (SELECT 1 FROM campanha_destinatario dd
                                WHERE dd.tenant_id = tenant_atual() AND dd.campanha_id = ${p.campanhaId}::uuid
                                  AND dd.telefone_chave = f.chave AND dd.estado <> 'excluida' AND dd.contato_id <> f.id))
                  THEN 'telefoneDuplicado' ELSE f.motivo END AS motivo
        FROM fatia f),
    ins AS (
      INSERT INTO campanha_destinatario (tenant_id, id, campanha_id, contato_id, telefone_chave, estado, motivo_exclusao, criado_em, atualizado_em)
      SELECT tenant_atual(), gen_random_uuid(), ${p.campanhaId}::uuid, mk.id, mk.chave,
             CASE WHEN mk.motivo IS NULL THEN 'pendente' ELSE 'excluida' END, mk.motivo, ${p.agora}, ${p.agora}
        FROM marcada mk
       WHERE mk.motivo IS DISTINCT FROM 'foraDoEscopo'
      ON CONFLICT (tenant_id, campanha_id, contato_id) DO NOTHING
      RETURNING 1)
    SELECT (SELECT count(*) FROM fatia)::int AS lidos,
           (SELECT count(*) FROM ins)::int AS inseridos,
           (SELECT f.id::text FROM fatia f ORDER BY f.id DESC LIMIT 1) AS ultimo`
  return { lidos: r?.lidos ?? 0, inseridos: r?.inseridos ?? 0, ultimo: r?.ultimo ?? null }
}

/**
 * Exclusões REAVALIADAS NO ENVIO (o snapshot é do iniciar; a campanha pode levar dias):
 * contato anonimizado/inativo, conversa recente, outra campanha que o alcançou (enviada
 * na janela ou SAINDO agora) e compra recente — com as janelas do público da campanha.
 * Opt-out e telefone ficam com o gateway no próprio envio. `null` = segue.
 */
export async function motivoNoEnvio(
  tx: Sql, p: { campanhaId: string; contatoId: string; publico: Publico; agora: Date },
): Promise<MotivoExclusao | null> {
  const x = p.publico.exclusoes
  const desde = (dias: number) => tx`${p.agora}::timestamptz - make_interval(days => ${dias})`
  const [r] = await tx<{ motivo: MotivoExclusao | null }[]>`
    SELECT CASE
        WHEN c.anonimizado_em IS NOT NULL OR NOT c.ativo THEN 'anonimizado'
        ${x.conversaRecenteDias > 0 ? tx`
        WHEN EXISTS (SELECT 1 FROM conversa rcv WHERE rcv.tenant_id = c.tenant_id AND rcv.contato_id = c.id
                        AND rcv.ultima_mensagem_em >= ${desde(x.conversaRecenteDias)}) THEN 'conversaRecente'` : tx``}
        ${x.campanhaRecenteDias > 0 ? tx`
        WHEN EXISTS (SELECT 1 FROM campanha_destinatario rd WHERE rd.tenant_id = c.tenant_id AND rd.contato_id = c.id
                        AND rd.campanha_id <> ${p.campanhaId}::uuid
                        AND (rd.enviado_em >= ${desde(x.campanhaRecenteDias)} OR rd.estado = 'enviando'))
          OR EXISTS (SELECT 1 FROM campanha_envio re WHERE re.tenant_id = c.tenant_id AND re.contato_id = c.id
                        AND re.estado = 'enviado' AND re.enviado_em >= ${desde(x.campanhaRecenteDias)}) THEN 'campanhaRecente'` : tx``}
        ${x.compraRecenteDias > 0 ? tx`
        WHEN c.ultima_venda_em >= ${desde(x.compraRecenteDias)}
          OR EXISTS (SELECT 1 FROM metricas_contato m WHERE m.tenant_id = c.tenant_id AND m.contato_id = c.id
                        AND m.ultima_venda_em >= ${desde(x.compraRecenteDias)}) THEN 'compraRecente'` : tx``}
        ELSE NULL END AS motivo
      FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${p.contatoId}`
  return r ? r.motivo : 'anonimizado'
}
