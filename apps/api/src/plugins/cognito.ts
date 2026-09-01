import { CognitoJwtVerifier } from 'aws-jwt-verify'

/**
 * Verificação do JWT do Cognito — a origem REAL do tenant (ADR-001).
 *
 * ⚠️ O tenant vem de `custom:tenant_id`, um claim do ID token ASSINADO pela
 * Meta... digo, pela AWS. Não é o `x-tenant-id` do dogfooding: aquele é um
 * bypass total, e existe só fora de produção. Aqui a confiança vem da
 * assinatura RS256 verificada contra o JWKS do pool — o cliente não consegue
 * forjar o tenant sem a chave privada da AWS.
 *
 * ⚠️ Usa o ID token, não o access token: `custom:tenant_id` é atributo do
 * usuário, e atributos só viajam no ID token. Trocar por access token sem um
 * Lambda de Pre-Token faria o claim sumir e todo request cair sem tenant.
 */

export interface IdentidadeCognito {
  readonly tenantId: string
  readonly sub: string
  readonly email?: string | undefined
  /**
   * Grupos do pool (`cognito:groups`). Hoje só o `staff` importa — é o que
   * autoriza as rotas de plataforma (cadastro de cliente).
   *
   * ⚠️ Vem do token ASSINADO, nunca de tabela nossa: revogar o acesso é tirar a
   * pessoa do grupo no Cognito, e o efeito vale no próximo token — sem depender
   * de nenhum estado no nosso banco poder ficar dessincronizado.
   */
  readonly grupos: readonly string[]
}

export interface VerificadorCognito {
  verificar(token: string): Promise<IdentidadeCognito>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Cria o verificador a partir do ambiente. Devolve `null` quando o Cognito não
 * está configurado — nesse caso a API cai no header de dev (se ligado), o que
 * mantém o dogfooding funcionando sem Cognito.
 *
 * ⚠️ Em produção, `null` aqui NÃO pode virar "sem autenticação": a checagem
 * `exigirCognitoEmProducao()` abaixo derruba o boot se faltar config em prod.
 */
export function criarVerificadorCognito(): VerificadorCognito | null {
  const userPoolId = process.env.COGNITO_USER_POOL_ID
  const clientId = process.env.COGNITO_CLIENT_ID
  if (!userPoolId || !clientId) return null

  // ⚠️ O verificador CACHEIA o JWKS (as chaves públicas do pool) — não busca a
  //    cada request. Sem cache, cada chamada faria um round-trip à AWS e o
  //    inbox pagaria latência de rede por mensagem.
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id',
    clientId,
  })

  return {
    async verificar(token) {
      // ⚠️ `verify` checa assinatura, emissor, expiração, `aud` (clientId) e
      //    `token_use` de uma vez. Falha lança — e falha de token é 401, não 500.
      const payload = await verifier.verify(token)
      const tenantId = payload['custom:tenant_id']
      if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
        // ⚠️ Usuário autenticado mas SEM tenant válido é erro de PROVISIONAMENTO,
        //    não de login: alguém foi criado sem custom:tenant_id. Recusar é
        //    obrigatório — deixar passar rodaria a query com tenant nulo e a RLS
        //    devolveria vazio, mascarando o problema como "não tem dados".
        throw new Error('cognito: usuário sem custom:tenant_id válido')
      }
      const grupos = payload['cognito:groups']
      return {
        tenantId,
        sub: String(payload.sub),
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
        grupos: Array.isArray(grupos) ? grupos.filter((g): g is string => typeof g === 'string') : [],
      }
    },
  }
}

/**
 * ⚠️ Trava de segurança: em produção, autenticação NÃO é opcional. Se o Cognito
 * não estiver configurado em prod, o processo NÃO sobe — falhar no boot é
 * infinitamente melhor que subir uma API que aceita qualquer um (ou ninguém).
 */
export function exigirCognitoEmProducao(verificador: VerificadorCognito | null): void {
  if (process.env.NODE_ENV === 'production' && !verificador) {
    throw new Error(
      'COGNITO_USER_POOL_ID e COGNITO_CLIENT_ID são obrigatórios em produção — ' +
        'sem eles a API não tem como autenticar ninguém.',
    )
  }
}
