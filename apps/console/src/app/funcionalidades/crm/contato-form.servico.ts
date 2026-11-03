import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { mensagemDeErro } from '../../compartilhado/ui/index.js'
import {
  mapearErros, type CorpoContato, type EmpresaConsulta, type EnderecoConsulta, type ErrosForm, type FichaParaForm,
} from './contato-form.regras.js'

/** Resultado tipificado — validação por campo e falha geral são retornos, não exceções. */
export type ResultadoSalvar =
  | { ok: true; id: string; novo: boolean }
  | { ok: false; campos: ErrosForm; geral: string | null }

export type ResultadoConsulta<T> =
  | { ok: true; dado: T }
  | { ok: false; codigo: string | null }

export type ResultadoCarga =
  | { ok: true; ficha: FichaParaForm }
  | { ok: false; naoEncontrado: boolean; mensagem: string }

/** Acesso HTTP do formulário de contato (a regra mora em `contato-form.regras.ts`). */
@Injectable({ providedIn: 'root' })
export class ContatoFormServico {
  private readonly http = inject(HttpClient)

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
    const corpo = e instanceof HttpErrorResponse ? e.error : null
    const { campos, geral } = mapearErros(corpo)
    if (Object.keys(campos).length > 0 || geral) return { ok: false, campos, geral }
    return { ok: false, campos: {}, geral: mensagemDeErro(e, 'Não foi possível salvar o contato. Tente de novo.') }
  }
}
