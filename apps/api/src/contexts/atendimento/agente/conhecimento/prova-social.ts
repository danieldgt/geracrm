import { VALIDADE_PROVA_SOCIAL_DIAS, type TipoProvaSocial } from '@geracrm/shared'
import type { Sql } from '../../../../db/index.js'

/**
 * PROVA SOCIAL — a leitura que a ferramenta `consultar_prova_social` usa (G3, #100).
 *
 * Prova social é um documento do Conhecimento com `tipo = 'prova_social'` e os
 * campos próprios (fonte, link, data de apuração, número/depoimento,
 * consentimento) e a APROVAÇÃO de um admin. Daqui só sai o que é:
 *   publicado  · aprovado  · vigente (apurado há no máximo VALIDADE_PROVA_SOCIAL_DIAS, nunca no futuro)
 *   · visível para o canal (do número ou global).
 *
 * ⚠️ A busca comum (`conhecimento_buscar`, `busca.ts`) EXCLUI prova social: o texto
 *    não aprovado nunca chega ao modelo por outro caminho.
 * Chamar sob tenant (RLS).
 */

export interface ItemProvaSocial {
  readonly documentoId: string
  readonly versao: number
  readonly titulo: string
  readonly tipo: TipoProvaSocial
  readonly texto: string
  readonly fonte: string
  readonly link: string | null
  /** "AAAA-MM-DD" */
  readonly apuradoEm: string
}

const LIMITE = 5
const MIN_TOKEN = 3
const MAX_TOKENS = 6

function tokensDoTema(tema: string): string[] {
  const vistos = new Set<string>()
  for (const t of tema.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= MIN_TOKEN) vistos.add(t)
    if (vistos.size >= MAX_TOKENS) break
  }
  return [...vistos]
}

export async function listarProvaSocialAprovada(
  tx: Sql, p: { canalId: string | null; tema: string | null; agora: Date },
): Promise<ItemProvaSocial[]> {
  const tokens = p.tema ? tokensDoTema(p.tema) : []
  const casaTema = tokens.length === 0
    ? tx`true`
    : tokens.reduce((acc, t) => tx`${acc} OR unaccent(lower(d.titulo || ' ' || d.conteudo || ' ' || coalesce(d.fonte, ''))) LIKE ${'%' + t + '%'}`, tx`false`)
  const linhas = await tx<{
    id: string; versao: number; titulo: string; prova_tipo: TipoProvaSocial; conteudo: string; fonte: string; link: string | null; apurado: string
  }[]>`
    SELECT d.id, d.versao, d.titulo, d.prova_tipo, d.conteudo, d.fonte, d.link, d.apurado_em::text AS apurado
      FROM conhecimento_documento d
     WHERE d.tenant_id = tenant_atual()
       AND d.tipo = 'prova_social' AND d.aprovado AND d.publicado
       AND d.apurado_em <= ${p.agora}::date
       AND d.apurado_em >= ${p.agora}::date - ${VALIDADE_PROVA_SOCIAL_DIAS}::int
       AND ${p.canalId ? tx`(d.canal_id IS NULL OR d.canal_id = ${p.canalId})` : tx`true`}
       AND (${casaTema})
     ORDER BY d.apurado_em DESC, d.id
     LIMIT ${LIMITE}`
  return linhas.map((l) => ({
    documentoId: l.id, versao: l.versao, titulo: l.titulo, tipo: l.prova_tipo, texto: l.conteudo,
    fonte: l.fonte, link: l.link, apuradoEm: l.apurado,
  }))
}
