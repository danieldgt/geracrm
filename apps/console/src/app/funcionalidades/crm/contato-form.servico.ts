import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { corpoDoErro, mensagemDeErro } from '../../compartilhado/ui/index.js'
import { EtiquetasServico } from './etiquetas.servico.js'
import {
  mapearErros, type CorpoContato, type EmpresaConsulta, type EnderecoConsulta, type ErrosForm, type FichaParaForm,
  type OrigemLista,
} from './contato-form.regras.js'

/** Teto de páginas ao carregar origens: o select é de poucas linhas; acima disso a lista é outra tela. */
const MAX_PAGINAS_ORIGENS = 5

/** Resultado tipificado — validação por campo e falha geral são retornos, não exceções. */
export type ResultadoSalvar =
  | { ok: true; id: string; novo: boolean }
  | { ok: false; campos: ErrosForm; geral: string | null }

export type ResultadoConsulta<T> =
  | { ok: true; dado: T }
  | { ok: false; codigo: string | null }

export type ResultadoOrigens =
  | { ok: true; itens: OrigemLista[] }
  | { ok: false }

export type ResultadoCarga =
  | { ok: true; ficha: FichaParaForm }
  | { ok: false; naoEncontrado: boolean; mensagem: string }

/** Acesso HTTP do formulário de contato (a regra mora em `contato-form.regras.ts`). */
@Injectable({ providedIn: 'root' })
export class ContatoFormServico {
  private readonly http = inject(HttpClient)
  private readonly etiquetas = inject(EtiquetasServico)

  /** Origens por cursor, até `MAX_PAGINAS_ORIGENS` páginas. `soAtivas` = `?ativas=true`. */
  async origens(soAtivas: boolean): Promise<ResultadoOrigens> {
    const itens: OrigemLista[] = []
    let cursor: string | null = null
    try {
      for (let pagina = 0; pagina < MAX_PAGINAS_ORIGENS; pagina++) {
        const r = await this.etiquetas.origens(cursor, soAtivas)
        itens.push(...r.itens)
        if (!r.proximoCursor) break
        cursor = r.proximoCursor
      }
      return { ok: true, itens }
    } catch {
      return { ok: false }
    }
  }

  async carregar(id: string): Promise<ResultadoCarga> {
    try {
      return { ok: true, ficha: await firstValueFrom(this.http.get<FichaParaForm>(`/v1/contatos/${id}`)) }
    } catch (e) {
      const naoEncontrado = e instanceof HttpErrorResponse && e.status === 404
      return { ok: false, naoEncontrado, mensagem: naoEncontrado ? 'Contato não encontrado.' : mensagemDeErro(e, 'Não foi possível carregar o contato.') }
    }
  }

  async criar(corpo: CorpoContato): Promise<ResultadoSalvar> {
    try {
      const r = await firstValueFrom(this.http.post<{ id: string; novo: boolean }>('/v1/contatos', corpo))
      return { ok: true, id: r.id, novo: r.novo }
    } catch (e) {
      return this.falha(e)
    }
  }

  async atualizar(id: string, corpo: CorpoContato): Promise<ResultadoSalvar> {
    try {
      await firstValueFrom(this.http.put<{ ok: true }>(`/v1/contatos/${id}`, corpo))
      return { ok: true, id, novo: false }
    } catch (e) {
      return this.falha(e)
    }
  }

  consultarCnpj(cnpj: string): Promise<ResultadoConsulta<EmpresaConsulta>> {
    return this.consultar<EmpresaConsulta>(`/v1/consultas/cnpj/${cnpj.replace(/\D/g, '')}`)
  }

  consultarCep(cep: string): Promise<ResultadoConsulta<EnderecoConsulta>> {
    return this.consultar<EnderecoConsulta>(`/v1/consultas/cep/${cep.replace(/\D/g, '')}`)
  }

  private async consultar<T>(url: string): Promise<ResultadoConsulta<T>> {
    try {
      return { ok: true, dado: await firstValueFrom(this.http.get<T>(url)) }
    } catch (e) {
      const codigo = e instanceof HttpErrorResponse ? ((e.error as { erro?: string } | null)?.erro ?? null) : null
      return { ok: false, codigo }
    }
  }

  private falha(e: unknown): ResultadoSalvar {
    const { campos, geral } = mapearErros(corpoDoErro(e))
    if (Object.keys(campos).length > 0 || geral) return { ok: false, campos, geral }
    return { ok: false, campos: {}, geral: mensagemDeErro(e, 'Não foi possível salvar o contato. Tente de novo.') }
  }
}
