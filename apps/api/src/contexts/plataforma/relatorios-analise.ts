import type { Sql } from '../../db/index.js'
import type { PeriodoResolvido } from './periodo-relatorio.js'
import { condicaoContato, condicaoOportunidade, condicaoTarefa, type Escopo } from './escopo.js'
import { contatosPorDimensao, taxaDe } from './rotas-relatorios.js'
import { metricasVendedores, funilAtual, type VendedorDesempenho } from './relatorios-gestao.js'
import { relatorioWhatsapp } from './relatorios-whatsapp.js'
import { diasDoPeriodo, fatia, ticketMedio } from './relatorios-vendas.js'
import { agruparCoorte, ehUuid, materializarCoorte, type GrupoCoorte } from './relatorios-contatos.js'

/**
 * RELATÓRIOS DE ANÁLISE (raia E3): comparativo de vendedores, visão geral, raio-x, desempenho do cadastro,
 * motivos de perda e o pacote dos imprimíveis. Mesmas réguas da E1/E2: coorte = contatos criados no período,
 * venda = pedido efetivado no período (fuso do tenant), escopo da D3, só leitura, período <= 366 dias.
 * Nada de view materializada: o dado é escopado por papel e a view não tem RLS (geracrm-dados-postgres).
 */

// ── Comparativo de vendedores ────────────────────────────────────────────────────────────────────

export const MAX_COMPARATIVO = 10

export type ErroVendedores = 'relatorio.vendedores_obrigatorio' | 'relatorio.vendedores_demais' | 'relatorio.vendedor_invalido'

/** Lê `?vendedores=id,id,...` (função pura): 1 a 10 UUIDs distintos. */
export function lerVendedores(v: string | undefined): { ids: string[] } | { erro: ErroVendedores } {
  const ids = [...new Set((v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  if (ids.length === 0) return { erro: 'relatorio.vendedores_obrigatorio' }
  if (ids.length > MAX_COMPARATIVO) return { erro: 'relatorio.vendedores_demais' }
  if (!ids.every(ehUuid)) return { erro: 'relatorio.vendedor_invalido' }
  return { ids }
}

export interface RespostaComparativo {
  readonly itens: VendedorDesempenho[]
  readonly totais: Omit<VendedorDesempenho, 'usuarioId' | 'nome'>
}

/** Os vendedores pedidos lado a lado (na ordem pedida); quem não tem atividade sai zerado. Ids fora do escopo são ignorados. */
export async function comparativoVendedores(tx: Sql, p: PeriodoResolvido, escopo: Escopo, ids: readonly string[]): Promise<RespostaComparativo> {
  const permitidos = await vendedoresPermitidos(tx, escopo, ids)
  const todas = new Map((await metricasVendedores(tx, p, escopo)).map((m) => [m.usuarioId, m]))
  const itens = ids.filter((id) => permitidos.has(id)).map((id): VendedorDesempenho =>
    todas.get(id) ?? {
      usuarioId: id, nome: permitidos.get(id)!, contatosNovos: 0, tarefasConcluidas: 0, conversoes: 0, taxa: null,
      pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0,
    })
  const soma = (f: (v: VendedorDesempenho) => number): number => itens.reduce((s, v) => s + f(v), 0)
  const contatos = soma((v) => v.contatosNovos)
  const conversoes = soma((v) => v.conversoes)
  const pedidos = soma((v) => v.pedidos)
  const valor = soma((v) => v.valorCentavos)
  return {
    itens,
    totais: {
      contatosNovos: contatos, tarefasConcluidas: soma((v) => v.tarefasConcluidas), conversoes, taxa: taxaDe(conversoes, contatos),
      pedidos, valorCentavos: valor, ticketMedioCentavos: ticketMedio(valor, pedidos),
    },
  }
}

// ── Opções dos selects (cursor) ──────────────────────────────────────────────────────────────────

export const EIXOS_OPCOES = ['vendedor', 'filial', 'formulario', 'origem'] as const
export type EixoOpcoes = (typeof EIXOS_OPCOES)[number]
export const LOTE_OPCOES = 30
export function ehEixoOpcoes(v: string): v is EixoOpcoes { return (EIXOS_OPCOES as readonly string[]).includes(v) }

/** Quem aparece nas listas: admin/tudo, todos; gestor, os da(s) sua(s) filial(is); vendedor, só a si mesmo. */
function restricaoUsuario(tx: Sql, escopo: Escopo) {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  if (escopo.tipo === 'carteira') return tx`u.id = ${escopo.usuarioId}`
  return tx`(u.id = ${escopo.usuarioId} OR EXISTS (SELECT 1 FROM usuario_filial x WHERE x.tenant_id = u.tenant_id
            AND x.usuario_id = u.id AND x.filial_id IN ${tx(escopo.filialIds)}))`
}

function restricaoFilial(tx: Sql, escopo: Escopo) {
  if (escopo.tipo === 'tudo') return tx`true`
  if (escopo.usuarioId === null) return tx`false`
  if (escopo.tipo === 'filial') return tx`f.id IN ${tx(escopo.filialIds)}`
  return tx`EXISTS (SELECT 1 FROM usuario_filial x WHERE x.tenant_id = f.tenant_id AND x.filial_id = f.id AND x.usuario_id = ${escopo.usuarioId})`
}

async function vendedoresPermitidos(tx: Sql, escopo: Escopo, ids: readonly string[]): Promise<Map<string, string>> {
  const linhas = await tx<{ id: string; nome: string }[]>`
    SELECT u.id, u.nome FROM usuario u
     WHERE u.tenant_id = tenant_atual() AND u.ativo AND u.id IN ${tx(ids)} AND ${restricaoUsuario(tx, escopo)}`
  return new Map(linhas.map((l) => [l.id, l.nome]))
}

export interface OpcaoRelatorio { readonly id: string; readonly nome: string }

/** Página de opções (nome, id) por cursor, com busca por nome. Cursor inválido = null no chamador (422). */
export async function opcoesDoEixo(
  tx: Sql, escopo: Escopo, eixo: EixoOpcoes, busca: string, cursor: string | null,
): Promise<{ itens: OpcaoRelatorio[]; proximoCursor: string | null } | 'cursor_invalido'> {
  let depois: { nome: string; id: string } | null = null
  if (cursor !== null) {
    const [nome, id, resto] = Buffer.from(cursor, 'base64url').toString().split('\u0001')
    if (resto !== undefined || nome === undefined || !id || !ehUuid(id)) return 'cursor_invalido'
    depois = { nome, id }
  }
  const termo = busca.trim() === '' ? null : `%${busca.trim().replace(/[\\%_]/g, '\\$&')}%`
  const tabela = { vendedor: 'usuario', filial: 'filial', formulario: 'formulario', origem: 'origem' }[eixo]
  const alias = { vendedor: 'u', filial: 'f', formulario: 'x', origem: 'x' }[eixo]
  const restricao = eixo === 'vendedor' ? restricaoUsuario(tx, escopo) : eixo === 'filial' ? restricaoFilial(tx, escopo) : tx`true`
  const ativo = eixo === 'vendedor' ? tx`u.ativo` : eixo === 'filial' ? tx`f.ativa` : eixo === 'formulario' ? tx`x.ativo` : tx`true`
  const linhas = await tx<OpcaoRelatorio[]>`
    SELECT ${tx(alias)}.id, ${tx(alias)}.nome FROM ${tx(tabela)} ${tx(alias)}
     WHERE ${tx(alias)}.tenant_id = tenant_atual() AND ${ativo} AND ${restricao}
       AND ${termo === null ? tx`true` : tx`${tx(alias)}.nome ILIKE ${termo}`}
       AND ${depois === null ? tx`true` : tx`(${tx(alias)}.nome, ${tx(alias)}.id) > (${depois.nome}, ${depois.id}::uuid)`}
     ORDER BY ${tx(alias)}.nome, ${tx(alias)}.id
     LIMIT ${LOTE_OPCOES + 1}`
  const temMais = linhas.length > LOTE_OPCOES
  const pagina = temMais ? linhas.slice(0, LOTE_OPCOES) : linhas
  const ultimo = pagina[pagina.length - 1]
  return {
    itens: pagina,
    proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.nome}\u0001${ultimo.id}`).toString('base64url') : null,
  }
}

// ── Visão geral ──────────────────────────────────────────────────────────────────────────────────

const MAX_FILIAIS_DIA = 10

export interface TotaisVisao {
  readonly contatos: number
  readonly convertidos: number
  readonly taxa: number | null
  readonly pedidos: number
  readonly valorCentavos: number
  readonly ticketMedioCentavos: number
  readonly respostasFormulario: number
}
export interface SerieFilialDia { readonly chave: string; readonly rotulo: string; readonly total: number; readonly porDia: number[] }
export interface ItemFormulario {
  readonly chave: string; readonly rotulo: string; readonly respostas: number; readonly contatos: number
  readonly convertidos: number; readonly valorCentavos: number
}

/** Respostas de formulário no período; fora de "tudo", só as de contato que quem pede enxerga. */
function respostasVisiveis(tx: Sql, p: PeriodoResolvido, escopo: Escopo) {
  return tx`
    SELECT fr.formulario_id, fr.contato_id
      FROM formulario_resposta fr
      LEFT JOIN contato c ON c.tenant_id = fr.tenant_id AND c.id = fr.contato_id
     WHERE fr.tenant_id = tenant_atual() AND fr.criado_em >= ${p.desde} AND fr.criado_em < ${p.ate}
       AND (c.id IS NULL OR (c.ativo AND coalesce(c.origem_carga, '') <> 'simulacao'))
       AND ${escopo.tipo === 'tudo' ? tx`true` : tx`(fr.contato_id IS NOT NULL AND ${condicaoContato(tx, escopo, 'c')})`}`
}

export async function visaoGeral(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<{
  totais: TotaisVisao; porFilial: GrupoCoorte[]; porFilialTruncado: boolean
  filialPorDia: { dias: string[]; series: SerieFilialDia[]; truncado: boolean }; porFormulario: ItemFormulario[]; porFormularioTruncado: boolean
}> {
  await materializarCoorte(tx, p, escopo)
  const [t] = await tx<{ contatos: number; convertidos: number; pedidos: number; valor: string }[]>`
    WITH k AS (SELECT * FROM coorte_e3)
    SELECT count(*)::int AS contatos, count(*) FILTER (WHERE pedidos > 0)::int AS convertidos,
           coalesce(sum(pedidos), 0)::int AS pedidos, coalesce(sum(valor), 0)::text AS valor FROM k`
  const [r] = await tx<{ n: number }[]>`WITH r AS (${respostasVisiveis(tx, p, escopo)}) SELECT count(*)::int AS n FROM r`
  const valor = Number(t!.valor)
  const totais: TotaisVisao = {
    contatos: t!.contatos, convertidos: t!.convertidos, taxa: taxaDe(t!.convertidos, t!.contatos), pedidos: t!.pedidos,
    valorCentavos: valor, ticketMedioCentavos: ticketMedio(valor, t!.pedidos), respostasFormulario: r!.n,
  }

  const filiais = await agruparCoorte(tx,
    { chave: tx`coalesce(k.filial_id::text, 'sem-filial')`, rotulo: tx`coalesce(k.filial, 'Sem filial')` }, totais.contatos)

  // Filial × dia: só as 10 filiais com mais contatos (limite explícito antes da consulta por dia).
  const top10 = filiais.itens.slice(0, MAX_FILIAIS_DIA).map((g) => g.chave)
  const dias = diasDoPeriodo(p.inicio, p.fim)
  const porDiaBruto = await tx<{ chave: string; rotulo: string; dia: string; n: number }[]>`
    WITH k AS (SELECT * FROM coorte_e3)
    SELECT coalesce(k.filial_id::text, 'sem-filial') AS chave, coalesce(min(k.filial), 'Sem filial') AS rotulo,
           to_char(k.criado_em AT TIME ZONE ${p.fuso}::text, 'YYYY-MM-DD') AS dia, count(*)::int AS n
      FROM k WHERE ${top10.length === 0 ? tx`false` : tx`coalesce(k.filial_id::text, 'sem-filial') IN ${tx(top10)}`}
     GROUP BY 1, 3`
  const mapa = new Map<string, { chave: string; rotulo: string; total: number; porDia: number[] }>()
  const indice = new Map(dias.map((d, i) => [d, i]))
  for (const l of porDiaBruto) {
    const s = mapa.get(l.chave) ?? { chave: l.chave, rotulo: l.rotulo, total: 0, porDia: dias.map(() => 0) }
    const i = indice.get(l.dia)
    if (i !== undefined) { s.porDia[i]! += l.n; s.total += l.n }
    mapa.set(l.chave, s)
  }
  const ordenadas = [...mapa.values()].sort((a, b) => b.total - a.total || a.chave.localeCompare(b.chave))

  const formularios = await tx<{ id: string; nome: string; respostas: number; contatos: number; convertidos: number; valor: string }[]>`
    WITH r AS (${respostasVisiveis(tx, p, escopo)}),
    pc AS (
      SELECT pd.contato_id, sum(pd.total_centavos) AS valor FROM pedido pd
       WHERE pd.tenant_id = tenant_atual() AND pd.estado = 'efetivado'
         AND pd.efetivado_em >= ${p.desde} AND pd.efetivado_em < ${p.ate}
         AND pd.contato_id IN (SELECT contato_id FROM r WHERE contato_id IS NOT NULL)
       GROUP BY pd.contato_id)
    SELECT f.id, f.nome, count(*)::int AS respostas, count(DISTINCT r.contato_id)::int AS contatos,
           count(DISTINCT pc.contato_id)::int AS convertidos,
           coalesce((SELECT sum(x.valor) FROM pc x WHERE x.contato_id IN
                      (SELECT r2.contato_id FROM r r2 WHERE r2.formulario_id = f.id)), 0)::text AS valor
      FROM r
      JOIN formulario f ON f.tenant_id = tenant_atual() AND f.id = r.formulario_id
      LEFT JOIN pc ON pc.contato_id = r.contato_id
     GROUP BY f.id, f.nome
     ORDER BY count(*) DESC, f.nome
     LIMIT 101`
  const formTrunc = formularios.length > 100
  return {
    totais,
    porFilial: filiais.itens, porFilialTruncado: filiais.truncado,
    filialPorDia: { dias, series: ordenadas.slice(0, MAX_FILIAIS_DIA), truncado: filiais.itens.length > MAX_FILIAIS_DIA || filiais.truncado },
    porFormulario: (formTrunc ? formularios.slice(0, 100) : formularios).map((l) => ({
      chave: l.id, rotulo: l.nome, respostas: l.respostas, contatos: l.contatos, convertidos: l.convertidos, valorCentavos: Number(l.valor),
    })),
    porFormularioTruncado: formTrunc,
  }
}

// ── Raio-X ───────────────────────────────────────────────────────────────────────────────────────

export const EIXOS_RAIOX = ['formulario', 'vendedor', 'filial'] as const
export type EixoRaioX = (typeof EIXOS_RAIOX)[number]
export function ehEixoRaioX(v: string): v is EixoRaioX { return (EIXOS_RAIOX as readonly string[]).includes(v) }

export interface RespostaRaioX {
  readonly eixo: EixoRaioX
  readonly chave: string
  readonly rotulo: string
  readonly cartoes: {
    readonly contatos: number; readonly convertidos: number; readonly taxa: number | null; readonly pedidos: number
    readonly valorCentavos: number; readonly ticketMedioCentavos: number
    /** só no eixo formulário */ readonly respostas: number | null
    /** só no eixo vendedor */ readonly tarefasConcluidas: number | null
  }
  readonly porDia: { dia: string; contatos: number; convertidos: number }[]
  readonly origens: GrupoCoorte[]
  readonly origensTruncado: boolean
  readonly qualificacao: GrupoCoorte[]
  readonly ufs: GrupoCoorte[]
  readonly ufsTruncado: boolean
}

const QUALIFICACAO_SQL = (tx: Sql) => tx`CASE WHEN k.qualificado IS NULL THEN 'novo' WHEN k.qualificado THEN 'qualificado' ELSE 'descartado' END`
const ROTULO_QUALIFICACAO: Record<string, string> = { novo: 'Novo', qualificado: 'Qualificado', descartado: 'Descartado' }

/** `null` = o objeto não existe (404). O objeto precisa estar visível: formulário/vendedor/filial do tenant. */
export async function raioX(tx: Sql, p: PeriodoResolvido, escopo: Escopo, eixo: EixoRaioX, chave: string): Promise<RespostaRaioX | null> {
  const [nomeLinha] = eixo === 'formulario'
    ? await tx<{ nome: string }[]>`SELECT nome FROM formulario WHERE tenant_id = tenant_atual() AND id = ${chave}`
    : eixo === 'vendedor'
      ? await tx<{ nome: string }[]>`SELECT u.nome FROM usuario u WHERE u.tenant_id = tenant_atual() AND u.id = ${chave} AND ${restricaoUsuario(tx, escopo)}`
      : await tx<{ nome: string }[]>`SELECT f.nome FROM filial f WHERE f.tenant_id = tenant_atual() AND f.id = ${chave} AND ${restricaoFilial(tx, escopo)}`
  if (!nomeLinha) return null

  await materializarCoorte(tx, p, escopo)
  const filtro = eixo === 'formulario' ? tx`k.formulario_id = ${chave}::uuid`
    : eixo === 'vendedor' ? tx`k.vendedor_id = ${chave}::uuid` : tx`k.filial_id = ${chave}::uuid`

  const [t] = await tx<{ contatos: number; convertidos: number; pedidos: number; valor: string }[]>`
    WITH k AS (SELECT * FROM coorte_e3)
    SELECT count(*)::int AS contatos, count(*) FILTER (WHERE pedidos > 0)::int AS convertidos,
           coalesce(sum(pedidos), 0)::int AS pedidos, coalesce(sum(valor), 0)::text AS valor FROM k WHERE ${filtro}`
  const valor = Number(t!.valor)

  const dias = await tx<{ dia: string; contatos: number; convertidos: number }[]>`
    WITH k AS (SELECT * FROM coorte_e3)
    SELECT to_char(k.criado_em AT TIME ZONE ${p.fuso}::text, 'YYYY-MM-DD') AS dia, count(*)::int AS contatos,
           count(*) FILTER (WHERE k.pedidos > 0)::int AS convertidos
      FROM k WHERE ${filtro} GROUP BY 1`
  const porDia = new Map(dias.map((d) => [d.dia, d]))

  let respostas: number | null = null
  let tarefas: number | null = null
  if (eixo === 'formulario') {
    const [n] = await tx<{ n: number }[]>`
      WITH r AS (${respostasVisiveis(tx, p, escopo)}) SELECT count(*)::int AS n FROM r WHERE formulario_id = ${chave}::uuid`
    respostas = n!.n
  }
  if (eixo === 'vendedor') {
    const [n] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tarefa t
       WHERE t.tenant_id = tenant_atual() AND t.estado = 'concluida' AND t.concluida_em >= ${p.desde} AND t.concluida_em < ${p.ate}
         AND coalesce(t.concluida_por, t.responsavel_id) = ${chave}::uuid AND ${condicaoTarefa(tx, escopo, 't')}`
    tarefas = n!.n
  }

  const origens = await agruparCoorte(tx,
    { chave: tx`coalesce(k.origem_id::text, 'sem-origem')`, rotulo: tx`coalesce(k.origem, 'Sem origem')` }, t!.contatos, filtro, 10)
  const qual = await agruparCoorte(tx, { chave: QUALIFICACAO_SQL(tx), rotulo: QUALIFICACAO_SQL(tx) }, t!.contatos, filtro, 3)
  const ufs = await agruparCoorte(tx,
    { chave: tx`coalesce(nullif(upper(k.uf), ''), 'sem-uf')`, rotulo: tx`coalesce(nullif(upper(k.uf), ''), 'Sem UF')` }, t!.contatos, filtro, 10)

  return {
    eixo, chave, rotulo: nomeLinha.nome,
    cartoes: {
      contatos: t!.contatos, convertidos: t!.convertidos, taxa: taxaDe(t!.convertidos, t!.contatos), pedidos: t!.pedidos,
      valorCentavos: valor, ticketMedioCentavos: ticketMedio(valor, t!.pedidos), respostas, tarefasConcluidas: tarefas,
    },
    porDia: diasDoPeriodo(p.inicio, p.fim).map((dia) => ({ dia, contatos: porDia.get(dia)?.contatos ?? 0, convertidos: porDia.get(dia)?.convertidos ?? 0 })),
    origens: origens.itens, origensTruncado: origens.truncado,
    qualificacao: qual.itens.map((g) => ({ ...g, rotulo: ROTULO_QUALIFICACAO[g.chave] ?? g.rotulo })),
    ufs: ufs.itens, ufsTruncado: ufs.truncado,
  }
}

// ── Desempenho do cadastro ───────────────────────────────────────────────────────────────────────

export interface CampoCompletude {
  readonly campo: string; readonly rotulo: string; readonly preenchidos: number; readonly total: number; readonly percentual: number
}
export interface RespostaDesempenho {
  readonly contatos: number
  readonly completude: CampoCompletude[]
  readonly cadastroCompleto: number
  readonly tipoPessoa: GrupoCoorte[]
  readonly qualificacao: GrupoCoorte[]
  readonly origem: GrupoCoorte[]
  readonly canal: GrupoCoorte[]
  readonly uf: GrupoCoorte[]
  readonly cidade: GrupoCoorte[]
  readonly funil: GrupoCoorte[]
  readonly truncado: { origem: boolean; canal: boolean; uf: boolean; cidade: boolean; funil: boolean }
}

const CAMPOS_COMPLETUDE: readonly (readonly [string, string])[] = [
  ['telefone', 'Telefone'], ['email', 'E-mail'], ['documento', 'CPF/CNPJ'], ['endereco', 'Cidade e UF'],
  ['origem', 'Origem'], ['vendedor', 'Vendedor'],
]

export async function desempenhoCadastro(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<RespostaDesempenho> {
  await materializarCoorte(tx, p, escopo)
  const [c] = await tx<{ total: number; telefone: number; email: number; documento: number; endereco: number; origem: number; vendedor: number; completos: number }[]>`
    WITH k AS (SELECT * FROM coorte_e3),
    f AS (SELECT k.id,
                 k.telefone IS NOT NULL AS telefone, nullif(trim(k.email), '') IS NOT NULL AS email, k.tipo_doc IS NOT NULL AS documento,
                 (nullif(trim(k.uf), '') IS NOT NULL AND nullif(trim(k.cidade), '') IS NOT NULL) AS endereco,
                 k.origem_id IS NOT NULL AS origem, k.vendedor_id IS NOT NULL AS vendedor FROM k)
    SELECT count(*)::int AS total, count(*) FILTER (WHERE telefone)::int AS telefone, count(*) FILTER (WHERE email)::int AS email,
           count(*) FILTER (WHERE documento)::int AS documento, count(*) FILTER (WHERE endereco)::int AS endereco,
           count(*) FILTER (WHERE origem)::int AS origem, count(*) FILTER (WHERE vendedor)::int AS vendedor,
           count(*) FILTER (WHERE telefone AND email AND documento AND endereco AND origem AND vendedor)::int AS completos FROM f`
  const total = c!.total
  const completude = CAMPOS_COMPLETUDE.map(([campo, rotulo]) => {
    const n = c![campo as 'telefone']
    return { campo, rotulo, preenchidos: n, total, percentual: fatia(n, total) }
  })

  const TIPO = tx`coalesce(k.tipo_doc, 'sem')`
  const tipoPessoa = await agruparCoorte(tx, { chave: TIPO, rotulo: TIPO }, total, undefined, 3)
  const ROT_TIPO: Record<string, string> = { cpf: 'Pessoa física (CPF)', cnpj: 'Pessoa jurídica (CNPJ)', sem: 'Sem documento' }
  const qualificacao = await agruparCoorte(tx, { chave: QUALIFICACAO_SQL(tx), rotulo: QUALIFICACAO_SQL(tx) }, total, undefined, 3)
  const origem = await agruparCoorte(tx,
    { chave: tx`coalesce(k.origem_id::text, 'sem-origem')`, rotulo: tx`coalesce(k.origem, 'Sem origem')` }, total)
  const uf = await agruparCoorte(tx,
    { chave: tx`coalesce(nullif(upper(k.uf), ''), 'sem-uf')`, rotulo: tx`coalesce(nullif(upper(k.uf), ''), 'Sem UF')` }, total)
  const cidade = await agruparCoorte(tx, {
    chave: tx`coalesce(upper(nullif(k.uf, '')) || '|' || lower(nullif(trim(k.cidade), '')), 'sem-cidade')`,
    rotulo: tx`coalesce(nullif(trim(k.cidade), '') || ' / ' || upper(nullif(k.uf, '')), nullif(trim(k.cidade), ''), 'Sem cidade')`,
  }, total)
  const canal = await agruparCoorte(tx, {
    chave: tx`coalesce(cn.canal_id::text, 'sem-conversa')`, rotulo: tx`coalesce(cc.nome_amigavel, 'Sem conversa')`,
    juncao: tx`LEFT JOIN LATERAL (SELECT DISTINCT cv.canal_id FROM conversa cv
                                   WHERE cv.tenant_id = tenant_atual() AND cv.contato_id = k.id) cn ON true
               LEFT JOIN canal_conectado cc ON cc.tenant_id = tenant_atual() AND cc.id = cn.canal_id`,
  }, total)
  const funil = await agruparCoorte(tx, {
    chave: tx`coalesce(fe.chave, 'sem-etapa')`, rotulo: tx`coalesce(fe.nome, 'Sem etapa')`,
    juncao: tx`LEFT JOIN LATERAL (SELECT op.etapa_id FROM oportunidade op
                                   WHERE op.tenant_id = tenant_atual() AND op.contato_id = k.id
                                   ORDER BY (op.estado = 'aberta') DESC, op.criado_em DESC LIMIT 1) atual ON true
               LEFT JOIN funil_etapa fe ON fe.tenant_id = tenant_atual() AND fe.id = atual.etapa_id`,
  }, total)

  return {
    contatos: total, completude, cadastroCompleto: c!.completos,
    tipoPessoa: tipoPessoa.itens.map((g) => ({ ...g, rotulo: ROT_TIPO[g.chave] ?? g.rotulo })),
    qualificacao: qualificacao.itens.map((g) => ({ ...g, rotulo: ROTULO_QUALIFICACAO[g.chave] ?? g.rotulo })),
    origem: origem.itens, canal: canal.itens, uf: uf.itens, cidade: cidade.itens, funil: funil.itens,
    truncado: { origem: origem.truncado, canal: canal.truncado, uf: uf.truncado, cidade: cidade.truncado, funil: funil.truncado },
  }
}

// ── Motivos de perda e imprimíveis ───────────────────────────────────────────────────────────────

export interface MotivoPerda { readonly chave: string; readonly rotulo: string; readonly total: number; readonly percentual: number }

/** Oportunidades PERDIDAS no período (`fechada_em`, fuso do tenant) por motivo; top 100 com `truncado`. */
export async function motivosDePerda(tx: Sql, p: PeriodoResolvido, escopo: Escopo): Promise<{
  total: number; itens: MotivoPerda[]; truncado: boolean
}> {
  const linhas = await tx<{ chave: string; rotulo: string; n: number }[]>`
    SELECT coalesce(o.motivo_perda_codigo, 'sem-motivo') AS chave, coalesce(min(m.nome), min(o.motivo_perda_codigo), 'Sem motivo') AS rotulo,
           count(*)::int AS n
      FROM oportunidade o
      LEFT JOIN motivo_perda m ON m.tenant_id = o.tenant_id AND m.codigo = o.motivo_perda_codigo
     WHERE o.tenant_id = tenant_atual() AND o.estado = 'perdida'
       AND o.fechada_em >= ${p.desde} AND o.fechada_em < ${p.ate} AND ${condicaoOportunidade(tx, escopo, 'o')}
     GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 101`
  const truncado = linhas.length > 100
  const [t] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM oportunidade o
     WHERE o.tenant_id = tenant_atual() AND o.estado = 'perdida'
       AND o.fechada_em >= ${p.desde} AND o.fechada_em < ${p.ate} AND ${condicaoOportunidade(tx, escopo, 'o')}`
  const total = t!.n
  return {
    total, truncado,
    itens: (truncado ? linhas.slice(0, 100) : linhas).map((l) => ({ chave: l.chave, rotulo: l.rotulo, total: l.n, percentual: fatia(l.n, total) })),
  }
}

/** Pacote dos imprimíveis: funil (foto de agora), origens, motivos de perda e WhatsApp, no mesmo período. */
export async function imprimiveis(tx: Sql, p: PeriodoResolvido, escopo: Escopo, limiteMin: number) {
  return {
    funil: await funilAtual(tx, escopo),
    origens: await contatosPorDimensao(tx, 'origem', p, escopo),
    motivosPerda: await motivosDePerda(tx, p, escopo),
    whatsapp: await relatorioWhatsapp(tx, p, escopo, limiteMin),
  }
}
