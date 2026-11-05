import { Injectable, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { queryDeLista } from '../../compartilhado/ui/index.js'
import type { FilialLista, TipoFilial } from './filiais.regras.js'
import type { PaginaDe } from './usuarios.servico.js'

export interface CorpoFilial {
  nome?: string; cidade?: string | null; uf?: string | null; tipo?: TipoFilial; cor?: string | null; ativa?: boolean
}

/** Filiais (D3.4). Lista por cursor; o tenant vem do token. */
@Injectable({ providedIn: 'root' })
export class FiliaisServico {
  private readonly http = inject(HttpClient)

  listar(cursor?: string | null): Promise<PaginaDe<FilialLista>> {
    return firstValueFrom(this.http.get<PaginaDe<FilialLista>>(`/v1/filiais${queryDeLista({ cursor })}`))
  }
  criar(corpo: CorpoFilial & { nome: string }): Promise<unknown> {
    return firstValueFrom(this.http.post('/v1/filiais', corpo))
  }
  editar(id: string, corpo: CorpoFilial): Promise<unknown> {
    return firstValueFrom(this.http.patch(`/v1/filiais/${id}`, corpo))
  }
}
