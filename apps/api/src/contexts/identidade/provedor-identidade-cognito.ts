import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UserNotFoundException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider'
import { cognitoAdminConfigurado } from './cognito-admin.js'
import type { DadosNovoUsuario, ProvedorIdentidade, ResultadoCriacao, ResultadoOperacao } from './provedor-identidade.js'

/**
 * Adaptador Cognito da porta `ProvedorIdentidade`.
 *
 * ⚠️ Mesma credencial IAM mínima do `cognito-admin.ts`, acrescida de
 *    `AdminDisableUser` e `AdminEnableUser` sobre o ARN do pool. Sem pool ou
 *    sem credencial, toda operação responde `indisponivel` (a tela avisa) —
 *    nunca lança.
 *
 * ⚠️ Convite: sem senha temporária, o Cognito envia o e-mail de convite com a
 *    senha dele (`DesiredDeliveryMediums: EMAIL`) e o primeiro login cai em
 *    NEW_PASSWORD_REQUIRED — o fluxo `/v1/auth/nova-senha` já trata. Com senha
 *    temporária, o convite é suprimido (quem cadastrou combina a senha) e o
 *    desafio é o mesmo.
 */
export function provedorIdentidadeCognito(): ProvedorIdentidade {
  const conectar = (): { client: CognitoIdentityProviderClient; poolId: string } | null => {
    if (!cognitoAdminConfigurado()) return null
    return {
      client: new CognitoIdentityProviderClient({ region: process.env.COGNITO_REGION ?? 'us-east-1' }),
      poolId: process.env.COGNITO_USER_POOL_ID!,
    }
  }

  const operar = async (fn: (c: { client: CognitoIdentityProviderClient; poolId: string }) => Promise<unknown>): Promise<ResultadoOperacao> => {
    const c = conectar()
    if (!c) return { tipo: 'indisponivel' }
    try {
      await fn(c)
      return { tipo: 'ok' }
    } catch (e) {
      if (e instanceof UserNotFoundException) return { tipo: 'nao_encontrado' }
      if (e instanceof InvalidPasswordException) return { tipo: 'senha_invalida' }
      throw e
    }
  }

  return {
    async criarUsuario(dados: DadosNovoUsuario): Promise<ResultadoCriacao> {
      const c = conectar()
      if (!c) return { tipo: 'indisponivel' }
      const email = dados.email.trim().toLowerCase()
      try {
        const criado = await c.client.send(new AdminCreateUserCommand({
          UserPoolId: c.poolId,
          Username: email,
          ...(dados.senhaTemporaria
            ? { TemporaryPassword: dados.senhaTemporaria, MessageAction: 'SUPPRESS' as const }
            : { DesiredDeliveryMediums: ['EMAIL' as const] }),
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'name', Value: dados.nome.trim() },
            { Name: 'custom:tenant_id', Value: dados.tenantId },
          ],
        }))
        const sub = criado.User?.Attributes?.find((a) => a.Name === 'sub')?.Value
        if (!sub) throw new Error('cognito: AdminCreateUser não devolveu o sub')
        return { tipo: 'ok', sub }
      } catch (e) {
        if (e instanceof UsernameExistsException) return { tipo: 'email_em_uso' }
        if (e instanceof InvalidPasswordException) return { tipo: 'senha_invalida' }
        throw e
      }
    },

    desativar: (email) => operar((c) => c.client.send(new AdminDisableUserCommand({
      UserPoolId: c.poolId, Username: email.trim().toLowerCase(),
    }))),

    reativar: (email) => operar((c) => c.client.send(new AdminEnableUserCommand({
      UserPoolId: c.poolId, Username: email.trim().toLowerCase(),
    }))),

    redefinirSenha: (email, senhaTemporaria) => operar((c) => c.client.send(new AdminSetUserPasswordCommand({
      UserPoolId: c.poolId, Username: email.trim().toLowerCase(), Password: senhaTemporaria, Permanent: false,
    }))),
  }
}
