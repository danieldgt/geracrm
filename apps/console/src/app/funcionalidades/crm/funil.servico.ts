import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface Etapa {
  readonly id: string
  readonly chave: string
  readonly nome: string
  readonly tipo: 'aberto' | 'ganho' | 'perdido'
  readonly total: number
}
export interface Card {
  readonly id: string
  readonly contatoId: string
  readonly nome: string
  readonly valorCentavos: number | null
  readonly responsavel: string | null
  readonly posicao: number
  readonly versao: number
}
export interface Coluna {
  readonly etapa: Etapa
  cards: Card[]
  proximoCursor: string | null
  carregandoMais: boolean
}
export interface Motivo { readonly codigo: string; readonly nome: string }

/** Etapa na visão de CONFIGURAÇÃO: inclui as inativas, a ordem e o uso. */
export interface EtapaConfig {
  readonly id: string
  readonly chave: string
  readonly nome: string
  readonly tipo: 'aberto' | 'ganho' | 'perdido'
  readonly criterio: string | null
  readonly ordem: number
  readonly ativo: boolean
  readonly total: number
}
export interface MotivoConfig {
  readonly codigo: string
  readonly nome: string
  readonly ativo: boolean
  readonly total: number
}

export interface MetricaEtapa {
  readonly chave: string; readonly nome: string; readonly tipo: string
  readonly entraram: number
  readonly tempoMedioDias: number | null
  readonly conversaoParaProxima: number | null
}
export interface Metricas {
  readonly etapas: readonly MetricaEtapa[]
  readonly recompra: { readonly comCompra: number; readonly recompraram: number; readonly taxa: number | null }
  readonly tempoSegundoPedido: { readonly base: number; readonly mediaDias: number | null; readonly medianaDias: number | null }
  readonly perda: {
    readonly fechadas: number; readonly perdidas: number; readonly taxaPerda: number | null
    readonly motivos: readonly { readonly codigo: string; readonly nome: string; readonly qtd: number }[]
  }
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Kanban do funil (Onda 2). ⚠️ Paginado POR COLUNA (nunca virtual scroll — o CDK
 * não junta drag-drop com virtual scroll). O move usa concorrência otimista
 * (versao): se alguém moveu antes, a API devolve 409 e a tela recarrega.
 */
@Injectable({ providedIn: 'root' })
export class FunilServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly colunas = signal<readonly Coluna[]>([])
  readonly motivos = signal<readonly Motivo[]>([])
  readonly erroMove = signal<string | null>(null)
  readonly metricas = signal<Metricas | null>(null)
  readonly carregandoMetricas = signal(false)

  // ── Configuração das raias (etapas e motivos) ──
  readonly config = signal<readonly EtapaConfig[]>([])
  readonly motivosConfig = signal<readonly MotivoConfig[]>([])
  readonly erroConfig = signal<string | null>(null)
  /** Houve mudança de estrutura — o board precisa recarregar ao fechar. */
  readonly configSujo = signal(false)

  async carregarConfig(): Promise<void> {
    try {
      const [etapas, motivos] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: EtapaConfig[] }>('/v1/funil/config/etapas')),
        firstValueFrom(this.http.get<{ itens: MotivoConfig[] }>('/v1/funil/config/motivos')),
      ])
      this.config.set(etapas.itens)
      this.motivosConfig.set(motivos.itens)
    } catch { this.erroConfig.set('Não foi possível carregar a configuração.') }
  }

  /**
   * ⚠️ A mensagem do servidor é MOSTRADA, não engolida: a API recusa deixar o
   * funil sem nenhuma etapa aberta, e um botão que não faz nada em silêncio é
   * pior do que o erro.
   */
  private async mutarConfig(acao: () => Promise<unknown>): Promise<boolean> {
    this.erroConfig.set(null)
    try {
      await acao()
      this.configSujo.set(true)
      await this.carregarConfig()
      return true
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string }) : null
      this.erroConfig.set(corpo?.mensagem ?? 'Não foi possível salvar a alteração.')
      await this.carregarConfig()
      return false
    }
  }

  criarEtapa(nome: string, tipo: EtapaConfig['tipo']): Promise<boolean> {
    return this.mutarConfig(() => firstValueFrom(this.http.post('/v1/funil/config/etapas', { nome, tipo })))
  }
  editarEtapa(id: string, campos: { nome?: string; ordem?: number; ativo?: boolean; tipo?: string }): Promise<boolean> {
    return this.mutarConfig(() => firstValueFrom(this.http.patch(`/v1/funil/config/etapas/${id}`, campos)))
  }
  removerEtapa(id: string): Promise<boolean> {
    return this.mutarConfig(() => firstValueFrom(this.http.delete(`/v1/funil/config/etapas/${id}`)))
  }
  criarMotivo(nome: string): Promise<boolean> {
    return this.mutarConfig(() => firstValueFrom(this.http.post('/v1/funil/config/motivos', { nome })))
  }
  removerMotivo(codigo: string): Promise<boolean> {
    return this.mutarConfig(() => firstValueFrom(this.http.delete(`/v1/funil/config/motivos/${codigo}`)))
  }

  /** Métricas do funil + recompra (skill funil-de-vendas). Carrega sob demanda. */
  async carregarMetricas(): Promise<void> {
    if (this.metricas() || this.carregandoMetricas()) return
    this.carregandoMetricas.set(true)
    try {
      this.metricas.set(await firstValueFrom(this.http.get<Metricas>('/v1/funil/metricas')))
    } catch { /* silencioso: métrica não pode derrubar o kanban */ } finally {
      this.carregandoMetricas.set(false)
    }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [etapas, motivos] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Etapa[] }>('/v1/funil/etapas')),
        firstValueFrom(this.http.get<{ itens: Motivo[] }>('/v1/funil/motivos')).catch(() => ({ itens: [] })),
      ])
      this.motivos.set(motivos.itens)
      const colunas = await Promise.all(etapas.itens.map(async (etapa) => {
        const r = await this.buscarColuna(etapa.id, null)
        return { etapa, cards: r.itens, proximoCursor: r.proximoCursor, carregandoMais: false } as Coluna
      }))
      this.colunas.set(colunas)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private buscarColuna(etapaId: string, cursor: string | null): Promise<{ itens: Card[]; proximoCursor: string | null }> {
    const url = cursor
      ? `/v1/funil/coluna/${etapaId}?cursor=${encodeURIComponent(cursor)}`
      : `/v1/funil/coluna/${etapaId}`
    return firstValueFrom(this.http.get<{ itens: Card[]; proximoCursor: string | null }>(url))
  }

  async carregarMais(etapaId: string): Promise<void> {
    const cols = [...this.colunas()]
    const col = cols.find((c) => c.etapa.id === etapaId)
    if (!col || !col.proximoCursor || col.carregandoMais) return
    col.carregandoMais = true
    this.colunas.set(cols)
    try {
      const r = await this.buscarColuna(etapaId, col.proximoCursor)
      col.cards = [...col.cards, ...r.itens]
      col.proximoCursor = r.proximoCursor
    } catch { /* mantém */ } finally {
      col.carregandoMais = false
      this.colunas.set([...cols])
    }
  }

  /**
   * Move o card para outra etapa na posição `indice`. Calcula a posição
   * fracionária a partir dos vizinhos na coluna de destino. Devolve o motivo do
   * erro (ex.: 'conflito') para a tela reagir.
   */
  async mover(card: Card, deEtapaId: string, paraEtapaId: string, indice: number, motivo?: string):
    Promise<{ ok: true } | { ok: false; motivo: string }> {
    const cols = this.colunas()
    const destino = cols.find((c) => c.etapa.id === paraEtapaId)
    const vizinhos = (destino?.cards ?? []).filter((c) => c.id !== card.id)
    const antes = vizinhos[indice - 1]?.posicao
    const depois = vizinhos[indice]?.posicao
    const posicao = antes !== undefined && depois !== undefined ? (antes + depois) / 2
      : antes !== undefined ? antes + 1
      : depois !== undefined ? depois - 1
      : 0

    try {
      await firstValueFrom(this.http.post(`/v1/funil/oportunidades/${card.id}/mover`,
        { etapaId: paraEtapaId, posicao, versao: card.versao, ...(motivo ? { motivo } : {}) }))
      return { ok: true }
    } catch (e) {
      const cod = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro ?? '' : ''
      // Conflito/erro: recarrega para refletir a verdade do servidor.
      await this.carregar()
      return { ok: false, motivo: cod }
    }
  }

  async criar(contatoId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post('/v1/funil/oportunidades', { contatoId }))
      await this.carregar()
      return true
    } catch { return false }
  }
}
