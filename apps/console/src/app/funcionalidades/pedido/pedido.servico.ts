import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { PERFIL_PRECO_PADRAO, type PerfilPreco } from '@geracrm/shared'
import { codigoDoErro, corpoDoErro, mensagemDeErro } from '../../compartilhado/ui/erro-http.js'

/**
 * Falha de negócio ao mexer nos itens — TIPIFICADA (PED-08), com a frase da API
 * (que já traz a ação corretiva). A tela mostra pelo código, nunca "erro".
 */
export interface FalhaItem {
  readonly codigo:
    | 'pedido.sku_desconhecido' | 'pedido.sem_preco' | 'pedido.estoque_insuficiente'
    | 'pedido.regras' | 'pedido.imutavel' | 'pedido.nao_encontrado' | 'pedido.quantidade_invalida'
    | 'item.nao_encontrado' | 'outro'
  readonly mensagem: string
  /** Só em `estoque_insuficiente`: quanto dá para vender. */
  readonly disponivel?: number
}

function falhaDe(e: unknown, padrao: string): FalhaItem {
  const codigo = codigoDoErro(e)
  const corpo = corpoDoErro(e)
  const conhecido: readonly FalhaItem['codigo'][] = [
    'pedido.sku_desconhecido', 'pedido.sem_preco', 'pedido.estoque_insuficiente', 'pedido.regras',
    'pedido.imutavel', 'pedido.nao_encontrado', 'pedido.quantidade_invalida', 'item.nao_encontrado',
  ]
  const mensagens: Partial<Record<FalhaItem['codigo'], string>> = {
    'pedido.imutavel': 'Este pedido não é mais um rascunho — abra ou crie outro para mexer nos itens.',
    'pedido.nao_encontrado': 'Este rascunho não existe mais. Crie um novo.',
    'item.nao_encontrado': 'Este item já não está no rascunho.',
  }
  const c = (conhecido as readonly string[]).includes(codigo ?? '') ? (codigo as FalhaItem['codigo']) : 'outro'
  return {
    codigo: c,
    mensagem: mensagemDeErro(e, mensagens[c] ?? padrao),
    ...(typeof corpo?.disponivel === 'number' ? { disponivel: corpo.disponivel } : {}),
  }
}

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

  /** Estado PARCIAL: a busca funciona sem os filtros, mas a tela avisa. */
  readonly avisoFiltros = signal<string | null>(null)
  async carregarFiltros(): Promise<void> {
    this.avisoFiltros.set(null)
    try { this.filtros.set(await firstValueFrom(this.http.get<{ cores: string[]; tamanhos: string[]; categorias: string[] }>('/v1/catalogo/filtros'))) }
    catch { this.avisoFiltros.set('Os filtros de cor, tamanho e categoria não carregaram — a busca por texto continua funcionando.') }
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

  readonly avisoRascunhos = signal<string | null>(null)
  async carregarRascunhos(contatoId: string): Promise<void> {
    this.avisoRascunhos.set(null)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: { id: string; nome: string | null; estado: string; itens: number; totalCentavos: number }[] }>(`/v1/contatos/${contatoId}/pedidos`))
      this.rascunhos.set(r.itens)
    } catch (e) { this.avisoRascunhos.set(mensagemDeErro(e, 'Não foi possível listar os rascunhos deste cliente.')) }
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

  /** Última falha de negócio nos itens — a tela mostra nomeada, com ação corretiva. */
  readonly erroItem = signal<FalhaItem | null>(null)

  /**
   * Adiciona pelo SKU. ⚠️ Só `skuId` + `quantidade` (+ `perfil`): o PREÇO é
   * resolvido no servidor (ADR-025) — a tela não manda valor nenhum, então não
   * há como ela "inventar" preço. Falha volta tipificada, não como exceção.
   */
  async adicionar(pedidoId: string, item: { skuId: string; quantidade: number; perfil?: PerfilPreco }): Promise<{ ok: true } | { ok: false; falha: FalhaItem }> {
    this.salvandoItem.set(true)
    this.erroItem.set(null)
    try {
      await firstValueFrom(this.http.post(`/v1/pedidos/${pedidoId}/itens`, item))
      await this.recarregar(pedidoId)
      return { ok: true }
    } catch (e) {
      const falha = falhaDe(e, 'Não foi possível adicionar o item.')
      this.erroItem.set(falha)
      return { ok: false, falha }
    } finally {
      this.salvandoItem.set(false)
    }
  }

  readonly removendoItem = signal<number | null>(null)
  /** Remove um item do rascunho (o servidor recalcula os totais). */
  async removerItem(pedidoId: string, seq: number): Promise<{ ok: true } | { ok: false; falha: FalhaItem }> {
    this.removendoItem.set(seq)
    this.erroItem.set(null)
    try {
      await firstValueFrom(this.http.delete(`/v1/pedidos/${pedidoId}/itens/${seq}`))
      await this.recarregar(pedidoId)
      return { ok: true }
    } catch (e) {
      const falha = falhaDe(e, 'Não foi possível remover o item.')
      this.erroItem.set(falha)
      // O item pode já ter saído (outra aba): reflete o estado real.
      if (falha.codigo === 'item.nao_encontrado') await this.recarregar(pedidoId).catch(() => undefined)
      return { ok: false, falha }
    } finally {
      this.removendoItem.set(null)
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
      : m === 'canal_arquivado' ? 'Este número foi removido da frota. Use outro número.'
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
