import type { Sql } from '../../db/index.js'
import { lerBusca, padraoContem } from '../../db/busca.js'
import { condicaoPedido, type Escopo } from '../plataforma/escopo.js'
import { resolverPeriodo, validarEntradaPeriodo } from '../plataforma/periodo-relatorio.js'

/**
 * Filtro único da lista de pedidos e dos contadores: os dois leem a MESMA condição, então o
 * total do card nunca diverge da lista. Sem `inicio`/`fim` NÃO há janela (a lista é cronológica
 * por cursor); com eles, vale a mesma validação dos relatórios (422 `periodo.*`).
 */
export interface EntradaFiltroPedidos { q?: unknown; inicio?: string; fim?: string; contatoId?: string }

export interface FiltroValido {
  readonly erro?: undefined
  readonly q: string | null
  readonly desde: Date | null
  readonly ate: Date | null
  readonly contatoId: string | null
}
export interface FiltroRecusado { readonly erro: { readonly status: 422; readonly corpo: Record<string, unknown> } }

export async function lerFiltroPedidos(tx: Sql, e: EntradaFiltroPedidos): Promise<FiltroValido | FiltroRecusado> {
  const q = lerBusca(e.q)
  if (q === 'invalido') return { erro: { status: 422, corpo: { erro: 'busca.invalida', campos: { q: 'Use até 100 caracteres.' } } } }
  const erroPeriodo = validarEntradaPeriodo(e.inicio, e.fim)
  if (erroPeriodo) return { erro: { status: 422, corpo: { erro: erroPeriodo } } }
  let desde: Date | null = null
  let ate: Date | null = null
  if (e.inicio !== undefined && e.fim !== undefined) {
    const p = await resolverPeriodo(tx, e.inicio, e.fim)
    desde = p.desde; ate = p.ate
  }
  return { q, desde, ate, contatoId: e.contatoId ?? null }
}

/** Condição SQL (alias `p` = pedido, `c` = contato): escopo por papel + busca + período + cliente. */
export function condicaoListaPedidos(tx: Sql, escopo: Escopo, f: FiltroValido) {
  return tx`
    ${condicaoPedido(tx, escopo, 'p')}
    AND ${f.contatoId ? tx`p.contato_id = ${f.contatoId}` : tx`true`}
    AND ${f.desde && f.ate ? tx`p.criado_em >= ${f.desde} AND p.criado_em < ${f.ate}` : tx`true`}
    AND ${f.q === null ? tx`true` : tx`(
          p.numero_externo ILIKE ${padraoContem(f.q)}
          OR p.nome ILIKE ${padraoContem(f.q)}
          OR c.nome ILIKE ${padraoContem(f.q)}
          -- Código curto: os 6 últimos hex do id, como o resumo e a proposta o mostram.
          OR right(replace(p.id::text, '-', ''), 6) ILIKE ${padraoContem(f.q)})`}`
}
