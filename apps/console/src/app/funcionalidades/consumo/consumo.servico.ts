import { Injectable, inject, signal } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { corpoDoErro } from '../../compartilhado/ui/index.js'
import type { PontoSerie } from './consumo.regras.js'

export interface Consumo {
  readonly mes: string
  readonly whatsapp: {
    readonly porCategoria: readonly { categoria: string; mensagens: number; custoCentavos: number }[]
    readonly totalCentavos: number
  }
  readonly ia: {
    readonly porFinalidade: readonly { finalidade: string; turnos: number; custoCentavos: number }[]
    readonly porModelo: readonly { modelo: string; turnos: number; custoCentavos: number }[]
    readonly totalCentavos: number
    readonly orcamentoCentavos: number | null
    readonly projecaoCentavos: number
    readonly alerta: null | '80' | '100'
  }
  readonly transcricao: { readonly minutos: number; readonly custoCentavos: number }
  readonly serieDiaria: readonly PontoSerie[]
  readonly porCampanha: readonly { campanhaId: string; nome: string; mensagens: number; custoCentavos: number }[]
  readonly conversasMaisCaras: readonly { conversaId: string; contatoNome: string; custoCentavos: number }[]
  readonly precosPadrao: boolean
}

export interface PrecosWhatsapp {
  readonly itens: readonly { categoria: string; centavosPorMensagem: number; padrao: boolean }[]
  readonly cambioUsdBrlMilesimos: number
}

export type EstadoConsumo = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/** Consumo do mês (WhatsApp, IA, transcrição) e os preços do WhatsApp. Tenant sempre do token. */
@Injectable({ providedIn: 'root' })
export class ConsumoServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoConsumo>('carregando')
  readonly dados = signal<Consumo | null>(null)
  /** Chamada mais recente vence: navegar rápido entre meses não deixa resposta velha sobrescrever a nova. */
  private seq = 0

  async carregar(mes: string | null): Promise<void> {
    const minha = ++this.seq
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Consumo>(`/v1/consumo${mes ? `?mes=${encodeURIComponent(mes)}` : ''}`))
      if (minha !== this.seq) return
      this.dados.set(r)
      this.estado.set('pronto')
    } catch (e) {
      if (minha !== this.seq) return
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  precos(): Promise<PrecosWhatsapp> {
    return firstValueFrom(this.http.get<PrecosWhatsapp>('/v1/config/precos-whatsapp'))
  }

  /** null em sucesso; senão o mapa campo → mensagem (422) ou uma mensagem geral. */
  async salvarPrecos(
    precos: Record<string, number>, cambioUsdBrlMilesimos: number,
  ): Promise<{ geral: string | null; campos: Record<string, string> } | null> {
    try {
      await firstValueFrom(this.http.put('/v1/config/precos-whatsapp', { precos, cambioUsdBrlMilesimos }))
      return null
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 403) {
        return { geral: 'Só administradores alteram os preços.', campos: {} }
      }
      const c = corpoDoErro(e)
      if (e instanceof HttpErrorResponse && e.status === 422 && c?.campos && Object.keys(c.campos).length > 0) {
        return { geral: null, campos: { ...c.campos } }
      }
      return { geral: 'Não foi possível salvar os preços.', campos: {} }
    }
  }
}
