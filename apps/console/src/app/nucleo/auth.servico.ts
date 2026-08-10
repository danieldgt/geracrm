import { Injectable, computed, signal } from '@angular/core'

/**
 * Login via a NOSSA API (`/v1/auth/*`), não direto no Cognito.
 *
 * ⚠️ O app client do Cognito é confidencial (tem secret), então o handshake mora
 * no servidor (contexts/identidade/rotas-auth.ts): o browser troca usuário/senha
 * por um ID token e nunca toca no secret. O ID token carrega `custom:tenant_id`
 * (ADR-001) e vira `Authorization: Bearer` nas demais chamadas.
 *
 * ⚠️ Em desenvolvimento (localhost) NÃO há login: a API aceita `x-tenant-id` de
 * dogfooding. Quem decide é `ehProducao()`.
 */

const CHAVE_TOKEN = 'geracrm.idToken'

/** Produção = qualquer host que não seja a máquina do dev. */
export function ehProducao(): boolean {
  const h = location.hostname
  return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]'
}

export type ResultadoLogin =
  | { tipo: 'ok' }
  | { tipo: 'nova_senha'; session: string; usuario: string }
  | { tipo: 'erro'; mensagem: string }

interface RespostaApi {
  tipo?: 'ok' | 'nova_senha' | 'erro'
  idToken?: string
  session?: string
  mensagem?: string
}

@Injectable({ providedIn: 'root' })
export class AuthServico {
  readonly idToken = signal<string | null>(localStorage.getItem(CHAVE_TOKEN))
  readonly autenticado = computed(() => this.idToken() !== null)

  private async postar(caminho: string, corpo: object): Promise<RespostaApi> {
    const resp = await fetch(caminho, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })
    return (await resp.json().catch(() => ({}))) as RespostaApi
  }

  async entrar(usuario: string, senha: string): Promise<ResultadoLogin> {
    const r = await this.postar('/v1/auth/login', { usuario, senha })
    if (r.tipo === 'ok' && r.idToken) {
      this.guardar(r.idToken)
      return { tipo: 'ok' }
    }
    if (r.tipo === 'nova_senha' && r.session) {
      return { tipo: 'nova_senha', session: r.session, usuario }
    }
    return { tipo: 'erro', mensagem: r.mensagem ?? 'Falha ao entrar.' }
  }

  async definirNovaSenha(usuario: string, novaSenha: string, session: string): Promise<ResultadoLogin> {
    const r = await this.postar('/v1/auth/nova-senha', { usuario, novaSenha, session })
    if (r.tipo === 'ok' && r.idToken) {
      this.guardar(r.idToken)
      return { tipo: 'ok' }
    }
    return { tipo: 'erro', mensagem: r.mensagem ?? 'Não foi possível definir a nova senha.' }
  }

  sair(): void {
    localStorage.removeItem(CHAVE_TOKEN)
    this.idToken.set(null)
  }

  private guardar(idToken: string): void {
    localStorage.setItem(CHAVE_TOKEN, idToken)
    this.idToken.set(idToken)
  }
}
