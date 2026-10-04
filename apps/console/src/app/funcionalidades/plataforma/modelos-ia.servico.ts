import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { codigoDoErro, ehStatus, mensagemDeErro, type ModeloComPermissao } from '../../compartilhado/ui/index.js'

/**
 * Porta HTTP do staff para "quais modelos de IA este cliente pode escolher"
 * (docs/estudo-modelos-llm.md §3). Só o staff chega aqui — a API exige o grupo.
 *
 * ⚠️ Falha volta TIPIFICADA, nunca exceção solta: o painel precisa do status
 * (403 → sem permissão) e da mensagem para mostrar inline.
 */
export type ResultadoPermissao =
  | { readonly ok: true; readonly permitidos: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly codigo: string | null; readonly mensagem: string }

@Injectable({ providedIn: 'root' })
export class ModelosIaServico {
  private readonly http = inject(HttpClient)

  async listar(clienteId: string): Promise<readonly ModeloComPermissao[]> {
    const r = await firstValueFrom(this.http.get<{ itens: ModeloComPermissao[] }>(`/v1/plataforma/clientes/${clienteId}/modelos`))
    return r.itens
  }

  /** Lista vazia = volta ao padrão do catálogo (apaga as regras do cliente). */
  async definir(clienteId: string, codigos: readonly string[]): Promise<ResultadoPermissao> {
    try {
      const r = await firstValueFrom(this.http.put<{ ok: true; permitidos: string[] }>(
        `/v1/plataforma/clientes/${clienteId}/modelos`, { codigos: [...codigos] }))
      return { ok: true, permitidos: r.permitidos }
    } catch (e) {
      return {
        ok: false,
        status: ehStatus(e, 403) ? 403 : ehStatus(e, 404) ? 404 : 0,
        codigo: codigoDoErro(e),
        mensagem: mensagemDeErro(e, 'Não foi possível salvar os modelos deste cliente.'),
      }
    }
  }
}
