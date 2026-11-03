/**
 * Lista de contatos (A2): vocabulário dos filtros e das ações em massa, igual na
 * API e no console. TypeScript puro — a regra de quem pode o quê fica na API; aqui
 * só os nomes e os limites, para a tela não divergir do servidor.
 */

export const QUALIFICACOES_CONTATO = ['novo', 'qualificado', 'descartado'] as const
export type QualificacaoContato = (typeof QUALIFICACOES_CONTATO)[number]

export const ROTULO_QUALIFICACAO: Readonly<Record<QualificacaoContato, string>> = {
  novo: 'Novo',
  qualificado: 'Qualificado',
  descartado: 'Descartado',
}

export function ehQualificacaoContato(v: unknown): v is QualificacaoContato {
  return typeof v === 'string' && (QUALIFICACOES_CONTATO as readonly string[]).includes(v)
}

/** Valor especial de `vendedorId`: contatos sem dono vigente na carteira. */
export const VENDEDOR_SEM_DONO = 'sem-dono'
/** Etiquetas que o filtro aceita juntas (o contato precisa ter TODAS). */
export const MAX_ETIQUETAS_NO_FILTRO = 5
/** Contatos por ação em massa. */
export const LIMITE_ACAO_EM_MASSA = 500

export const ACOES_EM_MASSA_CONTATO = [
  'qualificar', 'descartar', 'reabrir', 'transferir', 'etiquetar', 'desetiquetar', 'adicionar-lista', 'criar-tarefa',
] as const
export type AcaoEmMassaContato = (typeof ACOES_EM_MASSA_CONTATO)[number]

export function ehAcaoEmMassaContato(v: unknown): v is AcaoEmMassaContato {
  return typeof v === 'string' && (ACOES_EM_MASSA_CONTATO as readonly string[]).includes(v)
}

/** Motivos do descarte MANUAL (o automático da cadência é `sem_resposta`, do sistema). */
export const MOTIVOS_DESCARTE_CONTATO = [
  { codigo: 'sem_interesse', rotulo: 'Sem interesse' },
  { codigo: 'fora_do_perfil', rotulo: 'Fora do perfil' },
  { codigo: 'sem_retorno', rotulo: 'Sem retorno' },
  { codigo: 'duplicado', rotulo: 'Contato duplicado' },
  { codigo: 'dados_invalidos', rotulo: 'Dados inválidos' },
  { codigo: 'outro', rotulo: 'Outro' },
] as const
export type MotivoDescarteContato = (typeof MOTIVOS_DESCARTE_CONTATO)[number]['codigo']

export function ehMotivoDescarteContato(v: unknown): v is MotivoDescarteContato {
  return MOTIVOS_DESCARTE_CONTATO.some((m) => m.codigo === v)
}
export function rotuloMotivoDescarte(codigo: string): string {
  return MOTIVOS_DESCARTE_CONTATO.find((m) => m.codigo === codigo)?.rotulo ?? codigo
}
