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
 *    sempre (ver cognito-admin.ts). As operações sobre um login existente
 *    localizam pelo `sub` (`AlvoIdentidade`), nunca pelo e-mail.
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
  /**
   * O login existe, mas NÃO é deste tenant (`custom:tenant_id` diferente) ou é
   * do grupo `staff`. A operação NÃO foi chamada (revisão de segurança D3).
   */
  | { readonly tipo: 'recusado' }

/**
 * QUEM é o alvo de uma operação administrativa: o `sub` gravado na linha de
 * `usuario` (nunca o e-mail — e-mail é texto que o cadastro controla) e o
 * tenant da REQUISIÇÃO (`req.tenantId`, ADR-001).
 *
 * ⚠️ Todo adaptador, ANTES de qualquer operação, confere no provedor que o
 *    `custom:tenant_id` do login é `tenantId` e que ele NÃO está no grupo
 *    `staff` — senão responde `recusado` sem operar. É a segunda camada contra
 *    o admin de um cliente redefinir a senha (ou bloquear) a conta de alguém de
 *    outra empresa ou do staff.
 */
export interface AlvoIdentidade {
  readonly sub: string
  readonly tenantId: string
}

export interface ProvedorIdentidade {
  /**
   * Cria o login. E-mail que JÁ existe no provedor — de qualquer tenant, ou do
   * staff — é `email_em_uso`: o login existente NUNCA é reaproveitado.
   */
  criarUsuario(dados: DadosNovoUsuario): Promise<ResultadoCriacao>
  /** Bloqueia o login no provedor (o usuário continua existindo). */
  desativar(alvo: AlvoIdentidade): Promise<ResultadoOperacao>
  reativar(alvo: AlvoIdentidade): Promise<ResultadoOperacao>
  /** Define uma senha TEMPORÁRIA: o próximo login exige trocar. */
  redefinirSenha(alvo: AlvoIdentidade, senhaTemporaria: string): Promise<ResultadoOperacao>
}
