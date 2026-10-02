import { HttpErrorResponse } from '@angular/common/http'

/** O corpo tipificado que a nossa API devolve em 4xx. */
export interface ErroApi {
  readonly erro?: string
  readonly mensagem?: string
  readonly campos?: readonly string[]
  readonly disponivel?: number
  readonly skuSnapshot?: string
}

/** Extrai o corpo tipificado da API (ou `null` se não for um erro HTTP nosso). */
export function corpoDoErro(e: unknown): ErroApi | null {
  if (!(e instanceof HttpErrorResponse)) return null
  const c = e.error
  return c && typeof c === 'object' ? (c as ErroApi) : null
}

/** Código tipificado (`pedido.sem_preco`) ou `null`. */
export function codigoDoErro(e: unknown): string | null {
  return corpoDoErro(e)?.erro ?? null
}

/**
 * A frase a mostrar. ⚠️ A API já manda a mensagem com a ação corretiva — usar
 * ela; o `padrao` é só para rede caída / 5xx sem corpo. Nunca mensagem crua de
 * ERP (a API já traduz antes de chegar aqui).
 */
export function mensagemDeErro(e: unknown, padrao: string): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'Sem conexão com o Drezz Hub. Confira a rede e tente de novo.'
    if (e.status === 403) return 'Você não tem permissão para isto.'
    const m = corpoDoErro(e)?.mensagem
    if (typeof m === 'string' && m.trim()) return m
  }
  return padrao
}

export function ehStatus(e: unknown, status: number): boolean {
  return e instanceof HttpErrorResponse && e.status === status
}
