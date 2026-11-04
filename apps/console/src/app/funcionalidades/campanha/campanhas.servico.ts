import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type {
  AcoesApi, CorpoCampanha, CorpoPrevia, DestinatarioApi, JanelaDia, PausaPorQualidade, PreviaApi, PublicoApi, RelatorioApi,
} from './campanhas.regras.js'

export interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }

export interface CampanhaResumo {
  readonly id: string
  readonly nome: string
  readonly segmentoAlvo: string
  readonly estado: string
  /** 1 = legada (segmento + texto livre); 2 = wizard. */
  readonly modeloVersao: number
  readonly janelaDias: number
  readonly disparadaEm: string | null
  readonly criadoEm: string
  readonly canal: { id: string; nome: string | null; tipo: string | null } | null
  readonly template: { id: string; nome: string | null; categoria: string | null } | null
  readonly loteDiario: number | null
  readonly inicioEm: string | null
  readonly pausaMotivo: string | null
  readonly pausadaEm: string | null
  readonly iniciadaEm: string | null
  readonly concluidaEm: string | null
  readonly pausadaPorQualidade: PausaPorQualidade | null
}

export interface CampanhaDetalhe extends CampanhaResumo {
  readonly mensagem: string | null
  readonly publico: PublicoApi | null
  readonly janela: Readonly<Record<string, JanelaDia>> | null
  readonly janelaEfetiva: { origem: string; horario: Readonly<Record<string, JanelaDia>> }
  readonly confirmaRiscoBanimento: boolean
  readonly iniciadaPor: string | null
  readonly atualizadoEm: string | null
  readonly destinatarios: Readonly<Record<string, number>>
  readonly acoes: AcoesApi
}

export interface CanalCampanha { readonly id: string; readonly tipo: string; readonly nomeAmigavel: string; readonly estado: string }
export interface TemplateCampanha {
  readonly id: string; readonly nome: string; readonly categoria: string; readonly statusMeta: string
  readonly corpo: { body: { texto: string } }
  readonly mapeamentoVariaveis?: Readonly<Record<string, string>>
}
export interface ItemNomeado { readonly id: string; readonly nome: string }
export interface EtapaFunil { readonly id: string; readonly nome: string; readonly tipo: string; readonly ativo: boolean }

export interface ResultadoTeste { readonly telefone: string; readonly ok: boolean; readonly motivo?: string }
export interface RoiLegado {
  readonly janelaDias: number
  readonly exata: { pedidos: number; receitaCentavos: number }
  readonly estimada: { vendas: number; receitaCentavos: number }
  readonly enviados: number
}

/**
 * Campanhas v2 (F1b) — só HTTP. O tenant vem do token; preço e elegibilidade são resolvidos no servidor
 * (o corpo nunca carrega custo). Toda lista é por cursor.
 */
@Injectable({ providedIn: 'root' })
export class CampanhasServico {
  private readonly http = inject(HttpClient)

  listar(estado: string | null, cursor: string | null): Promise<Pagina<CampanhaResumo>> {
    return firstValueFrom(this.http.get<Pagina<CampanhaResumo>>(`/v1/campanhas${queryDeLista({ cursor, estado })}`))
  }
  obter(id: string): Promise<CampanhaDetalhe> {
    return firstValueFrom(this.http.get<CampanhaDetalhe>(`/v1/campanhas/${id}`))
  }
  previa(corpo: CorpoPrevia): Promise<PreviaApi> {
    return firstValueFrom(this.http.post<PreviaApi>('/v1/campanhas/previa', corpo))
  }
  criar(corpo: CorpoCampanha): Promise<{ id: string }> {
    return firstValueFrom(this.http.post<{ id: string }>('/v1/campanhas', corpo))
  }
  editar(id: string, corpo: CorpoCampanha): Promise<unknown> {
    return firstValueFrom(this.http.put(`/v1/campanhas/${id}`, corpo))
  }
  excluir(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/v1/campanhas/${id}`))
  }
  testar(id: string, telefones: readonly string[]): Promise<{ resultados: readonly ResultadoTeste[] }> {
    return firstValueFrom(this.http.post<{ resultados: readonly ResultadoTeste[] }>(`/v1/campanhas/${id}/teste`, { telefones }))
  }
  iniciar(id: string, confirmacaoNome: string): Promise<{ estado: string; destinatarios: number; excluidos: number }> {
    return firstValueFrom(this.http.post<{ estado: string; destinatarios: number; excluidos: number }>(
      `/v1/campanhas/${id}/iniciar`, { confirmacaoNome }))
  }
  pausar(id: string): Promise<unknown> { return firstValueFrom(this.http.post(`/v1/campanhas/${id}/pausar`, {})) }
  retomar(id: string): Promise<unknown> { return firstValueFrom(this.http.post(`/v1/campanhas/${id}/retomar`, {})) }
  cancelar(id: string): Promise<unknown> { return firstValueFrom(this.http.post(`/v1/campanhas/${id}/cancelar`, {})) }

  destinatarios(id: string, estado: string | null, cursor: string | null): Promise<Pagina<DestinatarioApi>> {
    return firstValueFrom(this.http.get<Pagina<DestinatarioApi>>(`/v1/campanhas/${id}/destinatarios${queryDeLista({ cursor, estado })}`))
  }
  relatorio(id: string): Promise<RelatorioApi> {
    return firstValueFrom(this.http.get<RelatorioApi>(`/v1/campanhas/${id}/relatorio`))
  }
  roiLegado(id: string): Promise<RoiLegado> {
    return firstValueFrom(this.http.get<RoiLegado>(`/v1/campanhas/${id}/roi`))
  }

  // ── Catálogos do wizard (todos por cursor) ──
  canais(): Promise<{ itens: readonly CanalCampanha[] }> {
    return firstValueFrom(this.http.get<{ itens: readonly CanalCampanha[] }>('/v1/canais'))
  }
  templates(cursor: string | null): Promise<Pagina<TemplateCampanha>> {
    return firstValueFrom(this.http.get<Pagina<TemplateCampanha>>(`/v1/templates${queryDeLista({ cursor })}`))
  }
  listas(cursor: string | null): Promise<Pagina<ItemNomeado>> {
    return firstValueFrom(this.http.get<Pagina<ItemNomeado>>(`/v1/listas${queryDeLista({ cursor })}`))
  }
  etapas(): Promise<{ itens: readonly EtapaFunil[] }> {
    return firstValueFrom(this.http.get<{ itens: readonly EtapaFunil[] }>('/v1/funil/config/etapas'))
  }
}
