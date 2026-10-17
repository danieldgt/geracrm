import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { RespostaSugestao, SugestaoVigente } from '@geracrm/shared'
import { mensagemErroGerar, type EstadoPainelSugestao } from './sugestao.regras.js'

/**
 * A porta HTTP da SUGESTÃO no inbox (raia P13).
 *
 *   GET  /v1/conversas/:id/sugestao               vigente + selo do modo + copiloto disponível
 *   POST /v1/conversas/:id/sugestao/gerar         copiloto sob demanda (até 20 s)
 *   POST /v1/agente/sugestoes/:decisaoId/descartar
 *
 * ⚠️ O tempo real (evento `agente.sugestao`) NÃO traz conteúdo: a página escuta o evento e chama
 *    `carregar` — o texto vem daqui, sob RLS (ADR-007).
 * ⚠️ Respostas atrasadas de outra conversa são descartadas (o vendedor troca de conversa rápido).
 */
@Injectable({ providedIn: 'root' })
export class SugestaoServico {
  readonly #http = inject(HttpClient)

  readonly estado = signal<EstadoPainelSugestao>('carregando')
  readonly resposta = signal<RespostaSugestao | null>(null)
  readonly gerando = signal(false)
  /** Falha LOCAL do copiloto ou do descarte (estado parcial: a sugestão anterior continua). */
  readonly erroAcao = signal<string | null>(null)
  #conversaId: string | null = null

  async carregar(conversaId: string, silencioso = false): Promise<void> {
    const trocou = this.#conversaId !== conversaId
    this.#conversaId = conversaId
    if (trocou) { this.erroAcao.set(null); this.resposta.set(null) }
    if (!silencioso || trocou) this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.#http.get<RespostaSugestao>(`/v1/conversas/${conversaId}/sugestao`))
      if (this.#conversaId !== conversaId) return
      this.resposta.set(r)
      this.estado.set('pronto')
    } catch (e) {
      if (this.#conversaId !== conversaId) return
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  /** "Sugerir resposta" — devolve a sugestão gerada (para preencher o campo) ou null. */
  async gerar(conversaId: string): Promise<SugestaoVigente | null> {
    if (this.gerando()) return null
    this.gerando.set(true)
    this.erroAcao.set(null)
    try {
      const r = await firstValueFrom(this.#http.post<{ sugestao: SugestaoVigente }>(`/v1/conversas/${conversaId}/sugestao/gerar`, {}))
      if (this.#conversaId !== conversaId) return null
      const atual = this.resposta()
      if (atual) this.resposta.set({ ...atual, sugestao: r.sugestao })
      return r.sugestao
    } catch (e) {
      if (this.#conversaId === conversaId) {
        const he = e instanceof HttpErrorResponse ? e : null
        this.erroAcao.set(mensagemErroGerar(he?.status ?? 0, (he?.error ?? null) as { erro?: string; mensagem?: string } | null))
        // Desligaram o agente com a tela aberta: o selo e o botão refletem na hora.
        if ((he?.error as { erro?: string } | null)?.erro === 'agente.desligado') void this.carregar(conversaId, true)
      }
      return null
    } finally {
      this.gerando.set(false)
    }
  }

  async descartar(conversaId: string, decisaoId: string): Promise<void> {
    this.erroAcao.set(null)
    try {
      await firstValueFrom(this.#http.post(`/v1/agente/sugestoes/${decisaoId}/descartar`, {}))
    } catch (e) {
      // 409 = já decidida (por mim em outra aba ou por um colega): só recarrega.
      if (!(e instanceof HttpErrorResponse && e.status === 409)) this.erroAcao.set('Não foi possível descartar a sugestão. Tente de novo.')
    }
    await this.carregar(conversaId, true)
  }
}
