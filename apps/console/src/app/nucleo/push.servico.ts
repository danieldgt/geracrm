import { Injectable, inject, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'

/**
 * Push nativo no navegador (PLT-07) — avisar com o console FECHADO.
 *
 * ⚠️ **A permissão é pedida no CLIQUE, nunca no carregamento.** Navegador
 * penaliza (e o Chrome bloqueia) site que pede notificação de cara, e a pessoa
 * que nega uma vez não é perguntada de novo — queimar o pedido no primeiro
 * segundo é perder o recurso para sempre naquele aparelho.
 *
 * ⚠️ E tudo aqui DEGRADA: sem suporte do navegador, sem chave no servidor, ou
 * com a permissão negada, o sino continua funcionando. Push é conveniência.
 */
export type EstadoPush =
  | 'verificando'
  /** O navegador não faz push (Safari sem PWA instalada, navegador antigo). */
  | 'sem_suporte'
  /** O servidor não tem chave VAPID configurada. */
  | 'sem_chave'
  /** Dá para ativar. */
  | 'disponivel'
  | 'ativo'
  /** A pessoa negou — e o navegador não deixa perguntar de novo. */
  | 'negado'

@Injectable({ providedIn: 'root' })
export class PushServico {
  readonly #http = inject(HttpClient)
  readonly estado = signal<EstadoPush>('verificando')
  #chave: string | null = null

  /** Chamar quando a tela do sino abre — só consulta, não pede permissão. */
  async verificar(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      this.estado.set('sem_suporte'); return
    }
    if (Notification.permission === 'denied') { this.estado.set('negado'); return }

    try {
      const r = await firstValueFrom(
        this.#http.get<{ disponivel: boolean; chave?: string }>('/v1/push/chave'))
      if (!r.disponivel || !r.chave) { this.estado.set('sem_chave'); return }
      this.#chave = r.chave

      const reg = await navigator.serviceWorker.getRegistration('/sw-push.js')
      const assinatura = await reg?.pushManager.getSubscription()
      this.estado.set(assinatura ? 'ativo' : 'disponivel')
    } catch {
      this.estado.set('sem_chave')
    }
  }

  /** ⚠️ Só a partir de um clique — ver o comentário do topo. */
  async ativar(): Promise<void> {
    if (!this.#chave) return
    const permissao = await Notification.requestPermission()
    if (permissao !== 'granted') { this.estado.set('negado'); return }

    const reg = await navigator.serviceWorker.register('/sw-push.js')
    const assinatura = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlParaBytes(this.#chave),
    })
    const j = assinatura.toJSON()
    await firstValueFrom(this.#http.post('/v1/push/assinaturas', {
      endpoint: assinatura.endpoint,
      keys: { p256dh: j.keys?.['p256dh'], auth: j.keys?.['auth'] },
    }))
    this.estado.set('ativo')
  }

  async desativar(): Promise<void> {
    const reg = await navigator.serviceWorker.getRegistration('/sw-push.js')
    const assinatura = await reg?.pushManager.getSubscription()
    if (assinatura) {
      // ⚠️ Avisa o servidor ANTES de cancelar no navegador: cancelar primeiro e
      //    falhar no POST deixaria uma linha morta empurrando para o nada.
      await firstValueFrom(
        this.#http.request('DELETE', '/v1/push/assinaturas', { body: { endpoint: assinatura.endpoint } }))
      await assinatura.unsubscribe()
    }
    this.estado.set('disponivel')
  }
}

/**
 * A chave VAPID viaja em base64url e o `subscribe` exige bytes.
 *
 * ⚠️ `atob` não entende base64URL: `-` e `_` no lugar de `+` e `/`, e sem o
 * padding. Passar direto lança `InvalidCharacterError` — erro que não menciona
 * nem VAPID nem push.
 */
function base64UrlParaBytes(base64Url: string): ArrayBuffer {
  const preenchimento = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + preenchimento).replace(/-/g, '+').replace(/_/g, '/')
  const cru = atob(base64)
  const bytes = new Uint8Array(cru.length)
  for (let i = 0; i < cru.length; i++) bytes[i] = cru.charCodeAt(i)
  // ⚠️ Devolve o ArrayBuffer, não o Uint8Array: desde o TS 5.7 o `Uint8Array` é
  //    genérico sobre `ArrayBufferLike` (que inclui SharedArrayBuffer) e deixa
  //    de casar com `BufferSource` do `subscribe`. O erro fala de tipo genérico
  //    e não de push — dois minutos perdidos para cada um que topar com ele.
  return bytes.buffer
}
