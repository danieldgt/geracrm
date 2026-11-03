import { montarIndicador, type AgrupamentoCockpit, type GrupoIndicadorCarteira, type IndicadorCarteira } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { condicaoCarteiraAtiva, condicaoFiltros, filialEfetivaDoContato, type FiltrosContato } from '../crm/contatos-filtros.js'
import { condicaoContato, type Escopo } from './escopo.js'

/**
 * HIGIENIZAÇÃO DA CARTEIRA (D2) — o indicador "% da carteira ativa com próximo passo".
 *
 * Ativo = qualificado OU oportunidade aberta (`condicaoCarteiraAtiva`, a mesma da lista de contatos com
 * `carteiraAtiva=true`). Com próximo passo = tarefa aberta futura OU, com a Agenda ligada, evento futuro:
 * é a negação do `semProximoPasso=true` da A2, então o número do indicador e a lista dessa tela batem.
 *
 * ⚠️ Sempre no escopo da D3 (`condicaoContato`); o tenant vem da transação (RLS), nunca de parâmetro.
 * ⚠️ Uma única passada agregada (COUNT FILTER) — nada de N+1 nem de contar em memória.
 */

export interface EntradaIndicador {
  readonly escopo: Escopo
  readonly agenda: boolean
  readonly fuso: string
  /** Só `filialId` e `vendedorId` são usados (os demais já vêm neutros). */
  readonly filtros: FiltrosContato
}

/** Teto defensivo de grupos devolvidos (filiais/vendedores de um tenant são dezenas). */
const MAX_GRUPOS = 500

const temPasso = (tx: Sql, agenda: boolean) => tx`(
  EXISTS (SELECT 1 FROM tarefa ht WHERE ht.tenant_id = c.tenant_id AND ht.contato_id = c.id
             AND ht.estado = 'aberta' AND ht.vence_em >= now())
  ${agenda ? tx`OR EXISTS (SELECT 1 FROM evento_agenda he WHERE he.tenant_id = c.tenant_id AND he.contato_id = c.id
             AND he.status = 'agendado' AND he.inicio >= now())` : tx``})`

const base = (tx: Sql, e: EntradaIndicador) => tx`
  FROM contato c
 WHERE c.tenant_id = tenant_atual() AND c.ativo
   AND coalesce(c.origem_carga, '') <> 'simulacao'
   AND ${condicaoCarteiraAtiva(tx, 'c')}
   AND ${condicaoContato(tx, e.escopo, 'c')}
   AND ${condicaoFiltros(tx, e.filtros, { fuso: e.fuso, agenda: e.agenda })}`

export async function indicadorDaCarteira(tx: Sql, e: EntradaIndicador): Promise<IndicadorCarteira> {
  const [l] = await tx<{ ativos: number; com: number }[]>`
    SELECT count(*)::int AS ativos, (count(*) FILTER (WHERE ${temPasso(tx, e.agenda)}))::int AS com
    ${base(tx, e)}`
  return montarIndicador(l?.ativos ?? 0, l?.com ?? 0)
}

export async function gruposDoIndicador(tx: Sql, e: EntradaIndicador, agrupar: AgrupamentoCockpit): Promise<GrupoIndicadorCarteira[]> {
  const chave = agrupar === 'vendedor'
    ? tx`(SELECT gca.usuario_id FROM carteira_atribuicao gca
           WHERE gca.tenant_id = c.tenant_id AND gca.contato_id = c.id AND gca.ate IS NULL AND gca.usuario_id IS NOT NULL
           LIMIT 1)`
    : filialEfetivaDoContato(tx, 'c')
  const linhas = await tx<{ chave: string | null; ativos: number; com: number }[]>`
    SELECT g.chave, count(*)::int AS ativos, (count(*) FILTER (WHERE g.com))::int AS com
      FROM (SELECT ${chave} AS chave, ${temPasso(tx, e.agenda)} AS com ${base(tx, e)}) g
     GROUP BY g.chave
     ORDER BY (count(*) FILTER (WHERE NOT g.com)) DESC, g.chave NULLS LAST
     LIMIT ${MAX_GRUPOS}`
  const ids = linhas.map((l) => l.chave).filter((k): k is string => k !== null)
  const nomes = new Map<string, string>()
  if (ids.length > 0) {
    const rs = agrupar === 'vendedor'
      ? await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM usuario WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
      : await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM filial WHERE tenant_id = tenant_atual() AND id = ANY(${ids}::uuid[])`
    for (const r of rs) nomes.set(r.id, r.nome)
  }
  return linhas.map((l) => ({
    chave: l.chave ?? 'sem',
    rotulo: l.chave === null ? (agrupar === 'vendedor' ? 'Sem responsável' : 'Sem filial') : (nomes.get(l.chave) ?? 'Removido'),
    ...montarIndicador(l.ativos, l.com),
  }))
}
