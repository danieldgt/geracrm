import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type { CampoFormulario, FormularioDefinicao } from './formulario.regras.js'

export interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }

export interface FormularioLista {
  readonly id: string; readonly nome: string; readonly slug: string; readonly chavePublica: string
  readonly titulo: string; readonly tipo: string; readonly ativo: boolean; readonly totalRespostas: number
  readonly criadoEm: string
}

export interface FormularioDetalhe {
  readonly id: string; readonly nome: string; readonly slug: string; readonly chavePublica: string
  readonly titulo: string; readonly descricao: string | null; readonly tipo: string
  readonly filialId: string | null; readonly etapaDestinoId: string | null
  readonly responsavelPadraoId: string | null; readonly origemId: string | null
  readonly cor: string; readonly textoBotao: string; readonly mensagemSucesso: string
  readonly ativo: boolean; readonly temToken: boolean; readonly campos: readonly CampoFormulario[]
}

export interface CorpoFormulario {
  nome?: string; slug?: string; titulo?: string; descricao?: string | null; tipo?: string
  filialId?: string | null; etapaDestinoId?: string | null; responsavelPadraoId?: string | null; origemId?: string | null
  cor?: string; textoBotao?: string; mensagemSucesso?: string; ativo?: boolean
}

export interface RespostaLinha {
  readonly id: string; readonly contatoId: string | null; readonly contatoNome: string | null
  readonly contatoNovo: boolean; readonly respostas: Record<string, unknown>; readonly criadoEm: string
}

export interface EtapaFunil { readonly id: string; readonly nome: string; readonly tipo: string; readonly ativo: boolean }

/** Formulários públicos (F3): administração autenticada + as duas rotas públicas (sem token). */
@Injectable({ providedIn: 'root' })
export class FormulariosServico {
  private readonly http = inject(HttpClient)

  listar(cursor?: string | null): Promise<Pagina<FormularioLista>> {
    return firstValueFrom(this.http.get<Pagina<FormularioLista>>(`/v1/formularios${queryDeLista({ cursor })}`))
  }
  obter(id: string): Promise<FormularioDetalhe> {
    return firstValueFrom(this.http.get<FormularioDetalhe>(`/v1/formularios/${id}`))
  }
  criar(corpo: CorpoFormulario & { nome: string }): Promise<FormularioDetalhe> {
    return firstValueFrom(this.http.post<FormularioDetalhe>('/v1/formularios', corpo))
  }
  editar(id: string, corpo: CorpoFormulario): Promise<unknown> {
    return firstValueFrom(this.http.patch(`/v1/formularios/${id}`, corpo))
  }
  remover(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/v1/formularios/${id}`))
  }
  salvarCampos(id: string, campos: readonly CampoFormulario[]): Promise<{ campos: CampoFormulario[] }> {
    return firstValueFrom(this.http.put<{ campos: CampoFormulario[] }>(`/v1/formularios/${id}/campos`, { campos }))
  }
  regerarToken(id: string): Promise<{ token: string }> {
    return firstValueFrom(this.http.post<{ token: string }>(`/v1/formularios/${id}/token`, {}))
  }
  respostas(id: string, cursor?: string | null): Promise<Pagina<RespostaLinha>> {
    return firstValueFrom(this.http.get<Pagina<RespostaLinha>>(`/v1/formularios/${id}/respostas${queryDeLista({ cursor })}`))
  }
  /** O CSV vem do streaming da API; o navegador baixa pelo próprio link (sem passar o arquivo por memória). */
  async baixarCsv(id: string, slug: string): Promise<void> {
    const texto = await firstValueFrom(this.http.get(`/v1/formularios/${id}/respostas.csv`, { responseType: 'text' }))
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = `formulario-${slug}-respostas.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  etapasDoFunil(): Promise<{ itens: readonly EtapaFunil[] }> {
    return firstValueFrom(this.http.get<{ itens: readonly EtapaFunil[] }>('/v1/funil/config/etapas'))
  }

  // ── Superfície pública (sem token): o interceptor só anexa identidade em /v1. ──
  definicaoPublica(chave: string): Promise<FormularioDefinicao> {
    return firstValueFrom(this.http.get<FormularioDefinicao>(`/publico/f/${encodeURIComponent(chave)}`))
  }
  enviarPublico(chave: string, corpo: Record<string, unknown>,
    anexos: ReadonlyMap<string, File>): Promise<{ ok: boolean; mensagem: string }> {
    const url = `/publico/f/${encodeURIComponent(chave)}/respostas`
    if (anexos.size === 0) return firstValueFrom(this.http.post<{ ok: boolean; mensagem: string }>(url, corpo))
    const fd = new FormData()
    fd.append('dados', JSON.stringify(corpo))
    for (const [campoId, arq] of anexos) fd.append(campoId, arq, arq.name)
    return firstValueFrom(this.http.post<{ ok: boolean; mensagem: string }>(url, fd))
  }
}
