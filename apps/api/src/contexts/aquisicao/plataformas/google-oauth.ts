import type { MotivoFalhaPlataforma, ResultadoPlataforma } from './porta.js'

/**
 * Provedor de access token do Google (OAuth 2.0).
 *
 * ⚠️ Existe porque **access token dura ~1 hora** e o adaptador vive num worker de
 * dias. Guardar o token como string fixa na credencial — como o adaptador fazia
 * antes — funcionaria no primeiro teste e falharia em silêncio na segunda hora de
 * produção, com `401` que pareceria credencial errada.
 *
 * O que é longo é o **refresh token**; o access token é derivado dele e trocado
 * quando envelhece.
 */

export interface CredencialOAuthGoogle {
  readonly clientId: string
  readonly clientSecret: string
  /** ⚠️ O que realmente precisa ser guardado com cuidado. Vive em env var. */
  readonly refreshToken: string
}

/** Renova com folga: token que expira em menos disto é trocado antes de usar. */
const FOLGA_SEGUNDOS = 300

export class ProvedorTokenGoogle {
  readonly #cred: CredencialOAuthGoogle
  readonly #buscar: typeof fetch
  readonly #agora: () => number
  #cache: { token: string; expiraEm: number } | null = null

  constructor(
    cred: CredencialOAuthGoogle,
    opcoes: { buscar?: typeof fetch; agora?: () => number } = {},
  ) {
    this.#cred = cred
    this.#buscar = opcoes.buscar ?? fetch
    this.#agora = opcoes.agora ?? (() => Date.now())
  }

  /**
   * Devolve um access token válido, renovando se necessário.
   *
   * ⚠️ O cache é por instância e em memória — não vai ao banco. Access token é
   * derivável a qualquer momento a partir do refresh; persistir só criaria mais
   * um segredo para vazar, sem economizar nada que importe.
   */
  async obter(): Promise<ResultadoPlataforma<string>> {
    const agora = this.#agora()
    if (this.#cache && this.#cache.expiraEm - FOLGA_SEGUNDOS * 1000 > agora) {
      return { ok: true, dados: this.#cache.token }
    }

    let resposta: Response
    try {
      resposta = await this.#buscar('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.#cred.clientId,
          client_secret: this.#cred.clientSecret,
          refresh_token: this.#cred.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      })
    } catch (e) {
      return { ok: false, motivo: 'indisponivel', detalhe: String(e) }
    }

    const corpo = (await resposta.json().catch(() => null)) as
      { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null

    if (!resposta.ok || !corpo?.access_token) {
      return { ok: false, ...traduzirErroOAuth(corpo?.error, corpo?.error_description) }
    }

    this.#cache = {
      token: corpo.access_token,
      expiraEm: agora + (corpo.expires_in ?? 3600) * 1000,
    }
    return { ok: true, dados: corpo.access_token }
  }
}

/**
 * Erro do OAuth → motivo tipificado.
 *
 * ⚠️ `invalid_grant` é o mais importante e o mais mal explicado pelo Google: ele
 * significa que o **refresh token morreu**. As causas práticas são poucas e todas
 * pedem a mesma ação — gerar outro:
 *
 * - a tela de consentimento voltou para "Testing" (o Google revoga em 7 dias);
 * - o acesso foi revogado em `myaccount.google.com/permissions`;
 * - o refresh token ficou 6 meses sem uso;
 * - a senha da conta mudou.
 *
 * Por isso o detalhe carrega a instrução: `invalid_grant` sozinho não diz nada a
 * quem está de plantão às duas da manhã.
 */
export function traduzirErroOAuth(
  erro: string | undefined, descricao: string | undefined,
): { motivo: MotivoFalhaPlataforma; detalhe: string } {
  if (erro === 'invalid_grant') {
    return {
      motivo: 'credencial_invalida',
      detalhe: 'refresh token inválido ou expirado — gere outro com '
        + 'infra/dev/gerar-refresh-token-google.mjs. ⚠️ Se isto se repetir a cada 7 dias, '
        + 'a tela de consentimento OAuth voltou para "Testing": publique em produção.',
    }
  }
  if (erro === 'invalid_client') {
    return { motivo: 'credencial_invalida', detalhe: 'client_id/client_secret não conferem' }
  }
  if (erro === 'slow_down' || erro === 'rate_limit_exceeded') {
    return { motivo: 'limite_de_taxa', detalhe: descricao ?? erro }
  }
  return { motivo: 'resposta_inesperada', detalhe: `${erro ?? 'sem erro'}: ${descricao ?? ''}`.trim() }
}
