import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { SegmentoRfv } from './clientes.servico.js'

/** O contato 360°, como a API entrega. */
export interface FichaContato {
  readonly id: string
  readonly nome: string
  readonly modalidade: string | null
  readonly qualificado: boolean | null
  readonly recebeCampanhas: boolean
  readonly recebeAutomacoes: boolean
  readonly telefones: readonly { seq: number; e164: string; principal: boolean; whatsapp: boolean }[]
  readonly documentos: readonly { seq: number; tipo: string; numero: string; fiscal: boolean }[]
  readonly totalDocumentos: number
  readonly endereco: {
    logradouro: string | null; numero: string | null; bairro: string | null
    cidade: string | null; uf: string | null; cep: string | null
  } | null
  readonly metricas: {
    qtdVendas: number; totalCentavos: number; ticketMedioCentavos: number | null
    diasSemComprar: number | null; mediaEntreVendasDias: number | null
    atrasoRelativo: number | null; ultimaVendaEm: string | null; confiavel: boolean
    segmento: SegmentoRfv
  } | null
  readonly ultimasVendas: readonly { id: string; ocorridaEm: string; valorCentavos: number; cancelada: boolean }[]
  readonly categorias: readonly { categoria: string; totalCentavos: number; qtd: number }[]
  readonly comentarios: readonly { id: string; texto: string; criadoEm: string }[]
}

export type EstadoFicha = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'nao_encontrado' | 'sem_permissao'

@Injectable({ providedIn: 'root' })
export class FichaServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoFicha>('ocioso')
  readonly ficha = signal<FichaContato | null>(null)
  readonly erro = signal<string | null>(null)

  async carregar(id: string): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    this.ficha.set(null)
    try {
      const f = await firstValueFrom(this.http.get<FichaContato>(`/v1/contatos/${id}`))
      this.ficha.set(f)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        if (e.status === 404) { this.estado.set('nao_encontrado'); return }
        if (e.status === 403) { this.estado.set('sem_permissao'); return }
        this.erro.set(e.status === 0 ? 'Sem conexão com o GeraCRM.' : `Erro ${e.status}.`)
      } else {
        this.erro.set('Erro inesperado.')
      }
      this.estado.set('erro')
    }
  }

  // ───────── Edição (CRUD da ficha) ─────────
  readonly erroEdicao = signal<string | null>(null)
  private idAtual: string | null = null

  private async apos<T>(op: Promise<T>): Promise<boolean> {
    this.erroEdicao.set(null)
    try {
      await op
      if (this.idAtual) await this.carregar(this.idAtual)
      return true
    } catch (e) {
      this.erroEdicao.set(e instanceof HttpErrorResponse && (e.error as { mensagem?: string })?.mensagem
        ? (e.error as { mensagem: string }).mensagem : 'Não foi possível salvar.')
      return false
    }
  }

  /** Lembra o id para recarregar após cada edição. */
  vincular(id: string): void { this.idAtual = id }

  editarNome(nome: string): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.patch(`/v1/contatos/${this.idAtual}`, { nome })))
  }
  addTelefone(telefone: string): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.post(`/v1/contatos/${this.idAtual}/telefones`, { telefone })))
  }
  principalTelefone(seq: number): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.post(`/v1/contatos/${this.idAtual}/telefones/${seq}/principal`, {})))
  }
  removerTelefone(seq: number): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.delete(`/v1/contatos/${this.idAtual}/telefones/${seq}`)))
  }
  addDocumento(tipo: 'cnpj' | 'cpf', numero: string): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.post(`/v1/contatos/${this.idAtual}/documentos`, { tipo, numero })))
  }
  removerDocumento(seq: number): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.delete(`/v1/contatos/${this.idAtual}/documentos/${seq}`)))
  }
  addComentario(texto: string): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.post(`/v1/contatos/${this.idAtual}/comentarios`, { texto })))
  }
  salvarEndereco(e: Record<string, string>): Promise<boolean> {
    return this.apos(firstValueFrom(this.http.put(`/v1/contatos/${this.idAtual}/endereco`, e)))
  }
}
