/**
 * Mensagem de falha ao SALVAR na tela de empresa (decisão (s), plano-port §4).
 *
 * ⚠️ Nunca "erro genérico": 403 é falta de papel e a tela diz quem pode;
 *    422 é regra de negócio e a tela mostra o que o servidor explicou
 *    (`mensagem`). O resto é falha de rede/servidor, com convite a tentar de novo.
 *
 * Regra pura (sem Angular): recebe qualquer coisa com a forma de um
 * `HttpErrorResponse` (`status` + `error`).
 */
export const TEXTO_SO_ADMIN = 'Só um administrador pode alterar isso.'

export function mensagemFalhaAoSalvar(e: unknown, padrao = 'Não foi possível salvar. Tente de novo.'): string {
  if (!e || typeof e !== 'object' || typeof (e as { status?: unknown }).status !== 'number') return padrao
  const { status, error } = e as { status: number; error?: unknown }
  if (status === 403) return TEXTO_SO_ADMIN
  const mensagem = error && typeof error === 'object' && typeof (error as { mensagem?: unknown }).mensagem === 'string'
    ? ((error as { mensagem: string }).mensagem).trim() : ''
  if (status === 422 && mensagem) return mensagem
  if (status === 0) return 'Sem conexão com o servidor. Tente de novo.'
  return padrao
}
