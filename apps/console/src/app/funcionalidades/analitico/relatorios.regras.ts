import { DIMENSOES_RELATORIO, type DimensaoRelatorio } from './relatorio-dimensao.config.js'

/**
 * O relatório "folha": o que de fato carrega na tela. É o valor de `?relatorio=` na URL — os ids antigos
 * (antes dos grupos) continuam valendo, então favorito e redirect de rota antiga (`/bi`, `/mapa`,
 * `/performance`, `/nps`, `/mensagens`) caem no lugar certo.
 */
export type Relatorio =
  | 'visao-geral' | 'operacional'
  | 'vendas' | 'conversao'
  | 'vendedores' | 'comparativo'
  | 'contatos' | 'lista' | 'desempenho'
  | 'raio-x'
  | 'atendimento'
  | 'whatsapp' | 'enviadas'
  | 'imprimiveis'

export interface FolhaRelatorio { readonly id: Relatorio; readonly rotulo: string }
export interface GrupoRelatorio { readonly id: string; readonly rotulo: string; readonly folhas: readonly FolhaRelatorio[] }

/**
 * Os relatórios em 8 grupos (eram 14 abas soltas — docs/plano-reorganizacao-console.md). Grupo com uma folha
 * só não mostra a segunda fileira de abas. Contatos mostra as dimensões como folhas (ver `subAbas`).
 */
export const GRUPOS_RELATORIO: readonly GrupoRelatorio[] = [
  { id: 'geral', rotulo: 'Visão geral', folhas: [
    { id: 'visao-geral', rotulo: 'Resumo do período' }, { id: 'operacional', rotulo: 'Mês contra mês' }] },
  { id: 'vendas', rotulo: 'Vendas', folhas: [
    { id: 'vendas', rotulo: 'Por dimensão' }, { id: 'conversao', rotulo: 'Tempo de conversão' }] },
  { id: 'vendedores', rotulo: 'Vendedores', folhas: [
    { id: 'vendedores', rotulo: 'Ranking' }, { id: 'comparativo', rotulo: 'Comparativo' }] },
  { id: 'contatos', rotulo: 'Contatos', folhas: [
    { id: 'contatos', rotulo: 'Por dimensão' }, { id: 'lista', rotulo: 'Lista completa' },
    { id: 'desempenho', rotulo: 'Qualidade do cadastro' }] },
  { id: 'raio-x', rotulo: 'Raio-X', folhas: [{ id: 'raio-x', rotulo: 'Raio-X' }] },
  { id: 'atendimento', rotulo: 'Atendimento', folhas: [{ id: 'atendimento', rotulo: 'Atendimento' }] },
  { id: 'whatsapp', rotulo: 'WhatsApp', folhas: [
    { id: 'whatsapp', rotulo: 'Volume e resposta' }, { id: 'enviadas', rotulo: 'Mensagens enviadas' }] },
  { id: 'imprimiveis', rotulo: 'Imprimíveis', folhas: [{ id: 'imprimiveis', rotulo: 'Imprimíveis' }] },
]

const FOLHAS: readonly Relatorio[] = GRUPOS_RELATORIO.flatMap((g) => g.folhas.map((f) => f.id))
const DIMENSOES: readonly DimensaoRelatorio[] = DIMENSOES_RELATORIO.map((d) => d.chave)

export interface Selecao { readonly folha: Relatorio; readonly dim: DimensaoRelatorio }

/** Lê `?relatorio=&dim=` com tolerância: id desconhecido cai na Visão geral; dimensão desconhecida, na primeira. */
export function selecaoDaUrl(relatorio: string | null | undefined, dim: string | null | undefined): Selecao {
  const folha = FOLHAS.includes(relatorio as Relatorio) ? (relatorio as Relatorio) : 'visao-geral'
  const d = DIMENSOES.includes(dim as DimensaoRelatorio) ? (dim as DimensaoRelatorio) : DIMENSOES[0]!
  return { folha, dim: d }
}

export function grupoDaFolha(folha: Relatorio): GrupoRelatorio {
  return GRUPOS_RELATORIO.find((g) => g.folhas.some((f) => f.id === folha)) ?? GRUPOS_RELATORIO[0]!
}

/** Query params que a URL deve ter para a seleção (`dim` só nos contatos por dimensão). */
export function paramsDaSelecao(s: Selecao): { relatorio: Relatorio; dim: DimensaoRelatorio | null } {
  return { relatorio: s.folha, dim: s.folha === 'contatos' ? s.dim : null }
}

/**
 * A segunda fileira de abas do grupo. No grupo Contatos, as dimensões viram abas ao lado da lista e da
 * qualidade do cadastro (uma fileira só, não três níveis): id `dim:<chave>` para as dimensões.
 */
export function subAbas(grupo: GrupoRelatorio): readonly { id: string; rotulo: string }[] {
  if (grupo.folhas.length < 2) return []
  if (grupo.id !== 'contatos') return grupo.folhas.map((f) => ({ id: f.id, rotulo: f.rotulo }))
  return [
    ...DIMENSOES_RELATORIO.map((d) => ({ id: `dim:${d.chave}`, rotulo: d.aba })),
    ...grupo.folhas.filter((f) => f.id !== 'contatos').map((f) => ({ id: f.id, rotulo: f.rotulo })),
  ]
}

/** Id da sub-aba ativa para a seleção (casa com `subAbas`). */
export function subAbaAtiva(s: Selecao): string {
  return s.folha === 'contatos' ? `dim:${s.dim}` : s.folha
}

/** Clique numa sub-aba → nova seleção (mantém a dimensão atual quando a sub-aba não é de dimensão). */
export function selecaoDaSubAba(id: string, atual: Selecao): Selecao {
  if (id.startsWith('dim:')) return selecaoDaUrl('contatos', id.slice(4))
  return { folha: selecaoDaUrl(id, atual.dim).folha, dim: atual.dim }
}

/** Clique num grupo → a primeira folha dele. */
export function selecaoDoGrupo(grupoId: string, atual: Selecao): Selecao {
  const g = GRUPOS_RELATORIO.find((x) => x.id === grupoId) ?? GRUPOS_RELATORIO[0]!
  return { folha: g.folhas[0]!.id, dim: atual.dim }
}
