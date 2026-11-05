import { HttpErrorResponse } from '@angular/common/http'

/** O corpo tipificado que a nossa API devolve em 4xx. */
export interface ErroApi {
  readonly erro?: string
  readonly mensagem?: string
  /** Mapa campo → mensagem (`{ nome: 'Informe o nome' }`), como o 422 da API devolve. */
  readonly campos?: Readonly<Record<string, string>>
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

/**
 * Erros por CAMPO de um 422 (`{ campos: { nome: '…' } }`), só dos campos que o formulário conhece
 * — o resto vira a mensagem geral, mostrada inline no corpo do modal (nunca só em toast).
 */
export function errosDeCampos(
  e: unknown, conhecidos: readonly string[], padrao: string,
): { readonly campos: Readonly<Record<string, string>>; readonly geral: string | null } {
  const corpo = corpoDoErro(e)
  const campos: Record<string, string> = {}
  for (const [k, v] of Object.entries(corpo?.campos ?? {})) if (conhecidos.includes(k) && typeof v === 'string') campos[k] = v
  const temCampo = Object.keys(campos).length > 0
  return { campos, geral: temCampo ? null : mensagemDeErro(e, padrao) }
}
