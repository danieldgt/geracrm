import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type {
  ContagensImportacao, DePara, EstadoImportacao, LinhaConferencia, ProgressoImportacao, ResultadoItem, TipoImportacao,
} from '@geracrm/shared'

export interface OpcoesImportacao { criarOrigens: boolean; criarEtiquetas: boolean }

export interface ImportacaoResumo {
  readonly id: string; readonly tipo: TipoImportacao; readonly arquivoNome: string; readonly arquivoHash: string
  readonly estado: EstadoImportacao; readonly dePara: DePara; readonly opcoes: OpcoesImportacao
  readonly contagens: ContagensImportacao; readonly progresso: ProgressoImportacao; readonly erro: string | null
  readonly criadoPor: string | null; readonly criadoEm: string; readonly atualizadoEm: string; readonly concluidoEm: string | null
}

export interface Pagina<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }

export interface ResultadoSimulacao {
  readonly importacaoId: string; readonly arquivoHash: string; readonly delimitador: string
  readonly colunas: readonly string[]; readonly deParaSugerido: DePara; readonly dePara: DePara
  readonly contagens: ContagensImportacao
  readonly amostraRejeicoes: readonly { readonly linha: number; readonly motivo: string }[]
}

export interface ItemImportacao {
  readonly linha: number; readonly resultado: ResultadoItem; readonly motivo: string | null; readonly referenciaId: string | null
}

export interface Conferencia { readonly estado: EstadoImportacao; readonly linhas: readonly LinhaConferencia[]; readonly total: number }

/** Importador por planilha (H1): simula, executa e confere. O tenant vem do token; nenhuma rota o aceita. */
@Injectable({ providedIn: 'root' })
export class ImportacaoServico {
  private readonly http = inject(HttpClient)

  /** O arquivo vai em multipart; de-para e opções vão como JSON em campos de texto. */
  private corpo(arquivo: File, campos: Record<string, unknown>): FormData {
    const fd = new FormData()
    for (const [k, v] of Object.entries(campos)) if (v !== undefined) fd.append(k, JSON.stringify(v))
    fd.append('arquivo', arquivo, arquivo.name)
    return fd
  }

  simular(tipo: TipoImportacao, arquivo: File, dePara: DePara, opcoes: OpcoesImportacao): Promise<ResultadoSimulacao> {
    return firstValueFrom(this.http.post<ResultadoSimulacao>(`/v1/importacoes/${tipo}/simular`, this.corpo(arquivo, { dePara, opcoes })))
  }

  /** O MESMO arquivo simulado, reenviado: a API confere o hash e devolve 409 `importacao.nao_simulada` se divergir. */
  executar(id: string, arquivo: File, dePara: DePara, opcoes: OpcoesImportacao): Promise<{ id: string; estado: EstadoImportacao }> {
    return firstValueFrom(this.http.post<{ id: string; estado: EstadoImportacao }>(
      `/v1/importacoes/${id}/executar`, this.corpo(arquivo, { deParaConfirmado: dePara, opcoes })))
  }

  cancelar(id: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`/v1/importacoes/${id}/cancelar`, {}))
  }

  obter(id: string): Promise<ImportacaoResumo> {
    return firstValueFrom(this.http.get<ImportacaoResumo>(`/v1/importacoes/${id}`))
  }

  listar(cursor?: string | null): Promise<Pagina<ImportacaoResumo>> {
    return firstValueFrom(this.http.get<Pagina<ImportacaoResumo>>(`/v1/importacoes${queryDeLista({ cursor })}`))
  }

  conferencia(id: string): Promise<Conferencia> {
    return firstValueFrom(this.http.get<Conferencia>(`/v1/importacoes/${id}/conferencia`))
  }

  async baixarModelo(tipo: TipoImportacao): Promise<void> {
    await this.baixar(`/v1/importacoes/${tipo}/modelo.csv`, `modelo-${tipo}.csv`)
  }

  async baixarRelatorio(id: string): Promise<void> {
    await this.baixar(`/v1/importacoes/${id}/relatorio.csv`, `relatorio-importacao-${id.slice(0, 8)}.csv`)
  }

  private async baixar(url: string, nome: string): Promise<void> {
    const texto = await firstValueFrom(this.http.get(url, { responseType: 'text' }))
    const href = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = href; a.download = nome; a.click()
    URL.revokeObjectURL(href)
  }
}
