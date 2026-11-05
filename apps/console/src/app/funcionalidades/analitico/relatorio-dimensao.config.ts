/**
 * Configuração por dimensão do relatório "Contatos por…" (E1). Um componente (`app-relatorio-dimensao`),
 * várias dimensões: o que muda de uma para outra mora aqui, não em `if` no template.
 * A chave casa com `:dimensao` de `GET /v1/relatorios/contatos-por/:dimensao`.
 */
export type DimensaoRelatorio = 'origem' | 'etapa' | 'vendedor' | 'dia-semana' | 'qualificacao' | 'uf'

export interface ConfigDimensao {
  readonly chave: DimensaoRelatorio
  /** Rótulo da aba. */
  readonly aba: string
  readonly titulo: string
  /** Cabeçalho da primeira coluna da tabela. */
  readonly colunaRotulo: string
  readonly vazio: string
}

export const DIMENSOES_RELATORIO: readonly ConfigDimensao[] = [
  { chave: 'origem', aba: 'Origem', titulo: 'Contatos por origem', colunaRotulo: 'Origem',
    vazio: 'Nenhum contato novo no período. Cadastre origens em Etiquetas e origens e informe a origem ao criar o contato.' },
  { chave: 'etapa', aba: 'Etapa', titulo: 'Contatos por etapa do funil', colunaRotulo: 'Etapa',
    vazio: 'Nenhum contato novo no período para distribuir pelas etapas do funil.' },
  { chave: 'vendedor', aba: 'Vendedor', titulo: 'Contatos por vendedor', colunaRotulo: 'Vendedor',
    vazio: 'Nenhum contato novo no período. A carteira atual do contato define o vendedor.' },
  { chave: 'dia-semana', aba: 'Dia da semana', titulo: 'Contatos por dia da semana', colunaRotulo: 'Dia da semana',
    vazio: 'Nenhum contato novo no período.' },
  { chave: 'qualificacao', aba: 'Qualificação', titulo: 'Contatos por qualificação', colunaRotulo: 'Qualificação',
    vazio: 'Nenhum contato novo no período.' },
  { chave: 'uf', aba: 'UF', titulo: 'Contatos por UF', colunaRotulo: 'UF',
    vazio: 'Nenhum contato novo no período. A UF vem do endereço principal do contato.' },
]

export function configDaDimensao(chave: DimensaoRelatorio): ConfigDimensao {
  return DIMENSOES_RELATORIO.find((d) => d.chave === chave) ?? DIMENSOES_RELATORIO[0]!
}
