import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { EsquemaCredencial } from '../integracao/tipos.js'

export interface ProvedorCanal {
  readonly codigo: string
  readonly nome: string
  readonly tipo: string
  readonly oficial: boolean
  readonly descricao: string
  readonly esquemaCredencial: EsquemaCredencial
  readonly capacidades: { janela24h: boolean; aceitaTemplate: boolean; riscoBanimento: boolean; textoLivreSempre: boolean }
  readonly aviso: string | null
}

export interface Canal {
  readonly id: string
  readonly tipo: string
  readonly provedor: string | null
  readonly nomeAmigavel: string
  readonly estado: string
  readonly ultimoErro: string | null
  readonly credencial: { configurada: boolean; camposPreenchidos: readonly string[] }
}

export interface ErroApi {
  readonly erro: string
  readonly mensagem: string
  readonly detalhe?: { campos?: Record<string, string>; campo?: string }
}

export type EstadoLista = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/** Saúde da frota (EP-03): entrega recente + alertas abertos. */
export interface SaudeFrota {
  readonly entrega: { ok: number; falha: number; taxa: number | null; amostras: number }
  readonly alertasAbertos: number
}

@Injectable({ providedIn: 'root' })
export class CanaisServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoLista>('ocioso')
  readonly canais = signal<readonly Canal[]>([])
  readonly provedores = signal<readonly ProvedorCanal[]>([])
  readonly erro = signal<string | null>(null)
  readonly testando = signal<ReadonlySet<string>>(new Set())
  readonly saude = signal<SaudeFrota | null>(null)
  readonly vazio = computed(() => this.estado() === 'pronto' && this.canais().length === 0)

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const [provs, lista, saude] = await Promise.all([
        firstValueFrom(this.http.get<ProvedorCanal[]>('/v1/canais/provedores')),
        firstValueFrom(this.http.get<{ itens: Canal[] }>('/v1/canais')),
        // ⚠️ Saúde é PARCIAL: se falhar, os canais ainda aparecem (não derruba a tela).
        firstValueFrom(this.http.get<SaudeFrota>('/v1/frota/saude')).catch(() => null),
      ])
      this.provedores.set(provs)
      this.canais.set(lista.itens)
      this.saude.set(saude)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erro.set('Não foi possível carregar os canais.')
      this.estado.set('erro')
    }
  }

  async criar(dados: { provedor: string; nomeAmigavel: string; credencial: Record<string, string> }):
    Promise<{ ok: true; id: string } | { ok: false; erro: ErroApi }> {
    try {
      const r = await firstValueFrom(this.http.post<{ id: string }>('/v1/canais', dados))
      await this.carregar()
      return { ok: true, id: r.id }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  async testar(id: string): Promise<{ conectado: boolean; detalhe?: string }> {
    this.testando.update((s) => new Set(s).add(id))
    try {
      const r = await firstValueFrom(this.http.post<{ conectado: boolean; detalhe?: string }>(`/v1/canais/${id}/testar`, {}))
      await this.carregar()
      return r
    } catch {
      return { conectado: false, detalhe: 'falha ao testar' }
    } finally {
      this.testando.update((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // Aquecimento de frota (Onda 3): teto diário de disparo por número.
  readonly aquecimento = signal<Record<string, Aquecimento>>({})

  async carregarAquecimento(id: string): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<Aquecimento>(`/v1/canais/${id}/aquecimento`))
      this.aquecimento.update((a) => ({ ...a, [id]: r }))
    } catch { /* silencioso */ }
  }

  async iniciarAquecimento(id: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/v1/canais/${id}/aquecimento`, {}))
      await this.carregarAquecimento(id)
    } catch { /* silencioso */ }
  }
}

export interface Aquecimento {
  readonly emAquecimento: boolean
  readonly dia: number
  readonly limiteHoje: number | null
  readonly usadoHoje: number
  readonly restante: number | null
}

function erroApiDe(e: unknown): ErroApi {
  if (e instanceof HttpErrorResponse && e.error && typeof e.error === 'object' && 'erro' in e.error) return e.error as ErroApi
  return { erro: 'erro.desconhecido', mensagem: 'Erro inesperado.' }
}
