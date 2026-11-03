/**
 * PROVEDOR DE IDENTIDADE — a porta do NOSSO domínio para "quem pode entrar".
 *
 * O cadastro de usuários (rotas-usuarios.ts) fala com esta interface, nunca com
 * o SDK do Cognito: trocar de IdP (skill geracrm-identidade-acesso, "lock-in
 * mitigado por desenho") é trocar o adaptador, não as rotas. O adaptador real
 * é `provedor-identidade-cognito.ts`; o falso (`provedor-identidade-falso.ts`)
 * é o dos testes — nenhum teste chama a AWS.
 *
 * ⚠️ Falha esperada é RETORNO tipificado, não exceção: e-mail já existente no
 *    pool e provedor não configurado são estados que a tela precisa nomear.
 *    Exceção fica para o inesperado (rede, credencial recusada).
 *
 * ⚠️ O login no provedor é o E-MAIL (minúsculo). O `custom:tenant_id` é gravado
 *    na criação e é IMUTÁVEL no pool — um e-mail pertence a um tenant para
 *    sempre (ver cognito-admin.ts).
 */

export interface DadosNovoUsuario {
  readonly email: string
  readonly nome: string
  readonly tenantId: string
  /**
   * Senha TEMPORÁRIA opcional. Sem ela, o provedor manda o convite por e-mail
   * com a senha dele; com ela, o primeiro login cai no desafio de nova senha
   * (`/v1/auth/nova-senha`), que o console já trata.
   */
  readonly senhaTemporaria?: string | undefined
}

export type ResultadoCriacao =
  | { readonly tipo: 'ok'; readonly sub: string }
  /** O e-mail já existe no POOL (pode ser de outro tenant — o tenant é imutável). */
  | { readonly tipo: 'email_em_uso' }
  /** A senha temporária não atende à política do provedor. */
  | { readonly tipo: 'senha_invalida' }
  | { readonly tipo: 'indisponivel' }

export type ResultadoOperacao =
  | { readonly tipo: 'ok' }
  | { readonly tipo: 'nao_encontrado' }
  | { readonly tipo: 'senha_invalida' }
  | { readonly tipo: 'indisponivel' }

export interface ProvedorIdentidade {
  criarUsuario(dados: DadosNovoUsuario): Promise<ResultadoCriacao>
  /** Bloqueia o login no provedor (o usuário continua existindo). */
  desativar(email: string): Promise<ResultadoOperacao>
  reativar(email: string): Promise<ResultadoOperacao>
  /** Define uma senha TEMPORÁRIA: o próximo login exige trocar. */
  redefinirSenha(email: string, senhaTemporaria: string): Promise<ResultadoOperacao>
}
