import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type { PapelAtribuido, UsuarioLista } from './usuarios.regras.js'

export interface PaginaDe<T> { readonly itens: readonly T[]; readonly proximoCursor: string | null }
export type ProvedorLogin = 'ok' | 'nao_encontrado' | 'indisponivel' | null

export interface NovoUsuario {
  nome: string; email: string; telefone?: string | null; cargo?: string | null
  papeis?: readonly PapelAtribuido[]; senhaTemporaria?: string
}
export interface EdicaoUsuario {
  nome?: string; telefone?: string | null; cargo?: string | null; ativo?: boolean; papeis?: readonly PapelAtribuido[]
}

/** Usuários (D3.4). Lista por cursor; o tenant vem do token; só admin (403 caso contrário). */
@Injectable({ providedIn: 'root' })
export class UsuariosServico {
  private readonly http = inject(HttpClient)

  listar(p: { cursor?: string | null; busca?: string; ativo?: 'true' | 'false' | '' }): Promise<PaginaDe<UsuarioLista>> {
    return firstValueFrom(this.http.get<PaginaDe<UsuarioLista>>(
      `/v1/usuarios${queryDeLista({ cursor: p.cursor, busca: p.busca?.trim(), ativo: p.ativo })}`))
  }
  criar(corpo: NovoUsuario): Promise<{ id: string }> {
    return firstValueFrom(this.http.post<{ id: string }>('/v1/usuarios', corpo))
  }
  editar(id: string, corpo: EdicaoUsuario): Promise<{ ok: boolean; provedor: ProvedorLogin }> {
    return firstValueFrom(this.http.patch<{ ok: boolean; provedor: ProvedorLogin }>(`/v1/usuarios/${id}`, corpo))
  }
  redefinirSenha(id: string, senhaTemporaria: string): Promise<{ ok: boolean }> {
    return firstValueFrom(this.http.post<{ ok: boolean }>(`/v1/usuarios/${id}/redefinir-senha`, { senhaTemporaria }))
  }
}
