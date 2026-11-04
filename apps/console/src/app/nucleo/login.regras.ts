// Regras PURAS do "esqueci a senha" na tela de login (vitest em node: nada de Angular aqui).

export type EtapaLogin = 'entrar' | 'esqueci_email' | 'esqueci_codigo'

export type ResultadoRecuperacao =
  | { readonly tipo: 'ok'; readonly mensagem: string }
  | { readonly tipo: 'erro'; readonly mensagem: string; readonly campos?: Readonly<Record<string, string>> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export const SENHA_MINIMA = 8

export const emailValido = (v: string): boolean => EMAIL.test(v.trim())

/** Etapa 1: o e-mail. Mensagem de erro por campo, ou `{}`. */
export function errosDoEmail(usuario: string): Readonly<Record<string, string>> {
  return emailValido(usuario) ? {} : { usuario: 'Informe o e-mail do seu cadastro.' }
}

/** Etapa 2: código recebido e nova senha. */
export function errosDaRedefinicao(codigo: string, novaSenha: string, confirmacao: string): Readonly<Record<string, string>> {
  const e: Record<string, string> = {}
  if (!/^\d{4,10}$/.test(codigo.trim())) e['codigo'] = 'Digite o código de 6 dígitos enviado ao seu e-mail.'
  if (novaSenha.length < SENHA_MINIMA) e['novaSenha'] = `A nova senha precisa de pelo menos ${SENHA_MINIMA} caracteres.`
  if (confirmacao !== novaSenha) e['confirmacao'] = 'A confirmação não é igual à nova senha.'
  return e
}

/**
 * Resposta da API → o que a tela mostra. ⚠️ Os erros são tipificados (`erro`) e a mensagem já vem com a
 * ação corretiva; o `padrao` cobre só rede caída e 5xx sem corpo.
 */
export function resultadoDaRecuperacao(
  status: number, corpo: { erro?: string; mensagem?: string; campos?: Record<string, string> },
): ResultadoRecuperacao {
  if (status >= 200 && status < 300) {
    return { tipo: 'ok', mensagem: corpo.mensagem ?? 'Pronto.' }
  }
  if (status === 0) return { tipo: 'erro', mensagem: 'Sem conexão com o servidor. Confira a rede e tente de novo.' }
  if (status === 429) return { tipo: 'erro', mensagem: corpo.mensagem ?? 'Muitas tentativas. Aguarde alguns minutos.' }
  return {
    tipo: 'erro',
    mensagem: corpo.mensagem ?? 'Não foi possível concluir. Tente de novo.',
    ...(corpo.campos ? { campos: corpo.campos } : {}),
  }
}
