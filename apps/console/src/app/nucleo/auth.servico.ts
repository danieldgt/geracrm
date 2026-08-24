import { Injectable, computed, inject, signal } from '@angular/core'
import { Router } from '@angular/router'

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
const CHAVE_REFRESH = 'geracrm.refreshToken'
const CHAVE_USUARIO = 'geracrm.usuario'
const CHAVE_EXPIRA = 'geracrm.expiraEm'
/** Renova ANTES de expirar, com esta folga (evita 401 por corrida de relógio). */
const MARGEM_MS = 2 * 60 * 1000

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
  refreshToken?: string
  expiraEm?: number
  session?: string
  mensagem?: string
}

@Injectable({ providedIn: 'root' })
export class AuthServico {
  readonly idToken = signal<string | null>(localStorage.getItem(CHAVE_TOKEN))
  readonly autenticado = computed(() => this.idToken() !== null)

  /** Dados do usuário decodificados do idToken (para o menu). null em dev/local. */
  readonly usuario = computed<{ nome: string; email: string | null } | null>(() => {
    const t = this.idToken()
    if (!t) return null
    try {
      const base = t.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? ''
      const p = JSON.parse(atob(base)) as Record<string, unknown>
      const email = (p['email'] as string | undefined) ?? null
      const nome = (p['name'] as string | undefined)
        ?? (p['cognito:username'] as string | undefined)
        ?? email?.split('@')[0] ?? 'Usuário'
      return { nome, email }
    } catch {
      return null
    }
  })

  private async postar(caminho: string, corpo: object): Promise<RespostaApi> {
    const resp = await fetch(caminho, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })
    return (await resp.json().catch(() => ({}))) as RespostaApi
  }

  /** Timer de renovação proativa; null quando não há sessão. */
  private timerRefresh: ReturnType<typeof setTimeout> | null = null

  /** Para levar ao login quando a sessão morre (ver `encerrarSessao`). */
  private readonly router = inject(Router)

  constructor() {
    // Ao abrir o app com sessão salva, agenda a renovação (ou renova já se está
    // perto/passou do vencimento). E renova ao voltar para a aba — setTimeout é
    // estrangulado em aba oculta e pode não disparar a tempo.
    if (this.idToken() && localStorage.getItem(CHAVE_REFRESH)) this.agendarRefresh()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.idToken()) this.agendarRefresh()
      })
    }
  }

  async entrar(usuario: string, senha: string): Promise<ResultadoLogin> {
    const r = await this.postar('/v1/auth/login', { usuario, senha })
    if (r.tipo === 'ok' && r.idToken) {
      this.guardar(r, usuario)
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
      this.guardar(r, usuario)
      return { tipo: 'ok' }
    }
    return { tipo: 'erro', mensagem: r.mensagem ?? 'Não foi possível definir a nova senha.' }
  }

  sair(): void {
    if (this.timerRefresh) { clearTimeout(this.timerRefresh); this.timerRefresh = null }
    for (const k of [CHAVE_TOKEN, CHAVE_REFRESH, CHAVE_USUARIO, CHAVE_EXPIRA]) localStorage.removeItem(k)
    this.idToken.set(null)
  }

  /**
   * Renova o ID token com o refresh token guardado. Chamado pelo timer antes de
   * expirar. Falhou (refresh expirado ~30 dias) → encerra a sessão para o login.
   */
  private async refrescar(): Promise<void> {
    const refreshToken = localStorage.getItem(CHAVE_REFRESH)
    const usuario = localStorage.getItem(CHAVE_USUARIO)
    if (!refreshToken || !usuario) return
    try {
      const r = await this.postar('/v1/auth/refresh', { refreshToken, usuario })
      if (r.tipo === 'ok' && r.idToken) { this.guardar(r); return } // mantém o mesmo refresh token
      // ⚠️ O servidor RECUSOU o refresh (token expirado, ~30 dias). Limpar a
      //    sessão não basta: sem navegar, o usuário FICA NA TELA ATUAL sem token,
      //    e a guarda de rota só roda em navegação. O resultado é uma tela que
      //    não recarrega e parece defeito da página — foi assim que isto apareceu
      //    em produção (24/ago), com um 400 no refresh e 401 em tudo depois.
      this.encerrarSessao()
    } catch { /* rede: mantém o token atual; o timer/visibilidade tenta de novo */ }
  }

  /**
   * Encerra a sessão E leva ao login.
   *
   * ⚠️ `sair()` sozinho só limpa o armazenamento — quem descobre que a sessão
   * morreu precisa mandar o usuário para algum lugar, senão ele fica preso numa
   * tela morta sem nenhuma mensagem.
   */
  encerrarSessao(): void {
    this.sair()
    void this.router.navigateByUrl('/login')
  }

  /** Agenda a renovação para MARGEM antes do vencimento (ou já, se perto/passou). */
  private agendarRefresh(): void {
    if (this.timerRefresh) { clearTimeout(this.timerRefresh); this.timerRefresh = null }
    const expira = Number(localStorage.getItem(CHAVE_EXPIRA) ?? 0)
    if (!expira || !localStorage.getItem(CHAVE_REFRESH)) return
    const atraso = expira - Date.now() - MARGEM_MS
    if (atraso <= 0) { void this.refrescar(); return }
    // setTimeout aceita no máx ~24.8 dias; o IdToken vive ~1h, então cabe.
    this.timerRefresh = setTimeout(() => void this.refrescar(), atraso)
  }

  /**
   * Persiste o token e agenda a renovação. `refreshToken`/`usuario` só vêm no
   * login; no refresh, preserva os que já estão guardados.
   * ⚠️ O refresh token fica no localStorage, como o idToken — coerente com o
   * modelo atual (login server-side, SPA). É o vetor a fechar se endurecer XSS.
   */
  private guardar(r: RespostaApi, usuario?: string): void {
    localStorage.setItem(CHAVE_TOKEN, r.idToken!)
    if (r.refreshToken) localStorage.setItem(CHAVE_REFRESH, r.refreshToken)
    if (usuario) localStorage.setItem(CHAVE_USUARIO, usuario)
    if (r.expiraEm) localStorage.setItem(CHAVE_EXPIRA, String(r.expiraEm))
    this.idToken.set(r.idToken!)
    this.agendarRefresh()
  }
}
