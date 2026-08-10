import type { Credencial, MotivoFalhaTeste } from '../credencial.js'

/**
 * Autenticação do GeraCloud.
 *
 * ⚠️ O GeraCloud NÃO aceita usuário e senha na API. Ele usa Keycloak: o login
 * troca usuário+senha por um token no servidor de identidade, e é o TOKEN que
 * vai para a API. Descoberto lendo o frontend em produção e confirmado no
 * fonte do pdv-core (`@ApplicationPath("/api/v1")`, `RecursoEmpresa`).
 *
 * ⚠️ A pessoa continua digitando usuário e senha — os mesmos da retaguarda. O
 * Keycloak é detalhe de implementação do adaptador; não vaza para a tela.
 */

/**
 * Configuração do realm. ⚠️ Constantes de FORNECEDOR, não da instância do
 * cliente: o Keycloak é o mesmo para todas as lojas (`auth.geracloud.com.br`);
 * o que muda por cliente é só a URL da API (`baseUrl` na credencial).
 *
 * ⚠️ O `clientSecret` vem do bundle público do frontend — já é distribuído a
 * qualquer navegador que abre o sistema, então não é segredo de verdade; é
 * config do client `modulo-retaguardaview`. Fica overridável por ambiente para
 * o dia em que a Gera3 nos der um client dedicado, sem exigir troca de código.
 */
export const KEYCLOAK_GERACLOUD = {
  tokenUrl: 'https://auth.geracloud.com.br/auth/realms/GERA3/protocol/openid-connect/token',
  clientId: 'modulo-retaguardaview',
  clientSecret: 'bd82bd01-e543-4531-bb53-794196595426',
} as const

/** Endpoint de sonda: exige auth E devolve a empresa do usuário logado. */
export const CAMINHO_SONDA_GERACLOUD = 'empresas/usuario-logado'

export interface Autenticado {
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  /** Segundos até o access token expirar — o conector renova antes disso. */
  readonly expiraEm: number
}

export type ResultadoAuth =
  | { ok: true; sessao: Autenticado }
  | { ok: false; motivo: MotivoFalhaTeste; detalhe?: string }

/**
 * Faz o `password grant` no Keycloak.
 *
 * ⚠️ Recebe o `fetch` de fora em vez de usar o global: é o único ponto de rede,
 * e o teste precisa substituí-lo sem subir um Keycloak. Também é o que mantém
 * este pacote livre de framework — ele é consumido por Angular, Expo E API, e
 * um `import` de cliente HTTP quebraria dois dos três (regra de `packages`).
 */
export async function autenticarGeraCloud(
  credencial: Credencial,
  fetchFn: typeof fetch,
): Promise<ResultadoAuth> {
  const corpo = new URLSearchParams({
    grant_type: 'password',
    client_id: KEYCLOAK_GERACLOUD.clientId,
    client_secret: KEYCLOAK_GERACLOUD.clientSecret,
    username: credencial['usuario'] ?? '',
    password: credencial['senha'] ?? '',
  })

  let resposta: Response
  try {
    resposta = await fetchFn(KEYCLOAK_GERACLOUD.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: corpo.toString(),
    })
  } catch {
    // Sem alcançar o Keycloak: a ação é esperar, não redigitar.
    return { ok: false, motivo: 'indisponivel', detalhe: 'servidor de login não respondeu' }
  }

  if (resposta.status === 200) {
    const dados = (await resposta.json().catch(() => null)) as
      | { access_token?: string; refresh_token?: string; expires_in?: number }
      | null
    if (!dados?.access_token) {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'login sem access_token' }
    }
    return {
      ok: true,
      sessao: {
        accessToken: dados.access_token,
        refreshToken: dados.refresh_token,
        expiraEm: dados.expires_in ?? 60,
      },
    }
  }

  // ⚠️ 400/401 do Keycloak precisam ser DISTINGUIDOS pelo corpo, não só pelo
  //    código: `invalid_grant` é senha errada (ação da pessoa); `invalid_client`
  //    é a NOSSA configuração de client errada (ação nossa, não dela). Tratar os
  //    dois como "credencial inválida" mandaria o lojista redigitar por um
  //    problema que não é dele e que redigitar nunca resolve.
  if (resposta.status === 400 || resposta.status === 401) {
    const erro = (await resposta.json().catch(() => null)) as { error?: string } | null
    if (erro?.error === 'invalid_grant') {
      return { ok: false, motivo: 'credencial_invalida' }
    }
    if (erro?.error === 'invalid_client' || erro?.error === 'unauthorized_client') {
      return { ok: false, motivo: 'resposta_inesperada', detalhe: 'configuração de client do GeraCRM' }
    }
    return { ok: false, motivo: 'credencial_invalida' }
  }

  if (resposta.status >= 500) {
    return { ok: false, motivo: 'indisponivel', detalhe: `login HTTP ${resposta.status}` }
  }
  return { ok: false, motivo: 'resposta_inesperada', detalhe: `login HTTP ${resposta.status}` }
}
