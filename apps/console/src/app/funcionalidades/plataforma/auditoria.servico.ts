import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export type EstadoCarga = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/** Uma entrada do rastro (EP-07). `dados` é o diff/contexto da ação. */
export interface EntradaAuditoria {
  readonly criadoEm: string
  readonly acao: string
  readonly entidade: string
  readonly entidadeId: string | null
  readonly atorNome: string | null
  readonly dados: unknown
}

/**
 * Rastro de auditoria (EP-07 / PLT-05).
 *
 * ⚠️ Paginação por CURSOR ("carregar mais"), nunca lista inteira: o rastro só
 * cresce e uma conta antiga tem centenas de milhares de linhas. O cursor vem
 * do servidor — o cliente nunca calcula OFFSET.
 */
@Injectable({ providedIn: 'root' })
export class AuditoriaServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoCarga>('ocioso')
  readonly itens = signal<readonly EntradaAuditoria[]>([])
  readonly erro = signal<string | null>(null)
  /** null quando não há próxima página — o botão "carregar mais" some. */
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const r = await this.buscar(null)
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) {
        this.estado.set('sem_permissao')
        return
      }
      this.erro.set(mensagemDe(e))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.buscar(cursor)
      // ⚠️ Anexa, não substitui: o "carregar mais" é aditivo. Concatenar
      //    preserva a página anterior; trocar perderia o histórico já lido.
      this.itens.update((atual) => [...atual, ...r.itens])
      this.proximoCursor.set(r.proximoCursor)
    } catch {
      // Mantém o que já há; o botão continua para nova tentativa.
    } finally {
      this.carregandoMais.set(false)
    }
  }

  private async buscar(cursor: string | null): Promise<{ itens: EntradaAuditoria[]; proximoCursor: string | null }> {
    const url = cursor
      ? `/v1/auditoria?cursor=${encodeURIComponent(cursor)}`
      : '/v1/auditoria'
    return firstValueFrom(
      this.http.get<{ itens: EntradaAuditoria[]; proximoCursor: string | null }>(url),
    )
  }
}

function mensagemDe(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'Não foi possível falar com o Drezz Hub. Verifique sua conexão.'
    return `O Drezz Hub respondeu com erro (${e.status}).`
  }
  return 'Erro inesperado.'
}
