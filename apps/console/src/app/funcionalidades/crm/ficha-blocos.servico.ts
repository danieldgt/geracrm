import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type { FatoMemoria, ItemFeed } from './ficha.regras.js'

export interface PaginaFeed { readonly itens: readonly ItemFeed[]; readonly proximoCursor: string | null }
export interface ArquivoContato {
  readonly id: string
  readonly nome: string
  readonly tipoMime: string
  readonly tamanhoBytes: number
  readonly legenda: string | null
  readonly enviadoPor: { readonly id: string; readonly nome: string } | null
  readonly criadoEm: string
}
export interface PaginaArquivos { readonly itens: readonly ArquivoContato[]; readonly proximoCursor: string | null; readonly bucketDisponivel: boolean }
export type PedidoDoContato = {
  readonly id: string
  readonly estado: string
  readonly rotulo: string | null
  readonly totalCentavos: number
  readonly itens: number
  readonly numeroExterno: string | null
  readonly criadoEm: string
}
export type TarefaDoContato = {
  readonly id: string
  readonly titulo: string
  readonly tipo: string
  readonly estado: string
  readonly venceEm: string
  readonly vencida: boolean
  readonly responsavel: string | null
  readonly resultado: string | null
}
export interface ResumoWhatsapp {
  readonly conversa: { readonly id: string; readonly canal: string; readonly ultimaMensagemEm: string | null } | null
  readonly mensagens: readonly { id: string; direcao: string; tipo: string; criadoEm: string; resumo: string }[]
}

/**
 * Leituras e escritas dos BLOCOS da ficha. Sem estado de propósito: cada bloco da tela guarda o seu
 * (carregando/erro/pronto), então um bloco que falha não derruba a ficha. Tudo por cursor.
 */
@Injectable({ providedIn: 'root' })
export class FichaBlocosServico {
  private readonly http = inject(HttpClient)

  feed(id: string, cursor: string | null): Promise<PaginaFeed> {
    return firstValueFrom(this.http.get<PaginaFeed>(`/v1/contatos/${id}/feed${queryDeLista({ cursor })}`))
  }
  async memoria(id: string): Promise<FatoMemoria[]> {
    const r = await firstValueFrom(this.http.get<{ itens: { id: string; tipo: string; fato: string }[] }>(`/v1/contatos/${id}/memoria`))
    return r.itens
  }
  comentar(id: string, texto: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`/v1/contatos/${id}/comentarios`, { texto }))
  }
  arquivos(id: string, cursor: string | null): Promise<PaginaArquivos> {
    return firstValueFrom(this.http.get<PaginaArquivos>(`/v1/contatos/${id}/arquivos${queryDeLista({ cursor })}`))
  }
  enviarArquivo(id: string, arquivo: File): Promise<unknown> {
    const corpo = new FormData()
    corpo.append('arquivo', arquivo, arquivo.name)
    return firstValueFrom(this.http.post(`/v1/contatos/${id}/arquivos`, corpo))
  }
  removerArquivo(id: string, arquivoId: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/v1/contatos/${id}/arquivos/${arquivoId}`))
  }
  urlDoArquivo(id: string, arquivoId: string): Promise<{ url: string; nome: string }> {
    return firstValueFrom(this.http.get<{ url: string; nome: string }>(`/v1/contatos/${id}/arquivos/${arquivoId}/url`))
  }
  pedidos(id: string, cursor: string | null): Promise<{ itens: PedidoDoContato[]; proximoCursor: string | null }> {
    return firstValueFrom(this.http.get<{ itens: PedidoDoContato[]; proximoCursor: string | null }>(
      `/v1/pedidos${queryDeLista({ contatoId: id, cursor })}`))
  }
  tarefas(id: string, cursor: string | null): Promise<{ itens: TarefaDoContato[]; proximoCursor: string | null }> {
    return firstValueFrom(this.http.get<{ itens: TarefaDoContato[]; proximoCursor: string | null }>(
      `/v1/tarefas${queryDeLista({ contatoId: id, cursor })}`))
  }
  whatsapp(id: string): Promise<ResumoWhatsapp> {
    return firstValueFrom(this.http.get<ResumoWhatsapp>(`/v1/contatos/${id}/whatsapp`))
  }
  qualificar(id: string, estado: 'qualificado' | 'descartado'): Promise<unknown> {
    return firstValueFrom(this.http.post(`/v1/leads/${id}/qualificar`, { estado }))
  }
}
