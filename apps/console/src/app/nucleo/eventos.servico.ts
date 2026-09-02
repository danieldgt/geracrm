import { Injectable, inject, signal } from '@angular/core'
import { AuthServico, ehProducao } from './auth.servico.js'

/**
 * Cliente de tempo real (ADR-007). Abre UMA conexão SSE em `/v1/eventos` e avisa
 * quem escuta que algo mudou — o conteúdo é buscado depois pela API (sob RLS).
 *
 * ⚠️ Usa `fetch`+stream, não `EventSource`: o EventSource não deixa mandar
 * `Authorization: Bearer`, e a nossa identidade (o tenant) vem do token.
 *
 * ⚠️ Reconexão por CURSOR: guarda o último id recebido e reconecta com
 * `?desde=<id>`, então o servidor devolve o delta do outbox — nada se perde se a
 * conexão cair. Backoff exponencial com teto. O estado é VISÍVEL (a skill exige:
 * silêncio é pior que aviso).
 */

const TENANT_DOGFOODING = '6e7a0d00-0000-4000-8000-000000000001'

export type EstadoConexao = 'ocioso' | 'conectando' | 'conectado' | 'reconectando' | 'offline'

export interface EventoRecebido {
  readonly id: number
  readonly tipo: string
  readonly conversaId?: string
  readonly versao?: number
}

type Ouvinte = (ev: EventoRecebido) => void

@Injectable({ providedIn: 'root' })
export class EventosServico {
  private readonly auth = inject(AuthServico)
  readonly estado = signal<EstadoConexao>('ocioso')

  private ultimoId = 0
  private tentativa = 0
  private controle: AbortController | null = null
  private ligado = false
  private readonly ouvintes = new Map<string, Set<Ouvinte>>()

  /** Escuta um tipo de evento (ex.: 'mensagem.recebida'). Devolve cancelamento. */
  escutar(tipo: string, fn: Ouvinte): () => void {
    let set = this.ouvintes.get(tipo)
    if (!set) {
      set = new Set()
      this.ouvintes.set(tipo, set)
    }
    set.add(fn)
    return () => this.ouvintes.get(tipo)?.delete(fn)
  }

  conectar(): void {
    if (this.ligado) return
    this.ligado = true
    void this.laco()
  }

  desconectar(): void {
    this.ligado = false
    this.controle?.abort()
    this.controle = null
    this.estado.set('ocioso')
  }

  private async laco(): Promise<void> {
    while (this.ligado) {
      try {
        await this.conexao()
      } catch {
        // queda/erro — cai no backoff abaixo
      }
      if (!this.ligado) break
      // Reconecta com backoff exponencial (teto 30s).
      this.tentativa++
      this.estado.set('reconectando')
      const espera = Math.min(30_000, 1000 * 2 ** Math.min(this.tentativa, 5))
      await new Promise((r) => setTimeout(r, espera))
    }
  }

  private cabecalhos(): Record<string, string> {
    if (ehProducao()) {
      const t = this.auth.tokenAtual()
      return t ? { authorization: `Bearer ${t}` } : {}
    }
    return { 'x-tenant-id': TENANT_DOGFOODING }
  }

  private async conexao(): Promise<void> {
    this.controle = new AbortController()
    this.estado.set(this.tentativa === 0 ? 'conectando' : 'reconectando')

    const url = `/v1/eventos${this.ultimoId > 0 ? `?desde=${this.ultimoId}` : ''}`
    const resp = await fetch(url, {
      headers: { accept: 'text/event-stream', ...this.cabecalhos() },
      signal: this.controle.signal,
    })
    if (!resp.ok || !resp.body) {
      if (resp.status === 401) {
        // Token caiu: para de tentar; o interceptor/guarda leva ao login.
        this.desconectar()
      }
      throw new Error(`SSE HTTP ${resp.status}`)
    }

    this.tentativa = 0
    this.estado.set('conectado')

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let corte: number
      while ((corte = buffer.indexOf('\n\n')) >= 0) {
        const bloco = buffer.slice(0, corte)
        buffer = buffer.slice(corte + 2)
        this.processarBloco(bloco)
      }
    }
    // Stream terminou sem erro (servidor fechou) → o laço reconecta.
    throw new Error('SSE encerrado')
  }

  private processarBloco(bloco: string): void {
    // Comentário/heartbeat (linha começando com ':') é ignorado.
    if (bloco.startsWith(':')) return
    let tipo = 'message'
    let dados = ''
    let idEvento: number | null = null
    for (const linha of bloco.split('\n')) {
      if (linha.startsWith('event:')) tipo = linha.slice(6).trim()
      else if (linha.startsWith('data:')) dados += linha.slice(5).trim()
      else if (linha.startsWith('id:')) idEvento = Number(linha.slice(3).trim()) || null
    }
    if (idEvento && idEvento > this.ultimoId) this.ultimoId = idEvento
    if (!dados) return
    let ev: EventoRecebido
    try {
      ev = JSON.parse(dados) as EventoRecebido
    } catch {
      return
    }
    // Despacha para quem escuta este tipo E para o coringa '*' (todos).
    for (const chave of [tipo, '*']) {
      const set = this.ouvintes.get(chave)
      if (set) for (const fn of set) fn(ev)
    }
  }
}
