import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ehStatus, mensagemDeErro } from '../../compartilhado/ui/erro-http.js'
import { mesclarPagina } from '../../compartilhado/ui/cursor.js'
import {
  montarQueryAuditoria, opcoesDeUsuarios, type EntradaAuditoria, type FiltroAuditoria,
} from './auditoria.regras.js'

export type { EntradaAuditoria } from './auditoria.regras.js'

export type EstadoCarga = 'ocioso' | 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

interface Membro { readonly id: string; readonly nome: string }
interface Pagina { readonly itens: EntradaAuditoria[]; readonly proximoCursor: string | null; readonly janelaPadrao?: boolean; readonly janelaDias?: number | null }

/**
 * Rastro de auditoria (EP-07 / PLT-05).
 *
 * ⚠️ Paginação por CURSOR ("carregar mais"), nunca lista inteira: o rastro só
 * cresce e uma conta antiga tem centenas de milhares de linhas. O cursor vem
 * do servidor — o cliente nunca calcula OFFSET. Trocar o filtro zera a lista;
 * resposta de um filtro antigo que chega atrasada é descartada.
 */
@Injectable({ providedIn: 'root' })
export class AuditoriaServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoCarga>('ocioso')
  readonly itens = signal<readonly EntradaAuditoria[]>([])
  readonly erro = signal<string | null>(null)
  /** null quando não há próxima página — o botão "carregar mais" some. */
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  /** A busca veio sem período: o servidor limitou aos últimos N dias e a tela precisa dizer. */
  readonly janelaPadraoDias = signal<number | null>(null)

  readonly usuarios = signal<{ valor: string; rotulo: string }[]>([])
  /** Seletor de usuário degrada sozinho: a tela segue funcionando sem ele. */
  readonly usuariosFalharam = signal(false)

  private geracao = 0
  private filtro: FiltroAuditoria = { busca: '', acao: '', atorId: '', inicio: '', fim: '' }

  async carregar(filtro: FiltroAuditoria): Promise<void> {
    const g = ++this.geracao
    this.filtro = filtro
    this.estado.set('carregando')
    this.erro.set(null)
    try {
      const r = await this.pagina(montarQueryAuditoria(filtro))
      if (g !== this.geracao) return
      this.itens.set(r.itens)
      this.proximoCursor.set(r.proximoCursor)
      this.janelaPadraoDias.set(r.janelaPadrao ? (r.janelaDias ?? 30) : null)
      this.estado.set('pronto')
    } catch (e) {
      if (g !== this.geracao) return
      if (ehStatus(e, 403)) {
        this.estado.set('sem_permissao')
        return
      }
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar a auditoria. Tente de novo.'))
      this.estado.set('erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    const g = this.geracao
    this.carregandoMais.set(true)
    try {
      const r = await this.pagina(montarQueryAuditoria(this.filtro, cursor))
      if (g !== this.geracao) return
      // Anexa, não substitui; mesclar por id cobre item que entrou entre as páginas.
      this.itens.update((atual) => mesclarPagina(atual, r.itens, (e) => e.id))
      this.proximoCursor.set(r.proximoCursor)
    } catch {
      // Mantém o que já há; o botão continua para nova tentativa.
    } finally {
      if (g === this.geracao) this.carregandoMais.set(false)
    }
  }

  /** Detalhe completo de um evento (JSON inteiro). Falha sobe para a tela mostrar. */
  buscarDetalhe(criadoEm: string, id: string): Promise<EntradaAuditoria> {
    return firstValueFrom(
      this.http.get<EntradaAuditoria>(`/v1/auditoria/${encodeURIComponent(criadoEm)}/${encodeURIComponent(id)}`),
    )
  }

  async carregarUsuarios(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe'))
      this.usuarios.set(opcoesDeUsuarios(r.itens))
      this.usuariosFalharam.set(false)
    } catch {
      this.usuariosFalharam.set(true)
    }
  }

  private pagina(query: string): Promise<Pagina> {
    return firstValueFrom(this.http.get<Pagina>(`/v1/auditoria${query}`))
  }
}
