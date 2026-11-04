/**
 * PORTA DE SENHA — o que a PESSOA faz com a própria senha (D4): trocar, esquecer, redefinir.
 *
 * É irmã de `ProvedorIdentidade` (que é do ADMIN: criar, desativar, redefinir senha de outro). As rotas
 * falam com esta interface, nunca com o Cognito; o adaptador real é `provedor-senha-cognito.ts` e o dos
 * testes é `provedor-senha-falso.ts` — nenhum teste chama a AWS.
 *
 * ⚠️ Falha esperada é RETORNO tipificado, não exceção: senha atual errada, política de senha, código
 *    errado/expirado e limite de tentativas são estados que a tela precisa nomear.
 *
 * ⚠️ O login no provedor é o E-MAIL (minúsculo), como no resto da identidade.
 */

export type ResultadoTrocaSenha =
  | { readonly tipo: 'ok' }
  | { readonly tipo: 'senha_atual_errada' }
  /** A nova senha não atende à política do provedor (`mensagem` é a do provedor, para a tela). */
  | { readonly tipo: 'senha_invalida'; readonly mensagem: string }
  | { readonly tipo: 'limite' }
  | { readonly tipo: 'indisponivel' }

export type ResultadoEsqueciSenha =
  /** ⚠️ Vale para e-mail existente OU NÃO: o provedor nunca é consultado de um jeito que vaze existência. */
  | { readonly tipo: 'ok' }
  | { readonly tipo: 'indisponivel' }

export type ResultadoRedefinicao =
  | { readonly tipo: 'ok' }
  /** Código errado, ou e-mail sem pedido de redefinição (as duas coisas são a MESMA resposta). */
  | { readonly tipo: 'codigo_invalido' }
  | { readonly tipo: 'codigo_expirado' }
  | { readonly tipo: 'senha_invalida'; readonly mensagem: string }
  | { readonly tipo: 'limite' }
  | { readonly tipo: 'indisponivel' }

export interface ProvedorSenha {
  /** Confere a senha atual e troca (Cognito `ChangePassword`). */
  trocarSenha(email: string, senhaAtual: string, novaSenha: string): Promise<ResultadoTrocaSenha>
  /** Pede o código por e-mail (Cognito `ForgotPassword`). Nunca revela se o e-mail existe. */
  esqueciSenha(email: string): Promise<ResultadoEsqueciSenha>
  /** Confirma o código e define a nova senha (Cognito `ConfirmForgotPassword`). */
  confirmarEsqueciSenha(email: string, codigo: string, novaSenha: string): Promise<ResultadoRedefinicao>
}
