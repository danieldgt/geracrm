import { variaveisDoCorpo, CAMPOS_MAPEAMENTO } from '@geracrm/shared'
import type { CorpoTemplate } from './templates.servico.js'

/** Regras puras do mapeamento {{n}} -> campo (F2). A validação final é da API (422). */

/** Variáveis `{{n}}` que o template realmente tem (cabeçalho + corpo), em ordem. */
export function variaveisDoTemplate(corpo: CorpoTemplate | null | undefined): number[] {
  return variaveisDoCorpo(`${corpo?.header?.texto ?? ''} ${corpo?.body?.texto ?? ''}`)
}

export const OPCOES_CAMPO_MAPEAMENTO = CAMPOS_MAPEAMENTO.map((c) => ({ valor: c.campo as string, rotulo: c.rotulo as string }))

/** Mapeamento a enviar: só as variáveis que existem E têm campo escolhido (vazio = sem mapeamento). */
export function mapeamentoParaSalvar(
  variaveis: readonly number[], escolhas: Readonly<Record<string, string>>,
): Record<string, string> {
  const r: Record<string, string> = {}
  for (const v of variaveis) {
    const campo = escolhas[String(v)]
    if (campo) r[String(v)] = campo
  }
  return r
}

/** Quantas variáveis do template ainda não têm campo (aviso no cartão). */
export function variaveisSemCampo(
  variaveis: readonly number[], mapeamento: Readonly<Record<string, string>>,
): number {
  return variaveis.filter((v) => !mapeamento[String(v)]).length
}
