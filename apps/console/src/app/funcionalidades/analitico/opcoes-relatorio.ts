import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { CarregarOpcoes, OpcaoPaginada } from '../../compartilhado/ui/select-paginado.estado.js'

export type EixoOpcoes = 'vendedor' | 'filial' | 'formulario' | 'origem'

/**
 * Carregador do `ui-select-paginado` para os filtros dos relatórios: `GET /v1/relatorios/opcoes/:eixo`, por
 * cursor e com busca no servidor. `lembrar` recebe cada opção carregada (o select só devolve o valor, e o
 * comparativo precisa do nome para o chip).
 */
export function carregarOpcoesRelatorio(http: HttpClient, eixo: EixoOpcoes, lembrar?: (o: OpcaoPaginada) => void): CarregarOpcoes {
  return async (cursor, termo) => {
    const partes = [termo.trim() !== '' ? `busca=${encodeURIComponent(termo.trim())}` : '', cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
    const query = partes.filter((p) => p !== '').join('&')
    const r = await firstValueFrom(http.get<{ itens: { id: string; nome: string }[]; proximoCursor: string | null }>(
      `/v1/relatorios/opcoes/${eixo}${query ? `?${query}` : ''}`))
    const itens = r.itens.map((i): OpcaoPaginada => ({ valor: i.id, rotulo: i.nome }))
    itens.forEach((o) => lembrar?.(o))
    return { itens, proximoCursor: r.proximoCursor }
  }
}
