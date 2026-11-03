import { Injectable, computed, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

/** Módulos opcionais por tenant (espelho de `MODULOS` em `@geracrm/shared`). */
export type ModuloId = 'agenda'
export type EstadoModulos = Readonly<Record<ModuloId, boolean>>

const TUDO_DESLIGADO: EstadoModulos = { agenda: false }

/**
 * CHAVES DE MÓDULO — um estado para o console inteiro (raia D5).
 *
 * ⚠️ O estado é do SERVIDOR (`GET /v1/config/modulos`). Aqui é espelho: carregado
 * UMA vez no shell e só muda depois que o `PUT` confirmou — o menu nunca mostra
 * um módulo que a API vai responder 404.
 * ⚠️ Padrão DESLIGADO, inclusive enquanto não carregou ou se a carga falhar:
 * esconder por engano custa um clique em Configurações; mostrar por engano
 * leva o usuário a uma tela que não funciona.
 *
 * Quem consome (menu, ficha, Agenda): `inject(ModulosServico).agendaAtiva()`.
 */
@Injectable({ providedIn: 'root' })
export class ModulosServico {
  private readonly http = inject(HttpClient)

  readonly estado = signal<EstadoModulos>(TUDO_DESLIGADO)
  readonly carregado = signal(false)
  readonly agendaAtiva = computed(() => this.estado().agenda)
  #carregando: Promise<void> | null = null

  /** Idempotente: a segunda chamada reaproveita a primeira (o shell chama uma vez). */
  carregar(forcar = false): Promise<void> {
    if (this.#carregando && !forcar) return this.#carregando
    this.#carregando = (async () => {
      try {
        const r = await firstValueFrom(this.http.get<{ modulos: EstadoModulos }>('/v1/config/modulos'))
        this.estado.set({ ...TUDO_DESLIGADO, ...r.modulos })
        this.carregado.set(true)
      } catch { /* mantém o padrão desligado; a tela de Configurações mostra o erro por conta própria */ }
    })()
    return this.#carregando
  }

  /** Liga/desliga (admin). Lança o erro HTTP para a tela nomear (403/422). */
  async definir(modulo: ModuloId, ativo: boolean): Promise<void> {
    const r = await firstValueFrom(this.http.put<{ modulos: EstadoModulos }>(`/v1/config/modulos/${modulo}`, { ativo }))
    this.estado.set({ ...TUDO_DESLIGADO, ...r.modulos })
    this.carregado.set(true)
  }
}
