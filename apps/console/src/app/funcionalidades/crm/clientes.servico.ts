import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

/**
 * Estado da lista de clientes com RFV.
 *
 * ⚠️ Os cinco estados obrigatórios são EXPLÍCITOS (regra do console), não
 * derivados de `itens.length`. Vazio-por-erro e vazio-por-base-limpa pedem
 * telas opostas.
 *
 * ⚠️ Paginação por CURSOR: `carregarMais` acrescenta, nunca recarrega do zero
 * nem usa página numérica. O grid não paginado foi o que derrubou o Postgres
 * do GeraCloud.
 */

export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

export interface ResultadoImport {
  readonly total: number
  readonly criados: number
  readonly atualizados: number
  readonly rejeitados: number
  readonly rejeicoes: readonly { linha: number; motivo: string }[]
}

export interface SegmentoRfv {
  readonly codigo: string
  readonly rotulo: string
  readonly acao: string
  readonly urgencia: number
}

export interface ClienteRfv {
  readonly id: string
  readonly nome: string
  readonly qtdVendas: number
  readonly totalCentavos: number
  readonly ticketMedioCentavos: number | null
  readonly diasSemComprar: number | null
  readonly mediaEntreVendasDias: number | null
  readonly atrasoRelativo: number | null
  readonly ultimaVendaEm: string | null
  readonly confiavel: boolean
  readonly segmento: SegmentoRfv
}

export interface ContatoBusca {
  readonly id: string
  readonly nome: string
  readonly telefone: string | null
}

@Injectable({ providedIn: 'root' })
export class ClientesServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly clientes = signal<readonly ClienteRfv[]>([])
  readonly erro = signal<string | null>(null)
  private readonly cursor = signal<string | null>(null)
  private readonly carregandoMais = signal(false)

  readonly temMais = computed(() => this.cursor() !== null)
  readonly buscandoMais = this.carregandoMais.asReadonly()
  readonly vazio = computed(() => this.estado() === 'pronto' && this.clientes().length === 0)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    this.cursor.set(null)
    try {
      const r = await this.buscar(null)
      this.clientes.set(r.itens)
      this.cursor.set(r.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) {
        this.estado.set('sem_permissao')
        return
      }
      this.erro.set(this.mensagem(e))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.cursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.buscar(cursor)
      // ⚠️ Acrescenta ao que já está na tela — a rolagem não recomeça.
      this.clientes.update((atual) => [...atual, ...r.itens])
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      // Falha ao paginar é PARCIAL: o que já carregou continua utilizável.
      this.erro.set(this.mensagem(e))
    } finally {
      this.carregandoMais.set(false)
    }
  }

  // Cadastro de contato + iniciar conversa
  readonly salvandoContato = signal(false)
  readonly erroForm = signal<string | null>(null)

  // Busca de contato (por nome ou telefone) — acha até contato manual sem venda.
  readonly resultadosBusca = signal<readonly ContatoBusca[]>([])
  readonly buscando = signal(false)

  async buscarContatos(termo: string): Promise<void> {
    const q = termo.trim()
    if (q.length < 2) { this.resultadosBusca.set([]); return }
    this.buscando.set(true)
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: ContatoBusca[] }>(`/v1/contatos/busca?q=${encodeURIComponent(q)}`),
      )
      this.resultadosBusca.set(r.itens)
    } catch {
      this.resultadosBusca.set([])
    } finally {
      this.buscando.set(false)
    }
  }

  /** Cadastra um contato (nome + telefone). Devolve o id (novo ou existente). */
  async criarContato(nome: string, telefone: string): Promise<string | null> {
    this.salvandoContato.set(true)
    this.erroForm.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/contatos', { nome, telefone }))
      await this.carregar()
      return r.id
    } catch (e) {
      this.erroForm.set(this.mensagem(e))
      return null
    } finally {
      this.salvandoContato.set(false)
    }
  }

  // Importação por CSV (EP-02).
  readonly importando = signal(false)
  readonly resultadoImport = signal<ResultadoImport | null>(null)
  readonly erroImport = signal<string | null>(null)

  async importarCsv(csv: string): Promise<void> {
    if (this.importando()) return
    this.importando.set(true)
    this.erroImport.set(null)
    this.resultadoImport.set(null)
    try {
      const r = await firstValueFrom(this.http.post<ResultadoImport>('/v1/contatos/importar', { csv }))
      this.resultadoImport.set(r)
      await this.carregar() // a lista reflete os novos contatos
    } catch (e) {
      this.erroImport.set(this.mensagem(e))
    } finally {
      this.importando.set(false)
    }
  }

  /** Inicia (ou reabre) a conversa com um contato. Devolve o conversaId. */
  async iniciarConversa(contatoId: string): Promise<string | null> {
    this.erroForm.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ conversaId: string }>('/v1/conversas', { contatoId }))
      return r.conversaId
    } catch (e) {
      this.erroForm.set(this.mensagem(e))
      return null
    }
  }

  private async buscar(cursor: string | null) {
    const params = new URLSearchParams({ limite: '30' })
    if (cursor) params.set('cursor', cursor)
    return firstValueFrom(
      this.http.get<{ itens: ClienteRfv[]; proximoCursor: string | null }>(
        `/v1/contatos?${params.toString()}`,
      ),
    )
  }

  private mensagem(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) return 'Não foi possível falar com o Drezz Hub. Verifique sua conexão.'
      return `O Drezz Hub respondeu com erro (${e.status}).`
    }
    return 'Erro inesperado.'
  }
}
