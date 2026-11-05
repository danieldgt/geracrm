import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { AcaoEmMassaContato } from '@geracrm/shared'
import { mesclarPagina, type OpcaoSelect } from '../../compartilhado/ui/index.js'
import { tokenDaCor } from './etiquetas.regras.js'
import { FILTROS_CONTATOS_VAZIOS, paramsDaApi, type FiltrosContatos } from './clientes.regras.js'

/**
 * Estado da lista de Contatos (A2): filtros no servidor, cursor, seleção fica na tela.
 *
 * ⚠️ Os cinco estados obrigatórios são EXPLÍCITOS, não derivados de `itens.length`.
 * ⚠️ Paginação por CURSOR: `carregarMais` acrescenta (mesclando por id), nunca recarrega
 * do zero nem usa página numérica. Trocar filtro volta ao início (cursor novo).
 * ⚠️ Corrida: cada carga tem um número; resposta de filtro antigo é descartada.
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

export interface EtiquetaDoContato { readonly id: string; readonly nome: string; readonly cor: string }

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
  // A2 — o que a tabela mostra ao lado do RFV (ausente em quem lê a Fila do Dia).
  readonly email?: string | null
  readonly telefone?: string | null
  readonly qualificacao?: string
  readonly origem?: string | null
  readonly vendedor?: string | null
  readonly etiquetas?: readonly EtiquetaDoContato[]
  readonly etiquetasTotal?: number
  readonly ultimaCompraEm?: string | null
  readonly criadoEm?: string
  readonly semProximoPasso?: boolean
}

interface PaginaContatos {
  readonly itens: ClienteRfv[]
  readonly proximoCursor: string | null
  readonly gestao?: boolean
}

export interface ResultadoAcaoEmMassa { readonly aplicados: number; readonly ignorados: number }

/** Erro de uma ação em massa: mensagem e, se a API apontou, os campos. */
export class ErroAcaoEmMassa extends Error {
  constructor(mensagem: string, readonly campos: readonly string[], readonly status: number) { super(mensagem) }
}

interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor?: string | null }

@Injectable({ providedIn: 'root' })
export class ClientesServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly clientes = signal<readonly ClienteRfv[]>([])
  readonly erro = signal<string | null>(null)
  /** O chamador é da gestão? Vem da própria lista (a API revalida cada ação). */
  readonly gestao = signal(false)
  private readonly cursor = signal<string | null>(null)
  private readonly carregandoMais = signal(false)
  private filtros: FiltrosContatos = FILTROS_CONTATOS_VAZIOS
  private carga = 0

  readonly temMais = computed(() => this.cursor() !== null)
  readonly buscandoMais = this.carregandoMais.asReadonly()
  readonly vazio = computed(() => this.estado() === 'pronto' && this.clientes().length === 0)

  /** (Re)carrega do início com os filtros dados. */
  async carregar(filtros: FiltrosContatos = this.filtros): Promise<void> {
    this.filtros = filtros
    const minha = ++this.carga
    this.estado.set('carregando')
    this.erro.set(null)
    this.cursor.set(null)
    try {
      const r = await this.buscar(null)
      if (minha !== this.carga) return
      this.clientes.set(r.itens)
      this.cursor.set(r.proximoCursor)
      if (r.gestao !== undefined) this.gestao.set(r.gestao)
      this.estado.set('pronto')
    } catch (e) {
      if (minha !== this.carga) return
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
    const minha = this.carga
    this.carregandoMais.set(true)
    try {
      const r = await this.buscar(cursor)
      if (minha !== this.carga) return
      // ⚠️ Acrescenta ao que já está na tela, sem repetir id — a rolagem não recomeça.
      this.clientes.update((atual) => mesclarPagina(atual, r.itens, (c) => c.id))
      this.cursor.set(r.proximoCursor)
    } catch (e) {
      // Falha ao paginar é PARCIAL: o que já carregou continua utilizável.
      if (minha === this.carga) this.erro.set(this.mensagem(e))
    } finally {
      this.carregandoMais.set(false)
    }
  }

  // ───────────── catálogos dos filtros e dos modais (listas pequenas, por cursor) ─────────────
  readonly origens = signal<OpcaoSelect[]>([])
  readonly etiquetas = signal<{ valor: string; rotulo: string; cor: string }[]>([])
  readonly listas = signal<OpcaoSelect[]>([])
  readonly equipe = signal<OpcaoSelect[]>([])
  readonly filiais = signal<OpcaoSelect[]>([])
  private catalogosCarregados = false

  /** Carrega uma vez; cada catálogo que falha só deixa o seu select vazio (a lista segue). */
  async carregarCatalogos(): Promise<void> {
    if (this.catalogosCarregados) return
    this.catalogosCarregados = true
    const tudo = async <T>(url: string): Promise<T[]> => {
      const itens: T[] = []
      let cursor: string | null = null
      // Catálogos pequenos; o teto de páginas impede laço sem fim.
      for (let i = 0; i < 20; i++) {
        const qs: string = cursor ? `${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''
        const r: Pagina<T> = await firstValueFrom(this.http.get<Pagina<T>>(`${url}${qs}`))
        itens.push(...r.itens)
        cursor = r.proximoCursor ?? null
        if (!cursor) break
      }
      return itens
    }
    await Promise.all([
      tudo<{ id: string; nome: string }>('/v1/origens?ativas=true')
        .then((l) => this.origens.set(l.map((o) => ({ valor: o.id, rotulo: o.nome })))).catch(() => undefined),
      tudo<{ id: string; nome: string; cor: string }>('/v1/etiquetas?ativas=true')
        .then((l) => this.etiquetas.set(l.map((e) => ({ valor: e.id, rotulo: e.nome, cor: tokenDaCor(e.cor) }))))
        .catch(() => undefined),
      firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/listas'))
        .then((r) => this.listas.set(r.itens.map((l) => ({ valor: l.id, rotulo: l.nome })))).catch(() => undefined),
      firstValueFrom(this.http.get<{ itens: { id: string; nome: string }[] }>('/v1/equipe'))
        .then((r) => this.equipe.set(r.itens.map((u) => ({ valor: u.id, rotulo: u.nome })))).catch(() => undefined),
      // Filial é cadastro de admin: gestor de filial recebe 403 e fica sem o filtro (o escopo já o recorta).
      tudo<{ id: string; nome: string }>('/v1/filiais')
        .then((l) => this.filiais.set(l.map((f) => ({ valor: f.id, rotulo: f.nome })))).catch(() => undefined),
    ])
  }

  // ───────────── ações em massa ─────────────
  readonly aplicando = signal(false)

  /** Roda a ação; devolve o resultado ou lança `ErroAcaoEmMassa` (422 com campos, 403, rede). */
  async acaoEmMassa(acao: AcaoEmMassaContato, corpo: Record<string, unknown>): Promise<ResultadoAcaoEmMassa> {
    this.aplicando.set(true)
    try {
      return await firstValueFrom(this.http.post<ResultadoAcaoEmMassa>(`/v1/contatos/acoes-em-massa/${acao}`, corpo))
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        const b = (e.error ?? {}) as { mensagem?: string; campos?: string[] }
        if (e.status === 403) throw new ErroAcaoEmMassa('Seu papel não permite esta ação. Peça a um administrador.', [], 403)
        throw new ErroAcaoEmMassa(b.mensagem ?? this.mensagem(e), b.campos ?? [], e.status)
      }
      throw new ErroAcaoEmMassa('Erro inesperado.', [], 0)
    } finally {
      this.aplicando.set(false)
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
    this.erro.set(null)
    try {
      const r = await firstValueFrom(this.http.post<{ conversaId: string }>('/v1/conversas', { contatoId }))
      return r.conversaId
    } catch (e) {
      this.erro.set(this.mensagem(e))
      return null
    }
  }

  private buscar(cursor: string | null): Promise<PaginaContatos> {
    return firstValueFrom(this.http.get<PaginaContatos>(`/v1/contatos?${paramsDaApi(this.filtros, cursor)}`))
  }

  private mensagem(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) return 'Não foi possível falar com o Drezz Hub. Verifique sua conexão.'
      return `O Drezz Hub respondeu com erro (${e.status}).`
    }
    return 'Erro inesperado.'
  }
}
