import { randomUUID } from 'node:crypto'
import {
  conteudoPlaybook, diffPorSecao, personaDoPlaybook, playbookDaConfig, slotsDoPlaybook, validarPlaybook,
  type ConteudoPlaybook, type EscopoPlaybook, type ErroCampoPlaybook, type EstadoPlaybook, type OrigemPlaybook,
  type PlaybookVigente, type VersaoPlaybook,
} from '@geracrm/shared'
import type { Sql } from '../../../../db/index.js'
import { jsonbDe } from '../../../../db/jsonb.js'
import { auditar } from '../../../plataforma/auditoria.js'

/**
 * PLAYBOOK COMERCIAL — persistência e ciclo de vida (raia P17; ADR-033).
 *
 *   rascunho ──publicar(observação ≥ 10, admin)──▶ publicada ──(próxima publicação)──▶ arquivada
 *        ▲                                              │
 *        └──────── restaurar(versão antiga) = cópia publicada como versão NOVA
 *
 * Tudo aqui roda na transação de quem chama, sob RLS (`req.comTenant`). Cada
 * escrita trava o ESCOPO (tenant + número, ou tenant) com advisory lock da
 * transação: duas publicações simultâneas não disputam o mesmo número de versão.
 *
 * ⚠️ Publicar ESPELHA a versão em `agente_config` (playbook, persona, slots) na
 *    mesma transação — é o que o turno lê, então a próxima mensagem já sai com
 *    ela. Escopo `tenant` alcança os números SEM playbook próprio.
 */

export const PAGINA_VERSOES = 20

interface LinhaVersao {
  id: string; canal_id: string | null; numero: number | null; conteudo: unknown; origem: OrigemPlaybook
  baseada_em: string | null; observacao: string | null; resumo_mudancas: unknown; documento_nome: string | null
  criado_em: Date; criado_por_nome: string | null; publicada_em: Date | null; publicada_por_nome: string | null
  arquivada_em: Date | null; custo_centavos: number; atualizado_em: Date
}

/**
 * Conteúdo gravado que não passa no schema de hoje. Não se lê como "padrão" em
 * silêncio: quem chama devolve erro nomeado (`playbook.conteudo_invalido`).
 */
export class ErroConteudoPlaybook extends Error {
  constructor(readonly versaoId: string, readonly detalhe: string) {
    super(`agente_playbook_versao ${versaoId}: conteúdo fora do contrato (${detalhe})`)
    this.name = 'ErroConteudoPlaybook'
  }
}

const COLUNAS = (tx: Sql) => tx`
  p.id, p.canal_id, p.numero, p.conteudo, p.origem, p.baseada_em, p.observacao, p.resumo_mudancas, p.documento_nome,
  p.criado_em, uc.nome AS criado_por_nome, p.publicada_em, up.nome AS publicada_por_nome, p.arquivada_em, least(p.custo_centavos, 2147483647)::int AS custo_centavos,
  date_trunc('milliseconds', p.atualizado_em) AS atualizado_em`

const JUNCOES = (tx: Sql) => tx`
  LEFT JOIN usuario uc ON uc.tenant_id = p.tenant_id AND uc.id = p.criado_por
  LEFT JOIN usuario up ON up.tenant_id = p.tenant_id AND up.id = p.publicada_por`

function estadoDe(l: Pick<LinhaVersao, 'publicada_em' | 'arquivada_em'>): EstadoPlaybook {
  return l.publicada_em === null ? 'rascunho' : l.arquivada_em === null ? 'publicada' : 'arquivada'
}

/** Linha → versão. Conteúdo gravado que não passa no schema (não deveria existir) cai no padrão de leitura. */
function versaoDe(l: LinhaVersao): VersaoPlaybook & { readonly custoCentavos: number } {
  const c = conteudoPlaybook.safeParse(l.conteudo)
  if (!c.success) throw new ErroConteudoPlaybook(l.id, `${c.error.issues[0]?.path.join('.') ?? ''}: ${c.error.issues[0]?.message ?? ''}`)
  return {
    id: l.id, canalId: l.canal_id, numero: l.numero, estado: estadoDe(l), origem: l.origem, baseadaEm: l.baseada_em,
    observacao: l.observacao, resumoMudancas: Array.isArray(l.resumo_mudancas) ? l.resumo_mudancas.filter((x): x is string => typeof x === 'string') : [],
    documentoNome: l.documento_nome, criadoEm: l.criado_em.toISOString(), criadoPor: l.criado_por_nome,
    publicadaEm: l.publicada_em?.toISOString() ?? null, publicadaPor: l.publicada_por_nome,
    conteudo: c.data, custoCentavos: l.custo_centavos, atualizadoEm: l.atualizado_em.toISOString(),
  }
}

/** Escopo como chave SQL: o número, ou NULL (conta). */
const doEscopo = (tx: Sql, canalId: string | null) => (canalId ? tx`p.canal_id = ${canalId}` : tx`p.canal_id IS NULL`)

/**
 * UMA trava por TENANT até o fim da transação — a MESMA do trigger de INSERT em
 * `agente_config` (0106). Publicar e espelhar a conta e um número ao mesmo tempo
 * (ou um número nascendo no meio) não se cruzam: quem espelha vê o estado final.
 * `canalId` fica na assinatura por legibilidade de quem chama.
 */
async function travarEscopo(tx: Sql, _canalId: string | null): Promise<void> {
  await travarPlaybookDoTenant(tx)
}

/**
 * A trava do playbook do tenant. ⚠️ ORDEM CANÔNICA DE LOCKS (revisão P17, deadlock
 * reproduzido): todo caminho que trava linha de `agente_config` e depois faz
 * INSERT nela (o trigger da 0106 pega esta trava) chama isto PRIMEIRO, antes de
 * qualquer FOR UPDATE — a publicação pega esta trava e depois atualiza as linhas.
 */
export async function travarPlaybookDoTenant(tx: Sql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('agente_playbook'), hashtext(tenant_atual()::text))`
}

export async function canalExiste(tx: Sql, canalId: string): Promise<boolean> {
  const [c] = await tx<{ id: string }[]>`SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${canalId}`
  return !!c
}

export async function lerRascunho(tx: Sql, canalId: string | null) {
  const [l] = await tx<LinhaVersao[]>`
    SELECT ${COLUNAS(tx)} FROM agente_playbook_versao p ${JUNCOES(tx)}
     WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, canalId)} AND p.publicada_em IS NULL`
  return l ? versaoDe(l) : null
}

export async function lerPublicada(tx: Sql, canalId: string | null) {
  const [l] = await tx<LinhaVersao[]>`
    SELECT ${COLUNAS(tx)} FROM agente_playbook_versao p ${JUNCOES(tx)}
     WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, canalId)} AND p.publicada_em IS NOT NULL AND p.arquivada_em IS NULL`
  return l ? versaoDe(l) : null
}

export async function lerVersao(tx: Sql, id: string) {
  const [l] = await tx<LinhaVersao[]>`
    SELECT ${COLUNAS(tx)} FROM agente_playbook_versao p ${JUNCOES(tx)}
     WHERE p.tenant_id = tenant_atual() AND p.id = ${id}`
  return l ? versaoDe(l) : null
}

/** O que vale para o número agora: o playbook dele ou, sem ele, o da conta. */
export async function vigenteDoCanal(tx: Sql, canalId: string): Promise<{ escopo: EscopoPlaybook; versao: NonNullable<Awaited<ReturnType<typeof lerPublicada>>> } | null> {
  const doNumero = await lerPublicada(tx, canalId)
  if (doNumero) return { escopo: 'numero', versao: doNumero }
  const daConta = await lerPublicada(tx, null)
  return daConta ? { escopo: 'tenant', versao: daConta } : null
}

/** Histórico do escopo (publicadas e arquivadas), por número DESC, cursor = número. Sem conteúdo. */
export async function listarVersoes(tx: Sql, canalId: string | null, antesDoNumero: number | null) {
  const linhas = await tx<LinhaVersao[]>`
    SELECT ${COLUNAS(tx)} FROM agente_playbook_versao p ${JUNCOES(tx)}
     WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, canalId)} AND p.numero IS NOT NULL
       AND ${antesDoNumero === null ? tx`true` : tx`p.numero < ${antesDoNumero}`}
     ORDER BY p.numero DESC LIMIT ${PAGINA_VERSOES + 1}`
  const temMais = linhas.length > PAGINA_VERSOES
  const pagina = (temMais ? linhas.slice(0, PAGINA_VERSOES) : linhas).map(versaoDe)
  return {
    itens: pagina.map(({ conteudo: _c, ...resto }) => resto),
    proximoCursor: temMais ? String(pagina[pagina.length - 1]!.numero) : null,
  }
}

// ── espelho em agente_config ────────────────────────────────────────────────

function espelhoDe(v: { id: string; numero: number; publicadaEm: string; conteudo: ConteudoPlaybook }, escopo: EscopoPlaybook): PlaybookVigente {
  return { versaoId: v.id, numero: v.numero, escopo, publicadaEm: v.publicadaEm, conteudo: v.conteudo }
}

/**
 * Escreve a publicada do escopo em `agente_config` dos números alcançados:
 * `numero` → só aquele; `tenant` → os números SEM publicada própria.
 * Devolve quantos números mudaram.
 */
export async function espelharPlaybook(tx: Sql, canalId: string | null): Promise<number> {
  const pub = await lerPublicada(tx, canalId)
  if (!pub || pub.numero === null || !pub.publicadaEm) return 0
  const espelho = espelhoDe({ id: pub.id, numero: pub.numero, publicadaEm: pub.publicadaEm, conteudo: pub.conteudo }, canalId ? 'numero' : 'tenant')
  const persona = jsonbDe(personaDoPlaybook(pub.conteudo))
  const slots = jsonbDe(slotsDoPlaybook(pub.conteudo))
  const r = canalId
    ? await tx`
        UPDATE agente_config SET playbook = ${jsonbDe(espelho)}::text::jsonb, persona = ${persona}::text::jsonb,
               qualificacao = ${slots}::text::jsonb, atualizado_em = now()
         WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
    : await tx`
        UPDATE agente_config ac SET playbook = ${jsonbDe(espelho)}::text::jsonb, persona = ${persona}::text::jsonb,
               qualificacao = ${slots}::text::jsonb, atualizado_em = now()
         WHERE ac.tenant_id = tenant_atual()
           AND NOT EXISTS (SELECT 1 FROM agente_playbook_versao p
                            WHERE p.tenant_id = ac.tenant_id AND p.canal_id = ac.canal_id
                              AND p.publicada_em IS NOT NULL AND p.arquivada_em IS NULL)`
  return r.count
}

// ── importação inicial ──────────────────────────────────────────────────────

/**
 * A v1 do NÚMERO a partir do `agente_config` dele (persona, slots, compliance
 * extra) — IDEMPOTENTE: se o escopo já tem qualquer versão, não faz nada e
 * devolve a publicada. Nasce PUBLICADA: é exatamente o comportamento de hoje.
 */
export async function importarPlaybookInicial(tx: Sql, p: { canalId: string; autorId: string | null; atorStaff?: boolean | undefined }) {
  await travarEscopo(tx, p.canalId)
  const [ja] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM agente_playbook_versao p WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, p.canalId)}`
  if ((ja?.n ?? 0) > 0) return { importada: false as const, publicada: await lerPublicada(tx, p.canalId) }
  // Número coberto pelo playbook da CONTA: importar a config criaria uma v1 que
  // troca o comportamento em silêncio (perde estilo/mensagens da conta). Recusa.
  const daConta = await lerPublicada(tx, null)
  if (daConta) return { importada: false as const, publicada: null, cobertoPelaConta: { versaoId: daConta.id, numero: daConta.numero } }
  const [cfg] = await tx<{ persona: unknown; qualificacao: unknown; compliance: unknown }[]>`
    SELECT persona, qualificacao, (to_jsonb(ac.*) -> 'compliance') AS compliance
      FROM agente_config ac WHERE ac.tenant_id = tenant_atual() AND ac.canal_id = ${p.canalId}`
  const conteudo = playbookDaConfig(cfg ?? {})
  const id = randomUUID()
  await tx`
    INSERT INTO agente_playbook_versao (tenant_id, id, canal_id, numero, conteudo, origem, criado_por, observacao,
                                        publicada_por, publicada_em)
    VALUES (tenant_atual(), ${id}, ${p.canalId}, 1, ${jsonbDe(conteudo)}::text::jsonb, 'importada', ${p.autorId},
            'Versão 1 importada da configuração do agente (persona, roteiro e compliance do número).',
            ${p.autorId}, now())`
  await espelharPlaybook(tx, p.canalId)
  await auditar(tx, {
    atorId: p.autorId, atorStaff: p.atorStaff ?? false, acao: 'agente.playbook_publicado', entidade: 'agente_playbook_versao',
    entidadeId: id, dados: { canalId: p.canalId, numero: 1, origem: 'importada', escopo: 'numero' },
  })
  return { importada: true as const, publicada: await lerPublicada(tx, p.canalId) }
}

// ── rascunho ────────────────────────────────────────────────────────────────

export type ResultadoSalvar =
  | { tipo: 'ok'; versao: NonNullable<Awaited<ReturnType<typeof lerRascunho>>> }
  | { tipo: 'invalido'; erros: readonly ErroCampoPlaybook[] }

/** Base de um rascunho novo: a publicada do escopo; sem ela, a vigente do número (ou o padrão). */
async function baseDoRascunho(tx: Sql, canalId: string | null): Promise<{ conteudo: ConteudoPlaybook; baseadaEm: string | null }> {
  const pub = await lerPublicada(tx, canalId)
  if (pub) return { conteudo: pub.conteudo, baseadaEm: pub.id }
  if (canalId) {
    const daConta = await lerPublicada(tx, null)
    if (daConta) return { conteudo: daConta.conteudo, baseadaEm: daConta.id }
    const [cfg] = await tx<{ persona: unknown; qualificacao: unknown; compliance: unknown }[]>`
      SELECT persona, qualificacao, (to_jsonb(ac.*) -> 'compliance') AS compliance
        FROM agente_config ac WHERE ac.tenant_id = tenant_atual() AND ac.canal_id = ${canalId}`
    return { conteudo: playbookDaConfig(cfg ?? {}), baseadaEm: null }
  }
  return { conteudo: playbookDaConfig({}), baseadaEm: null }
}

/** Cria o rascunho copiando a base; se já existe, devolve o existente (`criado: false`). */
export async function criarRascunho(tx: Sql, p: { canalId: string | null; autorId: string | null }) {
  await travarEscopo(tx, p.canalId)
  const existente = await lerRascunho(tx, p.canalId)
  if (existente) return { criado: false as const, versao: existente }
  const base = await baseDoRascunho(tx, p.canalId)
  await tx`
    INSERT INTO agente_playbook_versao (tenant_id, id, canal_id, conteudo, origem, baseada_em, criado_por)
    VALUES (tenant_atual(), ${randomUUID()}, ${p.canalId}, ${jsonbDe(base.conteudo)}::text::jsonb, 'manual', ${base.baseadaEm}, ${p.autorId})`
  return { criado: true as const, versao: (await lerRascunho(tx, p.canalId))! }
}

/**
 * Grava o conteúdo do rascunho (cria se não houver). Validação COMPLETA —
 * inclusive a que recusa tentativa de desligar guardrail (schema estrito).
 */
export async function salvarRascunho(tx: Sql, p: {
  canalId: string | null; conteudo: unknown; autorId: string | null
  origem?: OrigemPlaybook; resumoMudancas?: readonly string[]; documentoNome?: string | null; custoCentavos?: number
}): Promise<ResultadoSalvar> {
  const v = validarPlaybook(p.conteudo)
  if (!v.ok) return { tipo: 'invalido', erros: v.erros }
  await travarEscopo(tx, p.canalId)
  const existente = await lerRascunho(tx, p.canalId)
  if (existente) {
    await tx`
      UPDATE agente_playbook_versao
         SET conteudo = ${jsonbDe(v.conteudo)}::text::jsonb, atualizado_em = now(),
             origem = ${p.origem ?? existente.origem},
             resumo_mudancas = ${jsonbDe(p.resumoMudancas ?? existente.resumoMudancas)}::text::jsonb,
             documento_nome = ${p.documentoNome !== undefined ? p.documentoNome : existente.documentoNome},
             custo_centavos = custo_centavos + ${p.custoCentavos ?? 0}
       WHERE tenant_id = tenant_atual() AND id = ${existente.id}`
  } else {
    const base = await baseDoRascunho(tx, p.canalId)
    await tx`
      INSERT INTO agente_playbook_versao (tenant_id, id, canal_id, conteudo, origem, baseada_em, criado_por,
                                          resumo_mudancas, documento_nome, custo_centavos)
      VALUES (tenant_atual(), ${randomUUID()}, ${p.canalId}, ${jsonbDe(v.conteudo)}::text::jsonb, ${p.origem ?? 'manual'},
              ${base.baseadaEm}, ${p.autorId}, ${jsonbDe(p.resumoMudancas ?? [])}::text::jsonb, ${p.documentoNome ?? null},
              ${p.custoCentavos ?? 0})`
  }
  return { tipo: 'ok', versao: (await lerRascunho(tx, p.canalId))! }
}

export async function descartarRascunho(tx: Sql, canalId: string | null): Promise<boolean> {
  await travarEscopo(tx, canalId)
  const r = await tx`DELETE FROM agente_playbook_versao p WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, canalId)} AND p.publicada_em IS NULL`
  return r.count > 0
}

// ── publicar e restaurar ────────────────────────────────────────────────────

export type ResultadoPublicar =
  | { tipo: 'ok'; versao: NonNullable<Awaited<ReturnType<typeof lerPublicada>>>; numerosAlcancados: number }
  | { tipo: 'sem_rascunho' }
  | { tipo: 'rascunho_mudou'; atualizadoEm: string }
  | { tipo: 'invalido'; erros: readonly ErroCampoPlaybook[] }

/**
 * O rascunho vira a publicada: a anterior é ARQUIVADA, o número é o próximo do
 * escopo, a versão vai para `agente_config` e a auditoria guarda quem, quando,
 * por quê e o que mudou (seções). Tudo na transação de quem chama.
 */
export async function publicarRascunho(tx: Sql, p: {
  canalId: string | null; observacao: string; autorId: string | null; atorStaff?: boolean | undefined; restauradaDe?: { id: string; numero: number | null } | undefined
  /** O `atualizadoEm` do rascunho que a pessoa revisou; ausente só na restauração (rascunho criado aqui). */
  rascunhoAtualizadoEm?: string | undefined
}): Promise<ResultadoPublicar> {
  await travarEscopo(tx, p.canalId)
  const rascunho = await lerRascunho(tx, p.canalId)
  if (!rascunho) return { tipo: 'sem_rascunho' }
  if (p.rascunhoAtualizadoEm !== undefined && new Date(p.rascunhoAtualizadoEm).getTime() !== new Date(rascunho.atualizadoEm).getTime()) {
    return { tipo: 'rascunho_mudou', atualizadoEm: rascunho.atualizadoEm }
  }
  // A base do código pode ter mudado depois do último salvar: valida de novo.
  const v = validarPlaybook(rascunho.conteudo)
  if (!v.ok) return { tipo: 'invalido', erros: v.erros }
  const anterior = await lerPublicada(tx, p.canalId)
  const [prox] = await tx<{ n: number }[]>`
    SELECT coalesce(max(p.numero), 0)::int + 1 AS n FROM agente_playbook_versao p
     WHERE p.tenant_id = tenant_atual() AND ${doEscopo(tx, p.canalId)}`
  if (anterior) {
    await tx`UPDATE agente_playbook_versao SET arquivada_em = now() WHERE tenant_id = tenant_atual() AND id = ${anterior.id}`
  }
  await tx`
    UPDATE agente_playbook_versao
       SET numero = ${prox!.n}, observacao = ${p.observacao}, publicada_por = ${p.autorId}, publicada_em = now()
     WHERE tenant_id = tenant_atual() AND id = ${rascunho.id}`
  const alcancados = await espelharPlaybook(tx, p.canalId)
  const publicada = (await lerPublicada(tx, p.canalId))!
  const secoes = diffPorSecao(anterior?.conteudo ?? null, publicada.conteudo).filter((d) => d.mudou).map((d) => d.secao)
  await auditar(tx, {
    atorId: p.autorId, atorStaff: p.atorStaff ?? false, acao: 'agente.playbook_publicado', entidade: 'agente_playbook_versao',
    entidadeId: publicada.id,
    dados: {
      canalId: p.canalId, escopo: p.canalId ? 'numero' : 'tenant', numero: publicada.numero, origem: publicada.origem,
      observacao: p.observacao, anterior: anterior ? { id: anterior.id, numero: anterior.numero } : null,
      secoesAlteradas: secoes, numerosAlcancados: alcancados,
      ...(p.restauradaDe ? { restauradaDe: p.restauradaDe } : {}),
    },
  })
  return { tipo: 'ok', versao: publicada, numerosAlcancados: alcancados }
}

export type ResultadoRestaurar =
  | ResultadoPublicar
  | { tipo: 'versao_inexistente' } | { tipo: 'versao_rascunho' } | { tipo: 'rascunho_existente' }

/**
 * Restaurar = criar um rascunho com o conteúdo da versão antiga e publicá-lo
 * como versão NOVA (origem `restaurada`). A antiga continua intacta. Com um
 * rascunho em andamento no escopo, recusa — restaurar não apaga trabalho.
 */
export async function restaurarVersao(tx: Sql, p: { versaoId: string; observacao: string; autorId: string | null; atorStaff?: boolean | undefined }): Promise<ResultadoRestaurar> {
  const alvo = await lerVersao(tx, p.versaoId)
  if (!alvo) return { tipo: 'versao_inexistente' }
  if (alvo.estado === 'rascunho') return { tipo: 'versao_rascunho' }
  // Antes de criar qualquer linha: versão antiga que não passa nas regras de HOJE
  // (a base do filtro cresceu) não volta — a tela mostra o que corrigir.
  const v = validarPlaybook(alvo.conteudo)
  if (!v.ok) return { tipo: 'invalido', erros: v.erros }
  await travarEscopo(tx, alvo.canalId)
  if (await lerRascunho(tx, alvo.canalId)) return { tipo: 'rascunho_existente' }
  await tx`
    INSERT INTO agente_playbook_versao (tenant_id, id, canal_id, conteudo, origem, baseada_em, criado_por)
    VALUES (tenant_atual(), ${randomUUID()}, ${alvo.canalId}, ${jsonbDe(alvo.conteudo)}::text::jsonb, 'restaurada', ${alvo.id}, ${p.autorId})`
  return publicarRascunho(tx, {
    canalId: alvo.canalId, observacao: p.observacao, autorId: p.autorId, atorStaff: p.atorStaff,
    restauradaDe: { id: alvo.id, numero: alvo.numero },
  })
}
