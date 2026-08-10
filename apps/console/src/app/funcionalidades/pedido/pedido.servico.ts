import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
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
  readonly ultimoErro: { tipo: string } | null
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

  /** Confirma com o cliente: manda o resumo do pedido na conversa (gateway único). */
  async enviarResumo(id: string): Promise<void> {
    if (this.enviandoResumo()) return
    this.enviandoResumo.set(true)
    this.resumoMsg.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ ok: boolean; motivo?: string }>(`/v1/pedidos/${id}/enviar-resumo`, {}))
      this.resumoMsg.set(r.ok
        ? { ok: true, texto: 'Resumo enviado ao cliente no chat.' }
        : { ok: false, texto: this.motivoResumo(r.motivo) })
    } catch (e) {
      const erro = e instanceof HttpErrorResponse ? (e.error as { erro?: string })?.erro : undefined
      this.resumoMsg.set({
        ok: false,
        texto: erro === 'pedido.sem_conversa' ? 'Este pedido não nasceu numa conversa; não há para quem enviar.'
          : erro === 'pedido.vazio' ? 'Adicione itens antes de enviar o resumo.'
          : 'Não foi possível enviar o resumo.',
      })
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
