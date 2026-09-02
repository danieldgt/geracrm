import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

export interface EtapaK { readonly id: string; readonly chave: string; readonly nome: string; readonly tipo: 'atendimento' | 'encerrado'; readonly total: number }
export interface CardAtend {
  readonly kind: 'atend'
  readonly atendimentoId: string; readonly conversaId: string; readonly contato: string
  readonly atendente: string | null; readonly protocolo: number; readonly entrouEtapaEm: string | null; readonly versao: number
}
export interface CardFila { readonly kind: 'fila'; readonly conversaId: string; readonly contato: string; readonly ultimaMensagemEm: string | null }
export type Card = CardAtend | CardFila

export interface Coluna { etapa: EtapaK | null; chave: string; nome: string; tipo: 'atendimento' | 'encerrado' | 'fila'; total: number; cards: Card[]; proximoCursor: string | null; carregandoMais: boolean }
export interface EtapaConfig { readonly id: string; readonly chave: string; readonly nome: string; readonly tipo: string; readonly ordem: number; readonly ativo: boolean; readonly total: number }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Kanban de atendimentos (visão do gestor). 1ª coluna "Aguardando" derivada da
 * fila; as demais são etapas configuráveis por tenant. Espelha o funil: colunas
 * paginadas por cursor, mover com concorrência otimista (versao).
 */
@Injectable({ providedIn: 'root' })
export class AtendimentoKanbanServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly colunas = signal<readonly Coluna[]>([])
  readonly erroMove = signal<string | null>(null)

  /**
   * `silencioso` = recarga depois de um drop: a tela já mostra o resultado otimista;
   * trocar o board pelo esqueleto faria o painel inteiro piscar a cada card movido.
   */
  async carregar(opcoes: { silencioso?: boolean } = {}): Promise<void> {
    if (!(opcoes.silencioso && this.estado() === 'pronto')) this.estado.set('carregando')
    try {
      const e = await firstValueFrom(this.http.get<{ aguardando: { total: number }; itens: EtapaK[] }>('/v1/atendimento-kanban/etapas'))
      const fila = await this.buscarFila(null)
      const filaCol: Coluna = { etapa: null, chave: '__fila', nome: 'Aguardando', tipo: 'fila', total: e.aguardando.total, cards: fila.itens, proximoCursor: fila.proximoCursor, carregandoMais: false }
      const cols = await Promise.all(e.itens.map(async (etapa) => {
        const r = await this.buscarColuna(etapa.id, null)
        return { etapa, chave: etapa.chave, nome: etapa.nome, tipo: etapa.tipo, total: etapa.total, cards: r.itens, proximoCursor: r.proximoCursor, carregandoMais: false } as Coluna
      }))
      this.colunas.set([filaCol, ...cols])
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  private async buscarFila(cursor: string | null): Promise<{ itens: CardFila[]; proximoCursor: string | null }> {
    const url = cursor ? `/v1/atendimento-kanban/aguardando?cursor=${encodeURIComponent(cursor)}` : '/v1/atendimento-kanban/aguardando'
    const r = await firstValueFrom(this.http.get<{ itens: { conversaId: string; contato: string; ultimaMensagemEm: string | null }[]; proximoCursor: string | null }>(url))
    return { itens: r.itens.map((i) => ({ kind: 'fila', ...i })), proximoCursor: r.proximoCursor }
  }
  private async buscarColuna(etapaId: string, cursor: string | null): Promise<{ itens: CardAtend[]; proximoCursor: string | null }> {
    const url = cursor ? `/v1/atendimento-kanban/coluna/${etapaId}?cursor=${encodeURIComponent(cursor)}` : `/v1/atendimento-kanban/coluna/${etapaId}`
    const r = await firstValueFrom(this.http.get<{ itens: Omit<CardAtend, 'kind'>[]; proximoCursor: string | null }>(url))
    return { itens: r.itens.map((i) => ({ kind: 'atend', ...i })), proximoCursor: r.proximoCursor }
  }

  async carregarMais(col: Coluna): Promise<void> {
    if (!col.proximoCursor || col.carregandoMais) return
    const cols = [...this.colunas()]
    const alvo = cols.find((c) => c.chave === col.chave)!
    alvo.carregandoMais = true; this.colunas.set(cols)
    try {
      const r = col.tipo === 'fila' ? await this.buscarFila(col.proximoCursor) : await this.buscarColuna(col.etapa!.id, col.proximoCursor)
      alvo.cards = [...alvo.cards, ...r.itens]; alvo.proximoCursor = r.proximoCursor
    } catch { /* mantém */ } finally { alvo.carregandoMais = false; this.colunas.set([...this.colunas()]) }
  }

  /**
   * Assumir (da coluna Aguardando): o atendimento nasce NA etapa onde o card foi
   * solto — antes nascia sempre na 1ª, e o card "pulava" de coluna depois do drop.
   */
  async assumir(conversaId: string, etapaId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(`/v1/conversas/${conversaId}/assumir`, { etapaId }))
      await this.carregar({ silencioso: true })
      return true
    } catch (e) {
      await this.carregar({ silencioso: true })
      this.erroMove.set(this.mensagemDoErro(e, 'Não foi possível assumir.'))
      return false
    }
  }

  /** Mover um atendimento entre etapas (concorrência otimista). */
  async mover(card: CardAtend, paraEtapaId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(`/v1/atendimento-kanban/${card.atendimentoId}/mover`, { etapaId: paraEtapaId, versao: card.versao }))
      await this.carregar({ silencioso: true })
      return true
    } catch (e) {
      await this.carregar({ silencioso: true })
      this.erroMove.set(this.mensagemDoErro(e, 'Não foi possível mover.'))
      return false
    }
  }

  /** Erro tipificado da API → frase que diz o que houve e o que fazer. */
  private mensagemDoErro(e: unknown, padrao: string): string {
    const cod = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro ?? '' : ''
    switch (cod) {
      case 'atendimento.conflito': return 'Alguém moveu este atendimento antes — recarreguei.'
      case 'atendimento.ja_tem_aberto': return 'A conversa já tem um atendimento aberto.'
      case 'atendimento.ja_assumido': return 'Outro atendente assumiu esta conversa antes — recarreguei.'
      case 'etapa.invalida': return 'Para encerrar, assuma primeiro: solte o card numa etapa de atendimento.'
      default: return padrao
    }
  }

  // ───────── Config do fluxo ─────────
  readonly config = signal<readonly EtapaConfig[]>([])
  async carregarConfig(): Promise<void> {
    try { this.config.set((await firstValueFrom(this.http.get<{ itens: EtapaConfig[] }>('/v1/atendimento-kanban/config/etapas'))).itens) } catch { /* vazio */ }
  }
  async criarEtapa(nome: string, tipo: 'atendimento' | 'encerrado'): Promise<void> {
    await firstValueFrom(this.http.post('/v1/atendimento-kanban/config/etapas', { nome, tipo })); await this.carregarConfig()
  }
  async editarEtapa(id: string, campos: { nome?: string; ordem?: number; ativo?: boolean; tipo?: string }): Promise<void> {
    await firstValueFrom(this.http.patch(`/v1/atendimento-kanban/config/etapas/${id}`, campos)); await this.carregarConfig()
  }
  async removerEtapa(id: string): Promise<void> {
    try { await firstValueFrom(this.http.delete(`/v1/atendimento-kanban/config/etapas/${id}`)) } catch { /* ignora */ }
    await this.carregarConfig()
  }
}
