import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { signal } from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { periodoInvertido } from '../../compartilhado/ui/periodo.js'
import { codigoDoErro } from '../../compartilhado/ui/erro-http.js'
import { queryDoPeriodo } from './relatorio-dimensao.regras.js'
import { mensagemDoErro, type PeriodoApi } from './relatorios-gestao.regras.js'

export type EstadoRelatorio = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Estado de um relatório com período livre: período, estado de tela, dados e erro. A primeira carga vai sem
 * período (a API assume o mês atual no fuso do tenant) e o período devolvido preenche o filtro. Uma carga
 * nova descarta a resposta da anterior (`versao`). Instancie dentro do componente (precisa do HttpClient).
 */
export class CarregadorRelatorio<T extends { readonly periodo: PeriodoApi }> {
  readonly inicio = signal('')
  readonly fim = signal('')
  readonly estado = signal<EstadoRelatorio>('carregando')
  readonly dados = signal<T | null>(null)
  readonly erroTexto = signal('')
  private versao = 0

  /** `caminho`: rota sem query; `extra`: parâmetros além do período (ex.: `limiteMin=10`). */
  constructor(
    private readonly http: HttpClient,
    private readonly caminho: () => string,
    private readonly extra: () => string = () => '',
  ) {}

  async carregar(): Promise<void> {
    if (periodoInvertido(this.inicio(), this.fim())) return
    const minha = ++this.versao
    this.estado.set('carregando')
    const query = [queryDoPeriodo(this.inicio(), this.fim()), this.extra()].filter((q) => q !== '').join('&')
    try {
      const r = await firstValueFrom(this.http.get<T>(`${this.caminho()}${query ? `?${query}` : ''}`))
      if (minha !== this.versao) return
      this.dados.set(r)
      this.inicio.set(r.periodo.inicio)
      this.fim.set(r.periodo.fim)
      this.estado.set('pronto')
    } catch (e) {
      if (minha !== this.versao) return
      if (e instanceof HttpErrorResponse && e.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroTexto.set(mensagemDoErro(codigoDoErro(e)))
      this.estado.set('erro')
    }
  }
}
