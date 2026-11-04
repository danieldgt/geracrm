import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { mesclarPagina } from '../compartilhado/ui/cursor.js'
import { mensagemDeErro } from '../compartilhado/ui/erro-http.js'
import { NotificacoesServico } from './notificacoes.servico.js'
import {
  FILTRO_NOTIFICACAO_VAZIO, queryDeNotificacoes, type FiltroNotificacao, type NotificacaoItem,
} from './notificacoes.regras.js'

export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro'

interface Pagina { readonly itens: NotificacaoItem[]; readonly proximoCursor: string | null }

/**
 * Lista da PÁGINA Notificações (padrão L). ⚠️ Por CURSOR do servidor, nunca lista inteira; trocar o
 * filtro zera a lista e descarta resposta atrasada de um filtro antigo. O sino (`NotificacoesServico`)
 * segue sendo o contador — marcar lida aqui também refaz o contador dele.
 */
@Injectable({ providedIn: 'root' })
export class NotificacoesListaServico {
  private readonly http = inject(HttpClient)
  private readonly sino = inject(NotificacoesServico)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly itens = signal<readonly NotificacaoItem[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erro = signal<string | null>(null)
  readonly marcando = signal(false)

  private geracao = 0
  private filtro: FiltroNotificacao = FILTRO_NOTIFICACAO_VAZIO

  async carregar(filtro: FiltroNotificacao): Promise<void> {
    const g = ++this.geracao
    this.filtro = filtro
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const r = await firstValueFrom(this.http.get<Pagina>(`/v1/notificacoes${queryDeNotificacoes(filtro)}`))
      if (g !== this.geracao) return
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (g !== this.geracao) return
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar as notificações. Tente de novo.'))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    const g = this.geracao
    this.carregandoMais.set(true)
    try {
      const r = await firstValueFrom(this.http.get<Pagina>(`/v1/notificacoes${queryDeNotificacoes(this.filtro, cursor)}`))
      if (g !== this.geracao) return
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (n) => n.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch {
      // Mantém o que já há; o botão continua para nova tentativa.
    } finally {
      if (g === this.geracao) this.carregandoMais.set(false)
    }
  }

  /** Marca UMA como lida. Falha de rede deixa como estava (a pessoa vê que não mudou). */
  async marcarLida(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/v1/notificacoes/lidas', { ids: [id] }))
      this.itens.update((is) => is.map((i) => (i.id === id ? { ...i, lida: true } : i)))
      void this.sino.carregarContador()
    } catch { /* silencioso: o item continua não lido */ }
  }

  /** Marca TODAS as não lidas (não só as da página). Devolve false se falhou. */
  async marcarTodas(): Promise<boolean> {
    this.marcando.set(true)
    try {
      await firstValueFrom(this.http.post('/v1/notificacoes/lidas', {}))
      this.itens.update((is) => is.map((i) => ({ ...i, lida: true })))
      void this.sino.carregarContador()
      return true
    } catch {
      return false
    } finally {
      this.marcando.set(false)
    }
  }
}
