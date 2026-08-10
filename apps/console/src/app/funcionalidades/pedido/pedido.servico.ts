import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

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

  async buscar(termo: string, perfil: 'atacado' | 'varejo' = 'atacado'): Promise<void> {
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
}
