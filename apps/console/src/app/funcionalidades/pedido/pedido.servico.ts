import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { PERFIL_PRECO_PADRAO, type PerfilPreco } from '@geracrm/shared'

export interface SkuCatalogo {
  readonly id: string
  readonly atributos: Record<string, string>
  readonly codigoBarras: string | null
  /** Preço da tabela do ERP para o perfil, em centavos. `null` = sem preço. */
  readonly precoCentavos: number | null
  /** Saldo da última sincronização (soma entre lojas). `null` = sem saldo. */
  readonly saldo: number | null
  /** Quando o saldo foi apurado — ⚠️ NÃO é ao vivo. */
  readonly saldoEm: string | null
}
export interface ProdutoCatalogo {
  readonly id: string
  readonly referencia: string
  readonly descricao: string
  readonly skus: readonly SkuCatalogo[]
}
export interface ItemPedido {
  readonly seq: number
  readonly skuSnapshot: string
  readonly descricaoSnapshot: string
  readonly grade: Record<string, string>
  readonly quantidade: number
  readonly valorUnitarioCentavos: number
}
export interface Pedido {
  readonly id: string
  readonly estado: string
  readonly contatoId: string | null
  readonly nome: string | null
  readonly ultimoErro: { tipo: string } | null
  readonly formaPagamento: string | null
  readonly observacao: string | null
  readonly totalCentavos: number
  readonly totalPecas: number
  readonly itens: readonly ItemPedido[]
}

@Injectable({ providedIn: 'root' })
export class PedidoServico {
  private readonly http = inject(HttpClient)

  readonly buscando = signal(false)
  readonly resultados = signal<readonly ProdutoCatalogo[]>([])
  readonly limitado = signal(false)
  readonly pedido = signal<Pedido | null>(null)
  readonly salvandoItem = signal(false)

  async buscar(termo: string, perfil: PerfilPreco = PERFIL_PRECO_PADRAO): Promise<void> {
    this.buscando.set(true)
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: ProdutoCatalogo[]; limitado: boolean }>(
          `/v1/catalogo?busca=${encodeURIComponent(termo)}&perfil=${perfil}`),
      )
      this.resultados.set(r.itens)
      this.limitado.set(r.limitado)
    } finally {
      this.buscando.set(false)
    }
  }

  /** Abre (ou cria) o rascunho de uma conversa e carrega no pad. INV-52. */
  async abrirDaConversa(conversaId: string): Promise<void> {
    const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/pedidos', { conversaId }))
    await this.recarregar(r.id)
  }

  /** Salva o contexto de venda (forma de pagamento, observação) do rascunho. */
  async salvarContexto(id: string, ctx: { formaPagamento?: string | null; observacao?: string | null }): Promise<void> {
    await firstValueFrom(this.http.patch(`/v1/pedidos/${id}`, ctx))
    await this.recarregar(id)
  }

  // --- Catálogo robusto: filtros + paginação (tela de montagem) ---
  readonly filtros = signal<{ cores: string[]; tamanhos: string[]; categorias: string[] }>({ cores: [], tamanhos: [], categorias: [] })
  readonly proximoCursor = signal<string | null>(null)

  async carregarFiltros(): Promise<void> {
    try { this.filtros.set(await firstValueFrom(this.http.get<{ cores: string[]; tamanhos: string[]; categorias: string[] }>('/v1/catalogo/filtros'))) } catch { /* filtros vazios */ }
  }

  async buscarCatalogo(f: { termo?: string | undefined; perfil?: string | undefined; cor?: string | undefined; tamanho?: string | undefined; categoria?: string | undefined; precoMin?: string | undefined; precoMax?: string | undefined }, anexar = false): Promise<void> {
    this.buscando.set(true)
    try {
      const qs = new URLSearchParams()
      if (f.termo) qs.set('busca', f.termo)
      qs.set('perfil', f.perfil ?? 'atacado')
      for (const k of ['cor', 'tamanho', 'categoria', 'precoMin', 'precoMax'] as const) if (f[k]) qs.set(k, f[k]!)
      if (anexar && this.proximoCursor()) qs.set('cursor', this.proximoCursor()!)
      const r = await firstValueFrom(this.http.get<{ itens: ProdutoCatalogo[]; proximoCursor: string | null }>(`/v1/catalogo/busca?${qs}`))
      this.resultados.set(anexar ? [...this.resultados(), ...r.itens] : r.itens)
      this.proximoCursor.set(r.proximoCursor)
    } finally { this.buscando.set(false) }
  }

  // --- Rascunhos por cliente ---
  readonly rascunhos = signal<readonly { id: string; nome: string | null; estado: string; itens: number; totalCentavos: number }[]>([])

  async carregarRascunhos(contatoId: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string | null; estado: string; itens: number; totalCentavos: number }[] }>(`/v1/contatos/${contatoId}/pedidos`))
      this.rascunhos.set(r.itens)
    } catch { /* lista vazia */ }
  }
  async novoRascunho(contatoId: string, nome?: string, conversaId?: string): Promise<void> {
    const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/pedidos', { contatoId, conversaId: conversaId || undefined, nome: nome || undefined, novo: true }))
    await this.recarregar(r.id)
    await this.carregarRascunhos(contatoId)
  }
  async abrirRascunho(id: string): Promise<void> { await this.recarregar(id) }
  async renomear(id: string, nome: string, contatoId?: string): Promise<void> {
    await firstValueFrom(this.http.patch(`/v1/pedidos/${id}`, { nome }))
    await this.recarregar(id)
    if (contatoId) await this.carregarRascunhos(contatoId)
  }

  /** Garante um rascunho para o contato/conversa. Idempotente por conversa. */
  async garantirPedido(contatoId?: string): Promise<string> {
    const atual = this.pedido()
    if (atual) return atual.id
    const r = await firstValueFrom(
      this.http.post<{ id: string }>('/v1/pedidos', contatoId ? { contatoId } : {}),
    )
    await this.recarregar(r.id)
    return r.id
  }

  async adicionar(pedidoId: string, item: {
    skuId: string; skuSnapshot: string; descricaoSnapshot: string
    grade: Record<string, string>; quantidade: number; valorUnitarioCentavos: number
  }): Promise<void> {
    this.salvandoItem.set(true)
    try {
      await firstValueFrom(this.http.post(`/v1/pedidos/${pedidoId}/itens`, item))
      await this.recarregar(pedidoId)
    } finally {
      this.salvandoItem.set(false)
    }
  }

  private async recarregar(id: string): Promise<void> {
    this.pedido.set(await firstValueFrom(this.http.get<Pedido>(`/v1/pedidos/${id}`)))
  }

  // Efetivação (ADR-005). O resultado é tipificado: sucesso, degradação (ERP não
  // escreve) ou falha nomeada — a tela mostra cada um, e o rascunho nunca some.
  readonly efetivando = signal(false)
  readonly resultado = signal<ResultadoEfetivacao | null>(null)
  readonly enviandoResumo = signal(false)
  readonly resumoMsg = signal<{ ok: boolean; texto: string } | null>(null)

  async efetivar(id: string): Promise<void> {
    if (this.efetivando()) return
    this.efetivando.set(true)
    this.resultado.set(null)
    try {
      const r = await firstValueFrom(this.http.post<ResultadoEfetivacao>(`/v1/pedidos/${id}/efetivar`, {}))
      this.resultado.set(r)
    } catch (e) {
      // Falha de negócio volta como 4xx com o corpo tipificado.
      this.resultado.set(e instanceof HttpErrorResponse && e.error
        ? (e.error as ResultadoEfetivacao) : { mensagem: 'Não foi possível efetivar.' })
    } finally {
      this.efetivando.set(false)
      await this.recarregar(id) // reflete o novo estado; o rascunho continua lá
    }
  }

  /**
   * Confirma com o cliente: manda o resumo do pedido na conversa (gateway único).
   * Devolve o `conversaId` quando enviou — a tela abre o chat onde a mensagem caiu.
   */
  async enviarResumo(id: string): Promise<string | null> {
    if (this.enviandoResumo()) return null
    this.enviandoResumo.set(true)
    this.resumoMsg.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; motivo?: string; conversaId?: string }>(`/v1/pedidos/${id}/enviar-resumo`, {}))
      this.resumoMsg.set(r.ok
        ? { ok: true, texto: 'Resumo enviado ao cliente no chat.' }
        : { ok: false, texto: this.motivoResumo(r.motivo) })
      return r.ok ? (r.conversaId ?? null) : null
    } catch (e) {
      const erro = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro : undefined
      this.resumoMsg.set({
        ok: false,
        texto: erro === 'pedido.sem_conversa' ? 'Este pedido não nasceu numa conversa; não há para quem enviar.'
          : erro === 'pedido.vazio' ? 'Adicione itens antes de enviar o resumo.'
          : 'Não foi possível enviar o resumo.',
      })
      return null
    } finally { this.enviandoResumo.set(false) }
  }
  private motivoResumo(m?: string): string {
    return m === 'janela_fechada' ? 'A janela de 24h fechou — reabra com um template antes.'
      : m === 'bloqueado' ? 'O cliente pediu para não receber (opt-out).'
      : m === 'canal_sem_credencial' ? 'O canal ainda não está configurado para enviar.'
      : m === 'canal_indisponivel' ? 'O canal está suspenso ou desconectado.'
      : 'Não foi possível enviar o resumo agora.'
  }
}

export interface ResultadoEfetivacao {
  readonly ok?: boolean
  readonly degradado?: boolean
  readonly estado?: string
  readonly numeroExterno?: string
  readonly mensagem?: string
}
