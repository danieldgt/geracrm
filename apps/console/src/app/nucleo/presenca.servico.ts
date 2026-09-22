import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

/**
 * ESTOU NA MESA OU SÓ ACOMPANHANDO — o estado de presença do operador, um só
 * para o console inteiro.
 *
 * ⚠️ Mora num serviço, e não no componente do menu, porque DUAS telas dependem
 * dele: o menu do usuário (que liga e desliga) e o inbox (que abre ou fecha o
 * campo de digitação). Duas cópias do booleano divergiriam no primeiro clique —
 * e o sintoma seria o pior: o menu dizendo "ausente" com o campo de resposta
 * aberto do lado, que é exatamente a situação que isto existe para impedir.
 *
 * ⚠️ O estado é do SERVIDOR. Aqui ele é espelho: só muda depois do PATCH
 * confirmar. Uma tela que mente sobre o servidor faz a pessoa achar que voltou
 * a atender quando o robô ainda está falando pelo número dela.
 */
@Injectable({ providedIn: 'root' })
export class PresencaServico {
  private readonly http = inject(HttpClient)

  /** ⚠️ Nasce DISPONÍVEL: o padrão do produto é atender. */
  readonly ausente = signal(false)
  readonly mexendo = signal(false)
  #batimento: ReturnType<typeof setInterval> | null = null

  /**
   * ⚠️ O BATIMENTO. Fechar o navegador não avisa ninguém, então a AUSÊNCIA de
   * sinal é o sinal: sem isto o produto acharia que há gente na mesa a noite
   * inteira e o agente nunca assumiria. 2 min contra uma janela de 5 no
   * servidor — folga para uma reconexão sem derrubar a presença.
   *
   * ⚠️ Idempotente: a casca monta uma vez, mas chamar duas vezes não pode criar
   * dois intervalos batendo no servidor em dobro.
   */
  iniciar(): void {
    if (this.#batimento) return
    void this.bater()
    this.#batimento = setInterval(() => void this.bater(), 120_000)
    void this.carregar()
  }

  parar(): void {
    if (this.#batimento) { clearInterval(this.#batimento); this.#batimento = null }
  }

  private async bater(): Promise<void> {
    // ⚠️ Silencioso: falhar o batimento não pode virar erro na tela de quem só
    //    está trabalhando. Na pior hipótese a presença expira e o agente cobre.
    try { await firstValueFrom(this.http.post('/v1/config/presenca', {})) } catch { /* ignora */ }
  }

  /**
   * ⚠️ Pergunta ao servidor sobre MIM — `/v1/config/eu`, não a lista da equipe.
   * Antes a tela baixava até 200 colegas e procurava o próprio e-mail no meio
   * para ler um booleano; quando o e-mail do token não batia com o gravado, o
   * botão nascia errado e ninguém entendia por quê.
   */
  async carregar(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ausente: boolean }>('/v1/config/eu'))
      this.ausente.set(r.ausente === true)
    } catch { /* sem resposta: fica no padrão disponível */ }
  }

  async alternar(): Promise<void> {
    await this.definir(!this.ausente())
  }

  async definir(ausente: boolean): Promise<void> {
    if (this.mexendo() || ausente === this.ausente()) return
    this.mexendo.set(true)
    try {
      await firstValueFrom(this.http.patch('/v1/config/ausencia', { ausente }))
      this.ausente.set(ausente)
    } catch { /* mantém o estado anterior: a tela não mente sobre o servidor */ }
    finally { this.mexendo.set(false) }
  }
}
