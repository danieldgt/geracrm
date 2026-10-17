/**
 * GUARDRAIL NUMÉRICO AMPLIADO — STUB da raia P7 (docs/plano-port-playbook-am.md).
 *
 * Contrato a preencher (P7): `extrairNumerosDeNegocio(texto)` →
 * percentual | quantidade | prazo_dias | prazo_horas (ignora hora, data,
 * telefone, CNPJ, CEP). "% sem fonte" bloqueia; "temos N" / "entrega em N
 * dias" sem fonte bloqueia; outros ALTA.
 *
 * ⚠️ Enquanto stub: não extrai nada — só o guardrail de R$
 * (`verificarNumerosNaResposta`, agente-vendedor.ts) vale.
 */
export const TIPOS_NUMERO_DE_NEGOCIO = ['percentual', 'quantidade', 'prazo_dias', 'prazo_horas'] as const
export type TipoNumeroDeNegocio = (typeof TIPOS_NUMERO_DE_NEGOCIO)[number]

export interface NumeroDeNegocio {
  readonly tipo: TipoNumeroDeNegocio
  readonly valor: number
  readonly trecho: string
}

/** Stub: nenhum número de negócio reconhecido. */
export function extrairNumerosDeNegocio(_texto: string): readonly NumeroDeNegocio[] {
  return []
}
