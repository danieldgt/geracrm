import { Injectable, inject, signal, computed } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { Conexao, ConectorDisponivel, ErroApi, ResultadoTeste } from './tipos.js'

/**
 * Estado da tela de conexões de ERP.
 *
 * ⚠️ Os cinco estados obrigatórios (carregando, vazio, erro, sem permissão,
 * parcial) são explícitos aqui — não derivados de `lista.length === 0`. Uma
 * lista vazia por FALHA e uma lista vazia por NÃO TER NADA pedem telas
 * opostas: uma oferece "tentar de novo", a outra oferece "conectar seu ERP".
 * Derivar do tamanho colapsa as duas e mostra o convite errado justamente
 * quando a API caiu.
 */

export type EstadoCarga = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/** Uma ingestão concluída (INT-08) — o que cada fluxo trouxe e rejeitou. */
export interface Operacao {
  readonly fluxo: 'customers' | 'products' | 'orders'
  readonly origem: string
  readonly iniciadoEm: string
  readonly concluidoEm: string | null
  readonly total: number
  readonly aceitos: number
  readonly rejeitados: number
  readonly estado: string
}

@Injectable({ providedIn: 'root' })
export class ConexoesServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoCarga>('ocioso')
  readonly conexoes = signal<readonly Conexao[]>([])
  readonly conectores = signal<readonly ConectorDisponivel[]>([])
  readonly erro = signal<string | null>(null)

  /** ⚠️ Vazio DE VERDADE: pronto e sem nenhuma conexão. */
  readonly vazio = computed(() => this.estado() === 'pronto' && this.conexoes().length === 0)

  /** ids em teste — o botão de cada linha desabilita sozinho. */
  readonly testando = signal<ReadonlySet<string>>(new Set())

  /** Histórico de sincronizações (INT-08). Vazio até a primeira carga rodar. */
  readonly operacoes = signal<readonly Operacao[]>([])

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const [conectores, conexoes] = await Promise.all([
        firstValueFrom(this.http.get<ConectorDisponivel[]>('/v1/integracao/conectores')),
        firstValueFrom(this.http.get<{ itens: Conexao[] }>('/v1/integracao/conexoes')),
      ])
      this.conectores.set(conectores)
      this.conexoes.set(conexoes.itens)
      this.estado.set('pronto')
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) {
        // ⚠️ Sem permissão é estado próprio, não erro: quem não pode ver
        // integrações não deve receber "tentar de novo" — tentar de novo não
        // vai funcionar nunca, e insistir é o que gera chamado.
        this.estado.set('sem_permissao')
        return
      }
      this.erro.set(mensagemDe(e))
      this.estado.set('erro')
    }
  }

  /**
   * Sincronizações recentes. ⚠️ Falha silenciosa de propósito: é o estado
   * PARCIAL da tela — se o histórico não vier, as conexões ainda aparecem.
   * Um erro aqui não deve derrubar a tela inteira.
   */
  async carregarOperacoes(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: Operacao[] }>('/v1/integracao/operacoes'),
      )
      this.operacoes.set(r.itens)
    } catch {
      // Mantém o que já havia; a lista de conexões não depende disto.
    }
  }

  async criar(dados: {
    conector: string; nomeAmigavel: string; credencial: Record<string, string>
    papelFiscal?: boolean; fonteDeVenda?: boolean
  }): Promise<{ ok: true; id: string } | { ok: false; erro: ErroApi }> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ id: string }>('/v1/integracao/conexoes', dados),
      )
      await this.carregar()
      return { ok: true, id: r.id }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  async alterar(id: string, dados: Record<string, unknown>): Promise<{ ok: true } | { ok: false; erro: ErroApi }> {
    try {
      await firstValueFrom(this.http.patch(`/v1/integracao/conexoes/${id}`, dados))
      await this.carregar()
      return { ok: true }
    } catch (e) {
      return { ok: false, erro: erroApiDe(e) }
    }
  }

  /**
   * ⚠️ O teste responde 200 mesmo quando falha — o resultado é o corpo. Este
   * método devolve o `ResultadoTeste` inteiro para a tela poder mostrar o
   * motivo específico, em vez de um "erro ao conectar" que não diz o que fazer.
   */
  async testar(id: string): Promise<ResultadoTeste> {
    this.testando.update((s) => new Set(s).add(id))
    try {
      const r = await firstValueFrom(
        this.http.post<ResultadoTeste>(`/v1/integracao/conexoes/${id}/testar`, {}),
      )
      await this.carregar()
      return r
    } catch (e) {
      return { ok: false, motivo: 'indisponivel', detalhe: mensagemDe(e) }
    } finally {
      this.testando.update((s) => {
        const proximo = new Set(s)
        proximo.delete(id)
        return proximo
      })
    }
  }
}

function erroApiDe(e: unknown): ErroApi {
  if (e instanceof HttpErrorResponse && e.error && typeof e.error === 'object' && 'erro' in e.error) {
    return e.error as ErroApi
  }
  return { erro: 'erro.desconhecido', mensagem: mensagemDe(e) }
}

function mensagemDe(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    // ⚠️ status 0 é rede/CORS, não erro do servidor. Dizer "erro no servidor"
    // manda a pessoa abrir chamado quando o problema é a conexão dela.
    if (e.status === 0) return 'Não foi possível falar com o Drezz Hub. Verifique sua conexão.'
    return `O Drezz Hub respondeu com erro (${e.status}).`
  }
  return 'Erro inesperado.'
}
