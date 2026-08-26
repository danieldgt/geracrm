import { PlataformaGoogleAds } from './google-ads.js'
import { ProvedorTokenGoogle } from './google-oauth.js'
import { PlataformaNaoImplementada, type PortaPlataformaMidia } from './porta.js'

/**
 * Monta o adaptador de cada plataforma a partir das VARIÁVEIS DE AMBIENTE.
 *
 * ⚠️ **A credencial do Google Ads é da PLATAFORMA, não do tenant** — e essa é a
 * diferença que decide onde ela mora.
 *
 * | | Credencial de canal (WhatsApp) | Credencial do Google Ads |
 * |---|---|---|
 * | De quem é | **do tenant** — cada cliente traz a sua | **nossa** — uma MCC serve todos |
 * | Onde mora | cifrada em `canal_conectado` | ⚠️ **variável de ambiente** |
 * | Quantas | uma por número | **uma só** |
 *
 * É por isso que aqui NÃO há tabela nem cifragem por tenant: o que muda por
 * cliente é só o `customerId` na chamada. Guardar isto por tenant criaria N
 * cópias do mesmo segredo, com N chances de vazar e nenhuma vantagem.
 *
 * ⚠️ Em produção (Railway) as variáveis vêm do painel do serviço. Em dev, do
 * `.env`. Nunca de arquivo dentro do repositório — ver `.gitignore`.
 */

export interface ConfigGoogleAds {
  readonly developerToken: string
  readonly loginCustomerId: string
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
}

/** O que falta para o Google funcionar, em linguagem de quem vai configurar. */
export function faltaParaGoogle(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const exigidas = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ] as const
  return exigidas.filter((v) => !env[v]?.trim())
}

export function configGoogleDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigGoogleAds | null {
  if (faltaParaGoogle(env).length > 0) return null
  return {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    // ⚠️ Só dígitos: o painel mostra `123-276-0756`, a API quer `1232760756`.
    //    Aceitar os dois formatos evita um 403 que ninguém entende.
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!.replace(/\D/g, ''),
    clientId: env.GOOGLE_OAUTH_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!.trim(),
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN!.trim(),
  }
}

/**
 * Constrói o adaptador de uma plataforma.
 *
 * ⚠️ Sem configuração, devolve `PlataformaNaoImplementada` em vez de `null` ou de
 * lançar exceção: "não temos isso" vira um resultado NOMEADO, com capacidades
 * todas em `false`. O despachante de conversões já sabe lidar — ele descarta com
 * `plataforma_sem_capacidade` em vez de tentar oito vezes contra o vazio.
 */
export function adaptadorDaPlataforma(
  plataforma: string,
  opcoes: { env?: NodeJS.ProcessEnv; buscar?: typeof fetch } = {},
): PortaPlataformaMidia {
  const env = opcoes.env ?? process.env

  if (plataforma === 'google') {
    const cfg = configGoogleDoAmbiente(env)
    if (!cfg) return new PlataformaNaoImplementada('google')

    const provedor = new ProvedorTokenGoogle(
      { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken },
      // ⚠️ `exactOptionalPropertyTypes`: passar `buscar: undefined` é erro de
      //    tipo. O espalhamento condicional omite a chave em vez de zerá-la.
      opcoes.buscar ? { buscar: opcoes.buscar } : {},
    )
    return new PlataformaGoogleAds(
      {
        developerToken: cfg.developerToken,
        loginCustomerId: cfg.loginCustomerId,
        obterAccessToken: () => provedor.obter(),
      },
      opcoes.buscar ? { buscar: opcoes.buscar } : {},
    )
  }

  // Meta e TikTok: ainda não implementados (AMK-017 manteve o Google primeiro).
  return new PlataformaNaoImplementada(plataforma as never)
}
