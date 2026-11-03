/** Regras puras da anonimização LGPD no console (raia H2). Sem Angular, sem rede. */

/** O que a pessoa digita para confirmar a anonimização definitiva. */
export const TEXTO_CONFIRMACAO_ANONIMIZAR = 'ANONIMIZAR'
/** Código tipificado da API quando o contato tem compra (dado fiscal). */
export const ERRO_CONTATO_COM_COMPRA = 'lgpd.contato_com_compra'

export type MotivoAnonimizacao = 'retencao' | 'opt_out' | 'titular'

export interface RelatorioAnonimizacao {
  readonly de: string
  readonly ate: string
  readonly total: number
  readonly porMotivo: Readonly<Record<MotivoAnonimizacao, number>>
  readonly porModo: Readonly<Record<'completa' | 'canais', number>>
  readonly midiasPendentes: number
}

const ROTULO_MOTIVO: Readonly<Record<MotivoAnonimizacao, string>> = {
  retencao: 'Fim do prazo de retenção',
  opt_out: 'Pediu para sair (opt-out)',
  titular: 'Pedido do titular',
}

export function rotuloMotivo(m: MotivoAnonimizacao): string { return ROTULO_MOTIVO[m] }

/** Motivos na ordem fixa da tela, com a contagem (zero também aparece). */
export function linhasPorMotivo(r: RelatorioAnonimizacao): { motivo: MotivoAnonimizacao; rotulo: string; total: number }[] {
  return (['retencao', 'opt_out', 'titular'] as const).map((motivo) => ({ motivo, rotulo: ROTULO_MOTIVO[motivo], total: r.porMotivo[motivo] ?? 0 }))
}

/** Primeiro e último dia (AAAA-MM-DD, UTC) do mês de `agora` — o período padrão do painel. */
export function periodoDoMes(agora: Date): { de: string; ate: string } {
  const a = agora.getUTCFullYear(), m = agora.getUTCMonth()
  const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate()
  const mm = String(m + 1).padStart(2, '0')
  return { de: `${a}-${mm}-01`, ate: `${a}-${mm}-${String(ultimo).padStart(2, '0')}` }
}
