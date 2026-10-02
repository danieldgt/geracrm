/**
 * Máquina de estados do diálogo de confirmação — PURA, sem Angular.
 *
 * ⚠️ A regra que importa: só existe UM pedido aberto por vez. Abrir um segundo
 * enquanto o primeiro espera resposta resolve o primeiro como "não" (a pessoa
 * não respondeu a ele — e um `await` pendurado para sempre é um botão que
 * nunca mais destrava). Responder com o diálogo fechado é ignorado.
 */

export interface PedidoConfirmacao {
  readonly titulo: string
  readonly mensagem: string
  /** Rótulo do botão que executa (voz ativa: "Excluir", "Disparar"). */
  readonly acao: string
  /** Rótulo do botão que desiste. */
  readonly cancelar: string
  /** Ação destrutiva pinta o botão de perigo. */
  readonly perigo: boolean
}

export type EstadoConfirmacao =
  | { readonly aberto: false }
  | { readonly aberto: true; readonly pedido: PedidoConfirmacao; readonly serie: number }

export interface Transicao {
  readonly estado: EstadoConfirmacao
  /** Respostas a entregar a quem estava esperando (série → resposta). */
  readonly respostas: readonly { readonly serie: number; readonly resposta: boolean }[]
}

export const FECHADO: EstadoConfirmacao = { aberto: false }

export function normalizarPedido(p: {
  titulo: string; mensagem: string; acao?: string; cancelar?: string; perigo?: boolean
}): PedidoConfirmacao {
  return {
    titulo: p.titulo.trim(),
    mensagem: p.mensagem.trim(),
    acao: (p.acao ?? 'Confirmar').trim() || 'Confirmar',
    cancelar: (p.cancelar ?? 'Cancelar').trim() || 'Cancelar',
    perigo: p.perigo ?? true,
  }
}

/** Abre um pedido. Um pedido já aberto é resolvido como "não" antes do novo. */
export function abrir(estado: EstadoConfirmacao, pedido: PedidoConfirmacao, serie: number): Transicao {
  const respostas = estado.aberto ? [{ serie: estado.serie, resposta: false }] : []
  return { estado: { aberto: true, pedido, serie }, respostas }
}

/** Responde ao pedido aberto. Sem pedido aberto, nada acontece. */
export function responder(estado: EstadoConfirmacao, resposta: boolean): Transicao {
  if (!estado.aberto) return { estado, respostas: [] }
  return { estado: FECHADO, respostas: [{ serie: estado.serie, resposta }] }
}
