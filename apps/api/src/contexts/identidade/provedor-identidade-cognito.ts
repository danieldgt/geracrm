import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  ListUsersCommand,
  UserNotFoundException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider'
import { GRUPO_STAFF } from '../../plugins/tenant.js'
import { cognitoAdminConfigurado } from './cognito-admin.js'
import type {
  AlvoIdentidade, DadosNovoUsuario, ProvedorIdentidade, ResultadoCriacao, ResultadoOperacao,
} from './provedor-identidade.js'

/**
 * Adaptador Cognito da porta `ProvedorIdentidade`.
 *
 * ⚠️ Mesma credencial IAM mínima do `cognito-admin.ts`, acrescida de
 *    `AdminDisableUser`, `AdminEnableUser`, `ListUsers` e
 *    `AdminListGroupsForUser` sobre o ARN do pool. Sem pool ou sem credencial,
 *    toda operação responde `indisponivel` (a tela avisa) — nunca lança.
 *
 * ⚠️ OPERAÇÃO SOBRE LOGIN EXISTENTE (revisão de segurança D3): o login é
 *    localizado pelo `sub` da linha de `usuario` (`ListUsers` com filtro
 *    `sub = "…"`), NUNCA pelo e-mail — e, ANTES de qualquer Admin*, confere que
 *    o `custom:tenant_id` dele é o tenant da requisição e que ele NÃO está no
 *    grupo `staff`. Falhou qualquer um → `recusado`, sem chamar a operação. Sem
 *    isto, uma linha com o e-mail de outra pessoa (o staff que entrou por
 *    sessão PLT-05, ou um e-mail digitado errado) deixava o admin de um cliente
 *    redefinir a senha de quem tem acesso a todos os clientes.
 *
 * ⚠️ Convite: sem senha temporária, o Cognito envia o e-mail de convite com a
 *    senha dele (`DesiredDeliveryMediums: EMAIL`) e o primeiro login cai em
 *    NEW_PASSWORD_REQUIRED — o fluxo `/v1/auth/nova-senha` já trata. Com senha
 *    temporária, o convite é suprimido (quem cadastrou combina a senha) e o
 *    desafio é o mesmo.
 */

/** `sub` do Cognito é UUID; qualquer outra coisa não entra no filtro do ListUsers. */
const SUB_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Conexao = { client: CognitoIdentityProviderClient; poolId: string }

export function provedorIdentidadeCognito(): ProvedorIdentidade {
  const conectar = (): Conexao | null => {
    if (!cognitoAdminConfigurado()) return null
    return {
      client: new CognitoIdentityProviderClient({ region: process.env.COGNITO_REGION ?? 'us-east-1' }),
      poolId: process.env.COGNITO_USER_POOL_ID!,
    }
  }

  /**
   * Localiza pelo `sub` e confere tenant e grupo. Devolve o `Username` para a
   * operação, ou o resultado que encerra (nao_encontrado / recusado).
   */
  const localizar = async (c: Conexao, alvo: AlvoIdentidade): Promise<{ username: string } | ResultadoOperacao> => {
    if (!SUB_VALIDO.test(alvo.sub)) return { tipo: 'nao_encontrado' }
    const r = await c.client.send(new ListUsersCommand({ UserPoolId: c.poolId, Filter: `sub = "${alvo.sub}"`, Limit: 2 }))
    const usuarios = r.Users ?? []
    if (usuarios.length !== 1 || !usuarios[0]!.Username) return { tipo: 'nao_encontrado' }
    const u = usuarios[0]!
    const tenant = u.Attributes?.find((a) => a.Name === 'custom:tenant_id')?.Value
    if (tenant !== alvo.tenantId) return { tipo: 'recusado' }
    const grupos = await c.client.send(new AdminListGroupsForUserCommand({ UserPoolId: c.poolId, Username: u.Username!, Limit: 60 }))
    if ((grupos.Groups ?? []).some((g) => g.GroupName === GRUPO_STAFF)) return { tipo: 'recusado' }
    return { username: u.Username! }
  }

  const operar = async (alvo: AlvoIdentidade, fn: (c: Conexao, username: string) => Promise<unknown>): Promise<ResultadoOperacao> => {
    const c = conectar()
    if (!c) return { tipo: 'indisponivel' }
    try {
      const l = await localizar(c, alvo)
      if ('tipo' in l) return l
      await fn(c, l.username)
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
        // ⚠️ E-mail já no pool (de outro tenant, do staff, ou deste) → o
        //    `UsernameExistsException` vira `email_em_uso`: nunca reaproveita.
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

    desativar: (alvo) => operar(alvo, (c, username) => c.client.send(new AdminDisableUserCommand({
      UserPoolId: c.poolId, Username: username,
    }))),

    reativar: (alvo) => operar(alvo, (c, username) => c.client.send(new AdminEnableUserCommand({
      UserPoolId: c.poolId, Username: username,
    }))),

    redefinirSenha: (alvo, senhaTemporaria) => operar(alvo, (c, username) => c.client.send(new AdminSetUserPasswordCommand({
      UserPoolId: c.poolId, Username: username, Password: senhaTemporaria, Permanent: false,
    }))),
  }
}
