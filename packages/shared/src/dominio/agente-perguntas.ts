/**
 * PERGUNTA REPETIDA E SLOTS DETERMINÍSTICOS — STUB da raia P3 (docs/plano-port-playbook-am.md).
 *
 * Contrato a preencher (P3): `normalizar`, `perguntasDe`, Jaccard com LIMIAR
 * 0,7, `PERGUNTA_DO_SLOT`, `extrairSlotsDoCliente(texto)` (volume, prazo,
 * orçamento, tipoCompra, cnpj → 'informado', nunca dígitos) e
 * `evitarPerguntaRepetida(texto, {perguntasAnteriores, slotsRespondidos,
 * slotsDoCanal}) → {texto, removidas, substituta}`.
 *
 * ⚠️ Enquanto stub: não extrai nada e não mexe no texto.
 */
export interface ResultadoPerguntaRepetida {
  readonly texto: string
  readonly removidas: readonly string[]
  readonly substituta: string | null
}

/** Stub: nenhum slot reconhecido. */
export function extrairSlotsDoCliente(_texto: string): Readonly<Record<string, string>> {
  return {}
}

/** Stub: identidade. */
export function evitarPerguntaRepetida(
  texto: string,
  _ctx: {
    readonly perguntasAnteriores: readonly string[]
    readonly slotsRespondidos: readonly string[]
    readonly slotsDoCanal: readonly string[]
  },
): ResultadoPerguntaRepetida {
  return { texto, removidas: [], substituta: null }
}
